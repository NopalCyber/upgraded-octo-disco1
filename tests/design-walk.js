const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const bcrypt = require('bcrypt');
const { createSuiteDatabase, openTestDb } = require('./pg-test-databases');
const { pgTools } = require('../lib/backup');

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(__dirname, 'design-shots');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-design-'));
const KEY_FILE = path.join(TMP, 'master.key');
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TEST_PASSWORD = crypto.randomBytes(32).toString('base64url');

fs.mkdirSync(SHOT_DIR, { recursive: true });

let suiteDb = null;
let serverProc = null;
let browser = null;

function log(...a) { console.log('[design-walk]', ...a); }

async function buildDatabase() {
  suiteDb = await createSuiteDatabase();
  log('Building a seeded database', suiteDb.name);
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-test-db.js'), suiteDb.url],
    { env: { ...process.env, ISMS_KEY_FILE: KEY_FILE }, stdio: ['ignore', 'ignore', 'pipe'] });
  if (build.status !== 0) throw new Error('build-test-db failed:\n' + build.stderr);
}

async function prepareTestManager() {
  const db = await openTestDb(suiteDb.url);
  try {
    const manager = await db.prepare(`SELECT u.id, u.email, u.firm_id
      FROM users u
      JOIN workspaces w ON w.firm_id=u.firm_id
      WHERE u.active=1 AND u.user_type='firm' AND u.firm_role='manager'
      GROUP BY u.id, u.email, u.firm_id
      ORDER BY u.id LIMIT 1`).get();
    if (!manager) throw new Error('No active Manager with a workspace exists in the seeded database.');
    await db.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(bcrypt.hashSync(TEST_PASSWORD, 10), manager.id);
    const ws = await db.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(manager.firm_id);
    return { manager, wsId: ws.id };
  } finally {
    await db.close();
  }
}

async function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), NODE_ENV: 'test', DATABASE_URL: suiteDb.url,
      ISMS_KEY_FILE: KEY_FILE, ISMS_BACKUP_DIR: path.join(TMP, 'backups'), ISMS_DISABLE_JOBS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc = proc;
  let buf = '';
  proc.stdout.on('data', d => buf += d.toString());
  proc.stderr.on('data', d => buf += d.toString());
  const ready = await new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 15000);
    const i = setInterval(() => { if (buf.includes('running at')) { clearTimeout(t); clearInterval(i); resolve(true); } }, 200);
  });
  if (!ready) throw new Error('Server did not start. Output:\n' + buf);
  log('Server up.');
  return proc;
}

async function authenticate(page, manager) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.type('input[name="email"]', manager.email);
  await page.type('input[name="password"]', TEST_PASSWORD);
  await page.$eval('form.auth-form', form => form.requestSubmit());
  await page.waitForSelector('form[action="/logout"], button[aria-label="Sign out"]', { timeout: 20000 });
  log('Signed in as', manager.email);
}

let cleaning = null;
function cleanup() {
  if (!cleaning) cleaning = releaseResources();
  return cleaning;
}

async function releaseResources() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
  if (serverProc) {
    const proc = serverProc;
    serverProc = null;
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 10000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.kill();
      });
    }
  }
  if (suiteDb) {
    const { name } = suiteDb;
    suiteDb = null;
    try { await pgTools.dropDatabase(process.env.PG_TEST_URL, name); }
    catch (error) { console.error(`[design-walk] could not drop ${name}: ${error.message}`); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

let interrupted = false;
process.once('SIGINT', () => { interrupted = true; cleanup().finally(() => process.exit(130)); });

(async () => {
  await buildDatabase();
  const { manager, wsId } = await prepareTestManager();
  await startServer();

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    handleSIGINT: false,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await authenticate(page, manager);

  const routes = [
    ['dashboard', '/dashboard'],
    ['workspace-overview', `/workspaces/${wsId}`],
    ['readiness', `/workspaces/${wsId}/readiness`],
    ['gap-assessment', `/workspaces/${wsId}/gap-assessment`],
    ['controls', `/workspaces/${wsId}/controls`],
    ['controls-assess', `/workspaces/${wsId}/controls/assess`],
    ['risks', `/workspaces/${wsId}/risks`],
    ['soa', `/workspaces/${wsId}/soa`],
    ['evidence', `/workspaces/${wsId}/evidence`],
    ['documents', `/workspaces/${wsId}/documents`],
    ['interested-parties', `/workspaces/${wsId}/interested-parties`],
    ['objectives', `/workspaces/${wsId}/objectives`],
    ['audits', `/workspaces/${wsId}/audits`],
    ['nonconformities', `/workspaces/${wsId}/nonconformities`],
    ['vendors', `/workspaces/${wsId}/vendors`],
    ['reports', `/workspaces/${wsId}/reports`],
    ['glossary', '/glossary'],
    ['tenants', '/tenants'],
  ];

  for (const [name, url] of routes) {
    try {
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 400));
      const shot = path.join(SHOT_DIR, name + '.png');
      await page.screenshot({ path: shot, fullPage: true });
      log('  shot ' + name);
    } catch (e) { log('  fail ' + name + ': ' + e.message); }
  }

  for (const [name, url] of routes) {
    try {
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 300));
      const shot = path.join(SHOT_DIR, name + '__fold.png');
      await page.screenshot({ path: shot, fullPage: false });
    } catch (_) {}
  }

  await cleanup();
  log('Done. Screenshots in', SHOT_DIR);
})().catch(async e => {
  console.error('Design walk crashed:', e);
  await cleanup();
  process.exit(interrupted ? 130 : 1);
});
