'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const backup = require('./backup');

const { pgTools } = backup;
const DEFAULT_BACKUP_DIR = path.resolve(process.env.ISMS_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const MANIFEST_FORMAT = backup.MANIFEST_FORMAT;
const DATABASE_ARCHIVE_SUFFIX = backup.DATABASE_ARCHIVE_SUFFIX;
const UPLOAD_BUNDLE_MAGIC = backup.UPLOAD_BUNDLE_MAGIC.trimEnd();
const MAX_BUNDLE_HEADER_BYTES = 64 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_GENERATION_AGE_HOURS = positiveNumber(process.env.ISMS_BACKUP_MAX_AGE_HOURS, 26);

const SQLITE_ARCHIVE_SUFFIX = '.db.gz.enc';
const SQLITE_ERA_FORMATS = new Set(['nimbus-recovery-generation-v2', 'nimbus-sqlite-aes256gcm-v1']);

const SANITY_TABLES = ['workspaces', 'users', 'risks', 'iso_items', 'audit_log'];
const SNAPSHOT_COUNT_TABLES = [
  ...SANITY_TABLES,
  'evidence',
  'generated_docs',
  'questionnaire_attachments',
  'supplier_ddq_evidence',
  'supplier_documents',
  'tprm_condition_evidence_links',
];
const LIVE_COUNT_MIN_RATIO = 0.95;
const LIVE_COUNT_ABSOLUTE_ALLOWANCE = 1;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sqliteEraError(generationId) {
  return new Error(`recovery generation ${generationId || '(unnamed)'} was written by the SQLite version of the application; ` +
    'restore-check verifies PostgreSQL generations only. Materialize it with the SQLite release\'s scripts/restore.js, ' +
    'then load restored.db with scripts/sqlite-to-postgres.js');
}

function verifyManifestHmac(manifest, key) {
  const supplied = manifest && manifest.integrity && manifest.integrity.manifest_hmac_sha256;
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new Error('recovery manifest has no valid HMAC signature');
  }
  const expected = backup.signManifest(manifest, key);
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) {
    throw new Error('recovery manifest HMAC verification failed (tampered manifest or wrong escrowed key)');
  }
  return supplied;
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function normalizeUploadPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_BUNDLE_HEADER_BYTES) {
    throw new Error('uploads manifest contains an invalid path');
  }
  if (value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`unsafe upload path rejected: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`unsafe upload path rejected: ${JSON.stringify(value)}`);
  }
  if (value.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`unsafe upload path rejected: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function artifactPath(backupDir, name, expectedSuffix) {
  if (typeof name !== 'string' || path.basename(name) !== name || name.includes('\\') || !name.endsWith(expectedSuffix)) {
    throw new Error(`unsafe recovery artifact name: ${JSON.stringify(name)}`);
  }
  const root = path.resolve(backupDir);
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`recovery artifact escapes backup directory: ${name}`);
  return resolved;
}

function verifyArtifact(file, declared, label) {
  if (!declared || !Number.isSafeInteger(declared.size_bytes) || declared.size_bytes < 0 ||
      typeof declared.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(declared.sha256)) {
    throw new Error(`${label} artifact metadata is invalid`);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} artifact is missing: ${file}`);
  const size = fs.statSync(file).size;
  if (size !== declared.size_bytes) throw new Error(`${label} archive byte count mismatch: expected ${declared.size_bytes}, got ${size}`);
  const sha256 = hashFile(file);
  if (sha256 !== declared.sha256) throw new Error(`${label} archive SHA-256 mismatch`);
  return { size, sha256 };
}

async function tableExists(database, table) {
  return Boolean(await database.prepare(`SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ?`).get(table));
}

async function snapshotCounts(database) {
  const counts = {};
  for (const table of SNAPSHOT_COUNT_TABLES) {
    if (await tableExists(database, table)) {
      counts[table] = (await database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).count;
    }
  }
  return counts;
}

async function verifySnapshotCounts(restored, manifest) {
  const declared = manifest && manifest.database_snapshot_counts;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error('signed recovery manifest has no database snapshot counts');
  }
  const actual = await snapshotCounts(restored);
  for (const table of Object.keys(actual)) {
    if (!Object.prototype.hasOwnProperty.call(declared, table)) {
      throw new Error(`signed recovery manifest is missing restored table count ${table}`);
    }
  }
  for (const table of SNAPSHOT_COUNT_TABLES) {
    if (!Object.prototype.hasOwnProperty.call(declared, table)) continue;
    const expected = declared[table];
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw new Error(`signed database snapshot count is invalid for ${table}`);
    }
    if (!Object.prototype.hasOwnProperty.call(actual, table)) {
      throw new Error(`restored database is missing counted table ${table}`);
    }
    if (actual[table] !== expected) {
      throw new Error(`signed row count mismatch on ${table}: restored=${actual[table]} manifest=${expected}`);
    }
  }
  return actual;
}

function verifyGenerationAge(manifest, options = {}) {
  const createdAt = Date.parse(manifest && manifest.created_at);
  if (!Number.isFinite(createdAt)) throw new Error('recovery manifest has an invalid created_at timestamp');
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (!Number.isFinite(now)) throw new Error('generation-age reference time is invalid');
  const ageMs = now - createdAt;
  if (ageMs < -5 * 60_000) throw new Error('recovery generation timestamp is unreasonably far in the future');
  const maxAgeHours = options.maxAgeHours === undefined
    ? DEFAULT_MAX_GENERATION_AGE_HOURS
    : Number(options.maxAgeHours);
  if (options.allowStaleGeneration !== true && (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)) {
    throw new Error('maximum recovery generation age must be a positive number of hours');
  }
  if (options.allowStaleGeneration !== true && ageMs > maxAgeHours * 60 * 60_000) {
    throw new Error(`recovery generation is stale: age=${(ageMs / 3_600_000).toFixed(2)}h maximum=${maxAgeHours}h`);
  }
  return { createdAt: new Date(createdAt).toISOString(), ageMs: Math.max(0, ageMs), maxAgeHours };
}

function generationFiles(root, base) {
  const pgdump = path.join(root, `${base}${DATABASE_ARCHIVE_SUFFIX}`);
  if (fs.existsSync(pgdump) && fs.statSync(pgdump).isFile()) return { database: pgdump, sqliteEra: false };
  const sqlite = path.join(root, `${base}${SQLITE_ARCHIVE_SUFFIX}`);
  if (fs.existsSync(sqlite) && fs.statSync(sqlite).isFile()) return { database: sqlite, sqliteEra: true };
  return null;
}

function newestGeneration(backupDir = DEFAULT_BACKUP_DIR) {
  if (!fs.existsSync(backupDir)) return null;
  const names = fs.readdirSync(backupDir);
  const committed = names
    .filter(name => /^isms-.*\.manifest\.json$/.test(name))
    .map(name => name.replace(/\.manifest\.json$/, ''))
    .filter(base => generationFiles(backupDir, base))
    .sort();
  if (committed.length) {
    const base = committed[committed.length - 1];
    return { base, manifest: path.join(backupDir, `${base}.manifest.json`), ...generationFiles(backupDir, base) };
  }
  const legacy = names.filter(name => name.startsWith('isms-') && name.endsWith(SQLITE_ARCHIVE_SUFFIX)).sort();
  if (!legacy.length) return null;
  const name = legacy[legacy.length - 1];
  return { base: name.slice(0, -SQLITE_ARCHIVE_SUFFIX.length), manifest: null, database: path.join(backupDir, name), sqliteEra: true };
}

function generationById(backupDir = DEFAULT_BACKUP_DIR, generationId) {
  const root = path.resolve(backupDir);
  if (typeof generationId !== 'string' || generationId.length > 120 || !/^isms-[A-Za-z0-9-]+$/.test(generationId)) {
    throw new Error('recovery generation id is invalid');
  }
  const manifest = path.join(root, `${generationId}.manifest.json`);
  const files = generationFiles(root, generationId);
  if (!fs.existsSync(manifest) || !fs.statSync(manifest).isFile() || !files) {
    throw new Error(`recovery generation is not committed: ${generationId}`);
  }
  return { base: generationId, manifest, ...files };
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

function decryptArtifactToFile(file, destination, key) {
  const size = fs.statSync(file).size;
  if (size < 29) throw new Error(`encrypted artifact is truncated: ${path.basename(file)}`);
  const input = fs.openSync(file, 'r');
  const output = fs.openSync(destination, 'wx', 0o600);
  const header = Buffer.allocUnsafe(28);
  try {
    if (fs.readSync(input, header, 0, header.length, 0) !== header.length) throw new Error('encrypted artifact header is truncated');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(header.subarray(12, 28));
    const chunk = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    let position = 28;
    while (position < size) {
      const bytesRead = fs.readSync(input, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!bytesRead) throw new Error('encrypted artifact ended unexpectedly');
      position += bytesRead;
      const plain = decipher.update(chunk.subarray(0, bytesRead));
      if (plain.length) writeAll(output, plain);
    }
    const final = decipher.final();
    if (final.length) writeAll(output, final);
    fs.fsyncSync(output);
    fs.fchmodSync(output, 0o600);
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

class BundleReader {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    this.buffer = Buffer.alloc(0);
    this.eof = false;
  }

  fill() {
    if (this.eof) return;
    const incoming = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = fs.readSync(this.fd, incoming, 0, incoming.length, null);
    if (!bytesRead) { this.eof = true; return; }
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, incoming.subarray(0, bytesRead)])
      : Buffer.from(incoming.subarray(0, bytesRead));
  }

  line() {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline !== -1) {
        if (newline > MAX_BUNDLE_HEADER_BYTES) throw new Error('uploads bundle header is too large');
        const result = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        return result;
      }
      if (this.buffer.length > MAX_BUNDLE_HEADER_BYTES) throw new Error('uploads bundle header is too large');
      this.fill();
      if (this.eof) throw new Error('uploads bundle ended before its end marker');
    }
  }

  consume(bytes, callback) {
    let remaining = bytes;
    while (remaining > 0) {
      if (!this.buffer.length) this.fill();
      if (!this.buffer.length) throw new Error('uploads bundle file data is truncated');
      const count = Math.min(remaining, this.buffer.length);
      const chunk = this.buffer.subarray(0, count);
      callback(chunk);
      this.buffer = this.buffer.subarray(count);
      remaining -= count;
    }
  }

  hasTrailingData() {
    if (this.buffer.length) return true;
    this.fill();
    return this.buffer.length > 0;
  }

  close() { fs.closeSync(this.fd); }
}

function verifyUploadsBundle(bundleFile, uploadsManifest, extractRoot) {
  if (!uploadsManifest || !Array.isArray(uploadsManifest.files) ||
      !Number.isSafeInteger(uploadsManifest.file_count) || uploadsManifest.file_count < 0 ||
      !Number.isSafeInteger(uploadsManifest.files_size_bytes) || uploadsManifest.files_size_bytes < 0) {
    throw new Error('uploads manifest metadata is invalid');
  }
  if (uploadsManifest.file_count !== uploadsManifest.files.length) {
    throw new Error('uploads manifest file count does not match its inventory');
  }

  const expected = new Map();
  for (const entry of uploadsManifest.files) {
    const relative = normalizeUploadPath(entry && entry.path);
    if (expected.has(relative)) throw new Error(`duplicate path in uploads manifest: ${relative}`);
    if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid uploads manifest entry: ${relative}`);
    }
    expected.set(relative, entry);
  }

  fs.mkdirSync(extractRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(extractRoot, 0o700);
  const resolvedRoot = path.resolve(extractRoot);
  const reader = new BundleReader(bundleFile);
  const seen = new Set();
  let totalBytes = 0;
  try {
    if (reader.line() !== UPLOAD_BUNDLE_MAGIC) throw new Error('uploads bundle format is not recognized');
    while (true) {
      let header;
      try { header = JSON.parse(reader.line()); }
      catch (error) { throw new Error(`uploads bundle has an invalid entry header: ${error.message}`); }
      if (header && header.end === true) break;
      const relative = normalizeUploadPath(header && header.path);
      if (seen.has(relative)) throw new Error(`duplicate path in uploads bundle: ${relative}`);
      const declaration = expected.get(relative);
      if (!declaration) throw new Error(`uploads bundle contains undeclared file: ${relative}`);
      if (!Number.isSafeInteger(header.size_bytes) || header.size_bytes < 0 || header.size_bytes !== declaration.size_bytes) {
        throw new Error(`upload byte count declaration mismatch: ${relative}`);
      }
      const destination = path.resolve(resolvedRoot, ...relative.split('/'));
      if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`unsafe upload extraction path rejected: ${relative}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const out = fs.openSync(destination, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      try {
        reader.consume(header.size_bytes, chunk => {
          hash.update(chunk);
          writeAll(out, chunk);
        });
        fs.fsyncSync(out);
        fs.fchmodSync(out, 0o600);
      } finally {
        fs.closeSync(out);
      }
      const actualSha256 = hash.digest('hex');
      if (actualSha256 !== declaration.sha256) throw new Error(`upload SHA-256 mismatch: ${relative}`);
      seen.add(relative);
      totalBytes += header.size_bytes;
    }
    if (reader.hasTrailingData()) throw new Error('uploads bundle contains trailing data after its end marker');
  } finally {
    reader.close();
  }

  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].find(relative => !seen.has(relative));
    throw new Error(`uploads bundle is missing declared file: ${missing}`);
  }
  if (seen.size !== uploadsManifest.file_count || totalBytes !== uploadsManifest.files_size_bytes) {
    throw new Error('uploads bundle aggregate count or byte total does not match the manifest');
  }
  return { fileCount: seen.size, bytes: totalBytes, extracted: seen.size };
}

const DATABASE_UPLOAD_REFERENCES = [
  { table: 'evidence', column: 'stored_path', sha256: 'sha256', size: 'size_bytes' },
  { table: 'generated_docs', column: 'source_stored_path', sha256: 'source_sha256', size: 'source_size_bytes' },
  { table: 'questionnaire_attachments', column: 'stored_path', sha256: 'sha256', size: 'size_bytes' },
  { table: 'supplier_ddq_evidence', column: 'stored_path', sha256: 'sha256', size: 'size_bytes' },
  { table: 'supplier_documents', column: 'stored_path', sha256: 'sha256', size: 'size_bytes' },
  { table: 'tprm_condition_evidence_links', column: 'stored_path', sha256: 'sha256', size: 'size_bytes' },
];

async function verifyDatabaseUploadReferences(restoredDb, extractRoot) {
  const root = path.resolve(extractRoot);
  let checked = 0;
  let virtual = 0;
  let metadataChecked = 0;
  const missing = [];
  const contentCache = new Map();

  const verifyRow = (reference, row) => {
    const storedPath = String(row.stored_path).trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(storedPath)) { virtual++; return; }
    let relative;
    try { relative = normalizeUploadPath(storedPath); }
    catch (_) {
      missing.push(`${reference.table}#${row.id} has unsafe path ${JSON.stringify(storedPath)}`);
      return;
    }
    const candidates = [];
    if (row.firm_id != null) candidates.push(`firm_${row.firm_id}/${relative}`);
    candidates.push(relative);
    let resolved = null;
    for (const candidate of candidates) {
      let safe;
      try { safe = normalizeUploadPath(candidate); } catch (_) { continue; }
      const possible = path.resolve(root, ...safe.split('/'));
      if (possible.startsWith(`${root}${path.sep}`) && fs.existsSync(possible) && fs.statSync(possible).isFile()) {
        resolved = possible;
        break;
      }
    }
    if (!resolved) {
      missing.push(`${reference.table}#${row.id} -> ${storedPath}`);
      return;
    }

    const hasDeclaredSize = row.declared_size !== null && row.declared_size !== undefined;
    const hasDeclaredSha = row.declared_sha256 !== null && row.declared_sha256 !== undefined && String(row.declared_sha256).trim() !== '';
    if (hasDeclaredSize || hasDeclaredSha) {
      let content = contentCache.get(resolved);
      if (!content) {
        content = { size: fs.statSync(resolved).size, sha256: hashFile(resolved) };
        contentCache.set(resolved, content);
      }
      if (hasDeclaredSize) {
        const declaredSize = Number(row.declared_size);
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || content.size !== declaredSize) {
          missing.push(`${reference.table}#${row.id} byte count mismatch for ${storedPath}`);
          return;
        }
      }
      if (hasDeclaredSha) {
        const declaredSha = String(row.declared_sha256).trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(declaredSha) || content.sha256 !== declaredSha) {
          missing.push(`${reference.table}#${row.id} SHA-256 mismatch for ${storedPath}`);
          return;
        }
      }
      metadataChecked++;
    }
    checked++;
  };

  for (const reference of DATABASE_UPLOAD_REFERENCES) {
    if (!(await tableExists(restoredDb, reference.table))) continue;
    const columns = new Set((await restoredDb.prepare(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?`).all(reference.table)).map(column => column.column_name));
    if (!columns.has(reference.column) || !columns.has('workspace_id')) continue;
    const shaExpression = columns.has(reference.sha256) ? `r."${reference.sha256}"` : 'NULL';
    const sizeExpression = columns.has(reference.size) ? `r."${reference.size}"` : 'NULL';
    const rows = await restoredDb.prepare(`SELECT r.id, r."${reference.column}" AS stored_path,
      ${shaExpression} AS declared_sha256, ${sizeExpression} AS declared_size, w.firm_id
      FROM "${reference.table}" r
      INNER JOIN workspaces w ON w.id=r.workspace_id
      WHERE r."${reference.column}" IS NOT NULL AND trim(r."${reference.column}")<>''
      ORDER BY r.id`).all();
    for (const row of rows) verifyRow(reference, row);
  }

  if (missing.length) {
    const sample = missing.slice(0, 5).join(', ');
    const suffix = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
    throw new Error(`database upload reference missing from recovery snapshot: ${sample}${suffix}`);
  }
  return { checked, virtual, metadataChecked, missing: 0 };
}

function liveDatabaseUrl(options) {
  return options.databaseUrl
    || (options.db && options.db.pool && options.db.pool.options.connectionString)
    || process.env.DATABASE_URL;
}

async function verifyRecoveryGeneration(options = {}) {
  const started = Date.now();
  const backupDir = path.resolve(options.backupDir || DEFAULT_BACKUP_DIR);
  const generation = options.generation || (options.manifest ? null : newestGeneration(backupDir));
  if (!generation && !options.manifest) throw new Error(`no committed recovery generation found in ${backupDir}`);
  const key = options.key || require('./encryption').masterKey();
  const workRoot = path.resolve(options.workRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'isms-verify-')));
  const ownsWorkRoot = !options.workRoot;
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(workRoot, 0o700);
  const restoredDumpPath = path.join(workRoot, 'restored.pgdump');
  const extractedUploadsRoot = path.join(workRoot, 'uploads');
  let scratch = null;
  let restored = null;

  try {
    let manifest = options.manifest || null;
    if (!manifest && generation && generation.manifest) {
      manifest = JSON.parse(fs.readFileSync(generation.manifest, 'utf8'));
    }
    const generationId = manifest && manifest.generation_id || generation && generation.base;
    if (!manifest || manifest.format !== MANIFEST_FORMAT) {
      if (!manifest || (generation && generation.sqliteEra) || SQLITE_ERA_FORMATS.has(manifest.format)) {
        throw sqliteEraError(generationId);
      }
      throw new Error(`recovery manifest format is not recognized: ${JSON.stringify(manifest.format)}`);
    }

    verifyManifestHmac(manifest, key);
    const manifestIntegrity = 'hmac-sha256-verified';
    if (generation && manifest.generation_id !== generation.base) {
      throw new Error(`recovery manifest generation id does not match requested generation ${generation.base}`);
    }
    const generationAge = verifyGenerationAge(manifest, options);
    const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    if (manifest.key_fingerprint_sha256 && manifest.key_fingerprint_sha256 !== fingerprint) {
      throw new Error('escrowed key fingerprint does not match the recovery generation');
    }
    const databaseFile = artifactPath(backupDir,
      manifest.artifacts && manifest.artifacts.database && manifest.artifacts.database.name, DATABASE_ARCHIVE_SUFFIX);
    const uploadsFile = artifactPath(backupDir,
      manifest.artifacts && manifest.artifacts.uploads && manifest.artifacts.uploads.name, '.uploads.enc');
    const databaseArchive = verifyArtifact(databaseFile, manifest.artifacts.database, 'database');
    const uploadsArchive = verifyArtifact(uploadsFile, manifest.artifacts.uploads, 'uploads');

    const decryptedUploads = path.join(workRoot, '.uploads.bundle.partial');
    let uploadsResult;
    try {
      decryptArtifactToFile(uploadsFile, decryptedUploads, key);
      const verifiedUploads = verifyUploadsBundle(decryptedUploads, manifest.uploads, extractedUploadsRoot);
      uploadsResult = {
        status: 'verified',
        archive: uploadsFile,
        archiveSize: uploadsArchive.size,
        archiveSha256: uploadsArchive.sha256,
        fileCount: verifiedUploads.fileCount,
        bytes: verifiedUploads.bytes,
        extracted: verifiedUploads.extracted,
      };
    } finally {
      try { fs.unlinkSync(decryptedUploads); } catch (_) {}
    }

    decryptArtifactToFile(databaseFile, restoredDumpPath, key);
    scratch = await pgTools.createScratchDatabase(liveDatabaseUrl(options), 'restore');
    await pgTools.restoreArchive(scratch.url, restoredDumpPath);
    const { createDatabase: openDatabase } = require('./pg');
    restored = openDatabase(scratch.url, { max: 2, applicationName: 'iso27001-tool:restore-check' });
    await restored.loadCatalog();
    const restoredTables = (await restored.prepare(`SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`).get()).count;

    const restoredCounts = await verifySnapshotCounts(restored, manifest);
    const counts = {};
    for (const table of Object.keys(restoredCounts)) {
      let live = null;
      if (options.db && (await tableExists(options.db, table))) {
        live = (await options.db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).count;
      }
      counts[table] = {
        live,
        restored: restoredCounts[table],
        signed: manifest.database_snapshot_counts[table],
      };
      if (SANITY_TABLES.includes(table) && live !== null && live > restoredCounts[table]) {
        const shortfall = live - restoredCounts[table];
        const allowance = Math.max(LIVE_COUNT_ABSOLUTE_ALLOWANCE, Math.ceil(live * (1 - LIVE_COUNT_MIN_RATIO)));
        if (shortfall > allowance) {
          throw new Error(`live row-count sanity failed on ${table}: restored=${restoredCounts[table]} live=${live} allowance=${allowance}`);
        }
      }
    }
    const databaseUploadReferences = {
      ...(await verifyDatabaseUploadReferences(restored, extractedUploadsRoot)),
      status: 'verified',
    };

    return {
      ok: true,
      generationId,
      file: databaseFile,
      manifest: generation && generation.manifest || null,
      manifestIntegrity,
      generationAge,
      ms: Date.now() - started,
      counts,
      restoredDatabase: restoredDumpPath,
      restoredUploads: extractedUploadsRoot,
      database: {
        status: 'verified',
        archiveSize: databaseArchive.size,
        archiveSha256: databaseArchive.sha256,
        restore: 'pg_restore --single-transaction --exit-on-error into a scratch database',
        tables: restoredTables,
      },
      uploads: uploadsResult,
      databaseUploadReferences,
      fullGenerationVerified: manifestIntegrity === 'hmac-sha256-verified' && uploadsResult.status === 'verified',
    };
  } finally {
    if (restored) await restored.close().catch(() => {});
    if (scratch) {
      await scratch.drop().catch((error) => console.error(`[restore-drill] could not drop scratch database ${scratch.name}:`, error.message));
    }
    if (ownsWorkRoot) {
      try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

async function runDrill(options = {}) {
  const backupDir = path.resolve(options.backupDir || DEFAULT_BACKUP_DIR);
  let generation;
  try {
    generation = options.generationId
      ? generationById(backupDir, options.generationId)
      : newestGeneration(backupDir);
  } catch (error) {
    const db = options.db || require('../db').db;
    try {
      await db.prepare(`INSERT INTO backup_runs (kind, path, status, error, encrypted) VALUES ('restore_drill', ?, 'fail', ?, 1)`)
        .run(options.generationId || backupDir, error.message);
    } catch (_) {}
    return { ok: false, error: error.message, generationId: options.generationId || null };
  }
  const db = options.db || require('../db').db;
  const record = async (status, error, detail) => {
    try {
      const generationPath = generation && (generation.manifest || generation.database) || '(no backup found)';
      const size = generation && generation.database && fs.existsSync(generation.database) ? fs.statSync(generation.database).size : null;
      await db.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, status, error, encrypted) VALUES ('restore_drill', ?, ?, ?, ?, 1)`)
        .run(generationPath, size, status, error || (detail ? JSON.stringify(detail) : null));
    } catch (recordError) { console.error('[restore-drill] could not record verdict:', recordError.message); }
  };
  if (!generation) {
    const error = `no committed recovery generation found in ${backupDir}`;
    await record('fail', error);
    return { ok: false, error };
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isms-restore-drill-'));
  try {
    const result = await verifyRecoveryGeneration({
      ...options,
      backupDir,
      generation,
      db,
      workRoot: temporaryRoot,
    });
    await record('ok', null, {
      ms: result.ms,
      generationId: result.generationId,
      manifestIntegrity: result.manifestIntegrity,
      generationAge: result.generationAge,
      fullGenerationVerified: result.fullGenerationVerified,
      counts: result.counts,
      uploads: { fileCount: result.uploads.fileCount, bytes: result.uploads.bytes,
        databaseReferences: result.databaseUploadReferences },
    });
    return result;
  } catch (error) {
    await record('fail', error.message);
    return { ok: false, error: error.message, generationId: generation.base };
  } finally {
    try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate) {
  let existing = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalParent = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  return path.join(canonicalParent, ...suffix);
}

async function materializeRecovery(options = {}) {
  if (!options.destination) throw new Error('a recovery destination is required');
  const backupDir = path.resolve(options.backupDir || DEFAULT_BACKUP_DIR);
  const requested = path.resolve(options.destination);
  const uploadsDir = path.resolve(process.env.ISMS_UPLOADS_DIR || path.join(__dirname, '..', 'uploads'));
  const keyPath = path.resolve(process.env.ISMS_KEY_FILE || path.join(__dirname, '..', 'data', 'master.key'));
  const protectedPaths = [backupDir, uploadsDir, keyPath];
  const canonicalProtectedPaths = protectedPaths.map(canonicalPath);
  const assertSafeDestination = (candidate, boundaries) => {
    const overlapsCandidate = protectedPath => isInside(protectedPath, candidate) || isInside(candidate, protectedPath);
    if (candidate === path.parse(candidate).root || boundaries.some(overlapsCandidate)) {
      throw new Error('recovery destination overlaps a protected live or backup path');
    }
  };
  assertSafeDestination(requested, protectedPaths);
  if (fs.existsSync(requested) && fs.lstatSync(requested).isSymbolicLink()) {
    throw new Error('recovery destination must be a real directory');
  }
  const parent = path.dirname(requested);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('recovery destination parent must already exist');
  }
  const destination = canonicalPath(requested);
  const realParent = path.dirname(destination);
  assertSafeDestination(destination, canonicalProtectedPaths);
  let destinationExisted = false;
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('recovery destination must be a real directory');
    if (fs.readdirSync(destination).length) throw new Error('recovery destination must be empty');
    destinationExisted = true;
  }
  if (options.restoreInto) {
    const live = process.env.DATABASE_URL;
    if (live && pgTools.sameDatabase(options.restoreInto, live) && options.intoLiveDatabase !== true) {
      throw new Error('the restore target is the live database (DATABASE_URL); pass --into-live-database to restore into it');
    }
    await pgTools.assertEmptyCDatabase(options.restoreInto);
  }
  const stage = fs.mkdtempSync(path.join(realParent, '.nimbus-recovery-partial-'));
  fs.chmodSync(stage, 0o700);
  let removedDestination = false;
  try {
    const generation = options.generationId
      ? generationById(backupDir, options.generationId)
      : newestGeneration(backupDir);
    if (!generation) throw new Error(`no committed recovery generation found in ${backupDir}`);
    const result = await verifyRecoveryGeneration({ ...options, backupDir, generation, workRoot: stage });
    if (!result.fullGenerationVerified) throw new Error('materialized recovery requires a signed DB+uploads generation');
    let restoredInto = null;
    if (options.restoreInto) {
      await pgTools.restoreArchive(options.restoreInto, result.restoredDatabase);
      const target = pgTools.parseDatabaseUrl(options.restoreInto);
      restoredInto = { host: target.host, port: target.port, database: target.database };
    }
    const finalResult = {
      ...result,
      restoredDatabase: path.join(destination, 'restored.pgdump'),
      restoredUploads: path.join(destination, 'uploads'),
      report: path.join(destination, 'recovery-report.json'),
      restoredInto,
      promotionRequired: true,
    };
    fs.writeFileSync(path.join(stage, 'recovery-report.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      generation_id: result.generationId,
      manifest_integrity: result.manifestIntegrity,
      generation_age: result.generationAge,
      database: result.database,
      uploads: result.uploads,
      database_upload_references: result.databaseUploadReferences,
      counts: result.counts,
      restored_database: finalResult.restoredDatabase,
      restored_uploads: finalResult.restoredUploads,
      restored_into: restoredInto,
      promotion_required: true,
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (destinationExisted) {
      fs.rmdirSync(destination);
      removedDestination = true;
    }
    fs.renameSync(stage, destination);
    fs.chmodSync(destination, 0o700);
    return finalResult;
  } catch (error) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
    if (removedDestination && !fs.existsSync(destination)) {
      try { fs.mkdirSync(destination, { mode: 0o700 }); } catch (_) {}
    }
    throw error;
  }
}

async function lastDrill(options = {}) {
  try {
    const db = options.db || require('../db').db;
    return (await db.prepare(`SELECT * FROM backup_runs WHERE kind='restore_drill'
      ORDER BY ran_at DESC NULLS LAST, id DESC LIMIT 1`).get()) || null;
  } catch (_) { return null; }
}

module.exports = {
  runDrill,
  verifyRecoveryGeneration,
  materializeRecovery,
  lastDrill,
  normalizeUploadPath,
  verifyUploadsBundle,
  verifyDatabaseUploadReferences,
  verifyGenerationAge,
  snapshotCounts,
  SNAPSHOT_COUNT_TABLES,
  newestGeneration,
  generationById,
};
