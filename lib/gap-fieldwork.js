'use strict';

const crypto = require('crypto');
const { todayFor } = require('./dates');
const isoLifecycle = require('./iso-lifecycle');

const PHASES = ['mobilisation', 'fieldwork', 'validation', 'report', 'post_report'];
const RECEIVED_REQUESTS = new Set(['submitted', 'accepted', 'cancelled']);
const CLOSED_REQUESTS = new Set(['accepted', 'cancelled']);
const CLOSED_INTERVIEWS = new Set(['completed', 'cancelled']);

async function latestPass(db, workspaceId) {
  return (await db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=?
    ORDER BY (status='in_progress') DESC,pass_number DESC,id DESC LIMIT 1`).get(workspaceId)) || null;
}

async function assessmentContext(db, workspace) {
  const pass = await latestPass(db, workspace.id);
  const passId = pass?.id || -1;
  const gapOnly = isoLifecycle.isGapOnly(workspace.engagement_outcome);
  const control = await db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN ci.status IS NOT NULL AND ci.status!='not_assessed' THEN 1 ELSE 0 END) assessed,
      SUM(CASE WHEN ci.applicability IN ('applicable','excluded') THEN 1 ELSE 0 END) scope_decided
    FROM requirements r JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001'
    LEFT JOIN control_instances ci ON ci.requirement_id=r.id AND ci.workspace_id=? AND ci.entity_id IS NULL`).get(workspace.id);
  const requests = await db.prepare(`SELECT id,status,priority,due_date,title,assignee_id FROM client_requests
    WHERE workspace_id=? ORDER BY id`).all(workspace.id);
  const interviews = await db.prepare(`SELECT i.*,u.name owner_name FROM gap_fieldwork_interviews i
    LEFT JOIN users u ON u.id=i.owner_id
    WHERE i.workspace_id=? AND (i.assessment_pass_id=? OR i.assessment_pass_id IS NULL)
    ORDER BY i.scheduled_at,i.id`).all(workspace.id, passId);
  const manualBlockers = await db.prepare(`SELECT b.*,u.name owner_name FROM gap_fieldwork_blockers b
    LEFT JOIN users u ON u.id=b.owner_id
    WHERE b.workspace_id=? AND (b.assessment_pass_id=? OR b.assessment_pass_id IS NULL)
    ORDER BY CASE b.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,b.due_date NULLS FIRST,b.id`).all(workspace.id, passId);
  const defaults = await db.prepare(`SELECT d.*,r.ref,r.title requirement_title FROM gap_declared_defaults d
    JOIN requirements r ON r.id=d.requirement_id
    WHERE d.workspace_id=? AND (d.assessment_pass_id=? OR d.assessment_pass_id IS NULL)
    ORDER BY r.sort_order,d.id`).all(workspace.id, passId);
  const snapshots = await db.prepare(`SELECT * FROM gap_fieldwork_snapshots
    WHERE workspace_id=? AND (assessment_pass_id=? OR assessment_pass_id IS NULL)
    ORDER BY week_ending DESC,id DESC`).all(workspace.id, passId);
  const decisions = pass ? await db.prepare(`SELECT d.*,u.name decided_by_name FROM gap_assessment_phase_decisions d
    LEFT JOIN users u ON u.id=d.decided_by WHERE d.workspace_id=? AND d.assessment_pass_id=?`).all(workspace.id, pass.id) : [];
  const audit = (await db.prepare(`SELECT id,title,sampling_justification,population_size,sample_size FROM audits
    WHERE workspace_id=? ORDER BY CASE WHEN TRIM(COALESCE(sampling_justification,''))<>'' THEN 0 ELSE 1 END,
    audit_date DESC NULLS LAST,id DESC LIMIT 1`).get(workspace.id)) || null;
  const findings = [];
  const reports = [];
  const today = todayFor(workspace);
  const requestBlockers = requests.filter(row => !CLOSED_REQUESTS.has(row.status) &&
    (row.priority === 'urgent' || (row.due_date && row.due_date < today)));
  const openManualBlockers = manualBlockers.filter(row => row.status === 'open');
  const receivedRequests = requests.filter(row => RECEIVED_REQUESTS.has(row.status)).length;
  const completedInterviews = interviews.filter(row => row.status === 'completed').length;
  const confirmedDefaults = defaults.filter(row => row.status === 'confirmed').length;
  const visibleInterviews = interviews.filter(row => row.client_visible === 1);
  const visibleManualBlockers = openManualBlockers.filter(row => row.client_visible === 1);
  const visibleDefaults = defaults.filter(row => row.status === 'confirmed' && row.client_visible === 1);
  const scope = String(workspace.scope || '').trim();
  const decided = Object.fromEntries(decisions.map(row => [row.phase, row]));
  const finalDecision = phase => ['complete', 'not_required'].includes(decided[phase]?.decision);
  const reportIssued = decided.report?.decision === 'complete';
  const contractClosed = decided.closure?.decision === 'complete';
  const openRemediation = findings.filter(row => row.status !== 'closed').length;
  const interviewScheduleConcluded = interviews.length > 0 && interviews.every(row => CLOSED_INTERVIEWS.has(row.status));
  const rfiRegisterConcluded = requests.length > 0 && requests.every(row => RECEIVED_REQUESTS.has(row.status));

  const gates = {
    mobilisation: {
      ready: scope.length >= 20 && Number(control.scope_decided || 0) === Number(control.total || 0) &&
        !!String(audit?.sampling_justification || '').trim(),
      checks: [
        { label: 'Scope and boundary recorded', pass: scope.length >= 20 },
        { label: 'Applicability decided for every requirement', pass: Number(control.scope_decided || 0) === Number(control.total || 0) },
        { label: 'Sampling basis documented', pass: !!String(audit?.sampling_justification || '').trim() }
      ]
    },
    fieldwork: {
      ready: !!pass && pass.status === 'completed' && Number(control.assessed || 0) === Number(control.total || 0) &&
        interviewScheduleConcluded && rfiRegisterConcluded &&
        openManualBlockers.length === 0 && requestBlockers.length === 0,
      checks: [
        { label: 'Assessment pass completed', pass: !!pass && pass.status === 'completed' },
        { label: 'All requirements concluded', pass: Number(control.assessed || 0) === Number(control.total || 0) },
        { label: interviews.length ? 'Interview schedule concluded' : 'At least one interview must be scheduled and concluded', pass: interviewScheduleConcluded },
        { label: requests.length ? 'All RFIs received or closed' : 'At least one documented RFI must be issued and resolved', pass: rfiRegisterConcluded },
        { label: 'No active blockers', pass: openManualBlockers.length === 0 && requestBlockers.length === 0 }
      ]
    },
    validation: {
      ready: finalDecision('fieldwork'),
      checks: [
        { label: 'Fieldwork formally signed off', pass: finalDecision('fieldwork') },
        { label: findings.length ? 'Confirmed findings available for factual validation' : 'No-findings conclusion requires explicit Not required decision', pass: findings.length > 0 }
      ]
    },
    report: {
      ready: finalDecision('validation'),
      complete: reportIssued,
      checks: [
        { label: 'Validation complete or formally not required', pass: finalDecision('validation') },
        { label: 'Gap assessment report issued to the client', pass: reportIssued }
      ]
    },
    post_report: {
      ready: reportIssued && findings.length > 0 && openRemediation === 0,
      checks: [
        { label: 'Gap assessment report issued', pass: reportIssued },
        { label: findings.length ? 'All confirmed findings closed' : 'No-findings outcome requires an explicit Not required decision', pass: findings.length > 0 && openRemediation === 0 }
      ]
    }
  };

  const completed = {
    mobilisation: finalDecision('mobilisation'),
    fieldwork: finalDecision('fieldwork'),
    validation: finalDecision('validation'),
    report: reportIssued,
    post_report: gapOnly ? reportIssued : finalDecision('post_report')
  };
  const phases = gapOnly ? PHASES.slice(0, -1) : [...PHASES];
  let currentPhase = phases.find(phase => !completed[phase]) || phases[phases.length - 1];
  for (let index = 1; index < phases.length; index += 1) {
    if (currentPhase === phases[index] && !completed[phases[index - 1]]) currentPhase = phases[index - 1];
  }
  const assessmentDeliveryComplete = gapOnly && completed.mobilisation && completed.fieldwork && completed.validation && completed.report;
  if (assessmentDeliveryComplete) currentPhase = 'complete';

  const closureBlockers = [];
  if (!pass || pass.status !== 'completed') closureBlockers.push('Complete the independently reviewed assessment pass.');
  if (!completed.mobilisation) closureBlockers.push('Record mobilisation sign-off.');
  if (!completed.fieldwork) closureBlockers.push('Record fieldwork sign-off.');
  if (!completed.validation) closureBlockers.push('Record validation sign-off or a governed Not required decision.');
  if (!reportIssued) closureBlockers.push('Record the gap assessment report as issued.');

  return {
    pass, control, requests, interviews, manualBlockers, requestBlockers, openManualBlockers,
    defaults, snapshots, decisions, decisionMap: decided, findings, reports, audit, engagement: null,
    gates, completed, currentPhase, phases, gapOnly,
    closure: {
      applicable: gapOnly,
      ready: gapOnly && closureBlockers.length === 0,
      complete: gapOnly && contractClosed,
      blockers: closureBlockers,
      openFindings: openRemediation,
      issuedReports: reportIssued ? 1 : 0
    },
    live: {
      requirementsCovered: Number(control.assessed || 0),
      requirementsTotal: Number(control.total || 0),
      interviewsCompleted: completedInterviews,
      interviewsPlanned: interviews.length,
      requestsReceived: receivedRequests,
      requestsTotal: requests.length,
      activeBlockers: openManualBlockers.length + requestBlockers.length,
      declaredDefaults: confirmedDefaults
    },
    clientLive: {
      requirementsCovered: Number(control.assessed || 0),
      requirementsTotal: Number(control.total || 0),
      interviewsCompleted: visibleInterviews.filter(row => row.status === 'completed').length,
      interviewsPlanned: visibleInterviews.length,
      requestsReceived: receivedRequests,
      requestsTotal: requests.length,
      activeBlockers: visibleManualBlockers.length + requestBlockers.length,
      declaredDefaults: visibleDefaults.length
    }
  };
}

async function snapshotFieldwork(db, workspace, actorId, weekEnding) {
  const context = await assessmentContext(db, workspace);
  if (!context.pass) throw new Error('Start an assessment pass before freezing a weekly snapshot.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekEnding || ''))) throw new Error('A valid week-ending date is required.');
  const payload = {
    version: 1,
    workspace_id: workspace.id,
    assessment_pass_id: context.pass.id,
    week_ending: weekEnding,
    metrics: context.clientLive,
    interview_ids: context.interviews.filter(row => row.client_visible === 1).map(row => row.id),
    request_ids: context.requests.map(row => row.id),
    manual_blocker_ids: context.manualBlockers.filter(row => row.client_visible === 1).map(row => row.id),
    request_blocker_ids: context.requestBlockers.map(row => row.id),
    declared_default_ids: context.defaults.filter(row => row.status === 'confirmed' && row.client_visible === 1).map(row => row.id),
    frozen_at: new Date().toISOString()
  };
  const json = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const result = await db.prepare(`INSERT INTO gap_fieldwork_snapshots
    (workspace_id,assessment_pass_id,week_ending,requirements_covered,requirements_total,
     interviews_completed,interviews_planned,requests_received,requests_total,active_blockers,
     declared_defaults,snapshot_json,snapshot_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      workspace.id, context.pass.id, weekEnding, context.clientLive.requirementsCovered,
      context.clientLive.requirementsTotal, context.clientLive.interviewsCompleted, context.clientLive.interviewsPlanned,
      context.clientLive.requestsReceived, context.clientLive.requestsTotal, context.clientLive.activeBlockers,
      context.clientLive.declaredDefaults, json, hash, actorId);
  return Number(result.lastInsertRowid);
}

module.exports = { PHASES, latestPass, assessmentContext, snapshotFieldwork };
