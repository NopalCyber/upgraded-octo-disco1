'use strict';

async function reqId(db, framework, ref) {
  const r = await db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code=? AND r.ref=? AND f.status='active' ORDER BY f.id DESC LIMIT 1`).get(framework, ref);
  return r ? r.id : null;
}

async function linkInfo(db, linkId, evidenceId) {
  return await db.prepare(
    `SELECT erl.id, f.code AS framework, rq.ref AS item_ref
     FROM evidence_requirement_links erl
     JOIN requirements rq ON rq.id = erl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id
     WHERE erl.id = ? AND erl.evidence_id = ?`
  ).get(linkId, evidenceId);
}

async function attachIsoControl(db, evidenceId, isoItemId, sectionRef) {
  const rid = await reqId(db, 'iso27001', isoItemId);
  if (!rid) return false;
  await db.prepare('INSERT INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .run(evidenceId, rid, sectionRef ?? null);
  return true;
}

async function copyControlLinks(db, fromEvidenceId, toEvidenceId) {
  const rows = await db.prepare('SELECT requirement_id, section_ref FROM evidence_requirement_links WHERE evidence_id=?').all(fromEvidenceId);
  const ins = db.prepare('INSERT INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  for (const l of rows) await ins.run(toEvidenceId, l.requirement_id, l.section_ref);
  return rows.length;
}

async function updateSection(db, evidenceId, linkId, newRef) {
  const info = await db.prepare('UPDATE evidence_requirement_links SET section_ref=? WHERE id=? AND evidence_id=?').run(newRef ?? null, linkId, evidenceId);
  return info.changes > 0;
}

async function unlinkIsoControl(db, evidenceId, linkId) {
  const info = await linkInfo(db, linkId, evidenceId);
  if (!info || info.framework !== 'iso27001') return null;
  await db.prepare('DELETE FROM evidence_requirement_links WHERE id=? AND evidence_id=?').run(linkId, evidenceId);
  return info.item_ref;
}

module.exports = {
  reqId,
  attachIsoControl,
  copyControlLinks,
  updateSection,
  unlinkIsoControl,
};
