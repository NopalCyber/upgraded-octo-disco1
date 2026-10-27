const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-routes-'));
const { createSuiteDatabase, openTestDb } = require('./pg-test-databases');
const { pgTools } = require('../lib/backup');
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), ISMS_BACKUP_DIR: path.join(TMP, 'backups'),
  SESSION_SECRET: 'routes-test-fixed-secret-for-deterministic-cookies-only',
  DISABLE_CSRF: '1', PORT: '3345' };

const TEST_EMAIL = 'routes@test.local';
const TEST_PASSWORD = 'routes-test-password-1234';
const PORT = 3345;

const SKIP = new Set(['/logout']);

let serverProc = null;
let cookieJar = '';
let suiteDb = null;

async function finish(code) {
  if (serverProc) { serverProc.removeAllListeners('exit'); serverProc.kill(); }
  if (suiteDb) {
    try { await pgTools.dropDatabase(process.env.PG_TEST_URL, suiteDb.name); }
    catch (error) { console.error(`routes.test: could not drop ${suiteDb.name}: ${error.message}`); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

function get(pathStr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const headers = cookieJar ? { cookie: cookieJar } : {};
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathStr, method: 'GET', headers, timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) {
          const newCookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
          const existing = cookieJar ? cookieJar.split('; ').filter(c => !newCookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
          cookieJar = [...existing, ...newCookies].join('; ');
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function post(pathStr, formObj) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(formObj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`).join('&');
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) };
    if (cookieJar) headers['cookie'] = cookieJar;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathStr, method: 'POST', headers }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) {
          const newCookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
          const existing = cookieJar ? cookieJar.split('; ').filter(c => !newCookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
          cookieJar = [...existing, ...newCookies].join('; ');
        }
        resolve({ status: res.statusCode, body: resp });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function extractGetRoutes() {
  const sources = [path.join(ROOT, 'server.js')];
  const routesDir = path.join(ROOT, 'routes');
  if (fs.existsSync(routesDir)) {
    for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) sources.push(path.join(routesDir, f));
  }
  const routes = new Set();
  for (const file of sources) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/app\.get\('([^']+)'/g)) routes.add(m[1]);
  }
  return [...routes].sort();
}

(async () => {
  suiteDb = await createSuiteDatabase();
  ENV.DATABASE_URL = suiteDb.url;
  console.log(`routes.test: building a seeded database (${suiteDb.name})…`);
  const build = require('child_process').spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build-test-db.js'), suiteDb.url],
    { env: { ...process.env, ISMS_KEY_FILE: ENV.ISMS_KEY_FILE }, stdio: ['ignore', 'ignore', 'pipe'] });
  if (build.status !== 0) {
    console.error('routes.test: build-test-db failed:\n' + build.stderr);
    return finish(1);
  }

  const bcrypt = require('bcrypt');
  const conn = await openTestDb(suiteDb.url);
  const firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const firmId = firm ? firm.id : (await conn.prepare('INSERT INTO firms (name) VALUES (?)').run('Routes Test Firm')).lastInsertRowid;
  const hash = bcrypt.hashSync(TEST_PASSWORD, 4);
  const existing = await conn.prepare('SELECT id FROM users WHERE email=?').get(TEST_EMAIL);
  if (existing) {
    await conn.prepare(`UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?`).run(hash, firmId, existing.id);
  } else {
    await conn.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?, ?, 'Routes Tester', ?, 'firm', 'manager', 1)`).run(TEST_EMAIL, hash, firmId);
  }

  const wsRow = (await conn.prepare('SELECT id FROM workspaces WHERE firm_id = ? ORDER BY id LIMIT 1').get(firmId))
             || (await conn.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get());
  const isoRow = await conn.prepare('SELECT id FROM iso_items ORDER BY id LIMIT 1').get();
  await conn.close();
  const PARAMS = {
    wsId: wsRow ? String(wsRow.id) : '1',
    isoId: isoRow ? String(isoRow.id) : 'annex-a.5.1',
    token: 'not-a-real-token',
    slug: 'not-a-real-slug',
    perm: 'control.view',
  };

  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  serverProc.stdout.on('data', c => serverLog += c);
  serverProc.stderr.on('data', c => serverLog += c);
  let serverExited = false;
  serverProc.on('exit', (code, sig) => {
    if (serverExited) return;
    serverExited = true;
    console.error(`\nrouted server exited mid-walk (code=${code} sig=${sig}). Last server output:\n` + serverLog.slice(-2500));
    finish(1);
  });

  const up = await waitFor(async () => (await get('/login')).status === 200);
  if (!up) { console.error('routes.test: server did not come up.\n' + serverLog.slice(-2000)); return finish(1); }

  const login = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  if (login.status !== 302) { console.error(`routes.test: login failed (${login.status})`); return finish(1); }

  const routes = extractGetRoutes().filter(r => !SKIP.has(r));
  console.log(`Walking ${routes.length} GET routes (workspace ${PARAMS.wsId})…`);

  let failures = 0, walked = 0, skippedParams = 0;
  const statusCounts = {};
  for (const route of routes) {
    let url = route;
    let unresolved = false;
    url = url.replace(/:([a-zA-Z]+)/g, (_, p) => {
      if (PARAMS[p]) return PARAMS[p];
      if (/id$/i.test(p) || p === 'aid' || p === 'against') return '1';
      unresolved = true;
      return '1';
    });
    if (unresolved) skippedParams++;
    let res;
    if (process.env.ROUTES_VERBOSE) console.log('  … GET ' + url);
    try {
      res = await get(url, 15000);
    } catch (e) {
      failures++;
      console.error(`  ✗ GET ${url}  → ${e.message}`);
      continue;
    }
    walked++;
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (res.status >= 500) {
      failures++;
      const hint = (res.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 180);
      console.error(`  ✗ GET ${url}  → ${res.status}  ${hint}`);
    }
  }

  console.log(`Walked ${walked} routes. Status spread: ${JSON.stringify(statusCounts)}.`);
  if (skippedParams) console.log(`${skippedParams} routes had unmapped params substituted with '1' (still walked).`);
  serverExited = true;
  if (failures) { console.error(`\n${failures} route(s) returned 5xx or errored.`); return finish(1); }
  console.log('\nAll GET routes render without a server error.');
  return finish(0);
})().catch(e => { console.error(e); finish(1); });
