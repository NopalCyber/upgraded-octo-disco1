'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient, openTestDb } = require('./helpers');

let env, client, db, actor, colleague, wsId;
const docs = {};

async function inReview(name, preparedBy, approvers) {
  const id = Number((await db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, status, created_by, locked) VALUES (?, ?, 'policy', 'in_review', ?, 1)`)
    .run(wsId, name, preparedBy)).lastInsertRowid);
  const versionId = Number((await db.prepare(`INSERT INTO doc_versions (workspace_id, document_id, version, name, content, content_hash, status, created_by, submitted_at)
    VALUES (?, ?, 1, ?, 'Body', 'hash', 'in_review', ?, utc_now_text())`).run(wsId, id, name, preparedBy)).lastInsertRowid);
  await db.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=?').run(versionId, id);

  for (const [__index, __item] of approvers.entries()) await (async (userId, i) => await db.prepare(`INSERT INTO doc_approvers (workspace_id, document_id, version_id, sequence, user_id) VALUES (?, ?, ?, ?, ?)`)
    .run(wsId, id, versionId, i + 1, userId))(__item, __index);

  return id;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = await openTestDb(env.dbUrl);
  actor = await db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  colleague = Number((await db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES ('author@firm.example', '!noauth', 'Author', ?, 'firm', 'consultant', 1)`)
    .run(actor.firm_id)).lastInsertRowid);
  wsId = Number((await db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso27001"]', 'certification_support')`).run(actor.firm_id)).lastInsertRowid);
  docs.ready = await inReview('AI Policy', colleague, [actor.id]);
  docs.own = await inReview('AI Risk Methodology', actor.id, [actor.id]);
  docs.waiting = await inReview('Data Governance Procedure', colleague, [colleague, actor.id]);
  docs.partial = await inReview('Impact Assessment Procedure', colleague, [actor.id, colleague]);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the queue lists what is waiting on the user, with their own work not selectable', async () => {
  const page = await client.get(`/workspaces/${wsId}/documents`);
  assert.equal(page.status, 200);
  const queue = page.text.slice(page.text.indexOf('Waiting for your approval'), page.text.indexOf('</form>', page.text.indexOf('Waiting for your approval')));
  assert.match(queue, /Waiting for your approval \(3\)/);
  assert.match(queue, new RegExp(`name="document_ids" value="${docs.ready}" >`));
  assert.match(queue, new RegExp(`name="document_ids" value="${docs.own}" disabled>`));
  assert.doesNotMatch(queue, /Data Governance Procedure/, 'an earlier approver must decide first');
});

test('bulk approval approves what passes the checks and names what it skipped', async () => {
  const res = await client.post(`/workspaces/${wsId}/documents/bulk-approve`, { document_ids: [String(docs.ready), String(docs.own), String(docs.waiting), String(docs.partial)] });
  assert.equal(res.status, 302);
  const toast = decodeURIComponent(res.location);
  assert.match(toast, /Approved 2 documents/);
  assert.match(toast, /AI Risk Methodology \(you prepared this version/);
  assert.match(toast, /Data Governance Procedure \(an earlier approver has not decided\)/);
  const status = async id => (await db.prepare('SELECT status FROM generated_docs WHERE id=?').get(id)).status;
  assert.equal(await status(docs.ready), 'approved');
  assert.equal(await status(docs.own), 'in_review');
  assert.equal(await status(docs.waiting), 'in_review');
  assert.equal(await status(docs.partial), 'in_review', 'the next approver still has to decide');
  assert.equal((await db.prepare('SELECT decision FROM doc_approvers WHERE document_id=? AND user_id=?').get(docs.partial, actor.id)).decision, 'approved');
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='approve_document' AND CAST(entity_id AS TEXT)=?").get(String(docs.ready))).c, 1, 'the approval is in the audit log');
});
