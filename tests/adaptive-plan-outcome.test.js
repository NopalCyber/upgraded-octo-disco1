'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./helpers');

let env;
let db;
let delivery;
let firmId;
let managerId;
let reviewerId;

async function workspace(outcome, name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,created_at)
    VALUES (?,?,'gap_assessment','["iso27001"]',?,'2026-01-01')`).run(firmId, name, outcome)).lastInsertRowid);
  const row = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = ['iso27001'];
  return row;
}

async function governedGapRecords(ws) {
  const passId = Number((await db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by,completed_by,completed_at)
    VALUES (?,1,'Governed gap assessment','completed',?,?,utc_now_text())`).run(
      ws.id, managerId, reviewerId)).lastInsertRowid);
  const decision = db.prepare(`INSERT INTO gap_assessment_phase_decisions
    (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
    VALUES (?,?,?,?,'Independent decision retained.',?)`);
  await decision.run(ws.id, passId, 'mobilisation', 'complete', reviewerId);
  await decision.run(ws.id, passId, 'fieldwork', 'complete', reviewerId);
  await decision.run(ws.id, passId, 'validation', 'not_required', reviewerId);
  await decision.run(ws.id, passId, 'report', 'complete', reviewerId);
  return passId;
}

test.before(async () => {
  env = await bootApp();
  db = env.db;
  delivery = require('../lib/engagement-delivery');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()).id;
  reviewerId = Number((await db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('plan-outcome-reviewer@example.com','not-used','Plan Outcome Reviewer',?,'firm','manager',1)`).run(firmId)).lastInsertRowid);
});

test('gap-only projection exposes only the governed report journey while retaining future rows for conversion', async () => {
  const ws = await workspace('gap_assessment_only', 'Report Journey Client');
  const plan = await delivery.ensurePlan(db, ws, managerId);
  const projection = await delivery.getProjection(db, ws, managerId);

  assert.equal(plan.name, 'ISO 27001 gap assessment delivery plan');
  assert.match(plan.objective, /issue the report, and close the engagement/i);
  assert.match(plan.completion_criteria, /formally closed/i);
  assert.deepEqual(projection.phases.map(phase => phase.phase_key), ['gap_assessment']);
  assert.deepEqual(projection.milestones.map(milestone => milestone.milestone_key), [
    'gap-fieldwork-validation', 'gap-controlled-report'
  ]);
  assert.equal(projection.outcome.gapOnly, true);
  assert.equal(projection.summary.completionReady, false);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM engagement_delivery_phases WHERE plan_id=?').get(plan.id)).c, 12,
    'future certification phases remain retained for a one-way contract expansion');
  assert.ok(await db.prepare(`SELECT 1 FROM engagement_delivery_phases WHERE plan_id=? AND phase_key='stage_2'`).get(plan.id));

  const hidden = await db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases p ON p.id=m.phase_id
    WHERE m.plan_id=? AND p.phase_key='context' LIMIT 1`).get(plan.id);
  await assert.rejects(async () => await delivery.addDependency(db, ws, managerId, projection.milestones[0].id, hidden.id, 'finish_to_start', 0),
    /different milestones|contracted/i);
});

test('full certification projection inserts governed gap assessment before implementation and keeps surveillance non-blocking', async () => {
  const ws = await workspace('certification_support', 'Certification Journey Client');
  const plan = await delivery.ensurePlan(db, ws, managerId);
  const projection = await delivery.getProjection(db, ws, managerId);
  const keys = projection.phases.map(phase => phase.phase_key);

  assert.equal(plan.name, 'ISO 27001 certification support delivery plan');
  assert.equal(keys.length, 12);
  assert.ok(keys.indexOf('mobilisation') < keys.indexOf('gap_assessment'));
  assert.ok(keys.indexOf('gap_assessment') < keys.indexOf('context'));
  assert.ok(keys.indexOf('stage_1') < keys.indexOf('stage_2'));
  assert.ok(keys.indexOf('stage_2') < keys.indexOf('continuous'));
  assert.equal(projection.phases.find(phase => phase.phase_key === 'continuous').is_continuous, 1);
  assert.equal((await db.prepare(`SELECT title FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w11-stage1'`).get(plan.id)).title,
    'Support and represent client during Stage 1 audit');
  assert.match(plan.completion_criteria, /dated Stage 1 and Stage 2 certification audits/i);
});

test('gap-only completion follows governed closure and contract expansion reactivates a customized plan', async () => {
  const ws = await workspace('gap_assessment_only', 'Governed Closure Client');
  const plan = await delivery.ensurePlan(db, ws, managerId);
  const passId = await governedGapRecords(ws);

  let projection = await delivery.getProjection(db, ws, managerId);
  assert.equal(projection.summary.reportPublished, true);
  assert.equal(projection.summary.gapClosureReady, true);
  assert.equal(projection.summary.completionReady, false, 'an issued report alone is not formal contract closure');
  assert.match(projection.summary.completionBlockers.join(' '), /formally close/i);
  assert.equal((await delivery.syncOutcomePlanStatus(db, ws, managerId)).changed, false);

  await db.prepare(`INSERT INTO gap_assessment_phase_decisions
    (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
    VALUES (?,?,'closure','complete','Gap-assessment engagement closed at the issued report.',?)`).run(ws.id, passId, managerId);
  const synced = await delivery.syncOutcomePlanStatus(db, ws, managerId);
  assert.equal(synced.changed, true);
  projection = await delivery.getProjection(db, ws, managerId);
  assert.equal(projection.summary.completionReady, true);
  assert.equal(projection.plan.status, 'completed');
  assert.equal(projection.phases[0].effective_status, 'complete');
  assert.ok(await db.prepare(`SELECT 1 FROM engagement_delivery_events
    WHERE plan_id=? AND action='completed_at_controlled_report'`).get(plan.id));

  await db.prepare(`UPDATE engagement_delivery_plans SET
    name='Client-specific delivery record',objective='Client-approved custom objective',completion_criteria='Client-approved custom closure text'
    WHERE id=?`).run(plan.id);
  await db.prepare(`UPDATE workspaces SET engagement_outcome='certification_support' WHERE id=?`).run(ws.id);
  ws.engagement_outcome = 'certification_support';
  const expanded = await delivery.ensurePlan(db, ws, managerId);
  assert.equal(expanded.id, plan.id);
  assert.equal(expanded.status, 'active');
  assert.equal(expanded.name, 'Client-specific delivery record');
  assert.equal(expanded.objective, 'Client-approved custom objective');
  assert.equal(expanded.completion_criteria, 'Client-approved custom closure text');
  assert.ok(await db.prepare(`SELECT 1 FROM engagement_delivery_events
    WHERE plan_id=? AND action='contract_outcome_expanded'`).get(plan.id));
  assert.equal((await delivery.getProjection(db, ws, managerId)).phases.length, 12);
});

test('existing plans receive the gap checkpoint additively without overwriting customized metadata or row identity', async () => {
  const ws = await workspace('certification_support', 'Additive Repair Client');
  const plan = await delivery.ensurePlan(db, ws, managerId);
  const retained = await db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    WHERE m.plan_id=? AND m.milestone_key='w2-assets'`).get(plan.id);
  const gapPhase = await db.prepare(`SELECT id FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='gap_assessment'`).get(plan.id);
  await db.prepare(`UPDATE engagement_delivery_plans SET name='Custom programme',objective='Custom objective',
    completion_criteria='Custom criteria' WHERE id=?`).run(plan.id);
  await db.prepare('DELETE FROM engagement_delivery_phases WHERE id=?').run(gapPhase.id);

  const repaired = await delivery.ensurePlan(db, ws, managerId);
  assert.equal(repaired.id, plan.id);
  assert.equal(repaired.name, 'Custom programme');
  assert.equal(repaired.objective, 'Custom objective');
  assert.equal(repaired.completion_criteria, 'Custom criteria');
  assert.equal((await db.prepare(`SELECT id FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w2-assets'`).get(plan.id)).id, retained.id);
  assert.deepEqual((await db.prepare(`SELECT milestone_key FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key LIKE 'gap-%' ORDER BY id`).all(plan.id)).map(row => row.milestone_key),
    ['gap-fieldwork-validation', 'gap-controlled-report']);
});

test('a late Stage 1 or Stage 2 finding reopens the completed delivery plan with an event trail', async () => {
  for (const auditStage of ['stage_1', 'stage_2']) {
    const ws = await workspace('certification_support', `Late ${auditStage} Finding Client`);
    const plan = await delivery.ensurePlan(db, ws, managerId);
    await db.prepare(`UPDATE engagement_delivery_plans SET status='completed' WHERE id=?`).run(plan.id);
    const eventId = Number((await db.prepare(`INSERT INTO cert_cycle_events
      (workspace_id,event_type,actual_date,status,certification_body)
      VALUES (?,?,'2027-09-01','closed','Independent Certification Body')`).run(ws.id, auditStage)).lastInsertRowid);
    const findingId = Number((await db.prepare(`INSERT INTO nonconformities
      (workspace_id,title,source,source_ref,severity,status)
      VALUES (?,'Late certification observation','external_audit',?,'observation','open')`).run(
        ws.id, `cert_cycle_event:${eventId}`)).lastInsertRowid);

    const reopened = await delivery.reopenForCertificationFinding(db, ws, managerId, findingId);
    assert.equal(reopened.planReopened, true);
    assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id)).status, 'active');
    const planEvent = await db.prepare(`SELECT details FROM engagement_delivery_events
      WHERE plan_id=? AND action='reopened_for_certification_finding' ORDER BY id DESC LIMIT 1`).get(plan.id);
    assert.equal(JSON.parse(planEvent.details).audit_stage, auditStage);
    assert.equal(JSON.parse(planEvent.details).finding_id, findingId);
  }
});
