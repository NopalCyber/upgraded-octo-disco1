'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { bootApp, openTestDb } = require('./helpers');

const CHECK_VIOLATION = { code: '23514' };
const FOREIGN_KEY_VIOLATION = { code: '23503' };

let governanceRoutes;
let deleteWorkspace;

let env;
let db;
let firmId;
let actorId;

async function createWorkspace(name) {
  return Number((await db.prepare("INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome,lead_consultant_id) VALUES (?,?,'[\"iso27001\"]','certification_support',?)")
    .run(firmId, name, actorId)).lastInsertRowid);
}

async function createEvidence(workspaceId, filename) {
  return Number((await db.prepare('INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by) VALUES (?,?,?,?,?,?)')
    .run(workspaceId, filename, 'test/' + workspaceId + '/' + filename, 'a'.repeat(64), 12, actorId)).lastInsertRowid);
}

async function createCertificationFinding(workspaceId, severity = 'minor', title = 'Certification finding') {
  const eventId = Number((await db.prepare("INSERT INTO cert_cycle_events (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-08-01','closed')")
    .run(workspaceId)).lastInsertRowid);
  const findingId = Number((await db.prepare("INSERT INTO nonconformities (workspace_id,title,source,source_ref,severity,status) VALUES (?,?,'external_audit',?,?,'open')")
    .run(workspaceId, title, 'cert_cycle_event:' + eventId, severity)).lastInsertRowid);
  return { eventId, findingId };
}

async function linkEvidence(workspaceId, findingId, evidenceId, role) {
  return await db.prepare('INSERT INTO nonconformity_evidence_links (workspace_id,nonconformity_id,evidence_id,evidence_role,linked_by) VALUES (?,?,?,?,?)')
    .run(workspaceId, findingId, evidenceId, role, actorId);
}

function captureGovernanceHandlers() {
  const handlers = new Map();
  const app = {
    get(route, ...stack) { handlers.set('GET ' + route, stack.at(-1)); },
    post(route, ...stack) { handlers.set('POST ' + route, stack.at(-1)); },
  };
  const middleware = (_req, _res, next) => { if (next) next(); };
  governanceRoutes.register(app, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction() {},
    workspaceProgress() { return {}; },
  });
  return handlers;
}

function response() {
  return {
    statusCode: 200,
    redirected: null,
    rendered: null,
    status(code) { this.statusCode = code; return this; },
    send(message) { this.message = message; return message; },
    redirect(url) { this.redirected = url; return url; },
    render(view, locals) { this.rendered = { view, locals }; return this.rendered; },
  };
}

test.before(async () => {
  env = await bootApp();
  governanceRoutes = require('../routes/governance');
  ({ deleteWorkspace } = require('../lib/workspace-deletion'));
  db = await openTestDb(env.dbUrl);
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  actorId = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()).id;
});

test.after(async () => {
  if (db) await db.close();
  if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test('schema enforces workspace-qualified immutable CAPA evidence lineage and database closure gates', async () => {
  const wsId = await createWorkspace('Certification proof boundary');
  const otherWsId = await createWorkspace('Other evidence tenant');
  const { eventId, findingId } = await createCertificationFinding(wsId, 'major');
  const remediationId = await createEvidence(wsId, 'remediation.pdf');
  const validationId = await createEvidence(wsId, 'validation.pdf');
  const foreignEvidenceId = await createEvidence(otherWsId, 'foreign.pdf');

  await assert.rejects(async () => await linkEvidence(wsId, findingId, foreignEvidenceId, 'validation'), FOREIGN_KEY_VIOLATION);
  await assert.rejects(async () => await linkEvidence(wsId, findingId, remediationId, 'supporting'), CHECK_VIOLATION);
  await linkEvidence(wsId, findingId, remediationId, 'remediation');
  const remediationLink = await db.prepare('SELECT * FROM nonconformity_evidence_links WHERE workspace_id=? AND nonconformity_id=?')
    .get(wsId, findingId);
  assert.equal(remediationLink.evidence_role, 'remediation');
  await assert.rejects(async () => await db.prepare("UPDATE nonconformity_evidence_links SET evidence_role='validation' WHERE id=?")
    .run(remediationLink.id), /lineage is immutable/);
  await assert.rejects(async () => await db.prepare('DELETE FROM nonconformity_evidence_links WHERE id=?')
    .run(remediationLink.id), /lineage is immutable/);
  await assert.rejects(async () => await db.prepare('DELETE FROM evidence WHERE id=?').run(remediationId), FOREIGN_KEY_VIOLATION);

  await assert.rejects(async () => await db.prepare("UPDATE nonconformities SET root_cause='Missing ownership',corrective_action='Assign and operate the review',effectiveness_check='Independent sample passed',status='closed' WHERE id=?")
    .run(findingId), /closure requires CAPA and validation evidence/);

  await linkEvidence(wsId, findingId, validationId, 'validation');
  await db.prepare("UPDATE nonconformities SET root_cause='Missing ownership',corrective_action='Assign and operate the review',effectiveness_check='Independent sample passed',status='closed' WHERE id=?")
    .run(findingId);
  assert.equal((await db.prepare('SELECT status FROM nonconformities WHERE id=?').get(findingId)).status, 'closed');
  await assert.rejects(async () => await db.prepare("UPDATE nonconformities SET source_ref='other' WHERE id=?").run(findingId),
    /lineage is immutable/);
  await assert.rejects(async () => await db.prepare('DELETE FROM nonconformities WHERE id=?').run(findingId),
    /retained audit history/);
  await assert.rejects(async () => await db.prepare('DELETE FROM cert_cycle_events WHERE id=?').run(eventId),
    /retained findings cannot be deleted/);

  const observation = await createCertificationFinding(wsId, 'observation', 'Stage 1 observation');
  const observationEvidence = await createEvidence(wsId, 'observation-validation.pdf');
  await linkEvidence(wsId, observation.findingId, observationEvidence, 'validation');
  await assert.doesNotReject(async () => await db.prepare("UPDATE nonconformities SET corrective_action='Updated the procedure',effectiveness_check='Re-test passed',status='verified' WHERE id=?")
    .run(observation.findingId));
});

test('governance handlers expose evidence, enforce an actionable closure checklist, and clear stale closure time on reopen', async () => {
  const wsId = await createWorkspace('Certification proof route');
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  ws.frameworks = ['iso27001'];
  const { findingId } = await createCertificationFinding(wsId, 'minor');
  const evidenceId = await createEvidence(wsId, 'independent-validation.pdf');
  const handlers = captureGovernanceHandlers();
  const baseReq = {
    params: { id: String(findingId) },
    workspace: ws,
    user: { id: actorId },
    headers: {},
    connection: {},
  };

  let res = response();
  await handlers.get('GET /workspaces/:wsId/nonconformities/:id')({ ...baseReq, query: {} }, res);
  assert.equal(res.rendered.view, 'nonconformity_detail');
  assert.equal(res.rendered.locals.certificationLineage.event_type, 'stage_1');
  assert.ok(res.rendered.locals.evidenceCatalog.some(row => row.id === evidenceId));

  res = response();
  await handlers.get('POST /workspaces/:wsId/nonconformities/:id')({
    ...baseReq,
    body: {
      status: 'closed',
      corrective_action: 'Corrected the procedure',
      effectiveness_check: 'Follow-up sample passed',
    },
  }, res);
  assert.match(decodeURIComponent(res.redirected), /root-cause analysis/);
  assert.match(decodeURIComponent(res.redirected), /independent validation evidence/);
  assert.equal((await db.prepare('SELECT status FROM nonconformities WHERE id=?').get(findingId)).status, 'open');

  res = response();
  await handlers.get('POST /workspaces/:wsId/nonconformities/:id/evidence')({
    ...baseReq,
    body: { evidence_id: String(evidenceId), evidence_role: 'validation' },
  }, res);
  assert.match(decodeURIComponent(res.redirected), /Evidence linked into the retained CAPA record/);

  res = response();
  await handlers.get('POST /workspaces/:wsId/nonconformities/:id')({
    ...baseReq,
    body: {
      status: 'verified',
      root_cause: 'Ownership was not assigned',
      corrective_action: 'Assigned an owner and operated the review',
      effectiveness_check: 'An independent follow-up sample passed',
    },
  }, res);
  let finding = await db.prepare('SELECT * FROM nonconformities WHERE id=?').get(findingId);
  assert.equal(finding.status, 'verified');
  assert.ok(finding.closed_at);

  res = response();
  await handlers.get('POST /workspaces/:wsId/nonconformities/:id')({
    ...baseReq,
    body: { status: 'in_progress' },
  }, res);
  finding = await db.prepare('SELECT * FROM nonconformities WHERE id=?').get(findingId);
  assert.equal(finding.status, 'in_progress');
  assert.equal(finding.closed_at, null);
});

test('typed-confirm workspace deletion removes linked CAPA history and restores its immutable guard', async () => {
  const retainedWsId = await createWorkspace('Retained link control');
  const retainedFinding = await createCertificationFinding(retainedWsId, 'observation');
  const retainedEvidence = await createEvidence(retainedWsId, 'retained-control.pdf');
  await linkEvidence(retainedWsId, retainedFinding.findingId, retainedEvidence, 'validation');
  const retainedLinkId = (await db.prepare('SELECT id FROM nonconformity_evidence_links WHERE workspace_id=?')
    .get(retainedWsId)).id;

  const doomedWsId = await createWorkspace('Typed delete CAPA client');
  const doomedFinding = await createCertificationFinding(doomedWsId, 'minor');
  const doomedEvidence = await createEvidence(doomedWsId, 'doomed-validation.pdf');
  await linkEvidence(doomedWsId, doomedFinding.findingId, doomedEvidence, 'validation');

  const deleted = await deleteWorkspace(db, doomedWsId);
  assert.equal(deleted.workspaceId, doomedWsId);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=?').get(doomedWsId)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM nonconformity_evidence_links WHERE workspace_id=?').get(doomedWsId)).c, 0);
  assert.ok(await db.prepare("SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D' AND tgname='trg_nc_evidence_link_no_delete'").get());
  await assert.rejects(async () => await db.prepare('DELETE FROM nonconformity_evidence_links WHERE id=?').run(retainedLinkId),
    /lineage is immutable/);
});

test('route and UI sources retain the CAPA proof controls without nested delete forms', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'governance.js'), 'utf8');
  const viewPath = path.join(__dirname, '..', 'views', 'nonconformity_detail.ejs');
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.match(route, /nonconformities\/:id\/evidence/);
  assert.match(route, /independent validation evidence/);
  assert.match(view, /CAPA evidence lineage/);
  assert.match(view, /formaction="\/workspaces\/<%= ws\.id %>\/nonconformities\/<%= nc\.id %>\/delete"/);
  assert.doesNotMatch(view, /<form[^>]+action="\/workspaces\/<%= ws\.id %>\/nonconformities\/<%= nc\.id %>\/delete"/);
  assert.doesNotThrow(() => ejs.compile(view, { filename: viewPath }));
});
