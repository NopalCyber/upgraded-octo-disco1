'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const { PORTED_FROM_SQLITE } = require('../../migrations/run');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sqliteApp = opt('--sqlite-app');
const adminUrl = opt('--pg');
if (!sqliteApp || !adminUrl) {
  console.error('Usage: node scripts/postgres/boot-parity.js --sqlite-app <path> --pg <admin-url>');
  process.exit(2);
}
const BOOT_TIMESTAMPS = 'created_at,applied_at,updated_at,last_active_at';

const urlFor = (name) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };

function bootSqlite(dbPath, keyPath) {
  execFileSync(process.execPath, ['-e', "require('./db').init()"], {
    cwd: sqliteApp, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DB_PATH: dbPath, ISMS_KEY_FILE: keyPath, ISMS_DISABLE_JOBS: '1' },
  });
}

function bootPostgres(url) {
  const env = { ...process.env, DATABASE_URL: url, ISMS_DISABLE_JOBS: '1' };
  delete env.INITIAL_ADMIN_PASSWORD;
  execFileSync(process.execPath, ['-e', "const c = require('./db'); c.init().finally(() => c.db.close()).catch((e) => { console.error(e); process.exit(1); })"], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
}

function rowKey(row) { return row.id !== undefined ? `id=${row.id}` : JSON.stringify(row); }

function snapshotSqlite(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%'").all()) {
    out[name] = new Map(db.prepare(`SELECT * FROM "${name}"`).all().map((r) => [rowKey(r), r]));
  }
  db.close();
  return out;
}

async function snapshotPostgres(url) {
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const out = {};
  const tables = (await pg.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'search_index%'`)).rows;
  for (const { table_name: t } of tables) {
    const rows = (await pg.query(`SELECT to_jsonb(x) AS r FROM "${t}" x`)).rows.map((r) => r.r);
    out[t] = new Map(rows.map((r) => [rowKey(r), r]));
  }
  await pg.end();
  return out;
}

function diff(before, after) {
  const result = {};
  for (const t of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[t] || new Map(); const b = after[t] || new Map();
    let added = 0, removed = 0, changed = 0; const columns = new Set();
    for (const [k, row] of b) {
      if (!a.has(k)) { added++; continue; }
      const old = a.get(k); let rowChanged = false;
      for (const c of Object.keys(row)) {
        if (String(old[c]) !== String(row[c])) { columns.add(c); rowChanged = true; }
      }
      if (rowChanged) changed++;
    }
    for (const k of a.keys()) if (!b.has(k)) removed++;
    if (added || removed || changed) result[t] = { added, removed, changed, columns: [...columns].sort() };
  }
  return result;
}

function compareRows(sqlitePath, url, label) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'compare-rows.js'), '--sqlite', sqlitePath, '--pg', url,
    '--boot-timestamps', BOOT_TIMESTAMPS, '--ignore-columns', 'schema_migrations.checksum', '--sequences'], { encoding: 'utf8' });
  console.log(`\n== ${label}: compare-rows (exit ${r.status})`);
  process.stdout.write(r.stdout.split('\n').map((l) => (l ? `   ${l}` : l)).join('\n'));
  if (r.stderr) process.stdout.write(r.stderr);
  return r.status === 0;
}

function checkLedger(sqlitePath, ledgerRows) {
  const lite = new Database(sqlitePath, { readonly: true });
  const sqliteLedger = new Map(lite.prepare('SELECT id, checksum FROM schema_migrations').all().map((r) => [r.id, r.checksum]));
  lite.close();
  let ok = true;
  for (const [id, checksum] of ledgerRows) {
    const file = path.join(ROOT, 'migrations', id);
    const current = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
    const sqliteChecksum = sqliteLedger.get(id);
    const expectedSqlite = PORTED_FROM_SQLITE[id] || current;
    const good = checksum === current && sqliteChecksum === expectedSqlite;
    ok = ok && good;
    console.log(`   ledger ${id}: postgres ${checksum.slice(0, 12)}… (current file), sqlite ${String(sqliteChecksum).slice(0, 12)}…` +
      `${PORTED_FROM_SQLITE[id] ? ' (SQLite implementation, accepted as the same migration)' : ''} ${good ? 'ok' : 'MISMATCH'}`);
  }
  if (sqliteLedger.size !== ledgerRows.size) { ok = false; console.log('   ledger row counts differ'); }
  return ok;
}

const show = (d) => (Object.keys(d).length
  ? Object.entries(d).map(([t, v]) => `   ${t}: ${v.changed} changed${v.added ? `, ${v.added} added` : ''}${v.removed ? `, ${v.removed} removed` : ''} [${v.columns.join(', ')}]`).join('\n')
  : '   (no changes)');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-parity-'));
  const sqlitePath = path.join(tmp, 'sqlite.db');
  const keyPath = path.join(tmp, 'master.key');
  const name = `isms_parity_${crypto.randomBytes(4).toString('hex')}`;
  const url = urlFor(name);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`);
  let ok = true;
  try {
    console.log(`SQLite app: ${sqliteApp}\nSQLite database: ${sqlitePath}\nPostgreSQL database: ${name}`);
    bootSqlite(sqlitePath, keyPath);
    bootPostgres(url);
    ok = compareRows(sqlitePath, url, 'boot 1') && ok;
    const pgLedger = new Client({ connectionString: url }); await pgLedger.connect();
    const ledger = new Map((await pgLedger.query('SELECT id, checksum FROM schema_migrations')).rows.map((r) => [r.id, r.checksum]));
    await pgLedger.end();
    ok = checkLedger(sqlitePath, ledger) && ok;

    const s1 = snapshotSqlite(sqlitePath); const p1 = await snapshotPostgres(url);
    bootSqlite(sqlitePath, keyPath);
    bootPostgres(url);
    const s2 = snapshotSqlite(sqlitePath); const p2 = await snapshotPostgres(url);
    const sqliteSecond = diff(s1, s2); const pgSecond = diff(p1, p2);
    console.log('\n== boot 2: rows the second boot changed, SQLite');
    console.log(show(sqliteSecond));
    console.log('== boot 2: rows the second boot changed, PostgreSQL');
    console.log(show(pgSecond));
    const same = JSON.stringify(sqliteSecond) === JSON.stringify(pgSecond);
    console.log(`   same changes on both sides: ${same ? 'yes' : 'NO'}`);
    ok = same && ok;
    ok = compareRows(sqlitePath, url, 'boot 2') && ok;

    bootPostgres(url);
    const p3 = await snapshotPostgres(url);
    const third = diff(p2, p3);
    console.log('\n== boot 3: rows the third boot changed, PostgreSQL (exact values, timestamps included)');
    console.log(show(third));
    ok = Object.keys(third).length === 0 && ok;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nGate A: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
