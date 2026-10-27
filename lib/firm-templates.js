'use strict';

const enc = require('./encryption');

class FirmTemplateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function deidentify(db, workspace, content) {
  let out = String(content || '');
  const names = [workspace.brand_display_name, workspace.client_name].filter((n) => n && n.trim().length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) out = out.replace(new RegExp(escapeRe(name.trim()), 'g'), '{{client_name}}');
  return out;
}

async function mappingFor(db, doc) {
  const source = doc.template_id ? await db.prepare('SELECT tier, controls, clauses FROM doc_templates WHERE id=?').get(doc.template_id) : null;
  const refs = (await db.prepare(`SELECT rq.ref FROM document_requirement_links drl JOIN requirements rq ON rq.id = drl.requirement_id
    JOIN frameworks f ON f.id = rq.framework_id WHERE drl.document_id=? AND f.code='iso27001'`).all(doc.id)).map((l) => l.ref);
  return {
    controls: source && source.controls ? source.controls : JSON.stringify(refs.filter((r) => r.startsWith('annex-a.'))),
    clauses: source && source.clauses ? source.clauses : JSON.stringify(refs.filter((r) => r.startsWith('clause-'))),
    tier: (source && source.tier) || 'recommended',
  };
}

async function saveFromDocument(db, workspace, docId, input) {
  const doc = await db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(docId, workspace.id);
  if (!doc) throw new FirmTemplateError('Document not found.', 404);
  const name = clean(input.name, 160) || doc.name;
  if (await db.prepare('SELECT 1 FROM doc_templates WHERE firm_id=? AND is_system=0 AND name=?').get(workspace.firm_id, name)) {
    throw new FirmTemplateError('The firm already has a template with that name. Choose another name.', 409);
  }
  const content = deidentify(db, workspace, enc.decryptIfNeeded(doc.content || '', workspace.id));
  if (!content.trim()) throw new FirmTemplateError('The document is empty.');
  const m = await mappingFor(db, doc);
  const id = Number((await db.prepare(`INSERT INTO doc_templates (firm_id, name, category, description, content, is_system, tier, controls, clauses)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(workspace.firm_id, name, doc.category || 'policy',
    clean(input.description, 500) || `Firm template, first written as ${doc.name}.`, content, m.tier, m.controls, m.clauses)).lastInsertRowid);
  return { id, name, clientNameLeft: content.includes(workspace.client_name) };
}

async function list(db, firmId) {
  return await db.prepare(`SELECT t.id, t.name, t.category, t.tier, t.created_at,
      (SELECT COUNT(*) FROM generated_docs d WHERE d.template_id = t.id) AS used
    FROM doc_templates t WHERE t.firm_id=? AND t.is_system=0 ORDER BY t.name`).all(firmId);
}

async function remove(db, firmId, templateId) {
  const t = await db.prepare('SELECT id, name FROM doc_templates WHERE id=? AND firm_id=? AND is_system=0').get(templateId, firmId);
  if (!t) throw new FirmTemplateError('That firm template was not found.', 404);
  await db.transaction(async () => {
    await db.prepare('UPDATE generated_docs SET template_id=NULL WHERE template_id=?').run(t.id);
    await db.prepare('DELETE FROM doc_templates WHERE id=?').run(t.id);
  })();
  return t;
}

module.exports = { FirmTemplateError, saveFromDocument, list, remove, deidentify };
