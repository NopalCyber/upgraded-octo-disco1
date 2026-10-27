'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient, openTestDb } = require('./helpers');

let env, client, db, actor, wsId, contributorId;

async function addClientMember(email, name, role) {
  const id = Number((await db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active)
    VALUES (?, '!noauth', ?, 'client', 1)`).run(email, name)).lastInsertRowid);
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, id, role);
  return id;
}

async function draftRequest(title) {
  const created = await client.post(`/workspaces/${wsId}/client-portal/requests`,
    { request_type: 'evidence', title, description: 'Provide the approved AI management system scope.' });
  assert.equal(created.status, 302, created.text.slice(0, 200));
  const row = await db.prepare('SELECT * FROM client_requests WHERE workspace_id=? ORDER BY id DESC').get(wsId);
  assert.equal(row.released_at, null, 'a request with no assignee starts as a draft');
  return row;
}

const outboxFor = async requestId => await db.prepare(`SELECT o.*, n.title, n.user_id, n.severity
  FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id
  WHERE o.workspace_id=? AND o.source_type='request' AND o.source_id=?`).all(wsId, String(requestId));
const shareEvents = async requestId => (await db.prepare(`SELECT COUNT(*) c FROM client_request_events
  WHERE request_id=? AND event_type='target_updated'`).get(requestId)).c;
const visibleTo = async (row, userId) => (await require('../lib/client-work-policy').clientWorkPolicy({
  db, workspace: await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId),
  actor: await db.prepare('SELECT * FROM users WHERE id=?').get(userId), sourceType: 'request',
  row: await db.prepare('SELECT * FROM client_requests WHERE id=?').get(row.id),
})).visible;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = await openTestDb(env.dbUrl);
  actor = await db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number((await db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome)
    VALUES (?, 'Aurora Diagnostics', '["iso27001"]', 'certification_support')`).run(actor.firm_id)).lastInsertRowid);
  contributorId = await addClientMember('contributor@aurora.example', 'Theo Contributor', 'contributor');
});
test.after(async () => { db?.close(); await client?.close(); });

test('an unassigned request with no client coordinator is refused, not reported as shared', async () => {
  const row = await draftRequest('Unassigned AI scope evidence');
  const release = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });

  assert.equal(release.status, 422, release.text.slice(0, 300));
  assert.match(release.text, /has no assignee/);
  assert.match(release.text, /Assign it to an active client team member/);

  const after = await db.prepare('SELECT * FROM client_requests WHERE id=?').get(row.id);
  assert.equal(after.released_at, null, 'the refused share left the request unreleased');
  assert.equal(after.released_by, null);
  assert.equal(after.version, row.version, 'the refused share did not consume the request version');
  assert.equal(await shareEvents(row.id), 0, 'no share event survived the rollback');
  assert.equal((await outboxFor(row.id)).length, 0);
  assert.equal(await visibleTo(row, contributorId), false, 'an unassigned request stays outside a contributor scope');
});

test('an inactive client coordinator cannot receive a share either', async () => {
  const dormantId = await addClientMember('dormant-owner@aurora.example', 'Dormant Owner', 'client_owner');
  await db.prepare('UPDATE users SET active=0 WHERE id=?').run(dormantId);
  const row = await draftRequest('Share aimed at a dormant owner');

  const release = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });
  assert.equal(release.status, 422, release.text.slice(0, 300));
  assert.equal((await db.prepare('SELECT released_at FROM client_requests WHERE id=?').get(row.id)).released_at, null);
  assert.equal((await outboxFor(row.id)).length, 0, 'a dormant account is not a reachable recipient');
});

test('the same share succeeds once an active coordinator can receive it, and queues one notice', async () => {
  const ownerId = await addClientMember('owner@aurora.example', 'Priya Owner', 'client_owner');
  const row = await draftRequest('Shareable AI scope evidence');

  const release = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });
  assert.equal(release.status, 302, release.text.slice(0, 300));
  assert.match(release.location, /toast=Request%20shared%20with%20the%20client%20team/);

  const shared = await db.prepare('SELECT * FROM client_requests WHERE id=?').get(row.id);
  assert.ok(shared.released_at, 'the request is released');
  assert.equal(Number(shared.released_by), Number(actor.id));
  assert.equal(await shareEvents(row.id), 1);

  const queued = await outboxFor(row.id);
  assert.equal(queued.length, 1, 'exactly one recipient, queued once');
  assert.equal(Number(queued[0].recipient_id), ownerId, 'the coordinator who can act on it');
  assert.equal(queued[0].status, 'pending', 'queued for the outbox, not sent from the request');
  assert.match(queued[0].title, /^Request shared: Shareable AI scope evidence$/);
  assert.equal(await visibleTo(row, ownerId), true);
  assert.equal(await visibleTo(row, contributorId), false, 'releasing to the team queue is not a contributor disclosure');

  const replay = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });
  assert.equal(replay.status, 409);
  assert.equal((await outboxFor(row.id)).length, 1, 'the replay queued nothing new');
  assert.equal(await shareEvents(row.id), 1);
  assert.equal((await db.prepare('SELECT released_at FROM client_requests WHERE id=?').get(row.id)).released_at, shared.released_at);
});

test('a share aimed at its assignee reaches that assignee and nobody else', async () => {
  const row = await draftRequest('Assigned AI scope evidence');
  const assigned = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/assign`,
    { version: String(row.version), assignee_id: String(contributorId) });
  assert.equal(assigned.status, 302, assigned.text.slice(0, 300));

  const queued = await outboxFor(row.id);
  assert.equal(queued.length, 1, 'the assignee alone is told');
  assert.equal(Number(queued[0].recipient_id), contributorId);
  assert.equal(queued[0].status, 'pending');
  assert.equal(await visibleTo(row, contributorId), true, 'the assignee can open what they were told about');
});
