const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { createSuiteDatabase, openTestDb } = require('./pg-test-databases');

const bootDirs = [];
process.once('exit', () => {
  for (const dir of bootDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
  }
});

async function bootApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-test-'));
  bootDirs.push(tmpDir);
  const keyPath = path.join(tmpDir, 'master.key');
  const { name: dbName, url: dbUrl } = await createSuiteDatabase();
  process.env.DATABASE_URL = dbUrl;
  process.env.ISMS_KEY_FILE = keyPath;
  if (!process.env.PG_POOL_MAX) process.env.PG_POOL_MAX = '4';
  process.env.SESSION_SECRET = 'test-secret-' + crypto.randomBytes(4).toString('hex');
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  Object.keys(require.cache).filter(k => k.startsWith(PROJECT_ROOT)).forEach(k => delete require.cache[k]);
  const { app, db, ready } = require('../server.js');
  await ready;
  return { app, db, ready, tmpDir, dbUrl, dbName };
}

function makeClient(app) {
  const server = app.listen(0, '127.0.0.1');
  const listening = server.listening
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  let cookieJar = '';
  let csrfToken = null;

  async function request(method, urlPath, body, opts = {}) {
    await listening;
    const port = server.address().port;
    const headers = { ...(opts.headers || {}) };
    if (cookieJar) headers['cookie'] = cookieJar;
    let payload = null;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      if (opts.json) {
        headers['content-type'] = 'application/json';
        if (csrfToken && opts.csrf === true) headers['x-csrf-token'] = csrfToken;
        payload = JSON.stringify(body);
      } else {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        if (csrfToken && opts.csrf !== false && !body._csrf) body._csrf = csrfToken;
        const form = new URLSearchParams();
        Object.entries(body).forEach(([key, value]) => {
          if (Array.isArray(value)) value.forEach(item => form.append(key, item));
          else form.append(key, value);
        });
        payload = form.toString();
      }
    } else if (typeof body === 'string') {
      payload = body;
      if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    if (payload != null) headers['content-length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, method, path: urlPath, headers,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          const sc = res.headers['set-cookie'];
          if (sc) {
            const cookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
            const existing = cookieJar ? cookieJar.split('; ').filter(c => !cookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
            cookieJar = [...existing, ...cookies].join('; ');
          }
          const m = text.match(/name="csrf-token" content="([a-f0-9]+)"/);
          if (m) csrfToken = m[1];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer,
            text,
            location: res.headers.location || null,
            cookies: cookieJar,
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    get: async (p, opts) => await request('GET', p, null, opts),
    post: async (p, body, opts) => await request('POST', p, body || {}, opts),
    put: async (p, body, opts) => await request('PUT', p, body || {}, opts),
    delete: async (p, opts) => await request('DELETE', p, null, opts),
    deleteBody: async (p, body, opts) => await request('DELETE', p, body || {}, opts),
    baseUrl: async () => {
      await listening;
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.once('close', finish);
      server.close(finish);
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      setTimeout(finish, 250);
    }),
    getCsrfToken: () => csrfToken,
    getCookies: () => cookieJar,
  };
}

async function authenticate(client, database) {
  const email = 'sec-test@example.com';
  const password = 'sec-test-password-1234';
  const own = typeof database === 'string';
  const conn = own ? await openTestDb(database) : database;
  try {
    let firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    if (!firm) {
      await conn.prepare('INSERT INTO firms (name) VALUES (?)').run('Security Test Firm');
      firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    }
    const hash = bcrypt.hashSync(password, 4);
    const existing = await conn.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (existing) await conn.prepare("UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?").run(hash, firm.id, existing.id);
    else await conn.prepare("INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?, ?, 'Security Tester', ?, 'firm', 'manager', 1)").run(email, hash, firm.id);
  } finally {
    if (own) await conn.close();
  }

  const lg = await client.get('/login');
  const token = (lg.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await client.post('/login', { email, password, _csrf: token }, { csrf: false });
  if (res.status < 300 || res.status >= 400) throw new Error(`test login failed: expected 3xx, got ${res.status}`);
  let landing = await client.get('/dashboard');
  for (let redirects = 0; landing.location && redirects < 5; redirects++) landing = await client.get(landing.location);
  return { email, password };
}

async function bootClient() {
  const boot = await bootApp();
  const client = makeClient(boot.app);
  const login = await authenticate(client, boot.dbUrl);
  return { client, ...boot, login };
}

module.exports = { bootApp, makeClient, bootClient, authenticate, openTestDb };
