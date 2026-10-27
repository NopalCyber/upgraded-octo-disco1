'use strict';

const test = require('node:test');
const assert = require('node:assert');
const INTAKE = require('../data/intake-questions');
const { bootClient } = require('./helpers');

const q = (id) => INTAKE.flatten().find((x) => x.id === id);

test('a multiselect answer round-trips through the stored string format', () => {
  const dataTypes = q('data-types');
  const stored = INTAKE.serializeMultiselect(dataTypes,
    ['Cardholder data (PCI)', 'Personal data (PII)'], 'telemetry');
  assert.equal(typeof stored, 'string', 'the answer column holds a string, not JSON');
  assert.equal(stored, 'Personal data (PII)\nCardholder data (PCI)\ntelemetry');
  const back = INTAKE.parseMultiselect(dataTypes, stored);
  assert.deepEqual(back.selected, ['Personal data (PII)', 'Cardholder data (PCI)']);
  assert.equal(back.other, 'telemetry');
});

test('answers written before these fields were multiselects still resolve', () => {
  const back = INTAKE.parseMultiselect(q('data-types'), 'PII, PCI, some bespoke telemetry');
  assert.deepEqual(back.selected, ['Personal data (PII)', 'Cardholder data (PCI)']);
  assert.equal(back.other, 'some bespoke telemetry', 'unrecognised text must never be dropped');
});

test('a conditional question hides only when its controller rules it out', () => {
  const onprem = q('onprem-footprint');
  const cloud = q('cloud-providers');
  assert.equal(INTAKE.isVisible(onprem, { 'infra-model': 'Cloud-only' }), false);
  assert.equal(INTAKE.isVisible(onprem, { 'infra-model': 'Hybrid (balanced cloud + on-prem)' }), true);
  assert.equal(INTAKE.isVisible(cloud, { 'infra-model': 'On-prem only' }), false);
  assert.equal(INTAKE.isVisible(cloud, { 'infra-model': 'Cloud-only' }), true);
  assert.equal(INTAKE.isVisible(onprem, {}), true);
  assert.equal(INTAKE.isVisible(cloud, {}), true);
});

test('posting checkbox options saves the combined answer and feeds the scope statement', async () => {
  const env = await bootClient();
  const { client } = env;
  const { db } = require('../db');
  const manager = await db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const wsId = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,industry,frameworks)
    VALUES (?,'Intake Structured Co','Technology',?)`)
    .run(manager.firm_id, JSON.stringify(['iso27001']))).lastInsertRowid);

  const page = await client.get(`/workspaces/${wsId}/intake`);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="lbl-data-types"/);
  assert.match(page.text, /role="group" aria-labelledby="lbl-data-types"/,
    'multiselect choices must reference their visible question label');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];

  const res = await client.post(`/workspaces/${wsId}/intake`, {
    _csrf: csrf,
    'org-name': 'Intake Structured Co Ltd',
    'products-in-scope': 'The payments API',
    'infra-model': 'Cloud-only',
    'data-types__opt': ['Personal data (PII)', 'Cardholder data (PCI)'],
    'data-types__other': 'device telemetry',
    'cloud-providers__opt': 'AWS',
    'cloud-providers__other': '',
  });
  assert.ok(res.status === 302 || res.status === 200, `unexpected ${res.status}`);

  const stored = await db.prepare(
    `SELECT answer FROM engagement_intake WHERE workspace_id=? AND question_id='data-types'`).get(wsId);
  assert.equal(stored.answer, 'Personal data (PII)\nCardholder data (PCI)\ndevice telemetry');

  const single = await db.prepare(
    `SELECT answer FROM engagement_intake WHERE workspace_id=? AND question_id='cloud-providers'`).get(wsId);
  assert.equal(single.answer, 'AWS', 'one checked box must not be stored as an array');

  const answers = {};
  for (const row of await db.prepare(
    `SELECT question_id, answer FROM engagement_intake WHERE workspace_id=?`).all(wsId)) {
    answers[row.question_id] = row.answer;
  }
  const scope = INTAKE.draftScopeStatement(answers);
  assert.match(scope, /Intake Structured Co Ltd/);
  assert.match(scope, /Personal data \(PII\)/, 'multiselect answers must reach the clause 4.3 statement');

  await client.close();
});
