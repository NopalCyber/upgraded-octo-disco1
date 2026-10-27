'use strict';

const { ALLOWED_FRAMEWORKS } = require('./frameworks');

const knownFramework = (framework) => (ALLOWED_FRAMEWORKS.includes(framework) ? framework : 'iso27001');

async function linkedDocsForControl(db, framework, isoItemId, workspaceId) {
  return await db.prepare(
    `SELECT d.id, d.name, d.category, d.status, drl.section_ref, drl.id AS link_id
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
     JOIN generated_docs d ON d.id = drl.document_id
     WHERE rq.ref = ? AND d.workspace_id = ?
     ORDER BY d.name`
  ).all(framework, isoItemId, workspaceId);
}

async function linkedControlsForDoc(db, framework, documentId) {
  return await db.prepare(
    `SELECT drl.id AS link_id, rq.ref AS iso_item_id, drl.section_ref, i.title, i.category, i.type
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
     JOIN iso_items i ON i.id = rq.ref
     WHERE drl.document_id = ?
     ORDER BY i.sort_order`
  ).all(framework, documentId);
}

function linkedDocIdsSubquery() {
  return `SELECT drl.document_id FROM document_requirement_links drl
            JOIN requirements rq ON rq.id = drl.requirement_id
            JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
            WHERE rq.ref = ?`;
}

function docCountSubquery(framework) {
  return `(SELECT COUNT(*) FROM document_requirement_links drl
            JOIN requirements rq ON rq.id = drl.requirement_id
            JOIN frameworks f ON f.id = rq.framework_id AND f.code = '${knownFramework(framework)}'
            JOIN generated_docs gd ON gd.id = drl.document_id
            WHERE rq.ref = i.id AND gd.workspace_id = ? AND gd.retired_at IS NULL)`;
}

function docControlsExpr(framework) {
  return `(SELECT drl.id AS id, drl.document_id AS document_id, rq.ref AS iso_item_id,
                  drl.section_ref AS section_ref, drl.created_at AS created_at
           FROM document_requirement_links drl
           JOIN requirements rq ON rq.id = drl.requirement_id
           JOIN frameworks f ON f.id = rq.framework_id AND f.code = '${knownFramework(framework)}')`;
}

async function requirementId(db, framework, isoItemId) {
  const r = await db.prepare(
    `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = ? AND rq.ref = ? AND f.status='active'
     ORDER BY f.id DESC LIMIT 1`
  ).get(framework, isoItemId);
  return r ? r.id : null;
}

async function addLink(db, framework, documentId, isoItemId, sectionRef) {
  const rid = await requirementId(db, framework, isoItemId);
  if (!rid) return { changes: 0 };
  return await db.prepare(
    `INSERT INTO document_requirement_links (document_id, requirement_id, section_ref) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`
  ).run(documentId, rid, sectionRef == null ? null : sectionRef);
}

async function resolveLinkByDoc(db, linkId, documentId) {
  return await db.prepare(
    `SELECT drl.id, drl.document_id, rq.ref AS iso_item_id
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     WHERE drl.id = ? AND drl.document_id = ?`
  ).get(linkId, documentId);
}

async function resolveLinkByControl(db, linkId, isoItemId, workspaceId) {
  return await db.prepare(
    `SELECT drl.id, drl.document_id, rq.ref AS iso_item_id
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     JOIN generated_docs d ON d.id = drl.document_id
     WHERE drl.id = ? AND rq.ref = ? AND d.workspace_id = ?`
  ).get(linkId, isoItemId, workspaceId);
}

async function deleteLink(db, linkId) {
  return await db.prepare(`DELETE FROM document_requirement_links WHERE id = ?`).run(linkId);
}

module.exports = {
  linkedDocsForControl, linkedControlsForDoc, linkedDocIdsSubquery, docCountSubquery,
  docControlsExpr, requirementId, addLink, resolveLinkByDoc, resolveLinkByControl, deleteLink,
};
