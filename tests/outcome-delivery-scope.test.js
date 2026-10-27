'use strict';
const { everyAsync } = require('../lib/async-array');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootApp } = require('./helpers');

let env;
let db;
let delivery;
let scope;
let notificationsRoutes;
let dashboardRoutes;
let workspaceOpsRoutes;
let jobs;
let buildIntegratedDashboard;

let firmId;
let managerId;
let clientId;

async function createWorkspace(name, outcome) {
  const id = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,target_cert_date,created_at)
    VALUES (?,?,'gap_assessment','["iso27001"]',?,'2026-12-31','2026-01-01')`)
    .run(firmId, name, outcome)).lastInsertRowid);
  const row = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = ['iso27001'];
  return row;
}

function captureRoutes(register, deps) {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
  };
  register(app, deps);
  return routes;
}

test.before(async () => {
  env = await bootApp();
  db = env.db;
  delivery = require('../lib/engagement-delivery');
  scope = require('../lib/engagement-outcome-scope');
  notificationsRoutes = require('../routes/notifications');
  dashboardRoutes = require('../routes/dashboard');
  workspaceOpsRoutes = require('../routes/workspace-ops');
  jobs = require('../lib/jobs');
  ({ buildIntegratedDashboard } = require('../lib/integrated-dashboard'));
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()).id;
  clientId = Number((await db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,active)
    VALUES ('outcome-scope-client@example.com','not-used','Outcome Scope Client',?,'client',1)`)
    .run(firmId)).lastInsertRowid);
});

test('shared scope distinguishes full support, gap-only, and non-ISO programmes', () => {
  const gap = { frameworks: '["iso27001"]', engagement_outcome: 'gap_assessment_only' };
  const full = { frameworks: ['iso27001'], engagement_outcome: 'certification_support' };
  const generic = { frameworks: [], engagement_outcome: 'gap_assessment_only' };

  assert.equal(scope.workspaceMode(gap), scope.MODE.GAP_ASSESSMENT);
  assert.equal(scope.workspaceMode(full), scope.MODE.CERTIFICATION);
  assert.equal(scope.workspaceMode(generic), scope.MODE.GENERIC);
  assert.equal(scope.isPhaseInContract(gap, 'gap_assessment'), true);
  assert.equal(scope.isPhaseInContract(gap, 'stage_1'), false);
  assert.equal(scope.isPhaseInContract(full, 'stage_1'), true);
  assert.equal(scope.isPhaseInContract(generic, 'stage_1'), true,
    'a client without ISO 27001 remains generic rather than inheriting ISO outcome semantics');
  assert.equal(scope.phaseSqlForWorkspace(gap, 'phase'), "phase.phase_key='gap_assessment'");
  assert.throws(() => scope.phaseSqlForWorkspace(gap, 'phase;DROP TABLE workspaces'), /Invalid phase alias/);
});

test('certification-cycle and task routes enforce the service-path boundary without materialising plans', async () => {
  const gap = await createWorkspace('Gap Task Boundary Client', 'gap_assessment_only');
  const full = await createWorkspace('Full Cert Boundary Client', 'certification_support');
  const gapPlan = await delivery.ensurePlan(db, gap, managerId);
  const visible = await db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='gap_assessment' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hidden = await db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='stage_1' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hiddenDeliverable = await db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key='stage_1' ORDER BY d.id LIMIT 1`).get(gapPlan.id);
  assert.ok(visible && hidden && hiddenDeliverable);

  await db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by) VALUES (?,'Generic contracted task','todo',?)`)
    .run(gap.id, managerId);
  await db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by,engagement_milestone_id)
    VALUES (?,'Visible gap task','todo',?,?)`).run(gap.id, managerId, visible.id);
  await db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by,engagement_milestone_id)
    VALUES (?,'Hidden certification task','todo',?,?)`).run(gap.id, managerId, hidden.id);
  const hiddenDeliverableTaskId = Number((await db.prepare(`INSERT INTO tasks
    (workspace_id,title,status,created_by,engagement_deliverable_id)
    VALUES (?,'Hidden certification deliverable task','todo',?,?)`).run(
      gap.id, managerId, hiddenDeliverable.id)).lastInsertRowid);

  const middleware = (_req, _res, next) => { if (next) next(); };
  const stacks = new Map();
  const app = {
    get(route, ...handlers) { stacks.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { stacks.set(`POST ${route}`, handlers); },
  };
  workspaceOpsRoutes.register(app, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction: () => {},
    csvUpload: { single: () => middleware },
    activeEntityFilter: () => ({ sql: '', params: [] }),
    getOrCreateState: () => {},
    isFirmUser: () => true,
  });

  const user = { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' };
  const response = () => ({
    statusCode: 200,
    rendered: null,
    redirected: null,
    status(code) { this.statusCode = code; return this; },
    render(view, locals) { this.rendered = { view, locals }; return this; },
    redirect(url) { this.redirected = url; return this; },
  });

  const certGuard = stacks.get('GET /workspaces/:wsId/cert-cycle').at(-2);
  let nextCalled = false;
  await certGuard({ workspace: gap, user }, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'gap-only clients cannot enter the certification cycle');
  await certGuard({ workspace: full, user }, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'full ISO support can enter the certification cycle');

  const nonIsoId = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,created_at)
    VALUES (?,'Programme Neutral Task Client','onboarding','[]','certification_support','2026-01-01')`)
    .run(firmId)).lastInsertRowid);
  const nonIso = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(nonIsoId);
  nonIso.frameworks = [];
  nextCalled = false;
  const nonIsoGuardResponse = response();
  await certGuard({ workspace: nonIso, user }, nonIsoGuardResponse, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(nonIsoGuardResponse.statusCode, 409);

  const getTasks = stacks.get('GET /workspaces/:wsId/tasks').at(-1);
  const gapTasksResponse = response();
  await getTasks({ workspace: gap, user, query: { filter: 'all' } }, gapTasksResponse);
  const taskTitles = gapTasksResponse.rendered.locals.tasks.map(row => row.title);
  assert.ok(taskTitles.includes('Generic contracted task'));
  assert.ok(taskTitles.includes('Visible gap task'));
  assert.ok(!taskTitles.includes('Hidden certification task'));
  assert.ok(!taskTitles.includes('Hidden certification deliverable task'));
  assert.ok(await everyAsync(
    gapTasksResponse.rendered.locals.planMilestones,
    async row => row.id === visible.id
      || !(await db.prepare(`SELECT 1 FROM engagement_delivery_milestones m
        JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
        WHERE m.id=? AND ph.phase_key<>'gap_assessment'`).get(row.id))
  ));

  const nonIsoTasksResponse = response();
  await getTasks({ workspace: nonIso, user, query: { filter: 'all' } }, nonIsoTasksResponse);
  assert.equal(nonIsoTasksResponse.rendered.locals.planMilestones.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(nonIso.id)).c, 0,
    'opening generic Tasks must not materialise an ISO plan for an unassigned programme');

  const createTask = stacks.get('POST /workspaces/:wsId/tasks').at(-1);
  const before = (await db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id=?').get(gap.id)).c;
  const blockedCreate = response();
  await createTask({ workspace: gap, user, body: { title: 'Direct hidden task', engagement_milestone_id: String(hidden.id) } }, blockedCreate);
  assert.equal(blockedCreate.statusCode, 409);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id=?').get(gap.id)).c, before);

  const allowedCreate = response();
  await createTask({ workspace: gap, user, body: { title: 'Direct visible task', engagement_milestone_id: String(visible.id) } }, allowedCreate);
  assert.ok(allowedCreate.redirected);
  assert.equal((await db.prepare(`SELECT engagement_milestone_id FROM tasks
    WHERE workspace_id=? AND title='Direct visible task'`).get(gap.id)).engagement_milestone_id, visible.id);

  const genericTaskId = Number((await db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by)
    VALUES (?,'Retarget boundary task','todo',?)`).run(gap.id, managerId)).lastInsertRowid);
  const updateTask = stacks.get('POST /workspaces/:wsId/tasks/:id').at(-1);
  const blockedUpdate = response();
  await updateTask({
    workspace: gap,
    user,
    params: { id: String(genericTaskId) },
    body: { engagement_milestone_id: String(hidden.id) }
  }, blockedUpdate);
  assert.equal(blockedUpdate.statusCode, 409);
  assert.equal((await db.prepare('SELECT engagement_milestone_id FROM tasks WHERE id=?').get(genericTaskId)).engagement_milestone_id, null);

  const hiddenTaskId = (await db.prepare(`SELECT id FROM tasks
    WHERE workspace_id=? AND title='Hidden certification task'`).get(gap.id)).id;
  const blockedExistingUpdate = response();
  await updateTask({ workspace: gap, user, params: { id: String(hiddenTaskId) }, body: { status: 'done' } }, blockedExistingUpdate);
  assert.equal(blockedExistingUpdate.statusCode, 409);
  assert.equal((await db.prepare('SELECT status FROM tasks WHERE id=?').get(hiddenTaskId)).status, 'todo');

  const deleteTask = stacks.get('POST /workspaces/:wsId/tasks/:id/delete').at(-1);
  const blockedDelete = response();
  await deleteTask({ workspace: gap, user, params: { id: String(hiddenDeliverableTaskId) }, body: {} }, blockedDelete);
  assert.equal(blockedDelete.statusCode, 409);
  assert.ok(await db.prepare('SELECT id FROM tasks WHERE id=?').get(hiddenDeliverableTaskId),
    'a retained out-of-contract deliverable task cannot be deleted through the generic task route');
});

test('portfolio templates render service semantics instead of assuming certification for every row', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  const portfolio = fs.readFileSync(path.join(__dirname, '..', 'views', 'portfolio.ejs'), 'utf8');

  assert.match(dashboard, /w\.service\.position/);
  assert.match(dashboard, /w\.service\.target/);
  assert.match(dashboard, /gap-assessment-only/);
  assert.doesNotMatch(dashboard, /[rw]\.truth\./);
  assert.doesNotMatch(dashboard, /[rw]\.readiness\./);
  assert.match(portfolio, /e\.service\.position/);
  assert.match(portfolio, /e\.gapAssessment\.reportState/);
});

test('all downstream readers ignore retained certification rows for a gap-only contract', async () => {
  const gap = await createWorkspace('Gap Scope Client', 'gap_assessment_only');
  const full = await createWorkspace('Full Scope Client', 'certification_support');
  const gapPlan = await delivery.ensurePlan(db, gap, managerId);
  const fullPlan = await delivery.ensurePlan(db, full, managerId);
  const dueDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

  await db.prepare('UPDATE engagement_delivery_milestones SET planned_end_date=NULL,forecast_end_date=NULL WHERE plan_id IN (?,?)')
    .run(gapPlan.id, fullPlan.id);
  await db.prepare('UPDATE engagement_delivery_deliverables SET due_date=NULL WHERE plan_id IN (?,?)')
    .run(gapPlan.id, fullPlan.id);

  const visibleGapMilestone = await db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='gap_assessment' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hiddenGapMilestone = await db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='context' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hiddenGapDeliverable = await db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key='context' ORDER BY d.id LIMIT 1`).get(gapPlan.id);
  const fullDeliverable = await db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key='context' ORDER BY d.id LIMIT 1`).get(fullPlan.id);
  assert.ok(visibleGapMilestone && hiddenGapMilestone && hiddenGapDeliverable && fullDeliverable);

  await db.prepare(`UPDATE engagement_delivery_milestones SET title='VISIBLE GAP MILESTONE',forecast_end_date=? WHERE id=?`)
    .run(dueDate, visibleGapMilestone.id);
  await db.prepare(`UPDATE engagement_delivery_milestones SET title='HIDDEN CERT MILESTONE',forecast_end_date=? WHERE id=?`)
    .run(dueDate, hiddenGapMilestone.id);
  await db.prepare(`UPDATE engagement_delivery_deliverables
    SET title='HIDDEN CERT DELIVERABLE',client_title='Hidden client action',due_date=?,owner_id=?,client_visible=1,status='draft'
    WHERE id=?`).run(dueDate, clientId, hiddenGapDeliverable.id);
  await db.prepare(`UPDATE engagement_delivery_deliverables
    SET title='FULL CONTRACT DELIVERABLE',client_title='Full client action',due_date=?,owner_id=?,client_visible=1,status='draft'
    WHERE id=?`).run(dueDate, managerId, fullDeliverable.id);
  await db.prepare(`INSERT INTO cert_cycle_events (workspace_id,event_type,planned_date,status)
    VALUES (?,'stage_1',?,'planned')`).run(gap.id, dueDate);

  const middleware = (_req, _res, next) => { if (next) next(); };
  const notificationHandlers = captureRoutes(notificationsRoutes.register, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction: () => {},
  });
  let workspaceCalendar;
  await notificationHandlers.get('GET /workspaces/:wsId/calendar')({
    workspace: gap,
    user: { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' },
    query: { month: dueDate.slice(0, 7) },
  }, {
    render(_view, locals) { workspaceCalendar = locals; },
  });
  const workspaceEvents = workspaceCalendar.cells.filter(Boolean).flatMap(cell => cell.events);
  assert.ok(workspaceEvents.some(event => event.title === 'VISIBLE GAP MILESTONE'));
  assert.ok(!workspaceEvents.some(event => event.title === 'HIDDEN CERT MILESTONE'));
  assert.ok(!workspaceEvents.some(event => event.title === 'HIDDEN CERT DELIVERABLE'));
  assert.ok(!workspaceEvents.some(event => event.kind === 'cert'));

  const dashboardDeps = {
    db,
    requireAuth: middleware,
    logAction: () => {},
    isFirmUser: user => user.user_type === 'firm',
    isFirmOwner: () => true,
    getActiveFirmId: user => user.firm_id,
    listWorkspaces: () => [gap],
    workspaceProgress: () => ({ assessed: 0, total: 118, percent: 0 }),
  };
  const dashboardHandlers = captureRoutes(dashboardRoutes.register, dashboardDeps);
  let managerCalendar;
  await dashboardHandlers.get('GET /calendar')({
    user: { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' },
    query: { month: dueDate.slice(0, 7), legacy: '1' },
  }, {
    status() { return this; },
    render(_view, locals) { managerCalendar = locals; },
  });
  const managerEvents = managerCalendar.cells.filter(Boolean).flatMap(cell => cell.events);
  assert.ok(managerEvents.some(event => event.title === 'VISIBLE GAP MILESTONE'));
  assert.ok(!managerEvents.some(event => event.title === 'HIDDEN CERT MILESTONE'));
  assert.ok(!managerEvents.some(event => event.title === 'HIDDEN CERT DELIVERABLE'));
  assert.ok(!managerEvents.some(event => event.kind === 'cert'));

  let dashboard;
  await dashboardHandlers.get('GET /dashboard')({
    user: { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' },
    query: { legacy: '1' },
  }, {
    redirect() { throw new Error('unexpected redirect'); },
    status() { return this; },
    render(_view, locals) { dashboard = locals; },
  });
  const gapRow = dashboard.workspaces.find(w => w.client_name === 'Gap Scope Client');
  assert.ok(gapRow, 'the gap-only client must appear on the dashboard');
  assert.equal(gapRow.readiness, null);
  assert.equal(gapRow.truth, null);
  assert.equal(gapRow.service.path, 'Gap assessment only');
  assert.match(gapRow.service.targetDetail, /gap-assessment report/i);
  assert.equal(dashboard.totals.certification, 0);
  assert.equal(dashboard.totals.nearCert, 0);
  assert.ok(dashboard.workspaces.every(row =>
    (row.attention.reasons || []).every(reason => !/cert target|readiness gap|truth conflict/i.test(reason))));

  const clientTruth = (await buildIntegratedDashboard(db, gap, {
    actorId: clientId,
    clientFacing: true,
    today: dueDate,
  })).client;
  assert.ok(!clientTruth.actions.some(action => action.id === hiddenGapDeliverable.id));

  await db.prepare('DELETE FROM notifications WHERE workspace_id IN (?,?)').run(gap.id, full.id);
  await jobs.jobEngagementDeliveryAlerts();
  const gapNotifications = await db.prepare(`SELECT title FROM notifications WHERE workspace_id=?`).all(gap.id);
  const fullNotifications = await db.prepare(`SELECT title FROM notifications WHERE workspace_id=?`).all(full.id);
  assert.ok(!gapNotifications.some(row => /HIDDEN CERT DELIVERABLE/.test(row.title)));
  assert.ok(fullNotifications.some(row => /FULL CONTRACT DELIVERABLE/.test(row.title)),
    'the same phase remains actionable for a full-support contract');

  const hiddenPhase = await db.prepare(`SELECT id,status FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='stage_1'`).get(gapPlan.id);
  await db.prepare(`INSERT INTO engagement_delivery_gate_decisions
    (phase_id,decision,criteria_snapshot,snapshot_hash,note,waiver_expires_at,decided_by)
    VALUES (?,'waived','{}',?,'Hidden retained waiver','2000-01-01',?)`)
    .run(hiddenPhase.id, 'a'.repeat(64), managerId);
  await jobs.jobEngagementDeliveryAlerts();
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM engagement_delivery_gate_decisions WHERE phase_id=?`).get(hiddenPhase.id)).c, 1,
    'an expired waiver in a retained out-of-contract phase must not reopen or notify');
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_phases WHERE id=?').get(hiddenPhase.id)).status, hiddenPhase.status);

  await db.prepare(`UPDATE engagement_delivery_plans SET status='completed' WHERE id=?`).run(fullPlan.id);
  const fullPhase = await db.prepare(`SELECT id FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='context'`).get(fullPlan.id);
  await db.prepare(`UPDATE engagement_delivery_phases SET status='waived' WHERE id=?`).run(fullPhase.id);
  await db.prepare(`INSERT INTO engagement_delivery_gate_decisions
    (phase_id,decision,criteria_snapshot,snapshot_hash,note,waiver_expires_at,decided_by)
    VALUES (?,'waived','{}',?,'Expired contracted waiver','2000-01-01',?)`)
    .run(fullPhase.id, 'b'.repeat(64), managerId);

  await jobs.jobEngagementDeliveryAlerts();
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_phases WHERE id=?').get(fullPhase.id)).status, 'in_progress');
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(fullPlan.id)).status, 'active',
    'an expired contracted waiver must invalidate stale plan completion');
  assert.ok(await db.prepare(`SELECT 1 FROM engagement_delivery_events
    WHERE plan_id=? AND action='reopened_after_waiver_expiry'`).get(fullPlan.id));
});
