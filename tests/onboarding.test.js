'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient, openTestDb } = require('./helpers');
const { getOnboardingProgress } = require('../routes/tenants');

function workspaceId(location) {
  const match = String(location || '').match(/workspaces\/(\d+)/);
  assert.ok(match, `expected a workspace redirect, got ${location}`);
  return Number(match[1]);
}

test('fresh-firm onboarding is framework-neutral and contains one working required step', async (t) => {
  const { client, dbUrl } = await bootClient();
  t.after(() => client.close());

  const conn = await openTestDb(dbUrl);
  const firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const foreignFirm = (await conn.prepare('INSERT INTO firms (name) VALUES (?)').run('FOREIGN-ONBOARDING-CANARY')).lastInsertRowid;
  await conn.prepare('INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)')
    .run(foreignFirm, 'FOREIGN-CLIENT-CANARY', JSON.stringify(['iso27001']));

  const progress = await getOnboardingProgress(conn, firm.id);
  assert.equal(progress.done, 0);
  assert.equal(progress.total, 1);
  assert.equal(progress.pct, 0);
  assert.equal(progress.nextStep.title, 'Create your first client');
  await conn.close();

  const page = await client.get('/onboarding');
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, /Set up your firm/);
  assert.match(page.text, /0\s*<\/strong>\s*\/\s*1 required/);
  assert.match(page.text, /href="\/workspaces\/new"[^>]*>Create first client</);
  assert.equal((page.text.match(/href="\/workspaces\/new"/g) || []).length, 1,
    'zero-client onboarding exposes one authoritative create-client action');
  assert.match(page.text, /No client has been created yet/);
  assert.doesNotMatch(page.text, /Define ISMS scope|ISO 27001|Annex A|118 items|certification cycle/i);
  assert.doesNotMatch(page.text, /FOREIGN-(?:ONBOARDING|CLIENT)-CANARY/,
    'another firm must never satisfy or appear in this firm onboarding');
  const afterGet = await openTestDb(dbUrl);
  assert.equal(await afterGet.prepare('SELECT 1 FROM tenant_onboarding WHERE firm_id=?').get(firm.id), undefined,
    'reading onboarding must not create lifecycle state');
  afterGet.close();

  const createPage = await client.get('/workspaces/new');
  assert.equal(createPage.status, 200);
  assert.match(createPage.text, /Initial engagement scope/);
  assert.doesNotMatch(createPage.text, /ISMS scope statement/);
});

test('client summaries are rebuilt from only the programmes actually selected', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const created = await client.post('/workspaces', {
    client_name: 'Supplier Risk Client',
    industry: 'Technology',
    tprm_enabled: '1',
    tprm_service_model: 'assessment_only',
  });
  assert.equal(created.status, 302);
  const id = workspaceId(created.location);

  const page = await client.get('/onboarding');
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, /Supplier Risk Client/);
  assert.match(page.text, /Third-party risk/);
  assert.match(page.text, /Confirm the contracted service model/);
  assert.match(page.text, new RegExp(`href="/workspaces/${id}/setup"`));
  assert.doesNotMatch(page.text, /ISO 27001|Engagement intake and scope sign-off|certification cycle/i);
});

test('a client needs a programme, and one left without any gets an assignment path instead of an ISO intake', async (t) => {
  const { client, dbUrl } = await bootClient();
  t.after(() => client.close());

  const refused = await client.post('/workspaces', {
    client_name: 'Planning Only Client',
    industry: 'Professional services',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Choose at least one programme for this client/);
  const conn = await openTestDb(dbUrl);
  assert.equal((await conn.prepare("SELECT COUNT(*) c FROM workspaces WHERE client_name='Planning Only Client'").get()).c, 0);
  const lead = await conn.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const id = Number((await conn.prepare(`INSERT INTO workspaces (firm_id, client_name, industry, lead_consultant_id, frameworks)
    VALUES (?, 'Planning Only Client', 'Professional services', ?, '[]')`).run(lead.firm_id, lead.id)).lastInsertRowid);
  await conn.close();

  const page = await client.get('/onboarding');
  assert.match(page.text, /No services assigned/);
  assert.match(page.text, new RegExp(`href="/workspaces/${id}#programme-enable-form"[^>]*>Assign services</`));

  const clientPage = await client.get(`/workspaces/${id}`);
  assert.equal(clientPage.status, 200);
  assert.match(clientPage.text, /href="#programme-enable-form"[^>]*>Choose services</);
  assert.doesNotMatch(clientPage.text, /href="\/workspaces\/[^"]+\/intake"[^>]*>Client setup</);
});

test('consultants see setup guidance only for clients assigned to them', async (t) => {
  const { client, dbUrl, login } = await bootClient();
  t.after(() => client.close());

  const assigned = await client.post('/workspaces', {
    client_name: 'ASSIGNED-ONBOARDING-CLIENT',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
  });
  const assignedId = workspaceId(assigned.location);
  const hidden = await client.post('/workspaces', {
    client_name: 'UNASSIGNED-ONBOARDING-CANARY',
    tprm_enabled: '1',
    tprm_service_model: 'assessment_only',
  });
  assert.equal(hidden.status, 302);

  const conn = await openTestDb(dbUrl);
  const user = await conn.prepare('SELECT id FROM users WHERE email=?').get(login.email);
  await conn.prepare("UPDATE users SET firm_role='consultant' WHERE id=?").run(user.id);
  await conn.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role)
    VALUES (?,?,'consultant')`).run(assignedId, user.id);
  await conn.close();

  const page = await client.get('/onboarding');
  assert.equal(page.status, 200);
  assert.match(page.text, /ASSIGNED-ONBOARDING-CLIENT/);
  assert.match(page.text, /Engagement intake and scope sign-off/);
  assert.doesNotMatch(page.text, /UNASSIGNED-ONBOARDING-CANARY|Confirm the contracted service model/);
  assert.doesNotMatch(page.text, /href="\/admin\/(?:users|email)"/);
});

test('onboarding state changes are manager-only and skip is not completion', async (t) => {
  const { client, dbUrl, login } = await bootClient();
  t.after(() => client.close());

  const conn = await openTestDb(dbUrl);
  const firm = await conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const foreignFirm = (await conn.prepare('INSERT INTO firms (name) VALUES (?)').run('Foreign Completion Firm')).lastInsertRowid;
  await conn.prepare('INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)')
    .run(foreignFirm, 'Foreign Completion Client', '[]');

  const premature = await client.post('/onboarding/complete', {});
  assert.equal(premature.status, 302);
  assert.match(premature.location, /^\/onboarding\?/);
  let state = (await conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id)) || {
    skipped: 0,
    completed_at: null,
  };
  assert.equal(state.completed_at, null, 'a foreign-firm client cannot complete this firm onboarding');

  const skipped = await client.post('/onboarding/skip', {});
  assert.equal(skipped.status, 302);
  state = await conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.skipped, 1);
  assert.equal(state.completed_at, null, 'dismissing the guide is not completion');

  const created = await client.post('/workspaces', {
    client_name: 'Completion Client', frameworks: 'iso27001', engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);
  const createdId = workspaceId(created.location);
  const completed = await client.post('/onboarding/complete', {});
  assert.equal(completed.status, 302);
  state = await conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.skipped, 0);
  assert.ok(state.completed_at);

  const completedAt = state.completed_at;
  assert.equal((await client.post('/onboarding/complete', {})).status, 302);
  assert.equal((await conn.prepare('SELECT completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id)).completed_at,
    completedAt, 'repeated completion is idempotent');
  assert.equal((await client.post('/onboarding/skip', {})).status, 302);
  state = await conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.skipped, 0, 'a stale dismiss action cannot replace a completed state');
  assert.equal(state.completed_at, completedAt);

  const deleted = await client.post(`/workspaces/${createdId}/delete`, { confirm_name: 'Completion Client' });
  assert.equal(deleted.status, 302);
  state = await conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.completed_at, null, 'removing the final client invalidates live first-client completion');
  assert.equal((await getOnboardingProgress(conn, firm.id)).done, 0);
  const dashboard = await client.get('/dashboard?legacy=1');
  assert.match(dashboard.text, /Next:\s*Create your first client/);

  await conn.prepare("UPDATE users SET firm_role='consultant' WHERE email=?").run(login.email);
  const readOnly = await client.get('/onboarding');
  assert.equal(readOnly.status, 200);
  assert.doesNotMatch(readOnly.text, /action="\/onboarding\/(?:skip|complete)"/);
  assert.doesNotMatch(readOnly.text, /href="\/admin\/(?:users|email)"/);
  assert.equal((await client.post('/onboarding/skip', {})).status, 403);
  assert.equal((await client.post('/onboarding/complete', {})).status, 403);

  await conn.prepare("UPDATE users SET user_type='client',firm_role='client_owner' WHERE email=?").run(login.email);
  assert.equal((await client.get('/onboarding')).status, 403);
  assert.equal((await client.post('/onboarding/skip', {})).status, 403);
  assert.equal((await client.post('/onboarding/complete', {})).status, 403);

  const unchanged = await conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(unchanged.skipped, 0);
  assert.equal(unchanged.completed_at, state.completed_at);
  await conn.close();
});

async function seedClientRecords(conn, wsId, actorId) {
  const evidenceId = Number((await conn.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by) VALUES (?,?,?,?,?,?)`)
    .run(wsId, `purge-${wsId}.pdf`, `purge-${wsId}.pdf`, 'b'.repeat(64), 12, actorId)).lastInsertRowid);
  const eventId = Number((await conn.prepare(`INSERT INTO cert_cycle_events (workspace_id,event_type,actual_date,status)
    VALUES (?,'stage_1','2027-08-01','closed')`).run(wsId)).lastInsertRowid);
  const findingId = Number((await conn.prepare(`INSERT INTO nonconformities (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Purge finding','external_audit',?,'minor','open')`).run(wsId, `cert_cycle_event:${eventId}`)).lastInsertRowid);
  const linkId = Number((await conn.prepare(`INSERT INTO nonconformity_evidence_links
    (workspace_id,nonconformity_id,evidence_id,evidence_role,linked_by) VALUES (?,?,?,'validation',?)`)
    .run(wsId, findingId, evidenceId, actorId)).lastInsertRowid);
  const docId = Number((await conn.prepare(`INSERT INTO generated_docs (workspace_id,name,category,content,status,version,created_by)
    VALUES (?,'Purge policy','Policy','<p>Draft</p>','in_review',1,?)`).run(wsId, actorId)).lastInsertRowid);
  const versionId = Number((await conn.prepare(`INSERT INTO doc_versions
    (workspace_id,document_id,version,name,content,content_hash,status,created_by)
    VALUES (?,?,1,'Purge policy','<p>Frozen</p>','purge-hash','in_review',?)`).run(wsId, docId, actorId)).lastInsertRowid);
  await conn.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=?').run(versionId, docId);
  return { evidenceId, findingId, linkId, docId, versionId };
}

async function workspaceRowCounts(conn, wsId) {
  const tables = (await conn.prepare(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE' AND c.column_name='workspace_id'
    ORDER BY c.table_name`).all()).map(row => row.table_name);
  const counts = {};
  for (const table of tables) {
    const c = (await conn.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE workspace_id=?`).get(wsId)).c;
    if (c) counts[table] = c;
  }
  return counts;
}

test('deleting a populated client removes every workspace row, restores the guards, and keeps the audit chain verifiable', async (t) => {
  const { client, dbUrl, login } = await bootClient();
  const conn = await openTestDb(dbUrl);
  t.after(async () => { await conn.close(); await client.close(); });
  const { immutableMutationTriggers } = require('../lib/workspace-deletion');
  const { verifyAuditChain } = require('../db');
  const actor = await conn.prepare('SELECT id FROM users WHERE email=?').get(login.email);

  const doomed = await client.post('/workspaces', {
    client_name: 'Purged Client', frameworks: ['iso27001'], engagement_outcome: 'certification_support',
    tprm_enabled: '1', tprm_service_model: 'managed_lifecycle',
  });
  assert.equal(doomed.status, 302);
  const doomedId = workspaceId(doomed.location);
  const kept = await client.post('/workspaces', {
    client_name: 'Retained Client', frameworks: ['iso27001'], engagement_outcome: 'certification_support',
  });
  const keptId = workspaceId(kept.location);
  await seedClientRecords(conn, doomedId, actor.id);
  const retained = await seedClientRecords(conn, keptId, actor.id);

  const populated = await workspaceRowCounts(conn, doomedId);
  for (const table of ['engagement_delivery_plans', 'evidence', 'nonconformity_evidence_links', 'generated_docs', 'doc_versions', 'audit_log']) {
    assert.ok(populated[table] > 0, `the client to delete has ${table} rows`);
  }
  const keptBefore = await workspaceRowCounts(conn, keptId);
  const guardsBefore = await immutableMutationTriggers(conn);
  assert.ok(guardsBefore.some(g => g.name === 'trg_nc_evidence_link_no_delete'));

  const deleted = await client.post(`/workspaces/${doomedId}/delete`, { confirm_name: 'Purged Client' });
  assert.equal(deleted.status, 302);
  assert.match(deleted.location, /^\/dashboard\?/, 'the delete succeeds');

  assert.equal((await conn.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=?').get(doomedId)).c, 0);
  const left = await workspaceRowCounts(conn, doomedId);
  assert.deepEqual(Object.keys(left), ['audit_log'], 'only the audit trail outlives the client');
  assert.deepEqual(await workspaceRowCounts(conn, keptId), keptBefore, 'another client is untouched');
  assert.deepEqual(await immutableMutationTriggers(conn), guardsBefore, 'every immutable guard is enabled again');
  await assert.rejects(conn.prepare('DELETE FROM nonconformity_evidence_links WHERE id=?').run(retained.linkId), /immutable/);
  assert.deepEqual(await verifyAuditChain(), [], 'the audit hash chain still verifies end to end');
  const record = await conn.prepare(`SELECT details FROM audit_log WHERE action='delete_workspace' AND entity_id=?`).get(String(doomedId));
  assert.ok(record, 'the deletion itself is recorded');
});

test('deleting a tenant removes its clients, users and firm records, and keeps the audit chain verifiable', async (t) => {
  const { client, app, dbUrl } = await bootClient();
  const conn = await openTestDb(dbUrl);
  const { makeClient } = require('./helpers');
  const bcrypt = require('bcrypt');
  const { verifyAuditChain } = require('../db');
  const tenant = makeClient(app);
  t.after(async () => { await conn.close(); await tenant.close(); await client.close(); });

  const firmId = Number((await conn.prepare("INSERT INTO firms (name) VALUES ('Departing Tenant')").run()).lastInsertRowid);
  const password = 'departing-manager-1234';
  const managerId = Number((await conn.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('departing-manager@example.com',?,'Departing Manager','firm',?,'manager',1)`)
    .run(bcrypt.hashSync(password, 4), firmId)).lastInsertRowid);
  const page = await tenant.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.equal((await tenant.post('/login', { email: 'departing-manager@example.com', password, _csrf: csrf }, { csrf: false })).status, 302);
  await tenant.get('/tenants');
  const created = await tenant.post('/workspaces', {
    client_name: 'Departing Client', frameworks: ['iso27001'], engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);
  const wsId = workspaceId(created.location);
  await seedClientRecords(conn, wsId, managerId);
  const otherFirmWorkspaces = (await conn.prepare('SELECT COUNT(*) c FROM workspaces WHERE firm_id<>?').get(firmId)).c;

  const deleted = await tenant.post(`/tenants/${firmId}/delete`, { confirm_name: 'Departing Tenant' });
  assert.equal(deleted.status, 302, deleted.text.slice(0, 300));
  assert.equal((await conn.prepare('SELECT COUNT(*) c FROM firms WHERE id=?').get(firmId)).c, 0);
  assert.equal((await conn.prepare('SELECT COUNT(*) c FROM users WHERE firm_id=? OR id=?').get(firmId, managerId)).c, 0);
  assert.deepEqual(Object.keys(await workspaceRowCounts(conn, wsId)), ['audit_log']);
  const firmTables = (await conn.prepare(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE' AND c.column_name='firm_id'`).all()).map(r => r.table_name);
  for (const table of firmTables) {
    assert.equal((await conn.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE firm_id=?`).get(firmId)).c, 0, `${table} rows of the tenant remain`);
  }
  assert.equal((await conn.prepare('SELECT COUNT(*) c FROM workspaces WHERE firm_id<>?').get(firmId)).c, otherFirmWorkspaces);
  assert.equal((await conn.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action='delete_firm' AND entity_id=?`).get(String(firmId))).c, 1);
  assert.deepEqual(await verifyAuditChain(), [], 'the audit hash chain still verifies end to end');
});
