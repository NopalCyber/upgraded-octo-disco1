'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./helpers');

let env;
let db;
let delivery;
let governanceRoutes;
let firmId;
let actorId;

async function workspace(name, frameworks = ['iso27001']) {
  const id = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,created_at)
    VALUES (?,?,'implementation',?,'certification_support','2026-01-01')`).run(
      firmId, name, JSON.stringify(frameworks))).lastInsertRowid);
  const row = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = frameworks;
  return row;
}

test.before(async () => {
  env = await bootApp();
  db = env.db;
  delivery = require('../lib/engagement-delivery');
  governanceRoutes = require('../routes/governance');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  actorId = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()).id;
});

test('Stage 1 and Stage 2 accept only valid, unique and chronological audit records', async () => {
  const ws = await workspace('Certification event integrity client');
  assert.equal(delivery.isValidISODate('2028-02-29'), true);
  assert.equal(delivery.isValidISODate('2027-02-29'), false);
  assert.equal(delivery.isValidISODate('2027-2-09'), false);

  let result = await delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_1', planned_date: '2027-02-29', status: 'planned'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /valid ISO date/i);

  result = await delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_2', actual_date: '2027-09-01', status: 'closed'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /until exactly one retained Stage 1/i);

  const stage1Id = Number((await db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-09-10','closed')`)
    .run(ws.id)).lastInsertRowid);
  result = await delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_2', actual_date: '2027-09-01', status: 'closed'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /cannot be before/i);

  result = await delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_2', actual_date: '2027-09-11', status: 'closed'
  });
  assert.equal(result.valid, true);
  await db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_2','2027-09-11','closed')`).run(ws.id);

  result = await delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_1', actual_date: '2027-09-12', status: 'closed'
  }, { excludeEventId: stage1Id });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /cannot be after/i);

  result = await delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_1', actual_date: '2027-09-10', status: 'closed'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /already exists/i);

  await db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-09-10','closed')`).run(ws.id);
  const ambiguous = await delivery.certificationAuditState(db, ws.id, 'stage_1');
  assert.equal(ambiguous.eventCount, 2);
  assert.equal(ambiguous.duplicateEvents, 1);
  assert.equal(ambiguous.auditComplete, false, 'duplicate legacy rows cannot satisfy the completion gate');
  assert.equal((await delivery.stage2AssuranceState(db, ws.id)).auditComplete, false,
    'Stage 2 cannot satisfy completion while Stage 1 lineage is ambiguous');

  const invalidLegacy = await workspace('Invalid legacy certification date client');
  await db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,planned_date,actual_date,status)
    VALUES (?,'stage_1','2027-02-29','2027-03-01','closed')`).run(invalidLegacy.id);
  const invalidState = await delivery.certificationAuditState(db, invalidLegacy.id, 'stage_1');
  assert.equal(invalidState.invalidDateEvents, 1);
  assert.equal(invalidState.auditComplete, false, 'an invalid retained planned date cannot satisfy the audit gate');
});

test('an invalidated completed plan reopens with an immutable event trail', async () => {
  const ws = await workspace('Reconciliation client');
  const plan = await delivery.ensurePlan(db, ws, actorId);
  await db.prepare(`UPDATE engagement_delivery_plans SET status='completed' WHERE id=?`).run(plan.id);
  const stage1Id = Number((await db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-08-01','closed')`)
    .run(ws.id)).lastInsertRowid);
  const findingId = Number((await db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Reopened Stage 1 observation','external_audit',?,'observation','open')`).run(
      ws.id, `cert_cycle_event:${stage1Id}`)).lastInsertRowid);

  assert.equal((await delivery.certificationFindingLineage(db, ws.id, findingId)).event_type, 'stage_1');
  const reconciled = await delivery.reconcileCompletionState(db, ws, actorId, {
    reason: 'A generic status change reopened the certification observation.',
    details: { finding_id: findingId }
  });
  assert.equal(reconciled.planReopened, true);
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id)).status, 'active');
  const event = await db.prepare(`SELECT details FROM engagement_delivery_events
    WHERE plan_id=? AND action='reopened_after_completion_invalidated' ORDER BY id DESC LIMIT 1`).get(plan.id);
  assert.ok(event);
  assert.equal(JSON.parse(event.details).finding_id, findingId);

  assert.equal((await delivery.reconcileCompletionState(db, ws, actorId)).changed, false,
    'reconciliation is idempotent once the plan is active');

  await db.prepare(`UPDATE engagement_delivery_plans SET status='completed' WHERE id=?`).run(plan.id);
  const synced = await delivery.syncOutcomePlanStatus(db, ws, actorId);
  assert.equal(synced.changed, true, 'status synchronization also reconciles a stale completed record');
  assert.equal(synced.status, 'active');
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id)).status, 'active');
});

test('explicit non-ISO workspaces cannot seed or project an ISO delivery plan', async () => {
  const nonIso = await workspace('Non-ISO programme client', ['other_programme']);
  assert.equal(await delivery.ensurePlan(db, nonIso, actorId), null);
  assert.equal(await delivery.getProjection(db, nonIso, actorId), null);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(nonIso.id)).c, 0);

  const legacy = await workspace('Legacy unselected framework fixture', []);
  const legacyPlan = await delivery.ensurePlan(db, legacy, actorId);
  assert.ok(legacyPlan, 'empty legacy fixtures retain backward-compatible plan behavior');
  const fullDeliverable = await db.prepare(`SELECT id FROM engagement_delivery_deliverables WHERE plan_id=? ORDER BY id LIMIT 1`)
    .get(legacyPlan.id);
  assert.equal(await delivery.isDeliverableInOutcomeScope(db, legacy, fullDeliverable.id), true);
  assert.equal(await delivery.isDeliverableInOutcomeScope(db, nonIso, fullDeliverable.id), false);
});

test('generic governance routes cannot rewrite or delete certification finding lineage', async () => {
  const ws = await workspace('Immutable finding lineage client');
  const eventId = Number((await db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-08-01','closed')`)
    .run(ws.id)).lastInsertRowid);
  const findingId = Number((await db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Certification finding','external_audit',?,'minor','open')`).run(
      ws.id, `cert_cycle_event:${eventId}`)).lastInsertRowid);

  const handlers = {};
  const middleware = (_req, _res, next) => next();
  const app = {
    get() {},
    post(route, ...stack) { handlers[route] = stack[stack.length - 1]; }
  };
  governanceRoutes.register(app, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction() {},
    workspaceProgress() { return {}; }
  });
  const response = () => ({
    statusCode: 200,
    redirected: null,
    status(code) { this.statusCode = code; return this; },
    send(message) { this.message = message; return message; },
    redirect(url) { this.redirected = url; return url; }
  });

  let res = response();
  await handlers['/workspaces/:wsId/nonconformities/:id']({
    params: { id: String(findingId) },
    workspace: ws,
    user: { id: actorId },
    body: { source: 'other', source_ref: '', status: 'open' }
  }, res);
  assert.match(res.redirected, /toastKind=error/);
  let retained = await db.prepare('SELECT source,source_ref FROM nonconformities WHERE id=?').get(findingId);
  assert.equal(retained.source, 'external_audit');
  assert.equal(retained.source_ref, `cert_cycle_event:${eventId}`);

  res = response();
  await handlers['/workspaces/:wsId/nonconformities/:id/delete']({
    params: { id: String(findingId) }, workspace: ws, user: { id: actorId }, body: {}
  }, res);
  assert.match(res.redirected, /toastKind=error/);
  retained = await db.prepare('SELECT id FROM nonconformities WHERE id=?').get(findingId);
  assert.equal(retained.id, findingId);
});
