'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient, openTestDb } = require('./helpers');

let env;
let client;
let db;
let firmId;
let managerId;
let reviewerId;

async function createWorkspace(outcome, name) {
  const created = await client.post('/workspaces', {
    client_name: name,
    frameworks: 'iso27001',
    engagement_outcome: outcome,
  });
  assert.equal(created.status, 302);
  const workspaceId = Number((String(created.location).match(/workspaces\/(\d+)/) || [])[1]);
  assert.ok(workspaceId, `expected a workspace redirect, got ${created.location}`);
  assert.ok(await db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId));
  return workspaceId;
}

async function recordGapConclusion(workspaceId) {
  const requirementId = (await db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code='iso27001' ORDER BY r.sort_order,r.id LIMIT 1`).get()).id;
  await db.prepare(`INSERT INTO control_instances
    (workspace_id,requirement_id,entity_id,applicability,status,maturity,notes)
    VALUES (?,?,NULL,'applicable','not_implemented',0,'Access reviews do not cover every privileged account.')`)
    .run(workspaceId, requirementId);
  return requirementId;
}

async function conclusionStatus(workspaceId, requirementId) {
  return (await db.prepare(`SELECT status FROM control_instances
    WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(workspaceId, requirementId)).status;
}

async function completeAssessmentPass(workspaceId) {
  return Number((await db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by,completed_by,completed_at)
    VALUES (?,1,'Gap assessment','completed',?,?,utc_now_text())`).run(
      workspaceId, managerId, reviewerId)).lastInsertRowid);
}

async function signOffFieldwork(workspaceId, passId) {
  const decide = db.prepare(`INSERT INTO gap_assessment_phase_decisions
    (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
    VALUES (?,?,?,'complete',?,?)`);
  await decide.run(workspaceId, passId, 'mobilisation', 'Scope and method approved.', reviewerId);
  await decide.run(workspaceId, passId, 'fieldwork', 'All assessment conclusions independently reviewed.', reviewerId);
}

async function completeGovernedAssessment(workspaceId) {
  const passId = await completeAssessmentPass(workspaceId);
  await signOffFieldwork(workspaceId, passId);
  await db.prepare(`INSERT INTO gap_assessment_phase_decisions
    (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
    VALUES (?,?,'validation','not_required','No confirmed client findings required factual validation.',?)`)
    .run(workspaceId, passId, reviewerId);
  return passId;
}

async function decision(workspaceId, phase) {
  return await db.prepare(`SELECT * FROM gap_assessment_phase_decisions WHERE workspace_id=? AND phase=?`).get(workspaceId, phase);
}

function decidePhase(workspaceId, phase, body) {
  return client.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/phases/${phase}`, { row_version: '0', ...body });
}

async function issueReport(workspaceId) {
  const issued = await decidePhase(workspaceId, 'report', {
    decision: 'complete',
    rationale: 'Report v1.0 issued to the client sponsor.'
  });
  assert.equal(issued.status, 302);
  assert.doesNotMatch(issued.location, /toastKind=error/);
  assert.equal((await decision(workspaceId, 'report')).decision, 'complete');
}

function closeEngagement(workspaceId, body = {}) {
  return client.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/close`, { row_version: '0', ...body });
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = await openTestDb(env.dbUrl);
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare("SELECT id FROM users WHERE email='sec-test@example.com'").get()).id;
  reviewerId = Number((await db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('gap-lifecycle-reviewer@example.com','not-used','Independent Reviewer',?,'firm','manager',1)`).run(firmId)).lastInsertRowid);
});

test.after(async () => {
  if (db) await db.close();
  if (client) await client.close();
});

test('gap-only lifecycle ends at the issued report in firm and client presentations', async () => {
  const workspaceId = await createWorkspace('gap_assessment_only', 'Report Only Client');
  await recordGapConclusion(workspaceId);
  await completeGovernedAssessment(workspaceId);
  await issueReport(workspaceId);

  const remediation = await decidePhase(workspaceId, 'post_report', {
    decision: 'complete',
    rationale: 'Attempted remediation sign-off.'
  });
  assert.equal(remediation.status, 302);
  assert.match(decodeURIComponent(remediation.location), /Post-report remediation is outside this gap-assessment-only engagement/);
  assert.equal(await decision(workspaceId, 'post_report'), undefined);

  const fieldwork = await client.get(`/workspaces/${workspaceId}/gap-assessment/fieldwork`);
  assert.equal(fieldwork.status, 200);
  assert.match(fieldwork.text, /Current governed phase[\s\S]*Report issued - ready for closure/);
  assert.match(fieldwork.text, /Close at the controlled report/);
  assert.match(fieldwork.text, new RegExp(`action="/workspaces/${workspaceId}/gap-assessment/fieldwork/close"`));
  assert.doesNotMatch(fieldwork.text, />Post-report</);

  const portal = await client.get(`/workspaces/${workspaceId}/client-portal?preview=client`);
  assert.equal(portal.status, 200);
  assert.match(portal.text, /Report issued - ready for governed closure/);
  assert.match(portal.text, /recommendations remain with your organisation/i);
  assert.doesNotMatch(portal.text, />Post-report</);

  const projection = await require('../lib/client-gap-assessment').buildClientGapAssessmentProjection(
    db, await db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId));
  assert.equal(projection.currentPhase, 'complete');
  assert.equal(projection.currentPhaseLabel, 'Report issued - ready for governed closure');
  assert.equal(projection.assessmentDelivered, true);
  assert.equal(projection.engagementComplete, false);
  assert.equal(projection.contractClosed, false);
  assert.deepEqual(projection.phases.map(phase => phase.key), ['mobilisation', 'fieldwork', 'validation', 'report']);
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId)).status, 'active',
    'an issued report is not contract closure');
});

test('gap-only contract closure retains gap conclusions as open recommendations', async () => {
  const workspaceId = await createWorkspace('gap_assessment_only', 'Closure Evidence Client');
  const requirementId = await recordGapConclusion(workspaceId);
  await completeGovernedAssessment(workspaceId);
  await issueReport(workspaceId);

  const response = await closeEngagement(workspaceId, { completion_note: 'Final report handed to the client sponsor.' });
  assert.equal(response.status, 302);
  assert.doesNotMatch(response.location, /toastKind=error/);

  const closure = await decision(workspaceId, 'closure');
  assert.equal(closure.decision, 'complete');
  assert.equal(closure.rationale, 'Final report handed to the client sponsor.');
  assert.equal(closure.decided_by, managerId);
  assert.ok(await db.prepare(`SELECT 1 FROM gap_assessment_phase_events
    WHERE phase_decision_id=? AND to_decision='complete'`).get(closure.id));
  assert.equal((await decision(workspaceId, 'report')).decision, 'complete');
  assert.equal(await conclusionStatus(workspaceId, requirementId), 'not_implemented',
    'closing at the report does not represent the gap as remediated');

  const plan = await db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId);
  assert.equal(plan.status, 'completed');
  const event = await db.prepare(`SELECT details FROM engagement_delivery_events
    WHERE plan_id=? AND action='completed_at_controlled_report' ORDER BY id DESC LIMIT 1`).get(plan.id);
  assert.ok(event);
  assert.equal(JSON.parse(event.details).issued_reports, 1);

  const fieldwork = await client.get(`/workspaces/${workspaceId}/gap-assessment/fieldwork`);
  assert.equal(fieldwork.status, 200);
  assert.match(fieldwork.text, /Gap-assessment engagement complete/);
  assert.doesNotMatch(fieldwork.text, new RegExp(`action="/workspaces/${workspaceId}/gap-assessment/fieldwork/close"`));
  const portal = await client.get(`/workspaces/${workspaceId}/client-portal?preview=client`);
  assert.equal(portal.status, 200);
  assert.match(portal.text, /open recommendations remain with your organisation/i);

  const blockerCount = (await db.prepare('SELECT COUNT(*) c FROM gap_fieldwork_blockers WHERE workspace_id=?').get(workspaceId)).c;
  const retainedMutation = await client.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/blockers`, {
    title: 'Replayed post-closure blocker',
    description: 'This must not alter the retained assessment record.',
    priority: 'high'
  });
  assert.equal(retainedMutation.status, 302);
  assert.match(decodeURIComponent(retainedMutation.location), /formally closed/i);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM gap_fieldwork_blockers WHERE workspace_id=?').get(workspaceId)).c, blockerCount);

  const report = await decision(workspaceId, 'report');
  const reopened = await decidePhase(workspaceId, 'report', {
    decision: 'reopened',
    rationale: 'Replayed post-closure reopen.',
    row_version: String(report.row_version)
  });
  assert.equal(reopened.status, 302);
  assert.match(decodeURIComponent(reopened.location), /formally closed/i);
  assert.equal((await decision(workspaceId, 'report')).decision, 'complete');
  assert.equal((await decision(workspaceId, 'report')).row_version, report.row_version);

  const readinessPack = await client.get(`/workspaces/${workspaceId}/export/readiness-pack.zip?stage=1`);
  assert.equal(readinessPack.status, 409);
  assert.match(readinessPack.text, /outside this gap-assessment-only engagement/i);
});

test('gap-only closure is blocked until the governed report and assessment gates are complete', async () => {
  const workspaceId = await createWorkspace('gap_assessment_only', 'Incomplete Report Client');

  const withoutPass = await closeEngagement(workspaceId);
  assert.equal(withoutPass.status, 302);
  assert.match(withoutPass.location, /toastKind=error/);
  assert.equal(await decision(workspaceId, 'closure'), undefined);

  const passId = await completeAssessmentPass(workspaceId);
  await signOffFieldwork(workspaceId, passId);

  const prematureReport = await decidePhase(workspaceId, 'report', {
    decision: 'complete',
    rationale: 'Attempted before validation was concluded.'
  });
  assert.equal(prematureReport.status, 302);
  assert.match(prematureReport.location, /toastKind=error/);
  assert.match(decodeURIComponent(prematureReport.location), /Validation complete or formally not required/);
  assert.equal(await decision(workspaceId, 'report'), undefined);

  const beforeValidation = await closeEngagement(workspaceId);
  assert.match(beforeValidation.location, /toastKind=error/);
  assert.match(decodeURIComponent(beforeValidation.location), /validation sign-off[\s\S]*report as issued/i);
  assert.equal(await decision(workspaceId, 'closure'), undefined);

  const validation = await decidePhase(workspaceId, 'validation', {
    decision: 'not_required',
    rationale: 'No confirmed client findings required factual validation.'
  });
  assert.doesNotMatch(validation.location, /toastKind=error/);
  assert.equal((await decision(workspaceId, 'validation')).decision, 'not_required');

  const reportNotRequired = await decidePhase(workspaceId, 'report', {
    decision: 'not_required',
    rationale: 'Attempted to skip the report.'
  });
  assert.match(reportNotRequired.location, /toastKind=error/);
  assert.equal(await decision(workspaceId, 'report'), undefined);

  const beforeReport = await closeEngagement(workspaceId);
  assert.match(beforeReport.location, /toastKind=error/);
  assert.match(decodeURIComponent(beforeReport.location), /report as issued/i);
  assert.equal(await decision(workspaceId, 'closure'), undefined);
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId)).status, 'active');
});

test('certification-support engagements cannot be closed at the issued report', async () => {
  const workspaceId = await createWorkspace('certification_support', 'Certification Client');
  await recordGapConclusion(workspaceId);
  await completeGovernedAssessment(workspaceId);
  await issueReport(workspaceId);

  const response = await closeEngagement(workspaceId, { completion_note: 'Attempted certification-support closure.' });
  assert.equal(response.status, 302);
  assert.match(response.location, /toastKind=error/);
  assert.match(decodeURIComponent(response.location), /Only a gap-assessment-only engagement closes at the report/);
  assert.equal(await decision(workspaceId, 'closure'), undefined);
  assert.equal((await db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId)).status, 'active');
});
