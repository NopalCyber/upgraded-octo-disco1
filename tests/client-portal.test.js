'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, openTestDb } = require('./helpers');

let env;
let db;
let manager;
let contributor;
let clientOwner;
let workspaceId;
let otherWorkspaceId;
let contributorId;
let clientOwnerId;
let otherContributorId;
let managerId;
let requestId;
let policyId;

async function login(client, email, password) {
  const page = await client.get('/login');
  const token = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(token, 'login CSRF token should render');
  const result = await client.post('/login', { email, password, _csrf: token }, { csrf: false });
  assert.ok(result.status >= 300 && result.status < 400, `login failed with ${result.status}`);
  await client.get('/dashboard');
}

test.before(async () => {
  env = await bootClient();
  manager = env.client;
  db = await openTestDb(env.dbUrl);
  const firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare(`SELECT id FROM users WHERE email='sec-test@example.com'`).get()).id;
  workspaceId = Number((await db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage, locale) VALUES (?, 'Portal Client', 'gap_assessment', 'en-GB')`).run(firmId)).lastInsertRowid);
  otherWorkspaceId = Number((await db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage) VALUES (?, 'Other Client', 'gap_assessment')`).run(firmId)).lastInsertRowid);
  const pw = bcrypt.hashSync('client-test-password-1234', 4);
  contributorId = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES ('portal-client@example.com',?,'Portal Contributor','client',1)`).run(pw)).lastInsertRowid);
  otherContributorId = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES ('other-client@example.com',?,'Other Contributor','client',1)`).run(pw)).lastInsertRowid);
  clientOwnerId = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES ('portal-owner@example.com',?,'Portal Sponsor','client',1)`).run(pw)).lastInsertRowid);
  await db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'contributor')`).run(workspaceId, contributorId);
  await db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'contributor')`).run(workspaceId, otherContributorId);
  await db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')`).run(workspaceId, clientOwnerId);
  policyId = Number((await db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,version,created_by)
    VALUES (?, 'Scoped Security Policy', 'Policy', '<h2>Safe heading</h2><script>window.portalPwned=1</script><p onclick="window.portalPwned=2">Policy body</p>', 'draft', 1, ?)`)
    .run(workspaceId, managerId)).lastInsertRowid);
  await db.prepare(`INSERT INTO member_scopes (workspace_id,user_id,scope_type,scope_id,granted_by)
    VALUES (?,?,'document',?,?)`).run(workspaceId, contributorId, String(policyId), managerId);
  assert.ok(managerId);

  const page = await manager.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  const created = await manager.post(`/workspaces/${workspaceId}/client-portal/requests`, {
    request_type: 'control', title: 'Explain access review operation',
    description: 'Describe the quarterly process and attach a reviewed sample.',
    priority: 'high', assignee_id: String(contributorId), control_id: 'annex-a.5.18',
    due_date: '2026-09-01'
  });
  assert.equal(created.status, 302);
  requestId = Number((created.location.match(/\/requests\/(\d+)/) || [])[1]);
  assert.ok(requestId);

  contributor = makeClient(env.app);
  await login(contributor, 'portal-client@example.com', 'client-test-password-1234');
  clientOwner = makeClient(env.app);
  await login(clientOwner, 'portal-owner@example.com', 'client-test-password-1234');
});

test.after(async () => {
  if (db) await db.close();
  if (contributor) await contributor.close();
  if (clientOwner) await clientOwner.close();
  if (manager) await manager.close();
});

test('request creation records scope, event history, and audit entry', async () => {
  const request = await db.prepare('SELECT * FROM client_requests WHERE id=? AND workspace_id=?').get(requestId, workspaceId);
  assert.equal(request.assignee_id, contributorId);
  assert.equal(request.control_id, 'annex-a.5.18');
  assert.equal(request.status, 'open');
  assert.ok(await db.prepare(`SELECT 1 FROM member_scopes WHERE workspace_id=? AND user_id=? AND scope_type='control' AND scope_id='annex-a.5.18'`).get(workspaceId, contributorId));
  assert.ok(await db.prepare(`SELECT 1 FROM client_request_events WHERE request_id=? AND event_type='created'`).get(requestId));
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND entity_type='client_request' AND entity_id=? AND action='create_client_request'`).get(workspaceId, String(requestId)));
});

test('invalid request creation preserves input and identifies the exact fields to fix', async () => {
  const invalid = await manager.post(`/workspaces/${workspaceId}/client-portal/requests`, {
    request_type: 'policy', priority: 'high', assignee_id: String(contributorId),
    title: 'Preserve this carefully written request',
    description: 'The acceptance criteria must still be here after a validation error.',
    document_id: '', due_date: '2026-02-30'
  });
  assert.equal(invalid.status, 422);
  const page = invalid;
  assert.match(page.text, /id="new-request"[^>]*open/);
  assert.match(page.text, /Check the highlighted fields/);
  assert.match(page.text, /Choose the policy this request concerns/);
  assert.match(page.text, /Enter a valid calendar date/);
  assert.match(page.text, /value="Preserve this carefully written request"/);
  assert.match(page.text, /The acceptance criteria must still be here after a validation error/);
  assert.match(page.text, /id="request-document"[^>]*aria-invalid="true"[^>]*aria-describedby="request-document-error"/);
  assert.match(page.text, /id="request-due-date"[^>]*aria-invalid="true"[^>]*aria-describedby="request-due-date-error"/);
});

test('consultant workspace navigation groups the ISO 27001 journey without a duplicate audit-pack entry', async () => {
  const page = await manager.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/<details class="nav-domain(?! nav-programme)[ "]/g) || []).length, 5);
  const programmeGroup = label => page.text.split('<details class="nav-domain nav-programme').slice(1)
    .map(block => block.split('</details>')[0])
    .find(block => block.includes(`nav-domain-text">${label}<`)) || '';
  assert.match(programmeGroup('ISO 27001'), /<span>Gap assessment<\/span>/);
  assert.doesNotMatch(page.text, /nav-item-text">Audit pack/);
});

test('consultants can open a read-only client-shell preview without impersonating a client', async () => {
  const preview = await manager.get(`/workspaces/${workspaceId}/client-portal?preview=client`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Client view preview/);
  assert.match(preview.text, /read-only and does not impersonate a client account/i);
  assert.match(preview.text, /Your engagement/);
  assert.match(preview.text, /Read-only client preview/);
  assert.match(preview.text, new RegExp(`/workspaces/${workspaceId}/engagement-plan[^>]*>Exit preview<`));
  assert.match(preview.text, /nav-item-text">Home/);
  assert.match(preview.text, new RegExp(`href="/workspaces/${workspaceId}/client-portal\\?view=progress&amp;preview=client#programme-iso27001"`));
  assert.match(preview.text, /id="programme-iso27001"/);
  assert.match(preview.text, /Search this engagement/);
  assert.doesNotMatch(preview.text, /Consultant view|Create a client request|title="Inbox"/);
  assert.doesNotMatch(preview.text, /action="[^\"]+"[^>]*method="POST"/i);
});

test('contributor is redirected from workspace root and blocked from legacy workspace routes', async () => {
  const root = await contributor.get(`/workspaces/${workspaceId}`);
  assert.equal(root.status, 302);
  assert.equal(root.location, `/workspaces/${workspaceId}/client-portal`);
  const legacy = await contributor.get(`/workspaces/${workspaceId}/controls`);
  assert.equal(legacy.status, 403);
  assert.match(legacy.text, /limited to the client portal/i);
});

test('client accounts never render the consulting firm dashboard after login', async () => {
  for (const client of [clientOwner, contributor]) {
    const dashboard = await client.get('/dashboard');
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.location, `/workspaces/${workspaceId}/client-portal`);
  }
});

test('client sponsor is portal-only despite seeing all shared client work', async () => {
  const root = await clientOwner.get(`/workspaces/${workspaceId}`);
  assert.equal(root.status, 302);
  assert.equal(root.location, `/workspaces/${workspaceId}/client-portal`);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/controls`)).status, 403);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/members`)).status, 403);
  const portal = await clientOwner.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(portal.status, 200);
  assert.doesNotMatch(portal.text, /My action centre/);
  assert.match(portal.text, /client-portal\?view=actions/);
  assert.match(portal.text, /client-portal\?view=progress/);
  assert.match(portal.text, new RegExp(`href="/workspaces/${workspaceId}/client-portal\\?view=progress#programme-iso27001"`));
  assert.match(portal.text, /View programme/);
  assert.match(portal.text, /Explain access review operation/);
});

test('every client account receives the same restricted client workspace shell', async () => {
  for (const client of [clientOwner, contributor]) {
    const portal = await client.get(`/workspaces/${workspaceId}/client-portal`);
    assert.equal(portal.status, 200);

    for (const destination of ['Home', 'My actions', 'Progress']) {
      assert.match(portal.text, new RegExp(`nav-item-text">${destination}`));
    }
    for (const section of ['engagement-progress', 'action-list', 'team-help']) {
      assert.match(portal.text, new RegExp(`id="${section}"`));
    }

    assert.match(portal.text, /Client portal/);
    assert.match(portal.text, /Your engagement/);
    assert.match(portal.text, /Engagement progress/);
    assert.match(portal.text, /Your engagement contacts/);
    assert.match(portal.text, /Portal help/);
    assert.match(portal.text, /Search this engagement/);
    assert.match(portal.text, /class="palette-trigger"/);
    assert.doesNotMatch(portal.text, /Create a client request|Go to \(within a client\)|Search controls, risks, documents, clients/);

    for (const internalLabel of [
      'ISO 27001 programme', 'Plan &amp; work', 'Settings',
      'All clients', 'Other Client'
    ]) {
      assert.doesNotMatch(portal.text, new RegExp(`nav-item-text">${internalLabel}`));
    }
    assert.doesNotMatch(portal.text, /title="Inbox"/);
  }
});

test('client search is restricted to client-visible engagement destinations', async () => {
  const actual = await clientOwner.get(`/api/search?wsId=${workspaceId}&q=report`);
  assert.equal(actual.status, 200);
  const actualResults = JSON.parse(actual.text);
  assert.ok(actualResults.length > 0);
  assert.ok(actualResults.every(result => result.href.startsWith(`/workspaces/${workspaceId}/client-portal?`)));
  assert.ok(actualResults.every(result => result.type === 'Page'));

  const preview = await manager.get(`/api/search?wsId=${workspaceId}&clientMode=1&q=progress`);
  assert.equal(preview.status, 200);
  const previewResults = JSON.parse(preview.text);
  assert.ok(previewResults.length > 0);
  assert.ok(previewResults.every(result => result.href.includes('preview=client')));
  assert.doesNotMatch(actual.text + preview.text, /\/risks\/|\/controls\/|\/documents\/|Other Client/);
});

test('ISO 27001 clients receive a governed five-stage gap-assessment journey', async () => {
  const page = await clientOwner.get(`/workspaces/${workspaceId}/client-portal#gap-assessment`);
  assert.equal(page.status, 200);
  for (const heading of ['Mobilisation', 'Fieldwork', 'Validation', 'Report', 'Post-report']) {
    assert.match(page.text, new RegExp(`>${heading}<`));
  }
  assert.match(page.text, /Clause and Annex A boundary/);
  assert.match(page.text, /How each requirement is rated/);
  assert.match(page.text, /E1[\s\S]*Documented design[\s\S]*E2[\s\S]*Operating record[\s\S]*E3[\s\S]*Tested assurance/);
  assert.match(page.text, /RFI and document tracker/);
});

test('fieldwork interviews use governed records, publish weekly snapshots, and never infer new task titles', async () => {
  const passId = Number((await db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by) VALUES (?,1,'Portal fieldwork','in_progress',?)`)
    .run(workspaceId, managerId)).lastInsertRowid);
  await db.prepare(`INSERT INTO tasks (workspace_id,title,description,status,created_by)
    VALUES (?,'Ghost interview task','This ordinary task must not enter the interview schedule','done',?)`)
    .run(workspaceId, managerId);

  const managerPage = await manager.get(`/workspaces/${workspaceId}/gap-assessment/fieldwork`);
  assert.equal(managerPage.status, 200);
  assert.match(managerPage.text, /Structured interview records replace task-title inference/);
  assert.doesNotMatch(managerPage.text, /Ghost interview task/);

  const created = await manager.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/interviews`, {
    title: 'Risk ownership and operations interview',
    participant_role: 'Head of IT operations',
    objective: 'Confirm ownership, review cadence and retained operating evidence.',
    owner_id: String(managerId), scheduled_at: '2026-09-04T10:30', duration_minutes: '60', client_visible: '1'
  });
  assert.equal(created.status, 302);
  let interview = await db.prepare(`SELECT * FROM gap_fieldwork_interviews
    WHERE workspace_id=? AND assessment_pass_id=? AND source_task_id IS NULL`).get(workspaceId, passId);
  assert.ok(interview);
  assert.equal(interview.status, 'scheduled');

  const completed = await manager.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/interviews/${interview.id}/status`, {
    row_version: String(interview.row_version), status: 'completed',
    completion_summary: 'Ownership and review cadence were confirmed; supporting records remain tracked through the RFI log.'
  });
  assert.equal(completed.status, 302);
  interview = await db.prepare('SELECT * FROM gap_fieldwork_interviews WHERE id=?').get(interview.id);
  assert.equal(interview.status, 'completed');
  assert.ok(interview.completed_at);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND action='update_gap_interview' AND entity_id=?`)
    .get(workspaceId, String(interview.id)));

  const frozen = await manager.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/snapshots`, {
    week_ending: '2026-09-04'
  });
  assert.equal(frozen.status, 302);
  const snapshot = await db.prepare(`SELECT * FROM gap_fieldwork_snapshots WHERE workspace_id=? AND assessment_pass_id=?`)
    .get(workspaceId, passId);
  assert.equal(snapshot.interviews_completed, 1);
  assert.equal(snapshot.interviews_planned, 1);
  assert.equal(snapshot.snapshot_hash.length, 64);

  const portal = await clientOwner.get(`/workspaces/${workspaceId}/client-portal#gap-fieldwork`);
  assert.equal(portal.status, 200);
  assert.match(portal.text, /Risk ownership and operations interview/);
  assert.match(portal.text, /Head of IT operations/);
  assert.match(portal.text, /Frozen fieldwork record/);
  assert.match(portal.text, /1\/1/);
  assert.doesNotMatch(portal.text, /Ghost interview task/);
});

test('contributor sees only assigned requests and can open its scoped control', async () => {
  const second = await manager.post(`/workspaces/${workspaceId}/client-portal/requests`, {
    request_type: 'action', title: 'Request belonging to someone else', priority: 'normal',
    assignee_id: String(otherContributorId), due_date: '2026-09-02'
  });
  assert.equal(second.status, 302);
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Explain access review operation/);
  assert.doesNotMatch(page.text, /Request belonging to someone else/);
  assert.doesNotMatch(page.text, /Other Client/);
  assert.doesNotMatch(page.text, /nav-domain-summary/);
  const control = await contributor.get(`/workspaces/${workspaceId}/client-portal/controls/annex-a.5.18`);
  assert.equal(control.status, 200);
  assert.match(control.text, /Access rights/);
});

test('contributor cannot access a different workspace or another assignee request', async () => {
  const otherWs = await contributor.get(`/workspaces/${otherWorkspaceId}/client-portal`);
  assert.equal(otherWs.status, 403);
  const otherRequest = await db.prepare('SELECT id FROM client_requests WHERE workspace_id=? AND assignee_id=?').get(workspaceId, otherContributorId);
  const detail = await contributor.get(`/workspaces/${workspaceId}/client-portal/requests/${otherRequest.id}`);
  assert.equal(detail.status, 404);
});

test('scoped policy review sanitizes stored HTML before rendering to clients', async () => {
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal/policies/${policyId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Safe heading/);
  assert.match(page.text, /Policy body/);
  assert.doesNotMatch(page.text, /window\.portalPwned/);
  const controlledBody = (page.text.match(/<article class="panel-pad doc-content"[^>]*>([\s\S]*?)<\/article>/) || [])[1];
  assert.ok(controlledBody, 'controlled policy body should render');
  assert.doesNotMatch(controlledBody, /onclick=/i);
});

test('request transition uses optimistic concurrency and appends an event', async () => {
  const detail = await contributor.get(`/workspaces/${workspaceId}/client-portal/requests/${requestId}`);
  assert.equal(detail.status, 200);
  const current = (await db.prepare('SELECT version FROM client_requests WHERE id=?').get(requestId)).version;
  const transition = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/transition`, {
    status: 'in_progress', response_note: 'Reviewing the sample now.', version: String(current)
  });
  assert.equal(transition.status, 302);
  const updated = await db.prepare('SELECT status, version FROM client_requests WHERE id=?').get(requestId);
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.version, current + 1);
  assert.ok(await db.prepare(`SELECT 1 FROM client_request_events WHERE request_id=? AND event_type='status_changed' AND from_status='open' AND to_status='in_progress'`).get(requestId));

  const stale = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/transition`, {
    status: 'submitted', response_note: 'Stale browser submission.', version: String(current)
  });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /changed in another session/i);
});

test('client portal excludes unassigned delivery work and blocks evidence-free submission once assigned', async () => {
  assert.equal((await manager.get(`/workspaces/${workspaceId}/engagement-plan`)).status, 200);
  const rows = await db.prepare(`SELECT d.id,d.title FROM engagement_delivery_deliverables d JOIN engagement_delivery_plans p ON p.id=d.plan_id WHERE p.workspace_id=? ORDER BY d.id LIMIT 2`).all(workspaceId);
  await db.prepare(`UPDATE engagement_delivery_deliverables SET due_date='2020-08-20' WHERE id=?`).run(rows[0].id);
  const unassignedPage = await clientOwner.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
  assert.doesNotMatch(unassignedPage.text, new RegExp(`id="work-engagement_deliverable-${rows[0].id}"`));
  assert.doesNotMatch(unassignedPage.text, /Kick-off records and role acknowledgements/);
  assert.doesNotMatch(unassignedPage.text, /20 Aug 2020/);
  await db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`).run(contributorId, managerId, rows[0].id);
  await db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`).run(otherContributorId, managerId, rows[1].id);
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="action-list"/);
  assert.match(page.text, /Requests, deliverables, approvals and information checks in one list/);
  assert.match(page.text, /Kick-off records and role acknowledgements/);
  assert.doesNotMatch(page.text, /Completed engagement intake and draft scope statement/);
  assert.match(page.text, new RegExp(`/client-portal/deliverables/${rows[0].id}`));
  const detail = await contributor.get(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /What completion requires/);
  assert.match(detail.text, /All supporting files/);
  assert.match(detail.text, /for="delivery-file"/);
  assert.match(detail.text, /for="delivery-comment"/);
  assert.match(detail.text, /disabled>Submit for review/);
  assert.equal((await contributor.get(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[1].id}`)).status, 404);

  const blocked = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/submit`, { note: 'No evidence attached.' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.text, /Upload and link at least one evidence file/i);
  assert.equal((await db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id)).status, 'draft');
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id=? AND entity_type='engagement_deliverable' AND entity_id=? AND action='client_submit_delivery_deliverable'`).get(workspaceId, String(rows[0].id))).c, 0);

  const evidenceId = Number((await db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?, 'client-evidence.pdf', 'test-client-evidence.pdf', 'client-evidence-sha', 128, ?, 'Client submission evidence')`)
    .run(workspaceId, contributorId)).lastInsertRowid);
  await db.prepare(`INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`)
    .run(workspaceId, rows[0].id, evidenceId, contributorId);

  const readyPage = await contributor.get(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}`);
  assert.match(readyPage.text, /client-evidence.pdf/);
  assert.doesNotMatch(readyPage.text, /disabled>Submit for review/);
  const submitted = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/submit`, { note: 'Ready for formal review.' });
  assert.equal(submitted.status, 302);
  assert.equal((await db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id)).status, 'submitted');
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND entity_type='engagement_deliverable' AND entity_id=? AND action='client_submit_delivery_deliverable'`).get(workspaceId, String(rows[0].id)));
  const underReviewPage = await contributor.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
  const waitingRow = (underReviewPage.text.match(new RegExp(`<article[^>]*id="work-engagement_deliverable-${rows[0].id}"[\\s\\S]*?</article>`)) || [])[0];
  assert.ok(waitingRow, 'submitted work remains visible in the shared action queue');
  assert.match(waitingRow, /Waiting on engagement team/);
  assert.doesNotMatch(waitingRow, /Submit for review/);
  await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/accept`, { note: 'Owner must not self-approve.' });
  assert.equal((await db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id)).status, 'submitted', 'non-approver cannot accept');
  await manager.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/accept`, { note: 'Accepted against the linked evidence.' });
  assert.equal((await db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id)).status, 'accepted');
});

test('gap-only client cannot replay a direct link to retained implementation work', async () => {
  await db.prepare(`UPDATE workspaces SET frameworks='["iso27001"]',engagement_outcome='gap_assessment_only' WHERE id=?`).run(workspaceId);
  const hidden = await db.prepare(`SELECT d.id,d.status FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases p ON p.id=m.phase_id
    WHERE d.workspace_id=? AND p.phase_key='implementation' ORDER BY d.id LIMIT 1`).get(workspaceId);
  assert.ok(hidden, 'full-path implementation row is retained for an additive future conversion');
  await db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`)
    .run(contributorId, managerId, hidden.id);

  const comment = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${hidden.id}/comments`, {
    body: 'A replayed hidden-row comment must be rejected.'
  });
  assert.equal(comment.status, 400);
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM comments WHERE workspace_id=? AND parent_type='engagement_deliverable' AND parent_id=?`)
    .get(workspaceId, String(hidden.id))).c, 0);

  const submit = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${hidden.id}/submit`, {
    note: 'A replayed hidden-row transition must be rejected.'
  });
  assert.equal(submit.status, 400);
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_deliverables WHERE id=?').get(hidden.id)).status, hidden.status);
});

test('portal POST routes remain CSRF protected', async () => {
  const noCsrf = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/comments`,
    { body: 'This must be rejected.' }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM comments WHERE workspace_id=? AND parent_type='client_request' AND parent_id=?`).get(workspaceId, String(requestId))).c, 0);
});
