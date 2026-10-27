const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const migrationsDir = __dirname;

const PORTED_FROM_SQLITE = {
  '083_gap_report_and_closure_decisions.js': '049c875ee9b28768887ed1a448b8edadd8b076edd307ea2eb8dc6a26cdf48c9f',
};

const BOOT_LOCK = 'isms:boot-schema';

async function withBootLock(db, fn) {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: db.pool.options.connectionString,
    application_name: 'iso27001-tool:boot-lock',
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [BOOT_LOCK]);
    return await fn();
  } finally {
    await client.end().catch(() => {});
  }
}

function loadJavascriptMigration(file) {
  const migrationPath = path.join(migrationsDir, file);
  delete require.cache[require.resolve(migrationPath)];
  const migration = require(migrationPath);
  if (!migration || typeof migration.up !== 'function') {
    throw new Error(`${file} must export an up(db) function`);
  }
  return migration;
}

async function executeMigration(db, file, source, loadedMigration = null) {
  if (file.endsWith('.sql')) {
    await db.exec(source);
    return;
  }
  const migration = loadedMigration || loadJavascriptMigration(file);
  await migration.up(db);
}

async function applyPending(db, { log = false } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at text DEFAULT utc_now_text(),
    checksum text
  );`);

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d+.*\.(?:sql|js)$/.test(f))
    .sort();

  const applied = new Map(
    (await db.prepare('SELECT id, checksum FROM schema_migrations').all()).map((r) => [r.id, r.checksum])
  );

  const startedNs = process.hrtime.bigint();
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(source).digest('hex');
    if (applied.has(file)) {
      const recorded = applied.get(file);
      if (recorded !== checksum && recorded !== PORTED_FROM_SQLITE[file]) {
        throw new Error(`Migration checksum drift: ${file}. Refusing to start; restore the applied migration and add a new forward migration.`);
      }
      if (log) console.log(`= ${file} (already applied)`);
      continue;
    }
    try {
      const loadedMigration = file.endsWith('.js') ? loadJavascriptMigration(file) : null;
      await db.transaction(async () => {
        await executeMigration(db, file, source, loadedMigration);
        await db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, utc_now_text())')
          .run(file, checksum);
      })();
    } catch (e) {
      throw new Error(`Migration failed: ${file}: ${(e && e.message) || e}`);
    }
    if (log) console.log(`+ ${file} (applied)`);
    count++;
  }
  const ms = Number(process.hrtime.bigint() - startedNs) / 1e6;
  return { applied: count, total: files.length, ms };
}

module.exports = { applyPending, withBootLock, migrationsDir, PORTED_FROM_SQLITE };

if (require.main === module) {
  (async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const { createDatabase } = require('../lib/pg');
    const db = createDatabase(process.env.DATABASE_URL, { max: 2, applicationName: 'iso27001-tool:migrate' });
    try {
      const r = await withBootLock(db, async () => {
        await db.exec(fs.readFileSync(path.join(migrationsDir, 'postgres', 'baseline.sql'), 'utf8'));
        await db.loadCatalog();
        return applyPending(db, { log: true });
      });
      console.log(`\nDone. ${r.applied} migration(s) applied this run; ${r.total} known; ${r.ms.toFixed(0)}ms`);
    } finally {
      await db.close();
    }
  })().catch((e) => { console.error(e.message || e); process.exit(1); });
}
