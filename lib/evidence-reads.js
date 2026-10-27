'use strict';

const { ALLOWED_FRAMEWORKS, byFramework } = require('./frameworks');

function linkCountSubquery() {
  return `(SELECT COUNT(*) FROM evidence_requirement_links erl_lc
            WHERE erl_lc.evidence_id = e.id)`;
}

function linkedControlsSubquery() {
  return `(SELECT string_agg(f_lk.code || ':' || rq_lk.ref, '; ') FROM evidence_requirement_links erl_lk
            JOIN requirements rq_lk ON rq_lk.id = erl_lk.requirement_id
            JOIN frameworks f_lk ON f_lk.id = rq_lk.framework_id
            WHERE erl_lk.evidence_id = e.id)`;
}

function checklistEvidenceCountSubquery(framework = 'iso27001') {
  const fw = ALLOWED_FRAMEWORKS.includes(framework) ? framework : 'iso27001';
  return `(SELECT COUNT(*) FROM evidence_requirement_links erl_ck
            JOIN evidence e_ck ON e_ck.id = erl_ck.evidence_id
            JOIN requirements rq_ck ON rq_ck.id = erl_ck.requirement_id
            JOIN frameworks f_ck ON f_ck.id = rq_ck.framework_id AND f_ck.code='${fw}'
            WHERE rq_ck.ref = i.id AND e_ck.workspace_id = ?)`;
}

async function libraryLinks(db, evidenceIds) {
  const linksByEvidence = {};
  const crossLinksByEvidence = {};
  if (!evidenceIds || !evidenceIds.length) return { linksByEvidence, crossLinksByEvidence };
  for (const evidenceId of evidenceIds) {
    linksByEvidence[evidenceId] = [];
    crossLinksByEvidence[evidenceId] = byFramework();
  }
  const ph = evidenceIds.map(() => '?').join(',');

  const isoRows = await db.prepare(
    `SELECT erl.id AS link_id, erl.evidence_id, rq.ref AS iso_item_id, erl.section_ref,
            i.title AS iso_title, i.type AS iso_type
     FROM evidence_requirement_links erl
     JOIN requirements rq ON rq.id = erl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
     JOIN iso_items i ON i.id = rq.ref
     WHERE erl.evidence_id IN (${ph})
     ORDER BY i.sort_order ASC`
  ).all(...evidenceIds);
  for (const l of isoRows) {
    linksByEvidence[l.evidence_id].push(l);
  }

  const codePh = ALLOWED_FRAMEWORKS.map(() => '?').join(',');
  const crossRows = await db.prepare(
    `SELECT erl.id AS link_id, erl.evidence_id, f.code AS framework, rq.ref AS item_ref, erl.section_ref,
            rq.title AS requirement_title
     FROM evidence_requirement_links erl
     JOIN requirements rq ON rq.id = erl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id
     WHERE erl.evidence_id IN (${ph}) AND f.code IN (${codePh})
     ORDER BY f.code, rq.ref`
  ).all(...evidenceIds, ...ALLOWED_FRAMEWORKS);
  for (const l of crossRows) {
    crossLinksByEvidence[l.evidence_id][l.framework].push(l);
  }
  return { linksByEvidence, crossLinksByEvidence };
}

async function controlPanelEvidence(db, workspaceId, isoItemId) {
  return await db.prepare(
    `SELECT e.id, e.filename, e.size_bytes, e.description, e.uploaded_at,
            e.valid_from, e.valid_until, e.period_label, e.clause_section,
            e.superseded_at,
            u.name AS uploader,
            ${linkCountSubquery()} AS link_count
     FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
     WHERE e.workspace_id=? AND e.superseded_at IS NULL AND e.id IN (
       SELECT id FROM evidence WHERE workspace_id=? AND iso_item_id=?
       UNION
       SELECT erl.evidence_id FROM evidence_requirement_links erl
         JOIN requirements rq ON rq.id = erl.requirement_id
         JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
         WHERE rq.ref = ?
     )
     ORDER BY e.uploaded_at DESC NULLS LAST`
  ).all(workspaceId, workspaceId, isoItemId, isoItemId);
}

async function coverageEvidenceByControl(db, workspaceId) {
  const out = {};
  (await db.prepare(
    `SELECT iso_item_id, MAX(uploaded_at) AS last_uploaded_at, COUNT(*) AS attached
     FROM (
       SELECT iso_item_id, uploaded_at FROM evidence WHERE workspace_id=? AND iso_item_id IS NOT NULL AND superseded_at IS NULL
       UNION ALL
       SELECT rq.ref AS iso_item_id, e.uploaded_at FROM evidence_requirement_links erl
         INNER JOIN evidence e ON e.id = erl.evidence_id
         INNER JOIN requirements rq ON rq.id = erl.requirement_id
         WHERE e.workspace_id=? AND e.superseded_at IS NULL
     )
     GROUP BY iso_item_id`
  ).all(workspaceId, workspaceId)).forEach(r => {
    out[r.iso_item_id] = { attached: r.attached, last_uploaded_at: r.last_uploaded_at };
  });
  return out;
}

module.exports = {
  linkCountSubquery,
  linkedControlsSubquery,
  checklistEvidenceCountSubquery,
  libraryLinks,
  controlPanelEvidence,
  coverageEvidenceByControl,
};
