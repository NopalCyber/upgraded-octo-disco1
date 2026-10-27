'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, openTestDb } = require('./helpers');
const coverage = require('../lib/tprm-framework-coverage');

test('capability coverage maps directly to every ISO supplier control', () => {
  const facts = {};
  for (const capability of coverage.CAPABILITIES) {
    for (const requirement of capability.requirements) {
      facts[requirement] = { value: true, sources: [{ sourceType: 'test_record', sourceId: requirement, label: requirement }] };
    }
  }
  const capabilities = coverage.evaluateCapabilities(facts);
  assert.equal(capabilities.length, 10);
  assert.ok(capabilities.every(item => item.status === 'evidenced' && item.percentage === 100));
  const rollup = coverage.frameworkRollup(capabilities);
  assert.deepEqual(Object.keys(rollup), ['iso27001']);
  assert.deepEqual(rollup.iso27001.map(item => item.ref), [
    'A.5.19','A.5.20','A.5.21','A.5.22','A.5.23','A.5.24','A.5.26',
  ]);
  assert.ok(rollup.iso27001.every(item => item.status === 'evidenced' && item.percentage === 100));
  assert.ok(rollup.iso27001.every(item => /not a conformity or certification conclusion/.test(item.disclaimer)));
});

test('partial evidence is reported as partial and names the exact missing capability checks', () => {
  const capabilities = coverage.evaluateCapabilities({
    inventoryRecord: { value: true, sources: [{ sourceType: 'third_party', sourceId: '1', label: 'Provider' }] },
    approvedInherentRisk: { value: false, sources: [], note: 'Approve tiering.' },
  });
  const inventory = capabilities.find(item => item.key === 'inventory_and_criticality');
  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.percentage, 50);
  assert.deepEqual(inventory.gaps, [{ key: 'approvedInherentRisk', note: 'Approve tiering.' }]);
  assert.deepEqual(inventory.evidence, [{ sourceType: 'third_party', sourceId: '1', label: 'Provider' }]);
});

test('database projection is tenant scoped and does not claim framework conformity', async () => {
  const env = await bootApp();
  const db = await openTestDb(env.dbUrl);
  try {
    const firm = await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    const managerId = Number((await db.prepare(`INSERT INTO users
      (email,password_hash,name,user_type,firm_id,firm_role,active)
      VALUES ('coverage-manager@example.test','!','Coverage Manager','firm',?,'manager',1)`).run(firm.id)).lastInsertRowid);
    const workspaceA = Number((await db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,frameworks) VALUES (?,'Coverage client A','[]')`).run(firm.id)).lastInsertRowid);
    const workspaceB = Number((await db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,frameworks) VALUES (?,'Coverage client B','[]')`).run(firm.id)).lastInsertRowid);
    const supplierId = Number((await db.prepare(`INSERT INTO suppliers
      (workspace_id,name,service_provided,lifecycle_stage,tier,business_owner,relationship_owner,exit_strategy)
      VALUES (?,'Scoped Provider','Critical processing','prospect','tier_2','Client owner','Consultancy owner','Controlled migration and deletion')`).run(workspaceA)).lastInsertRowid);
    await require('../lib/tprm-domain').enableModule(db, {
      workspaceId: workspaceA, serviceModel: 'managed_lifecycle', actorId: managerId,
      reason: 'Enable governed third-party risk coverage.',
    });

    const result = await coverage.thirdPartyCoverage(db, workspaceA, supplierId);
    assert.equal(result.thirdParty.name, 'Scoped Provider');
    assert.equal(result.capabilities.find(item => item.key === 'inventory_and_criticality').status, 'partial');
    assert.match(result.disclaimer, /not a certification or compliance opinion/);
    assert.ok(result.frameworks.iso27001.every(item => item.evidence.every(source => !Object.hasOwn(source, 'storedPath'))));
    await assert.rejects(async () => await coverage.thirdPartyCoverage(db, workspaceB, supplierId), /third_party_not_found/);
  } finally {
    await db.close();
  }
});
