'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const enc = require('./encryption');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.resolve(process.env.ISMS_BACKUP_DIR || path.join(ROOT, 'data', 'backups'));
const UPLOADS_DIR = path.resolve(process.env.ISMS_UPLOADS_DIR || path.join(ROOT, 'uploads'));
const RETAIN = positiveInteger(process.env.ISMS_BACKUP_RETAIN, 14);
const LOCK_STALE_MS = positiveInteger(process.env.ISMS_BACKUP_LOCK_STALE_MIN, 360) * 60_000;
const LOCK_PATH = path.join(BACKUP_DIR, '.backup.lock');
const UPLOAD_BUNDLE_MAGIC = 'NIMBUS-UPLOADS-V1\n';
const MANIFEST_FORMAT = 'nimbus-recovery-generation-v3';
const MANIFEST_HMAC_DOMAIN = 'nimbus-recovery-manifest-v3\0';
const DATABASE_ARCHIVE_SUFFIX = '.pgdump.enc';
const DATABASE_ARCHIVE_FORMAT = 'nimbus-pgdump-custom-aes256gcm-v1';
const GENERATION_ARCHIVE = /^isms-.*\.pgdump\.enc$/;

function positiveInteger(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const TOOL_ENV = { pg_dump: 'PG_DUMP', pg_restore: 'PG_RESTORE' };

function toolPath(tool) {
  return process.env[TOOL_ENV[tool]] || tool;
}

function toolAvailable(tool) {
  const result = spawnSync(toolPath(tool), ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

const URL_PARAMETER_ENV = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  sslcrl: 'PGSSLCRL',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  application_name: 'PGAPPNAME',
  host: 'PGHOST',
  port: 'PGPORT',
};

function parseDatabaseUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch (_) { throw new Error('database URL is not a valid postgres:// URL'); }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('database URL must start with postgres:// or postgresql://');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('database URL names no database');
  const env = {
    PGHOST: decodeURIComponent(parsed.hostname).replace(/^\[(.*)\]$/, '$1') || 'localhost',
    PGPORT: parsed.port || '5432',
    PGDATABASE: database,
  };
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  for (const [name, value] of parsed.searchParams) {
    if (URL_PARAMETER_ENV[name]) env[URL_PARAMETER_ENV[name]] = value;
  }
  return { host: env.PGHOST.toLowerCase(), port: env.PGPORT, database, env };
}

function databaseUrlFor(url, database) {
  const parsed = new URL(String(url));
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

function sameDatabase(a, b) {
  const x = parseDatabaseUrl(a);
  const y = parseDatabaseUrl(b);
  const host = (value) => (['localhost', '127.0.0.1', '::1'].includes(value) ? 'loopback' : value);
  return host(x.host) === host(y.host) && x.port === y.port && x.database === y.database;
}

function childEnv(url) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^PG[A-Z]/.test(name)) env[name] = value;
  return { ...env, ...parseDatabaseUrl(url).env };
}

function conninfoDatabase(name) {
  return `dbname='${String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function spawnTool(tool, args, url) {
  const binary = toolPath(tool);
  const child = spawn(binary, args, { env: childEnv(url), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(
      `${tool} could not start (${binary}): ${error.message}. Install the PostgreSQL 16 client or set ${TOOL_ENV[tool]}.`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool} failed (${signal || `exit ${code}`}): ${stderr.trim().slice(-2000) || 'no output'}`));
    });
  });
  return { child, done };
}

async function settle(toolSteps, streamSteps) {
  const results = await Promise.allSettled([...toolSteps, ...streamSteps]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function encryptStreamToFile(source, target, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeSync(fd, iv);
    fs.writeSync(fd, Buffer.alloc(16));
    await pipeline(source, cipher, fs.createWriteStream(null, { fd, autoClose: false, start: 28 }));
    fs.writeSync(fd, cipher.getAuthTag(), 0, 16, 12);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

function dumpArgs(snapshot) {
  const args = ['--format=custom'];
  if (snapshot) args.push(`--snapshot=${snapshot}`);
  return args;
}

function restoreArgs(url) {
  return ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
    `--dbname=${conninfoDatabase(parseDatabaseUrl(url).database)}`];
}

async function dumpDatabaseEncrypted(url, target, key, { snapshot } = {}) {
  const dump = spawnTool('pg_dump', dumpArgs(snapshot), url);
  dump.child.stdin.end();
  await settle([dump.done], [encryptStreamToFile(dump.child.stdout, target, key)]);
}

async function restoreArchive(url, source) {
  const restore = spawnTool('pg_restore', restoreArgs(url), url);
  const input = typeof source === 'string' ? fs.createReadStream(source) : source;
  await settle([restore.done], [pipeline(input, restore.child.stdin)]);
}

async function copyDatabase(sourceUrl, targetUrl, { snapshot } = {}) {
  const dump = spawnTool('pg_dump', dumpArgs(snapshot), sourceUrl);
  dump.child.stdin.end();
  const restore = spawnTool('pg_restore', restoreArgs(targetUrl), targetUrl);
  await settle([dump.done, restore.done], [pipeline(dump.child.stdout, restore.child.stdin)]);
}

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

function scratchAdminUrl(fallbackUrl) {
  const url = process.env.ISMS_RESTORE_ADMIN_URL || fallbackUrl || process.env.DATABASE_URL;
  if (!url) throw new Error('no database URL for scratch databases (set DATABASE_URL or ISMS_RESTORE_ADMIN_URL)');
  return url;
}

async function withClient(url, fn) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, application_name: 'iso27001-tool:recovery' });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

async function createDatabase(adminUrl, name) {
  await withClient(adminUrl, async (client) => {
    try {
      await client.query(`CREATE DATABASE ${ident(name)} TEMPLATE template0 ENCODING 'UTF8'
        LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`);
    } catch (error) {
      if (error.code === '42501') {
        throw new Error(`cannot create database ${name}: the role needs CREATEDB (or set ISMS_RESTORE_ADMIN_URL)`);
      }
      throw error;
    }
  });
  return databaseUrlFor(adminUrl, name);
}

async function dropDatabase(adminUrl, name) {
  await withClient(adminUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
}

async function createScratchDatabase(liveUrl, label = 'restore') {
  const adminUrl = scratchAdminUrl(liveUrl);
  const name = `isms_${label}_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;
  const url = await createDatabase(adminUrl, name);
  return { name, url, drop: () => dropDatabase(adminUrl, name) };
}

async function assertEmptyCDatabase(url) {
  await withClient(url, async (client) => {
    const info = (await client.query(`SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()`)).rows[0];
    const isC = (value) => value === 'C' || value === 'POSIX';
    if (!info || !isC(info.datcollate) || !isC(info.datctype)) {
      throw new Error('restore target must use the C collation: createdb --template=template0 --encoding=UTF8 --lc-collate=C --lc-ctype=C <name>');
    }
    const { count } = (await client.query(`SELECT count(*)::int AS count FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`)).rows[0];
    if (count > 0) throw new Error(`restore target database is not empty (${count} relations); restore into a new database`);
  });
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  fs.chmodSync(dir, 0o700);
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function acquireLock(retryStale = true) {
  ensurePrivateDir(BACKUP_DIR);
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
    const token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }), { encoding: 'utf8' });
    fs.fchmodSync(fd, 0o600);
    return { fd, token };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try { stale = Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS; } catch (_) {}
    if (stale && retryStale) {
      fs.unlinkSync(LOCK_PATH);
      return acquireLock(false);
    }
    throw new Error(`backup already running (lock: ${LOCK_PATH})`);
  }
}

function releaseLock(lock) {
  if (!lock || lock.fd === undefined || !lock.token) return;
  try { fs.closeSync(lock.fd); } catch (_) {}
  try {
    const current = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (current.token === lock.token) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
}

async function recordFailure(database, target, error) {
  try {
    await database.prepare(`INSERT INTO backup_runs (kind, path, status, error) VALUES ('full', ?, 'fail', ?)`)
      .run(target || BACKUP_DIR, String(error && error.message || error).slice(0, 4000));
  } catch (recordError) {
    console.error('[backup] could not record failure:', recordError.message);
  }
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.partial-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate, seen = new Set()) {
  const absolute = path.resolve(candidate);
  if (seen.has(absolute)) throw new Error(`symbolic-link loop in recovery path: ${absolute}`);
  seen.add(absolute);
  let existing = absolute;
  const suffix = [];
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(existing), fs.readlinkSync(existing));
        return canonicalPath(path.join(target, ...suffix), seen);
      }
      return path.join(fs.realpathSync(existing), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return path.join(existing, ...suffix);
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function assertSafeSourceLayout() {
  const uploads = canonicalPath(UPLOADS_DIR);
  const backup = canonicalPath(BACKUP_DIR);
  if (isInside(uploads, backup)) {
    throw new Error('ISMS_BACKUP_DIR must not be inside ISMS_UPLOADS_DIR');
  }
  const mirror = process.env.BACKUP_MIRROR_DIR && path.resolve(process.env.BACKUP_MIRROR_DIR);
  if (mirror) {
    const canonicalMirror = canonicalPath(mirror);
    if (isInside(uploads, canonicalMirror)) {
      throw new Error('BACKUP_MIRROR_DIR must not be inside ISMS_UPLOADS_DIR');
    }
    if (isInside(backup, canonicalMirror) || isInside(canonicalMirror, backup)) {
      throw new Error('BACKUP_MIRROR_DIR must not overlap ISMS_BACKUP_DIR');
    }
  }
  const keyFile = path.resolve(process.env.ISMS_KEY_FILE || path.join(ROOT, 'data', 'master.key'));
  if (isInside(uploads, canonicalPath(keyFile))) {
    throw new Error('ISMS_UPLOADS_DIR includes the encryption key; refusing to archive it');
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function unsignedManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  if (copy.integrity) delete copy.integrity.manifest_hmac_sha256;
  return copy;
}

function signManifest(manifest, key) {
  return crypto.createHmac('sha256', key)
    .update(MANIFEST_HMAC_DOMAIN)
    .update(canonicalJson(unsignedManifest(manifest)))
    .digest('hex');
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
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

function uploadDescriptors() {
  if (!fs.existsSync(UPLOADS_DIR)) return { sourcePresent: false, files: [] };
  const rootStat = fs.lstatSync(UPLOADS_DIR);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('ISMS_UPLOADS_DIR must be a real directory, not a symlink');
  }
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`uploads snapshot refuses symbolic link: ${relative}`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push({ absolute, path: relative, size: stat.size, dev: stat.dev, ino: stat.ino });
      else throw new Error(`uploads snapshot refuses non-regular entry: ${relative}`);
    }
  };
  visit(UPLOADS_DIR, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sourcePresent: true, files };
}

async function* uploadBundleSource(descriptors, entries) {
  yield Buffer.from(UPLOAD_BUNDLE_MAGIC, 'utf8');
  for (const descriptor of descriptors) {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(descriptor.absolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== descriptor.dev || opened.ino !== descriptor.ino || opened.size !== descriptor.size) {
      fs.closeSync(fd);
      throw new Error(`upload changed while snapshot was starting: ${descriptor.path}`);
    }
    yield Buffer.from(JSON.stringify({ path: descriptor.path, size_bytes: descriptor.size }) + '\n', 'utf8');
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = fs.createReadStream(null, { fd, autoClose: true });
    for await (const chunk of stream) {
      bytes += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== descriptor.size) throw new Error(`upload changed while snapshot was running: ${descriptor.path}`);
    entries.push({ path: descriptor.path, size_bytes: bytes, sha256: hash.digest('hex') });
  }
  yield Buffer.from('{"end":true}\n', 'utf8');
}

async function writeEncryptedUploadsArchive(target, descriptors, key) {
  const entries = [];
  await encryptStreamToFile(Readable.from(uploadBundleSource(descriptors, entries)), target, key);
  return entries;
}

function mirrorArtifacts(files) {
  const configured = process.env.BACKUP_MIRROR_DIR;
  if (!configured) return [];
  const dir = path.resolve(configured);
  if (dir === BACKUP_DIR) throw new Error('BACKUP_MIRROR_DIR must be separate from ISMS_BACKUP_DIR');
  ensurePrivateDir(dir);
  const mirrored = [];
  try {
    for (const source of files) {
      const target = path.join(dir, path.basename(source));
      const temporary = `${target}.partial-${process.pid}`;
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      mirrored.push(target);
    }
  } catch (error) {
    for (const target of mirrored) {
      try { fs.unlinkSync(target); } catch (_) {}
    }
    throw error;
  }
  rotateDirectory(dir);
  return mirrored;
}

function rotateDirectory(dir = BACKUP_DIR) {
  ensurePrivateDir(dir);
  const backups = fs.readdirSync(dir)
    .filter(name => GENERATION_ARCHIVE.test(name))
    .filter(name => fs.existsSync(path.join(dir, name.replace(/\.pgdump\.enc$/, '.manifest.json'))))
    .sort();
  while (backups.length > RETAIN) {
    const backupName = backups.shift();
    const base = backupName.replace(/\.pgdump\.enc$/, '');
    for (const name of [backupName, `${base}.uploads.enc`, `${base}.manifest.json`]) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function clientStatements(client) {
  const { compile, bind } = require('./pg/sql');
  return {
    prepare(sql) {
      const compiled = compile(sql);
      const run = async (args) => (await client.query(compiled.text, bind(compiled, args))).rows;
      return {
        get: async (...args) => (await run(args))[0],
        all: async (...args) => await run(args),
      };
    },
  };
}

async function latestMigration(database) {
  const ledger = await database.prepare(`SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`).get();
  if (!ledger) return null;
  const row = await database.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
  return row ? row.id : null;
}

async function runBackup(options = {}) {
  const database = options.db || require('../db').db;
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL || database.pool.options.connectionString;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `isms-${stamp}`;
  const partialDbArchive = path.join(BACKUP_DIR, `.${base}.pgdump.partial-${process.pid}`);
  const partialUploadsArchive = path.join(BACKUP_DIR, `.${base}.uploads.partial-${process.pid}`);
  const databasePath = path.join(BACKUP_DIR, `${base}${DATABASE_ARCHIVE_SUFFIX}`);
  const uploadsPath = path.join(BACKUP_DIR, `${base}.uploads.enc`);
  const manifestPath = path.join(BACKUP_DIR, `${base}.manifest.json`);
  let lock;
  let committed = false;
  let snapshotClient = null;

  try {
    assertSafeSourceLayout();
    lock = acquireLock();
    const source = parseDatabaseUrl(databaseUrl);
    const key = enc.masterKey();
    const recovery = require('./restore-check');

    require('./pg');
    const { Client } = require('pg');
    snapshotClient = new Client({ connectionString: databaseUrl, application_name: 'iso27001-tool:backup' });
    await snapshotClient.connect();
    await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshotId = (await snapshotClient.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const view = clientStatements(snapshotClient);
    const snapshot = {
      counts: await recovery.snapshotCounts(view),
      serverVersion: (await snapshotClient.query('SHOW server_version')).rows[0].server_version,
      migration: await latestMigration(view),
    };
    await dumpDatabaseEncrypted(databaseUrl, partialDbArchive, key, { snapshot: snapshotId });
    await snapshotClient.query('COMMIT');
    await snapshotClient.end();
    snapshotClient = null;

    const uploadScan = uploadDescriptors();
    const uploadEntries = await writeEncryptedUploadsArchive(partialUploadsArchive, uploadScan.files, key);

    fs.renameSync(partialDbArchive, databasePath);
    fs.chmodSync(databasePath, 0o600);
    fs.renameSync(partialUploadsArchive, uploadsPath);
    fs.chmodSync(uploadsPath, 0o600);

    const databaseSize = fs.statSync(databasePath).size;
    const uploadsArchiveSize = fs.statSync(uploadsPath).size;
    const databaseSha256 = hashFile(databasePath);
    const uploadsArchiveSha256 = hashFile(uploadsPath);
    const uploadBytes = uploadEntries.reduce((sum, entry) => sum + entry.size_bytes, 0);
    const createdAt = new Date().toISOString();
    const manifest = {
      format: MANIFEST_FORMAT,
      generation_id: base,
      created_at: createdAt,
      source_database: source.database,
      archive: path.basename(databasePath),
      size_bytes: databaseSize,
      sha256: databaseSha256,
      encrypted: true,
      database_engine: 'postgresql',
      postgres: {
        server_version: snapshot.serverVersion,
        dump_format: 'custom',
        snapshot: 'repeatable read, exported to pg_dump',
      },
      schema_latest_migration: snapshot.migration,
      database_snapshot_counts: snapshot.counts,
      key_included: false,
      key_escrow_required: true,
      key_fingerprint_sha256: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
      artifacts: {
        database: {
          name: path.basename(databasePath),
          format: DATABASE_ARCHIVE_FORMAT,
          size_bytes: databaseSize,
          sha256: databaseSha256,
        },
        uploads: {
          name: path.basename(uploadsPath),
          format: 'nimbus-uploads-framed-aes256gcm-v1',
          size_bytes: uploadsArchiveSize,
          sha256: uploadsArchiveSha256,
        },
      },
      uploads: {
        source_present: uploadScan.sourcePresent,
        archive: path.basename(uploadsPath),
        archive_size_bytes: uploadsArchiveSize,
        archive_sha256: uploadsArchiveSha256,
        file_count: uploadEntries.length,
        files_size_bytes: uploadBytes,
        files: uploadEntries,
      },
      integrity: {
        algorithm: 'hmac-sha256',
        domain: 'nimbus-recovery-manifest-v3',
      },
    };
    manifest.integrity.manifest_hmac_sha256 = signManifest(manifest, key);

    const precommit = await recovery.verifyRecoveryGeneration({
      backupDir: BACKUP_DIR,
      manifest,
      key,
      db: database,
      databaseUrl,
      allowStaleGeneration: true,
    });
    if (!precommit.fullGenerationVerified) {
      throw new Error('pre-commit recovery verification did not prove a full signed generation');
    }
    writeJsonAtomic(manifestPath, manifest);
    committed = true;

    const mirrored = mirrorArtifacts([databasePath, uploadsPath, manifestPath]);
    const generationSize = databaseSize + uploadsArchiveSize + fs.statSync(manifestPath).size;
    await database.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, sha256, encrypted, status)
      VALUES ('full', ?, ?, ?, 1, 'ok')`).run(manifestPath, generationSize, databaseSha256);
    rotateDirectory();
    return {
      ok: true,
      generationId: base,
      path: databasePath,
      database: databasePath,
      uploads: uploadsPath,
      manifest: manifestPath,
      artifacts: [databasePath, uploadsPath, manifestPath],
      mirrored,
      size: generationSize,
      databaseSize,
      uploadsArchiveSize,
      uploadCount: uploadEntries.length,
      uploadBytes,
      sha256: databaseSha256,
      uploadsSha256: uploadsArchiveSha256,
      manifestHmac: manifest.integrity.manifest_hmac_sha256,
      precommitVerified: true,
      keyIncluded: false,
    };
  } catch (error) {
    if (snapshotClient) await snapshotClient.end().catch(() => {});
    for (const file of [partialDbArchive, partialUploadsArchive]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
    if (!committed) {
      for (const file of [databasePath, uploadsPath, manifestPath]) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
    await recordFailure(database, manifestPath, error);
    return { ok: false, error: error.message };
  } finally {
    releaseLock(lock);
  }
}

function listBackups() {
  ensurePrivateDir(BACKUP_DIR);
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => GENERATION_ARCHIVE.test(name))
    .filter(name => fs.existsSync(path.join(BACKUP_DIR, name.replace(/\.pgdump\.enc$/, '.manifest.json'))))
    .map(name => {
      const file = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(file);
      const manifestPath = path.join(BACKUP_DIR, name.replace(/\.pgdump\.enc$/, '.manifest.json'));
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
      const uploadsPath = path.join(BACKUP_DIR, name.replace(/\.pgdump\.enc$/, '.uploads.enc'));
      return {
        name,
        path: file,
        size: stat.size,
        mtime: stat.mtime,
        generationId: manifest && manifest.generation_id || name.replace(/\.pgdump\.enc$/, ''),
        format: manifest && manifest.format || 'unknown',
        complete: Boolean(manifest && manifest.format === MANIFEST_FORMAT && fs.existsSync(uploadsPath)),
        uploadCount: manifest && manifest.uploads ? manifest.uploads.file_count : null,
        uploadBytes: manifest && manifest.uploads ? manifest.uploads.files_size_bytes : null,
        manifest: manifestPath,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = {
  runBackup,
  listBackups,
  BACKUP_DIR,
  UPLOADS_DIR,
  acquireLock,
  releaseLock,
  canonicalJson,
  signManifest,
  MANIFEST_FORMAT,
  MANIFEST_HMAC_DOMAIN,
  UPLOAD_BUNDLE_MAGIC,
  DATABASE_ARCHIVE_SUFFIX,
  DATABASE_ARCHIVE_FORMAT,
  pgTools: {
    toolPath,
    toolAvailable,
    parseDatabaseUrl,
    databaseUrlFor,
    sameDatabase,
    restoreArchive,
    copyDatabase,
    createDatabase,
    dropDatabase,
    createScratchDatabase,
    scratchAdminUrl,
    assertEmptyCDatabase,
  },
};
