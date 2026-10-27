'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let setupLib;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  setupLib = require('../lib/client-setup');
});

test.after(async () => { if (client) await client.close(); });

function created(location) {
  const match = String(location || '').match(/workspaces\/(\d+)/);
  assert.ok(match, `expected a workspace redirect, got ${location}`);
  return Number(match[1]);
}

async function workspace(id) {
  const row = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = require('../lib/frameworks').parseWorkspaceFrameworks(row.frameworks);
  return row;
}

test('a client with more than one service lands on the setup hub, not one programme intake', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Multi Service Client',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    tprm_enabled: '1',
    tprm_service_model: 'managed_lifecycle',
  });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/workspaces\/\d+\/setup(?:\?|$)/,
    'a client with two services must not be sent to a single programme intake');

  const id = created(res.location);
  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.equal(setup.total, 2, 'every enabled service needs its own step');
  assert.deepEqual(setup.steps.map(s => s.key), ['iso27001', 'tprm']);
  assert.equal(setup.steps[0].status, 'not_started');
  assert.equal(setup.nextStep.key, 'iso27001');
});

test('a client with no ISO 27001 is never sent to the ISO 27001 intake', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Third-party Risk Only', tprm_enabled: '1', tprm_service_model: 'assessment_only',
  });
  const id = created(res.location);
  assert.doesNotMatch(res.location, /\/intake/,
    'the ISO 27001 intake is not this client\'s scoping surface');

  const open = await client.get(`/workspaces/${id}`);
  assert.equal(open.status, 302);
  assert.match(open.location, /\/tprm$/);

  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.deepEqual(setup.steps.map(s => s.key), ['tprm']);
});

test('a single-service client goes straight to its own surface', async () => {
  for (const [name, body, pattern] of [
    ['iso27001', { frameworks: ['iso27001'], engagement_outcome: 'certification_support' }, /\/intake(?:\?|$)/],
    ['tprm', { tprm_enabled: '1', tprm_service_model: 'assessment_only' }, /\/tprm(?:\?|$)/],
  ]) {
    const res = await client.post('/workspaces', { client_name: `Single ${name} Client`, ...body });
    assert.match(res.location, pattern,
      `a ${name}-only client should open its own scoping surface, not a checklist of one`);
  }
});

test('the seeded cert-deadline answer never counts as setup progress', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Seeded Deadline Client',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    target_cert_date: '2027-06-30',
  });
  const id = created(res.location);

  const seeded = (await db.prepare(`SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer))>0`).get(id)).c;
  assert.ok(seeded >= 1, 'this test is meaningless unless the seed still happens');

  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.equal(setup.steps[0].status, 'not_started',
    'an untouched client must read as not started despite the seeded answer');
  assert.equal(await setupLib.needsSetup(db, await workspace(id)), true);
});

test('a real scope statement is required, not placeholder prose', async () => {
  const res = await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES ((SELECT id FROM firms LIMIT 1),'Placeholder Scope Client',?, 'certification_support')`)
    .run(JSON.stringify(['iso27001']));
  const id = Number(res.lastInsertRowid);

  await db.prepare(`UPDATE workspaces SET scope=?, scope_confirmed_at=utc_now_text() WHERE id=?`)
    .run('The information security management system covers the operations of [org-name - not answered].', id);

  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.notEqual(setup.steps[0].status, 'complete',
    'placeholder scope prose must never count as a signed-off scope');
});

test('modules alone do not make a client look scoped', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Programme Plus TPRM',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    tprm_enabled: '1',
    tprm_service_model: 'assessment_only',
  });
  const id = created(res.location);
  const ws = await workspace(id);
  const setup = await setupLib.clientSetup(db, ws);

  const tprm = setup.steps.find(s => s.key === 'tprm');
  assert.ok(tprm, 'the TPRM module needs its own step');
  assert.equal(tprm.status, 'complete', 'the service model was chosen on the create form');
  assert.equal(tprm.kind, 'module');

  assert.equal(await setupLib.needsSetup(db, ws), true);
  assert.equal(setup.nextStep.kind, 'programme');
});

test('third-party risk can be added to a client that already has a programme', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'TPRM Added Later', frameworks: ['iso27001'], engagement_outcome: 'certification_support',
  });
  const id = created(res.location);
  const hub = await client.get(`/workspaces/${id}/setup`);
  assert.equal(hub.status, 200);
  assert.match(hub.text, new RegExp(`action="/workspaces/${id}/modules/tprm"`),
    'the setup hub must host the TPRM service-model form');
});
