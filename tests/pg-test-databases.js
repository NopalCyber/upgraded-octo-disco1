'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pg = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOCK = 'isms:test-databases';
const SUITE = /^isms_test_([a-z0-9]+)_(\d+)_[0-9a-f]+$/;
const TEMPLATE = /^isms_tpl_[0-9a-f]+$/;
const STALE_MS = 60 * 60 * 1000;

function adminUrl() {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    throw new Error('PG_TEST_URL is not set. Point it at a PostgreSQL 16 server with a role that can create databases, ' +
      'for example postgres://postgres:<password>@127.0.0.1:55500/postgres');
  }
  return url;
}

function databaseUrl(name) {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

function runId() {
  const id = String(process.env.ISMS_TEST_RUN_ID || 'adhoc').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return id || 'adhoc';
}

function codeVersion() {
  const list = (dir, pattern) => fs.readdirSync(path.join(PROJECT_ROOT, dir))
    .filter((name) => pattern.test(name)).sort().map((name) => path.join(dir, name));
  const files = [
    'migrations/postgres/baseline.sql',
    'db.js',
    'lib/template-refs.js',
    ...list('data', /\.(?:js|json)$/),
    ...list('migrations', /\.(?:js|sql)$/),
    ...list('lib/pg', /\.js$/),
  ];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(PROJECT_ROOT, file))).update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

async function withAdmin(fn) {
  const admin = new pg.Client({ connectionString: adminUrl(), application_name: 'isms-test-admin' });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end().catch(() => {});
  }
}

async function withLock(admin, fn) {
  await admin.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK]);
  try {
    return await fn();
  } finally {
    await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]).catch(() => {});
  }
}

async function dropDatabase(admin, name) {
  await admin.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE false`).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
}

async function listDatabases(admin) {
  return (await admin.query(`SELECT datname, datistemplate, shobj_description(oid, 'pg_database') AS note
    FROM pg_database ORDER BY datname`)).rows;
}

async function dropStaleSuites(admin, now = Date.now()) {
  let dropped = 0;
  for (const { datname } of await listDatabases(admin)) {
    const m = SUITE.exec(datname);
    if (m && now - Number(m[2]) * 1000 > STALE_MS) { await dropDatabase(admin, datname); dropped++; }
  }
  return dropped;
}

async function dropOldTemplates(admin, keep, now = Date.now()) {
  for (const { datname, note } of await listDatabases(admin)) {
    if (datname === keep || !TEMPLATE.test(datname)) continue;
    const built = /built (\d+)/.exec(note || '');
    if (!built || now - Number(built[1]) * 1000 > STALE_MS) await dropDatabase(admin, datname);
  }
}

function runInit(url) {
  const env = { ...process.env, DATABASE_URL: url, ISMS_DISABLE_JOBS: '1', PG_POOL_MAX: '4' };
  delete env.INITIAL_ADMIN_PASSWORD;
  delete env.INITIAL_ADMIN_EMAIL;
  delete env.INITIAL_ADMIN_NAME;
  const script = "const core = require('./db'); core.init().finally(() => core.db.close()).catch((e) => { console.error(e && e.stack || e); process.exit(1); });";
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], { cwd: PROJECT_ROOT, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`building the test template failed:\n${stdout}${stderr}`));
      else resolve();
    });
  });
}

async function ensureTemplate(admin) {
  const name = `isms_tpl_${codeVersion()}`;
  const existing = (await admin.query('SELECT datistemplate FROM pg_database WHERE datname = $1', [name])).rows[0];
  if (existing && existing.datistemplate) return name;
  if (existing) await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${ident(name)} TEMPLATE template0 ENCODING 'UTF8'
    LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`);
  try {
    await runInit(databaseUrl(name));
  } catch (error) {
    await dropDatabase(admin, name).catch(() => {});
    throw error;
  }
  await admin.query(`ALTER DATABASE ${ident(name)} WITH ALLOW_CONNECTIONS false`);
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
  await admin.query(`COMMENT ON DATABASE ${ident(name)} IS 'isms test template, built ${Math.floor(Date.now() / 1000)}'`);
  await admin.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE true`);
  await dropOldTemplates(admin, name);
  return name;
}

let staleDropped = false;

async function createSuiteDatabase() {
  return await withAdmin(async admin => await withLock(admin, async () => {
    if (!staleDropped) { await dropStaleSuites(admin); staleDropped = true; }
    const template = await ensureTemplate(admin);
    const name = `isms_test_${runId()}_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(template)}`);
    return { name, url: databaseUrl(name), template };
  }));
}

async function dropRunDatabases(id) {
  return await withAdmin(async admin => await withLock(admin, async () => {
    let dropped = 0;
    for (const { datname } of await listDatabases(admin)) {
      const m = SUITE.exec(datname);
      if (m && m[1] === id) { await dropDatabase(admin, datname); dropped++; }
    }
    return dropped;
  }));
}

async function openTestDb(dbUrl) {
  const { createDatabase } = require('../lib/pg');
  const db = createDatabase(dbUrl, { max: 2, applicationName: 'isms-test' });
  await db.loadCatalog();
  return db;
}

module.exports = {
  createSuiteDatabase, dropRunDatabases, dropStaleSuites, openTestDb, codeVersion, databaseUrl, runId,
};

if (require.main === module) {
  const [command, id] = process.argv.slice(2);
  if (command !== 'drop-run' || !id) {
    console.error('Usage: node tests/pg-test-databases.js drop-run <run-id>');
    process.exit(2);
  }
  dropRunDatabases(String(id).toLowerCase()).then((n) => {
    console.log(`[test] dropped ${n} suite database(s) of run ${id}`);
  }, (error) => { console.error(`[test] could not drop suite databases: ${error.message}`); process.exit(1); });
}
