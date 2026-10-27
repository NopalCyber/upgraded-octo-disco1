const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { bootApp, bootClient, makeClient, openTestDb } = require('./helpers');
const { sanitizeDocumentHtml } = require('../lib/document-html');

test('document HTML sanitizer removes executable and remote-content payloads while preserving controlled prose', () => {
  const clean = sanitizeDocumentHtml(`<h2>Controlled policy</h2>
    <script>window.pwned=1</script>
    <p onclick="window.pwned=2" style="color:#123456;background-image:url(https://tracker.invalid/pixel)">Body</p>
    <a href="javascript:window.pwned=3">unsafe link</a>
    <img src="https://tracker.invalid/pixel.png" onerror="window.pwned=4">
    <iframe src="https://attacker.invalid"></iframe>`);
  assert.match(clean, /<h2>Controlled policy<\/h2>/);
  assert.match(clean, /<p[^>]*>Body<\/p>/);
  assert.doesNotMatch(clean, /script|onclick|onerror|javascript:|iframe|tracker\.invalid|attacker\.invalid|background-image/i);
});

test('Public trust path explains evaluation, access, security, privacy, and disclosure before sign-in', async (t) => {
  const { app, dbUrl } = await bootApp();
  const client = makeClient(app);
  t.after(() => client.close());

  const conn = await openTestDb(dbUrl);
  await conn.prepare(`INSERT INTO firms (name) VALUES (?)`).run('PRIVATE-TENANT-CANARY');
  await conn.close();

  const expected = new Map([
    ['/', /href="\/contact"[^>]*>Talk to us/],
    ['/register', /Access starts with an invitation/],
    ['/security', /Security boundaries should be testable/],
    ['/privacy', /Privacy responsibilities are shared/],
    ['/terms', /does not itself certify conformity/],
    ['/contact', /Tell us about your compliance programme/],
  ]);
  for (const [url, marker] of expected) {
    const response = await client.get(url);
    assert.equal(response.status, 200, `${url} should be public`);
    assert.match(response.text, marker, `${url} should provide its promised next step`);
    assert.doesNotMatch(response.text, /PRIVATE-TENANT-CANARY/, `${url} must not expose tenant data`);
  }

  const disclosure = await client.get('/.well-known/security.txt');
  assert.equal(disclosure.status, 200);
  assert.match(String(disclosure.headers['content-type']), /^text\/plain/);
  assert.match(disclosure.text, /^Contact: /m);
  assert.match(disclosure.text, /^Expires: /m);
  assert.match(disclosure.text, /^Policy: /m);
});

test('CSRF - POST without token is rejected with 403', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.post('/tenants', { name: 'EvilCorp' }, { csrf: false });
  assert.equal(r.status, 403);
  assert.match(r.text, /CSRF token missing or invalid/);
});

test('CSRF - POST with wrong token is rejected with 403', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.post('/tenants', { name: 'EvilCorp', _csrf: 'deadbeef' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('CSRF - authenticated state-changing POST is rejected without a token and accepted with one', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const noToken = await client.post('/tenants', { name: 'NoTokenCorp' }, { csrf: false });
  assert.equal(noToken.status, 403, 'authenticated POST without a CSRF token must be 403');
  assert.match(noToken.text, /CSRF token missing or invalid/, 'rejection must come from CSRF, not auth');
  assert.doesNotMatch(noToken.text, /auth_required/, 'must not be an auth (401) failure masquerading as a CSRF pass');

  const withToken = await client.post('/tenants', { name: 'LegitCorp' });
  assert.equal(withToken.status, 302);
  assert.match(withToken.location, /\/onboarding/);
});

test('CSRF - safe GET requests do not require a token', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  for (const url of ['/dashboard?legacy=1', '/tenants', '/glossary']) {
    const r = await client.get(url);
    assert.equal(r.status, 200, `GET ${url} returned ${r.status}`);
  }
});

test('opening a workspace and its risk settings does not seed a risk methodology', async (t) => {
  const { client, dbUrl } = await bootClient();
  const db = await openTestDb(dbUrl);
  t.after(async () => { await db.close(); await client.close(); });
  const actor = await db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const id = Number((await db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Read-only workspace','[]')").run(actor.firm_id)).lastInsertRowid);
  for (const suffix of ['/client-portal', '/risk-methodology', '/risks']) {
    const response = await client.get(`/workspaces/${id}${suffix}`);
    assert.equal(response.status, 200, suffix);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM risk_methodologies WHERE workspace_id=?').get(id)).n, 0);
  }
  const response = await client.post(`/workspaces/${id}/risk-methodology/reset`, {});
  assert.equal(response.status, 302);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM risk_methodologies WHERE workspace_id=?').get(id)).n, 1, 'an explicit reset stores the default methodology');
});

test('CSRF - token is exposed as a 64-hex meta tag on rendered pages', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.get('/dashboard?legacy=1');
  const m = r.text.match(/name="csrf-token" content="([a-f0-9]+)"/);
  assert.ok(m, 'meta tag must include csrf token');
  assert.equal(m[1].length, 64, 'token should be 64 hex chars');
});

test('CSRF - token is stable across requests in the same session', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const a = await client.get('/dashboard?legacy=1');
  const b = await client.get('/glossary');
  const ta = (a.text.match(/name="csrf-token" content="([a-f0-9]+)"/) || [])[1];
  const tb = (b.text.match(/name="csrf-token" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(ta && tb, 'both pages must expose a token');
  assert.equal(ta, tb, 'token must persist for the lifetime of the session');
});

test('CSRF - different sessions get different tokens', async (t) => {
  const { client: c1 } = await bootClient();
  const { client: c2 } = await bootClient();
  t.after(async () => { await c1.close(); await c2.close(); });

  const t1 = c1.getCsrfToken();
  const t2 = c2.getCsrfToken();
  assert.ok(t1 && t1.length === 64, 'session 1 must have a 64-hex token');
  assert.ok(t2 && t2.length === 64, 'session 2 must have a 64-hex token');
  assert.notEqual(t1, t2, 'sessions must not share tokens');
});

test('XSS - a script payload in a client name is HTML-escaped on render', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const CANARY = 'XSSCANARY<script>window.__xss_canary=1</script>END';
  const post = await client.post('/workspaces', { client_name: CANARY, name: CANARY, industry: 'T', frameworks: 'iso27001', engagement_outcome: 'certification_support' });
  assert.equal(post.status, 302, 'client creation should redirect');

  const dash = await client.get('/dashboard?legacy=1');
  assert.equal(dash.status, 200);
  assert.ok(!dash.text.includes('<script>window.__xss_canary'), 'raw script must not render');
  assert.ok(dash.text.includes('XSSCANARY'), 'the client name must be rendered');
  assert.ok(dash.text.includes('&lt;script&gt;'), 'angle brackets must be HTML-escaped');
});

test('XSS - an attribute-breakout payload in a client name cannot escape its element', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const CANARY = 'XSSATTR" onclick="window.__xss_pwn=1"';
  const post = await client.post('/workspaces', { client_name: CANARY, name: CANARY, industry: 'T', frameworks: 'iso27001', engagement_outcome: 'certification_support' });
  assert.equal(post.status, 302);

  const dash = await client.get('/dashboard?legacy=1');
  assert.ok(dash.text.includes('XSSATTR'), 'the client name must be rendered');
  assert.ok(!/onclick="window\.__xss_pwn/.test(dash.text), 'attribute injection must be neutralised');
  assert.ok(dash.text.includes('&quot;') || dash.text.includes('&#34;') || dash.text.includes('&#x22;'), 'the breakout quote must be HTML-escaped');
});

test('Workspace creation requires a programme; a client from before still shows its decision as pending', async (t) => {
  const { client, dbUrl } = await bootClient();
  t.after(() => client.close());
  const refused = await client.post('/workspaces', { client_name:'Programme Pending Client', industry:'Technology' });
  assert.equal(refused.status,400);
  assert.match(refused.text,/Choose at least one programme for this client/);
  const seed = await openTestDb(dbUrl);
  const lead = await seed.prepare(`SELECT id,firm_id FROM users WHERE email='sec-test@example.com'`).get();
  await seed.prepare(`INSERT INTO workspaces (firm_id,client_name,industry,scope,lead_consultant_id,frameworks) VALUES (?,'Programme Pending Client','Technology','Programme selection remains under client discussion.',?,'[]')`).run(lead.firm_id,lead.id);
  await seed.close();
  const conn = await openTestDb(dbUrl);
  const workspace = await conn.prepare(`SELECT id,frameworks FROM workspaces WHERE client_name='Programme Pending Client'`).get();
  assert.equal(workspace.frameworks,'[]');
  await conn.close();
  const overview = await client.get(`/workspaces/${workspace.id}`);
  assert.equal(overview.status,200,overview.text.slice(0,500));
  assert.match(overview.text,/Programme decision pending/);
  assert.doesNotMatch(overview.text,/ISO 27001 programme|Stage 1 maturity/);
});

test('A non-numeric record id answers 404, as it did before PostgreSQL', async (t) => {
  const { client, dbUrl } = await bootClient();
  t.after(() => client.close());
  const created = await client.post('/workspaces', {
    client_name: 'Non-numeric Id Client', industry: 'Technology',
    frameworks: 'iso27001', engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);
  const conn = await openTestDb(dbUrl);
  const workspace = await conn.prepare(`SELECT id FROM workspaces WHERE client_name=?`).get('Non-numeric Id Client');
  await conn.close();

  const res = await client.get(`/workspaces/${workspace.id}/audits/abc`);
  assert.equal(res.status, 404, res.text.slice(0, 300));
  assert.match(res.text, /Page not found/);
});

test('Workspace deletion removes a populated client while restoring immutable-history guards', async (t) => {
  const { client, dbUrl } = await bootClient();
  t.after(() => client.close());

  const storedClientName = `Deletion Regression ${String.fromCodePoint(0x2014)} Client`;
  const renderedClientName = 'Deletion Regression - Client';

  const created = await client.post('/workspaces', {
    client_name: storedClientName,
    industry: 'Technology',
    scope: 'A disposable workspace containing governed history.',
    frameworks: 'iso27001',
    engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);

  const conn = await openTestDb(dbUrl);
  const workspace = await conn.prepare(`SELECT id FROM workspaces WHERE client_name=?`).get(storedClientName);
  const user = await conn.prepare(`SELECT id FROM users WHERE email=?`).get('sec-test@example.com');
  const snapshot = JSON.stringify({ workspaceId: workspace.id, covered: 1 });
  await conn.prepare(`INSERT INTO gap_fieldwork_snapshots
    (workspace_id,week_ending,requirements_covered,requirements_total,interviews_completed,
     interviews_planned,requests_received,requests_total,active_blockers,declared_defaults,
     snapshot_json,snapshot_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(workspace.id, '2026-08-16', 1, 118, 1, 2, 1, 3, 0, 0,
      snapshot, crypto.createHash('sha256').update(snapshot).digest('hex'), user.id);

  await assert.rejects(
    async () => await conn.prepare(`DELETE FROM gap_fieldwork_snapshots WHERE workspace_id=?`).run(workspace.id),
    /fieldwork snapshots are immutable/,
    'ordinary history deletion must remain blocked before the workspace purge'
  );
  await conn.close();

  const dashboard = await client.get('/dashboard?legacy=1');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Deletion Regression - Client/,
    'the confirmation dialog must show the globally normalized display name');

  const rejected = await client.post(`/workspaces/${workspace.id}/delete`, {
    confirm_name: 'Deletion Regression Client',
  });
  assert.equal(rejected.status, 302);
  const rejectedLocation = new URL(rejected.location, 'http://localhost');
  assert.equal(rejectedLocation.pathname, `/workspaces/${workspace.id}`);
  assert.equal(rejectedLocation.hash, '#workspace-settings');
  assert.equal(rejectedLocation.searchParams.get('toastKind'), 'error');
  const afterRejected = await openTestDb(dbUrl);
  assert.equal((await afterRejected.prepare(`SELECT COUNT(*) c FROM workspaces WHERE id=?`).get(workspace.id)).c, 1,
    'a genuinely different visible name must not delete the client');
  await afterRejected.close();

  const deleted = await client.post(`/workspaces/${workspace.id}/delete`, {
    confirm_name: renderedClientName,
  });
  assert.equal(deleted.status, 302, deleted.text.slice(0, 500));
  assert.match(deleted.location, /^\/dashboard\?/);

  const verify = await openTestDb(dbUrl);
  assert.equal((await verify.prepare(`SELECT COUNT(*) c FROM workspaces WHERE id=?`).get(workspace.id)).c, 0);
  assert.equal((await verify.prepare(`SELECT COUNT(*) c FROM gap_fieldwork_snapshots WHERE workspace_id=?`).get(workspace.id)).c, 0);
  assert.ok(await verify.prepare(`SELECT tgname FROM pg_trigger WHERE tgname='trg_gap_snapshot_no_delete' AND NOT tgisinternal`).get(),
    'immutable-history trigger must be restored before commit');
  await verify.close();
});

test('Auth - protected pages require authentication (no default-user bypass)', async (t) => {
  const { client, app } = await bootClient();
  t.after(() => client.close());

  const authed = await client.get('/dashboard?legacy=1');
  assert.equal(authed.status, 200, 'authenticated dashboard must render');
  assert.ok(!/No default user found/.test(authed.text), 'must not show a no-user error');
  assert.match(authed.text, /id="pageLoader"/, 'protected app shell must include the branded page loader');
  assert.match(authed.text, /page-loader\.js\?v=/, 'protected app shell must load the transition controller');
  assert.match(authed.text, /class="skip-link"[^>]*>Skip to content</, 'protected app shell must offer a keyboard skip link');
  assert.match(authed.text, /site-enhancements\.js\?v=/, 'protected app shell must load the shared interaction layer');
  assert.match(authed.text, /data-theme-toggle/, 'protected app shell must expose the theme control');
  const authedRoot = await client.get('/');
  assert.equal(authedRoot.status, 302, 'signed-in users should go directly to their dashboard');
  assert.equal(authedRoot.location, '/dashboard');

  const anon = makeClient(app);
  t.after(() => anon.close());
  const r = await anon.get('/dashboard?legacy=1');
  assert.equal(r.status, 302, 'unauthenticated dashboard must redirect, not serve a default user');
  assert.match(r.location, /\/login/, 'must redirect to /login');
  const login = await anon.get('/login');
  assert.equal(login.status, 200);
  assert.match(login.text, /id="pageLoader"/, 'authentication shell must include the branded page loader');
  assert.match(login.text, /page-loader\.css\?v=/, 'authentication shell must load the loader presentation');
});

test('Auth - a post-login destination must stay on this site', async (t) => {
  const { client, app } = await bootClient();
  t.after(() => client.close());

  for (const next of ['//attacker.invalid/x', '/\\attacker.invalid/x', 'https://attacker.invalid/x']) {
    const r = await client.get(`/login?next=${encodeURIComponent(next)}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/dashboard', `${next} must not be followed`);
  }
  const local = await client.get(`/login?next=${encodeURIComponent('/dashboard?legacy=1')}`);
  assert.equal(local.location, '/dashboard?legacy=1', 'a same-site path is honoured');

  const anon = makeClient(app);
  t.after(() => anon.close());
  const page = await anon.get(`/login?next=${encodeURIComponent('//attacker.invalid/x')}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /attacker\.invalid/, 'a foreign destination is not carried into the form');
});

test('Auth - logout crosses the view-transition boundary without retaining the authenticated session', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const logout = await client.post('/logout');
  assert.equal(logout.status, 302);
  assert.equal(logout.location, '/login?signed_out=1');

  const signedOut = await client.get(logout.location);
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.text, /You have been signed out\./);
  assert.match(signedOut.text, /<meta name="view-transition" content="same-origin"\s*\/?>/,
    'logout destination must share the protected shell transition contract');
  assert.match(signedOut.text, /@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/,
    'logout destination must opt into cross-document transitions');
  assert.match(signedOut.text, /::view-transition-old\(root\)[\s\S]*animation-duration:\s*0s/,
    'the auth boundary must not cross-fade the previously authenticated page');

  const protectedPage = await client.get('/dashboard?legacy=1');
  assert.equal(protectedPage.status, 302, 'the destroyed session must not retain protected access');
  assert.match(protectedPage.location, /^\/login/);
});

test('Auth - legacy MFA account data cannot trigger a second-factor challenge', async (t) => {
  const { app, dbUrl } = await bootApp();
  const db = await openTestDb(dbUrl);
  const firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const password = 'password-only-login-1234';
  await db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active,mfa_secret,mfa_enabled_at,mfa_recovery_codes,mfa_last_counter)
    VALUES ('legacy-mfa@example.com',?,'Legacy MFA User','firm',?,'consultant',1,'legacy-secret',CURRENT_TIMESTAMP,'["legacy-code"]',42)`)
    .run(bcrypt.hashSync(password, 4), firmId);
  const client = makeClient(app);
  t.after(async () => { await client.close(); await db.close(); });

  const loginPage = await client.get('/login');
  const csrf = (loginPage.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const signedIn = await client.post('/login', {
    email: 'legacy-mfa@example.com', password, _csrf: csrf
  }, { csrf: false });
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.location, '/dashboard');
  assert.equal((await client.get('/dashboard?legacy=1')).status, 200);
  assert.equal((await client.get('/mfa/verify')).status, 404);
  assert.equal((await client.get('/security/mfa/setup')).status, 404);
});

async function auditRows(db, action) {
  return await db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM audit_chain c WHERE c.audit_log_id=a.id) AS chained
    FROM audit_log a WHERE a.action=? ORDER BY a.id`).all(action);
}

test('Audit trail - sign-in attempts are recorded without the password, and a failed one is not the owner\'s activity', async (t) => {
  const { client, app, dbUrl, login } = await bootClient();
  const db = await openTestDb(dbUrl);
  t.after(async () => { await db.close(); await client.close(); });

  const user = await db.prepare('SELECT id FROM users WHERE email=?').get(login.email);
  const succeeded = (await auditRows(db, 'login_succeeded')).filter(row => row.user_id === user.id);
  assert.equal(succeeded.length, 1, 'the harness sign-in is recorded once');
  assert.equal(succeeded[0].entity_id, String(user.id));
  assert.equal(succeeded[0].chained, 1, 'the row joins the audit hash chain');
  assert.ok(!JSON.stringify(succeeded[0]).includes(login.password), 'the password is never recorded');

  await db.prepare(`UPDATE users SET last_active_at='2020-01-01 00:00:00' WHERE id=?`).run(user.id);

  const anon = makeClient(app);
  t.after(() => anon.close());
  const page = await anon.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const wrongPassword = 'not-the-password-9876';
  const wrong = await anon.post('/login', { email: login.email, password: wrongPassword, _csrf: csrf }, { csrf: false });
  assert.equal(wrong.status, 401);
  const unknown = await anon.post('/login', { email: 'nobody-here@example.com', password: wrongPassword, _csrf: csrf }, { csrf: false });
  assert.equal(unknown.status, 401);

  const failed = await auditRows(db, 'login_failed');
  const known = failed.find(row => JSON.parse(row.details).email === login.email);
  assert.ok(known, 'a wrong password for a real account is recorded');
  assert.equal(known.user_id, user.id);
  assert.equal(known.entity_id, String(user.id));
  assert.equal(JSON.parse(known.details).reason, 'wrong_password');
  const stranger = failed.find(row => JSON.parse(row.details).email === 'nobody-here@example.com');
  assert.ok(stranger, 'an attempt on an unknown email is recorded');
  assert.equal(stranger.entity_id, null);
  assert.equal(JSON.parse(stranger.details).reason, 'unknown_account');
  for (const row of failed) {
    assert.equal(row.chained, 1);
    assert.ok(!JSON.stringify(row).includes(wrongPassword), 'the attempted password is never recorded');
  }
  assert.equal((await db.prepare('SELECT last_active_at FROM users WHERE id=?').get(user.id)).last_active_at, '2020-01-01 00:00:00',
    'a failed attempt must not count as the account owner\'s activity');
});

test('Audit trail - a client cannot choose the address recorded by sending X-Forwarded-For', async (t) => {
  const { app, dbUrl } = await bootClient();
  const db = await openTestDb(dbUrl);
  const anon = makeClient(app);
  t.after(async () => { await db.close(); await anon.close(); });

  const page = await anon.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  await anon.post('/login', { email: 'forged-ip@example.com', password: 'wrong-password-1234', _csrf: csrf },
    { csrf: false, headers: { 'x-forwarded-for': '203.0.113.66, 198.51.100.7' } });
  const row = await db.prepare(`SELECT ip_address FROM audit_log WHERE action='login_failed' AND details LIKE '%forged-ip@example.com%'`).get();
  assert.ok(row, 'the attempt is recorded');
  assert.equal(row.ip_address, '127.0.0.1');
});

test('Audit trail - deleting an internal audit records what was deleted, once', async (t) => {
  const { client, dbUrl } = await bootClient();
  const db = await openTestDb(dbUrl);
  t.after(async () => { await db.close(); await client.close(); });

  const firmId = (await db.prepare(`SELECT firm_id FROM users WHERE email='sec-test@example.com'`).get()).firm_id;
  const workspaceId = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,stage) VALUES (?,'Audit Trail Client','implementation')`).run(firmId)).lastInsertRowid);
  const title = 'Q3 internal audit of access control';
  const created = await client.post(`/workspaces/${workspaceId}/audits`, { title, audit_date: '2026-09-30' });
  assert.equal(created.status, 302, created.text.slice(0, 300));
  const audit = await db.prepare('SELECT id FROM audits WHERE workspace_id=? AND title=?').get(workspaceId, title);
  assert.ok(audit);

  const deleted = await client.post(`/workspaces/${workspaceId}/audits/${audit.id}/delete`, {});
  assert.equal(deleted.status, 302);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM audits WHERE id=?').get(audit.id)).c, 0);

  const rows = (await auditRows(db, 'delete_audit')).filter(row => row.entity_id === String(audit.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, workspaceId);
  assert.equal(rows[0].entity_type, 'audit');
  assert.equal(rows[0].chained, 1);
  const details = JSON.parse(rows[0].details);
  assert.equal(details.title, title);
  assert.equal(details.audit_date, '2026-09-30');

  const again = await client.post(`/workspaces/${workspaceId}/audits/${audit.id}/delete`, {});
  assert.equal(again.status, 302);
  assert.equal((await auditRows(db, 'delete_audit')).filter(row => row.entity_id === String(audit.id)).length, 1,
    'nothing deleted, nothing recorded');
});

test('Audit trail - renaming a tenant records the old and new names', async (t) => {
  const { client, dbUrl } = await bootClient();
  const db = await openTestDb(dbUrl);
  t.after(async () => { await db.close(); await client.close(); });

  const firm = await db.prepare(`SELECT f.id, f.name FROM firms f JOIN users u ON u.firm_id=f.id WHERE u.email='sec-test@example.com'`).get();
  const renamed = await client.post(`/tenants/${firm.id}/rename`, { name: 'Renamed Audit Trail Firm' });
  assert.equal(renamed.status, 302);
  assert.equal((await db.prepare('SELECT name FROM firms WHERE id=?').get(firm.id)).name, 'Renamed Audit Trail Firm');

  const rows = (await auditRows(db, 'rename_firm')).filter(row => row.entity_id === String(firm.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chained, 1);
  assert.deepEqual(JSON.parse(rows[0].details), { old_name: firm.name, new_name: 'Renamed Audit Trail Firm' });
});

test('Audit trail - deleting a tenant keeps a record although the sweep removes the acting manager', async (t) => {
  const { app, dbUrl } = await bootApp();
  const db = await openTestDb(dbUrl);
  if (!(await db.prepare('SELECT id FROM firms LIMIT 1').get())) await db.prepare(`INSERT INTO firms (name) VALUES ('Remaining Firm')`).run();
  const firmId = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Disposable Audit Firm')`).run()).lastInsertRowid);
  const password = 'disposable-manager-1234';
  await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('disposable-manager@example.com',?,'Disposable Manager','firm',?,'manager',1)`).run(bcrypt.hashSync(password, 4), firmId);
  const client = makeClient(app);
  t.after(async () => { await db.close(); await client.close(); });

  const page = await client.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const signedIn = await client.post('/login', { email: 'disposable-manager@example.com', password, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302);
  await client.get('/tenants');

  const deleted = await client.post(`/tenants/${firmId}/delete`, { confirm_name: 'Disposable Audit Firm' });
  assert.equal(deleted.status, 302, deleted.text.slice(0, 300));
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM firms WHERE id=?').get(firmId)).c, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM users WHERE email='disposable-manager@example.com'`).get()).c, 0);

  const rows = (await auditRows(db, 'delete_firm')).filter(row => row.entity_id === String(firmId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chained, 1);
  assert.equal(rows[0].workspace_id, null);
  const details = JSON.parse(rows[0].details);
  assert.equal(details.name, 'Disposable Audit Firm');
  assert.equal(details.deleted_by_email, 'disposable-manager@example.com');
});
