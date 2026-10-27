'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { bootApp, makeClient, openTestDb } = require('./helpers');

const PASSWORD = 'lockout-test-password-1234';
const WRONG = 'not-the-password';
const LOCKED = /Too many failed attempts/;
const INCORRECT = /Email or password is incorrect/;

async function seedUser(dbUrl, email) {
  const conn = await openTestDb(dbUrl);
  try {
    let firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    if (!firm) {
      await conn.prepare('INSERT INTO firms (name) VALUES (?)').run('Lockout Test Firm');
      firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    }
    await conn.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
      VALUES (?, ?, 'Lockout Tester', ?, 'firm', 'manager', 1)`).run(email, bcrypt.hashSync(PASSWORD, 4), firm.id);
  } finally {
    await conn.close();
  }
}

async function failuresFor(dbUrl, email) {
  const conn = await openTestDb(dbUrl);
  try {
    const row = await conn.prepare('SELECT failures FROM login_failures WHERE email = ?').get(email);
    return row ? row.failures : 0;
  } finally {
    await conn.close();
  }
}

async function bootSecondInstance(dbUrl) {
  process.env.DATABASE_URL = dbUrl;
  const root = path.resolve(__dirname, '..');
  for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key];
  const { app, db, ready } = require('../server.js');
  await ready;
  return { app, db };
}

async function csrfFor(client) {
  const page = await client.get('/login');
  return (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
}

async function signIn(client, email, password, csrf) {
  return await client.post('/login', { email, password, _csrf: csrf || await csrfFor(client) }, { csrf: false });
}

test('eight failures lock the email for the window; success and an ended window clear it', async (t) => {
  const { app, dbUrl } = await bootApp();
  const client = makeClient(app);
  t.after(() => client.close());
  const email = 'lockout-single@example.com';
  await seedUser(dbUrl, email);

  for (let i = 0; i < 7; i++) assert.match((await signIn(client, email, WRONG)).text, INCORRECT);
  assert.equal(await failuresFor(dbUrl, email), 7);
  const signedIn = await signIn(client, email, PASSWORD);
  assert.equal(signedIn.status, 302, 'seven failures must not lock the account');
  assert.equal(await failuresFor(dbUrl, email), 0, 'a successful sign-in clears the counter');

  const fresh = makeClient(app);
  t.after(() => fresh.close());
  for (let i = 0; i < 8; i++) assert.match((await signIn(fresh, email, WRONG)).text, INCORRECT);
  const locked = await signIn(fresh, email.toUpperCase(), PASSWORD);
  assert.equal(locked.status, 401);
  assert.match(locked.text, LOCKED, 'the eighth failure locks the email, whatever its case');
  assert.equal(await failuresFor(dbUrl, email), 8, 'a refused attempt is not counted');

  const conn = await openTestDb(dbUrl);
  try {
    await conn.prepare(`UPDATE login_failures SET window_ends_at = now() - interval '1 second' WHERE email = ?`).run(email);
  } finally {
    await conn.close();
  }
  assert.match((await signIn(fresh, email, WRONG)).text, INCORRECT, 'an ended window no longer locks');
  assert.equal(await failuresFor(dbUrl, email), 1, 'the first failure after a window ends opens a new one');
  assert.equal((await signIn(fresh, email, PASSWORD)).status, 302);
});

test('two application instances on one database share the failure count', async (t) => {
  const first = await bootApp();
  const email = 'lockout-shared@example.com';
  await seedUser(first.dbUrl, email);
  const second = await bootSecondInstance(first.dbUrl);
  t.after(() => second.db.close());
  const a = makeClient(first.app);
  const b = makeClient(second.app);
  t.after(() => Promise.all([a.close(), b.close()]));

  for (let i = 0; i < 4; i++) assert.match((await signIn(a, email, WRONG)).text, INCORRECT);
  for (let i = 0; i < 4; i++) assert.match((await signIn(b, email, WRONG)).text, INCORRECT);
  assert.equal(await failuresFor(first.dbUrl, email), 8);
  assert.match((await signIn(a, email, PASSWORD)).text, LOCKED, 'instance A sees the failures counted on B');
  assert.match((await signIn(b, email, PASSWORD)).text, LOCKED, 'instance B sees the failures counted on A');

  const burst = 'lockout-burst@example.com';
  const [csrfA, csrfB] = await Promise.all([csrfFor(a), csrfFor(b)]);
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    attempts.push(signIn(a, burst, WRONG, csrfA), signIn(b, burst, WRONG, csrfB));
  }
  for (const response of await Promise.all(attempts)) assert.match(response.text, INCORRECT);
  assert.equal(await failuresFor(first.dbUrl, burst), 6);
});

test('the hourly sweep removes only ended windows', async () => {
  const { dbUrl } = await bootApp();
  const conn = await openTestDb(dbUrl);
  try {
    await conn.prepare(`INSERT INTO login_failures (email, failures, window_ends_at) VALUES
      ('ended@example.com', 8, now() - interval '1 minute'),
      ('open@example.com', 3, now() + interval '10 minutes')`).run();
    const { jobLoginFailureSweep } = require('../lib/jobs');
    assert.match(await jobLoginFailureSweep(), /^1 ended login-failure window/);
    const left = await conn.prepare('SELECT email FROM login_failures ORDER BY email').all();
    assert.deepEqual(left.map((row) => row.email), ['open@example.com']);
  } finally {
    await conn.close();
  }
});
