'use strict';

const { db } = require('../db');
const ctlReads = require('./control-reads');

async function computeNextStep(ws) {
  const wsId = ws.id;
  const cnt = async (sql, ...p) => (await db.prepare(sql).get(wsId, ...p)).c;

  const intakeCount = await cnt(`SELECT COUNT(*) c FROM engagement_intake WHERE workspace_id=? AND question_id<>'cert-deadline' AND answer IS NOT NULL AND length(trim(answer)) > 0`);
  if (intakeCount === 0) {
    return {
      kind: 'intake', title: 'Start the client setup',
      why: 'A 25-question scoping questionnaire that auto-drafts the clause 4.3 scope statement. Captures the business context, scope, and crown-jewel assets so the rest of the engagement has something to anchor against.',
      cta: 'Open setup', href: `/workspaces/${wsId}/intake`,
    };
  }
  if (intakeCount < 8) {
    return {
      kind: 'intake-partial', title: `Finish the client setup (${intakeCount} answered)`,
      why: 'Get to at least the business-context + scope sections before the kickoff workshop.',
      cta: 'Continue setup', href: `/workspaces/${wsId}/intake`,
    };
  }

  if (intakeCount >= 8 && (!ws.scope || ws.scope.length < 20)) {
    return {
      kind: 'apply-intake', title: 'Save the client setup to publish the scope',
      why: 'Pushes the auto-drafted clause 4.3 scope statement onto the client. Open setup, click Save & refresh summary.',
      cta: 'Open setup', href: `/workspaces/${wsId}/intake`,
    };
  }

  if (intakeCount >= 8 && !ws.scope_confirmed_at) {
    return {
      kind: 'confirm-scope', title: 'Confirm scope before gap assessment',
      why: 'Sign off on the clause 4.3 scope statement. Setup -> Confirm scope.',
      cta: 'Review & confirm', href: `/workspaces/${wsId}/intake`,
    };
  }

  const activePass = await db.prepare(`SELECT id, pass_number FROM assessment_passes WHERE workspace_id=? AND status='in_progress' ORDER BY pass_number DESC LIMIT 1`).get(wsId);
  const lastPass = await db.prepare(`SELECT id FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(wsId);
  if (!lastPass) {
    return {
      kind: 'pass-1', title: 'Start Pass 1 - initial gap assessment',
      why: 'Walks every clause and Annex A control. Each item gets diagnostic Y/P/N questions, a status, and a maturity score. Findings feed the asset + risk register work next.',
      cta: 'Start gap assessment', href: `/workspaces/${wsId}/gap-assessment`,
    };
  }

  const passAssessed = await cnt(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs} WHERE workspace_id=? AND status != 'Not Assessed'`);
  if (passAssessed < 20) {
    return {
      kind: 'pass-1-partial', title: `Continue the gap assessment (${passAssessed}/118 assessed)`,
      why: 'Get through the rest of the clauses + Annex A so you have a complete view of current state before the risk workshop.',
      cta: 'Continue gap', href: `/workspaces/${wsId}/gap-assessment`,
    };
  }

  const assets = await cnt(`SELECT COUNT(*) c FROM assets WHERE workspace_id=?`);
  if (assets < 5) {
    return {
      kind: 'assets', title: 'Build the asset register',
      why: 'You need 30-50 entries to support the risk assessment. The gap-assessment findings give you a list of asset categories that need coverage; the scoping workshop playbook walks a structured 90-min session.',
      cta: 'Add assets', href: `/workspaces/${wsId}/assets`,
    };
  }

  const risks = await cnt(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status NOT IN ('closed','accepted')`);
  if (risks < 10) {
    return {
      kind: 'risks', title: 'Populate the risk register',
      why: 'With the gap assessment + asset register in hand, the risk workshop can focus on the gaps that actually matter. Use "+ Firm library" to clone curated risks, or run the 90-min risk workshop playbook with the client.',
      cta: 'Open risks', href: `/workspaces/${wsId}/risks`,
    };
  }

  const undecided = await cnt(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs} cs INNER JOIN iso_items i ON i.id=cs.iso_item_id WHERE cs.workspace_id=? AND i.id ILIKE 'annex-a.%' AND (cs.applicability IS NULL OR cs.applicability='undecided')`);
  if (undecided > 30) {
    return {
      kind: 'soa-bulk', title: `Decide SoA applicability for ${undecided} controls`,
      why: 'Clause 6.1.3.d requires applicability + justification per Annex A control. Use "+ Bulk decide applicability" on the SoA page to set most in one go.',
      cta: 'Open SoA', href: `/workspaces/${wsId}/soa`,
    };
  }

  const mrmsDone = await cnt(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete'`);
  if (mrmsDone === 0) {
    return {
      kind: 'mrm', title: 'Run the first management review',
      why: 'Stage 1 readiness scores 0/10 on the MRM dimension until at least one is complete. Inputs auto-pull from current workspace data per clause 9.3.2.',
      cta: 'Open management reviews', href: `/workspaces/${wsId}/mrms`,
    };
  }

  const auditsDone = await cnt(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND status='complete'`);
  if (auditsDone === 0) {
    return {
      kind: 'audit', title: 'Conduct the first internal audit',
      why: 'Stage 1 readiness needs at least one completed internal audit. Document the programme first (clause 9.2.2), then conduct the audit.',
      cta: 'Open internal audit', href: `/workspaces/${wsId}/audits`,
    };
  }

  if (activePass) {
    return {
      kind: 'close-pass', title: `Mark Pass ${activePass.pass_number} as complete`,
      why: 'You\'ve covered intake, risks, SoA decisions, first MRM, first internal audit. Close the pass to lock the snapshot and start the Stage 1 readiness pack.',
      cta: 'Open gap assessment', href: `/workspaces/${wsId}/gap-assessment`,
    };
  }

  return {
    kind: 'pack', title: 'Generate the Stage 1 readiness pack',
    why: 'The single artefact you hand the certification body - SoA, RTP, audits, MRMs, parties, objectives, evidence manifest, every active evidence file in one ZIP.',
    cta: 'Open audit pack', href: `/workspaces/${wsId}/audit-pack`,
  };
}

async function computeNeedsAttention(wsId) {
  const today = new Date().toISOString().slice(0,10);
  const expSoon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10);

  const items = [];
  const push = (severity, category, title, link, detail) =>
    items.push({ severity, category, title, link, detail });

  (await db.prepare(`SELECT id, title, due_date FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < ?`)
    .all(wsId, today)).forEach(n => push('high', 'nc', `Overdue NC: ${n.title}`, `/workspaces/${wsId}/nonconformities/${n.id}`, `Due ${n.due_date}`));
  (await db.prepare(`SELECT id, title, due_date FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date >= ? AND due_date < ?`)
    .all(wsId, today, expSoon)).forEach(n => push('medium', 'nc', `NC due soon: ${n.title}`, `/workspaces/${wsId}/nonconformities/${n.id}`, `Due ${n.due_date}`));

  (await db.prepare(`SELECT id, filename, valid_until, iso_item_id FROM evidence
    WHERE workspace_id=? AND valid_until IS NOT NULL AND valid_until < ?`)
    .all(wsId, today)).forEach(e => push('high', 'evidence', `Expired evidence: ${e.filename}`, `/workspaces/${wsId}/controls/assess/${e.iso_item_id || 'summary'}`, `Valid until ${e.valid_until}`));
  (await db.prepare(`SELECT id, filename, valid_until, iso_item_id FROM evidence
    WHERE workspace_id=? AND valid_until IS NOT NULL AND valid_until >= ? AND valid_until < ?`)
    .all(wsId, today, expSoon)).forEach(e => push('medium', 'evidence', `Evidence expires soon: ${e.filename}`, `/workspaces/${wsId}/controls/assess/${e.iso_item_id || 'summary'}`, `Valid until ${e.valid_until}`));

  (await db.prepare(`SELECT id, name, next_review_date FROM generated_docs
    WHERE workspace_id=? AND next_review_date IS NOT NULL AND next_review_date < ?`)
    .all(wsId, today)).forEach(d => push('high', 'document', `Document overdue for review: ${d.name}`, `/workspaces/${wsId}/documents/${d.id}`, `Review by ${d.next_review_date}`));
  (await db.prepare(`SELECT id, name, next_review_date FROM generated_docs
    WHERE workspace_id=? AND next_review_date IS NOT NULL AND next_review_date >= ? AND next_review_date < ?`)
    .all(wsId, today, expSoon)).forEach(d => push('medium', 'document', `Document due for review: ${d.name}`, `/workspaces/${wsId}/documents/${d.id}`, `Review by ${d.next_review_date}`));

  (await db.prepare(`SELECT a.id, a.risk_id, a.expires_at, r.title FROM risk_acceptances a
    INNER JOIN risks r ON r.id=a.risk_id
    WHERE a.workspace_id=? AND a.revoked_at IS NULL AND a.expires_at IS NOT NULL AND a.expires_at < ?`)
    .all(wsId, today)).forEach(a => push('high', 'risk', `Expired acceptance: R-${a.risk_id} ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Expired ${a.expires_at} - re-accept or treat`));
  (await db.prepare(`SELECT a.id, a.risk_id, a.expires_at, r.title FROM risk_acceptances a
    INNER JOIN risks r ON r.id=a.risk_id
    WHERE a.workspace_id=? AND a.revoked_at IS NULL AND a.expires_at IS NOT NULL AND a.expires_at >= ? AND a.expires_at < ?`)
    .all(wsId, today, expSoon)).forEach(a => push('medium', 'risk', `Acceptance expires soon: R-${a.risk_id} ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Expires ${a.expires_at}`));

  (await db.prepare(`SELECT rta.id, rta.title, rta.due_date, rta.risk_id FROM risk_treatment_actions rta
    WHERE rta.workspace_id=? AND rta.status NOT IN ('done','cancelled') AND rta.due_date IS NOT NULL AND rta.due_date < ?`)
    .all(wsId, today)).forEach(a => push('high', 'treatment', `Overdue treatment action: ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Due ${a.due_date}`));
  (await db.prepare(`SELECT rta.id, rta.title, rta.due_date, rta.risk_id FROM risk_treatment_actions rta
    WHERE rta.workspace_id=? AND rta.status NOT IN ('done','cancelled') AND rta.due_date IS NOT NULL AND rta.due_date >= ? AND rta.due_date < ?`)
    .all(wsId, today, expSoon)).forEach(a => push('medium', 'treatment', `Treatment action due soon: ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Due ${a.due_date}`));

  (await db.prepare(`SELECT id, event_type, planned_date FROM cert_cycle_events
    WHERE workspace_id=? AND status NOT IN ('closed') AND planned_date IS NOT NULL AND planned_date >= ? AND planned_date < ?`)
    .all(wsId, today, expSoon)).forEach(e => push('medium', 'cert', `Upcoming: ${e.event_type.replace('_',' ')}`, `/workspaces/${wsId}/cert-cycle`, `Planned ${e.planned_date}`));

  const stale = await db.prepare(`SELECT cs.iso_item_id, cs.last_verified_at, i.title
    FROM ${ctlReads.tables(db, wsId).cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.status NOT IN ('Not Assessed','Not Applicable')
      AND (cs.last_verified_at IS NULL OR cs.last_verified_at < utc_text(now() + ('-365 days')::interval))
    ORDER BY cs.last_verified_at IS NULL DESC, cs.last_verified_at ASC
    LIMIT 6`).all(wsId);
  for (const s of stale) {
    const code = s.iso_item_id.replace('annex-','').toUpperCase();
    const detail = s.last_verified_at
      ? `Last verified ${s.last_verified_at.slice(0,10)} - re-assess`
      : 'Never verified - re-assess in this engagement';
    push(s.last_verified_at ? 'medium' : 'high', 'stale', `${code} stale: ${s.title.replace(/^A\.[0-9.]+ /,'')}`,
         `/workspaces/${wsId}/controls/assess/${s.iso_item_id}`, detail);
  }

  (await db.prepare(`SELECT id, title, due_date, status FROM security_objectives
    WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < ? AND status NOT IN ('achieved','paused')`)
    .all(wsId, today)).forEach(o => push('high', 'objective',
      `Objective overdue: ${o.title}`,
      `/workspaces/${wsId}/objectives`,
      `Due ${o.due_date}`));
  (await db.prepare(`SELECT id, title, status FROM security_objectives
    WHERE workspace_id=? AND status='off_track'`)
    .all(wsId)).forEach(o => push('high', 'objective',
      `Objective off-track: ${o.title}`,
      `/workspaces/${wsId}/objectives`, ''));

  const lastMrm = await db.prepare(`SELECT meeting_date FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC NULLS LAST LIMIT 1`).get(wsId);
  if (!lastMrm) push('medium', 'mrm', 'No completed management review on record', `/workspaces/${wsId}/mrms`, '');
  else if (lastMrm.meeting_date < new Date(Date.now() - 365*86400000).toISOString().slice(0,10))
    push('medium', 'mrm', 'Last management review > 12 months ago', `/workspaces/${wsId}/mrms`, `Last: ${lastMrm.meeting_date}`);

  const lastAudit = await db.prepare(`SELECT audit_date FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL ORDER BY audit_date DESC LIMIT 1`).get(wsId);
  if (!lastAudit) push('medium', 'audit', 'No internal audit on record', `/workspaces/${wsId}/audits`, '');
  else if (lastAudit.audit_date < new Date(Date.now() - 365*86400000).toISOString().slice(0,10))
    push('medium', 'audit', 'Last internal audit > 12 months ago', `/workspaces/${wsId}/audits`, `Last: ${lastAudit.audit_date}`);

  (await db.prepare(`SELECT id, title, due_date FROM tasks
    WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND due_date < ?`)
    .all(wsId, today)).forEach(t => push('high', 'task', `Overdue task: ${t.title}`, `/workspaces/${wsId}/tasks`, `Due ${t.due_date}`));
  (await db.prepare(`SELECT id, title, due_date FROM tasks
    WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND due_date >= ? AND due_date < ?`)
    .all(wsId, today, expSoon)).forEach(t => push('medium', 'task', `Task due soon: ${t.title}`, `/workspaces/${wsId}/tasks`, `Due ${t.due_date}`));

  (await db.prepare(`SELECT id, title, audit_date FROM audits
    WHERE workspace_id=? AND audit_date IS NOT NULL AND audit_date >= ? AND audit_date < ? AND closed_at IS NULL`)
    .all(wsId, today, expSoon)).forEach(a => push('medium', 'audit', `Internal audit scheduled: ${a.title}`, `/workspaces/${wsId}/audits/${a.id}`, `On ${a.audit_date}`));
  (await db.prepare(`SELECT id, meeting_date FROM mrms
    WHERE workspace_id=? AND meeting_date IS NOT NULL AND meeting_date >= ? AND meeting_date < ? AND status != 'completed'`)
    .all(wsId, today, expSoon)).forEach(m => push('medium', 'mrm', `Management review scheduled (clause 9.3)`, `/workspaces/${wsId}/mrms/${m.id}`, `On ${m.meeting_date}`));

  const wsRow = await db.prepare(`SELECT target_cert_date FROM workspaces WHERE id=?`).get(wsId);
  if (wsRow && wsRow.target_cert_date) {
    if (wsRow.target_cert_date < today) push('high', 'cert', 'Certification target date has passed', `/workspaces/${wsId}`, `Target was ${wsRow.target_cert_date}`);
    else if (wsRow.target_cert_date < expSoon) push('medium', 'cert', 'Certification audit within 30 days', `/workspaces/${wsId}`, `Target ${wsRow.target_cert_date}`);
  }

  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
  return items;
}

module.exports = { computeNextStep, computeNeedsAttention };
