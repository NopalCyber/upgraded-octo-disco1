'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const relationships = require('../lib/tprm-relationships');
const { bootApp, openTestDb } = require('./helpers');

let productionDb;
let dbUrl;

test.before(async () => {
  ({ db: productionDb, dbUrl } = await bootApp());
});

test.after(async () => {
  assert.deepEqual(await productionDb.prepare(`SELECT conname FROM pg_constraint
    WHERE contype='f' AND NOT convalidated AND connamespace=current_schema()::regnamespace`).all(), []);
  await productionDb.close();
});

test('service activation authority follows only the latest positive client decision and exact frozen service scope', async () => {
  const db = await openTestDb(dbUrl);
  try {
    await db.transaction(async () => {
      await db.exec(`
        CREATE TEMP TABLE tprm_service_relationships (id bigint PRIMARY KEY,workspace_id bigint,supplier_id bigint) ON COMMIT DROP;
        CREATE TEMP TABLE tprm_recommendations (id bigint PRIMARY KEY,workspace_id bigint,supplier_id bigint,issued_at text,supersedes_id bigint) ON COMMIT DROP;
        CREATE TEMP TABLE tprm_client_decisions (
          id bigint PRIMARY KEY,workspace_id bigint,supplier_id bigint,version bigint,
          recommendation_id bigint,decision text,valid_until text,decision_snapshot_json text,supersedes_id bigint
        ) ON COMMIT DROP;
        INSERT INTO tprm_service_relationships VALUES (10,1,100),(11,1,100);
        INSERT INTO tprm_recommendations VALUES (20,1,100,'2026-08-01 00:00:00',NULL);
      `);
      assert.equal((await relationships.relationshipActivationAuthority(db, { workspaceId:1, relationshipId:10 })).code,
        'TPRM_CLIENT_DECISION_REQUIRED');
      await db.prepare(`INSERT INTO tprm_client_decisions VALUES (30,1,100,1,20,'onboard',NULL,?,NULL)`)
        .run(JSON.stringify({ serviceRelationships:[{ id:11 }] }));
      assert.equal((await relationships.relationshipActivationAuthority(db, { workspaceId:1, relationshipId:10 })).code,
        'TPRM_RELATIONSHIP_NOT_CLIENT_AUTHORISED');
      await db.prepare(`UPDATE tprm_client_decisions SET decision_snapshot_json=? WHERE id=30`)
        .run(JSON.stringify({ serviceRelationships:[{ id:10 }] }));
      assert.equal((await relationships.relationshipActivationAuthority(db, { workspaceId:1, relationshipId:10 })).allowed, true);
      await db.prepare(`INSERT INTO tprm_recommendations VALUES (21,1,100,'2026-08-02 00:00:00',NULL)`).run();
      assert.equal((await relationships.relationshipActivationAuthority(db, { workspaceId:1, relationshipId:10 })).code,
        'TPRM_CLIENT_DECISION_STALE');
      await db.prepare(`INSERT INTO tprm_client_decisions VALUES (31,1,100,2,21,'defer_request_information',NULL,?,30)`)
        .run(JSON.stringify({ serviceRelationships:[{ id:10 }] }));
      assert.equal((await relationships.relationshipActivationAuthority(db, { workspaceId:1, relationshipId:10 })).code,
        'TPRM_POSITIVE_CLIENT_DECISION_REQUIRED');
      await db.prepare(`INSERT INTO tprm_client_decisions VALUES (32,1,100,3,21,'do_not_onboard',NULL,?,31)`)
        .run(JSON.stringify({ serviceRelationships:[{ id:10 }] }));
      assert.equal((await relationships.relationshipActivationAuthority(db, { workspaceId:1, relationshipId:10 })).code,
        'TPRM_POSITIVE_CLIENT_DECISION_REQUIRED');
    })();
  } finally {
    await db.close();
  }
});

let setupSequence = 0;
async function setupDomain() {
  setupSequence++;
  const db = productionDb;
  const firm = await db.prepare('SELECT * FROM firms ORDER BY id LIMIT 1').get();
  const actorId = Number((await db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'manager',1)`).run(
      `relationship-manager-${setupSequence}@example.test`, '!test', `Relationship Manager ${setupSequence}`, firm.id
    )).lastInsertRowid);
  const workspaceId = Number((await db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Relationship client','[]')`).run(firm.id)).lastInsertRowid);
  await db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Relationship domain test fixture',?)`).run(workspaceId, actorId);
  const supplier = async (name, service) => Number((await db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier) VALUES (?,?,?,'active','tier_1')`)
    .run(workspaceId, name, service)).lastInsertRowid);
  const supplierA = await supplier('Northstar Cloud Ltd', 'Primary application hosting');
  const supplierB = await supplier('Continuity Hosting Ltd', 'Alternate hosting capability');
  return { db, actorId, workspaceId, supplierA, supplierB };
}

async function createRelationship(db, ids, supplierId, key, name, overrides = {}) {
  return (await relationships.createRelationship(db, {
    workspaceId: ids.workspaceId,
    supplierId,
    actorId: ids.actorId,
    relationshipKey: key,
    relationshipName: name,
    serviceDescription: `${name} service scope`,
    serviceCategory: 'Cloud hosting',
    provisionModel: 'iaas',
    status: 'active',
    criticality: 'critical',
    dataAccess: 'restricted',
    isPrimary: true,
    idempotencyKey: `${key}-idempotency-key-000000000000000000000`,
    reason: 'Create the governed service relationship for testing.',
    ...overrides,
  })).relationship;
}

test('relationship domain refuses an intake-to-active transition without exact client authority', async () => {
  const ids = await setupDomain();
  const relationship = await createRelationship(ids.db, ids, ids.supplierA, 'activation-gate', 'Activation gated service', {
    status: 'active',
  });
  assert.equal(relationship.status, 'intake', 'creation cannot bypass the governed client-authorised activation transition');
  await assert.rejects(async () => await relationships.updateRelationship(ids.db, {
    workspaceId:ids.workspaceId,
    relationshipId:relationship.id,
    actorId:ids.actorId,
    expectedRowVersion:relationship.row_version,
    patch:{ status:'active' },
    reason:'Attempt activation before the client has authorised the exact service.',
  }), error => error.code === 'TPRM_CLIENT_DECISION_REQUIRED');
  assert.equal((await ids.db.prepare('SELECT status FROM tprm_service_relationships WHERE id=?').get(relationship.id)).status, 'intake');
});

test('service relationships support multiple services, optimistic concurrency and immutable contract renewal history', async () => {
  const ids = await setupDomain();
  const { db } = ids;
  try {
    const primary = await createRelationship(db, ids, ids.supplierA, 'northstar-primary', 'Northstar production hosting', {
      annualSpendMinor: 15000000,
      currency: 'USD',
      rtoHours: 4,
      rpoHours: 1,
      substitutability: 'difficult',
      estimatedExitDays: 120,
      exitPlanStatus: 'documented',
      exitOwner: 'Technology continuity lead',
      exitStrategy: 'Move workloads to the tested alternate hosting environment.',
      transitionAssistance: 'Provider supplies export and migration support for 90 days.',
      dataReturnDeletionRequirements: 'Return data and provide a deletion certificate.',
      soleSource: true,
    });
    const second = (await relationships.createRelationship(db, {
      workspaceId: ids.workspaceId,
      supplierId: ids.supplierA,
      legalEntityId: primary.legal_entity_id,
      actorId: ids.actorId,
      relationshipKey: 'northstar-analytics',
      relationshipName: 'Northstar analytics service',
      serviceDescription: 'Separate analytics processing service and contract scope.',
      serviceCategory: 'Analytics',
      provisionModel: 'saas',
      status: 'active',
      criticality: 'high',
      dataAccess: 'confidential',
      annualSpendMinor: 2500000,
      currency: 'USD',
      idempotencyKey: 'northstar-analytics-relationship-idempotency-000001',
      reason: 'Record the separately governed analytics service relationship.',
    })).relationship;
    assert.equal(second.legal_entity_id, primary.legal_entity_id);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM tprm_service_relationships WHERE legal_entity_id=?').get(primary.legal_entity_id)).count, 2);

    const updated = (await relationships.updateRelationship(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      actorId: ids.actorId,
      expectedRowVersion: primary.row_version,
      patch: { alternateProviderRelationshipId: second.id, procurementOwner: 'Strategic sourcing lead' },
      reason: 'Record the approved alternate and procurement accountability.',
    })).relationship;
    assert.equal(updated.row_version, primary.row_version + 1);
    assert.equal(updated.alternate_provider_relationship_id, second.id);
    await assert.rejects(async () => await relationships.updateRelationship(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      actorId: ids.actorId,
      expectedRowVersion: primary.row_version,
      patch: { serviceCategory: 'Changed from a stale screen' },
      reason: 'Attempt a stale update that must be refused.',
    }), error => error.code === 'TPRM_RELATIONSHIP_CONFLICT');

    const firstContract = await relationships.addContractVersion(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      actorId: ids.actorId,
      contractFamilyKey: 'hosting-msa',
      contractType: 'msa',
      status: 'executed',
      title: 'Hosting master services agreement',
      reference: 'MSA-2026-001',
      effectiveDate: '2026-01-01',
      endDate: '2027-12-31',
      noticeDeadline: '2027-09-30',
      autoRenew: true,
      currency: 'USD',
      committedSpendMinor: 15000000,
      terminationRights: 'Client may terminate for material security breach.',
      transitionAssistance: 'Ninety days of supported migration.',
      dataReturnDeletionTerms: 'Return and verified deletion within thirty days.',
      documentSha256: 'a'.repeat(64),
      expectedCurrentContractId: null,
      idempotencyKey: 'contract-hosting-msa-version-one-000000000001',
      reason: 'Record the executed contract baseline and exit obligations.',
    });
    assert.equal(firstContract.contract.version, 1);
    assert.equal((await relationships.addContractVersion(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      actorId: ids.actorId,
      contractFamilyKey: 'hosting-msa',
      contractType: 'msa',
      status: 'executed',
      title: 'Hosting master services agreement',
      reference: 'MSA-2026-001',
      effectiveDate: '2026-01-01',
      endDate: '2027-12-31',
      noticeDeadline: '2027-09-30',
      autoRenew: true,
      currency: 'USD',
      committedSpendMinor: 15000000,
      terminationRights: 'Client may terminate for material security breach.',
      transitionAssistance: 'Ninety days of supported migration.',
      dataReturnDeletionTerms: 'Return and verified deletion within thirty days.',
      documentSha256: 'a'.repeat(64),
      expectedCurrentContractId: null,
      idempotencyKey: 'contract-hosting-msa-version-one-000000000001',
      reason: 'Record the executed contract baseline and exit obligations.',
    })).replayed, true);
    const renewal = (await relationships.addContractVersion(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      actorId: ids.actorId,
      contractFamilyKey: 'hosting-msa',
      contractType: 'msa',
      status: 'executed',
      title: 'Hosting master services agreement renewal',
      reference: 'MSA-2028-001',
      effectiveDate: '2028-01-01',
      endDate: '2029-12-31',
      noticeDeadline: '2029-09-30',
      documentSha256: 'b'.repeat(64),
      expectedCurrentContractId: firstContract.contract.id,
      idempotencyKey: 'contract-hosting-msa-version-two-000000000002',
      reason: 'Record the signed renewal as a successor contract snapshot.',
    })).contract;
    assert.equal(renewal.version, 2);
    assert.equal(renewal.supersedes_id, firstContract.contract.id);
    assert.equal(renewal.previous_contract_hash, firstContract.contract.contract_hash);
    await assert.rejects(async () => await db.prepare('UPDATE tprm_relationship_contracts SET title=? WHERE id=?').run('Tampered title', firstContract.contract.id), /immutable/);
    await assert.rejects(async () => await db.prepare('DELETE FROM tprm_service_relationships WHERE id=?').run(primary.id), /history cannot be deleted/);
    await assert.rejects(async () => relationships.addContractVersion(db, {
      workspaceId: ids.workspaceId, relationshipId: primary.id, actorId: ids.actorId,
      contractFamilyKey: 'hosting-msa', contractType: 'msa', status: 'draft', title: 'Stale version',
      expectedCurrentContractId: firstContract.contract.id, reason: 'Attempt a stale contract successor.',
    }), error => error.code === 'TPRM_CONTRACT_CONFLICT');
  } finally {
  }
});

test('dependency chains, geographic exposure and portfolio concentration remain tenant-scoped and evidence-limited', async () => {
  const ids = await setupDomain();
  const { db } = ids;
  try {
    const primary = await createRelationship(db, ids, ids.supplierA, 'primary-hosting', 'Primary hosting', {
      annualSpendMinor: 10000000,
      currency: 'USD',
      substitutability: 'not_substitutable',
      soleSource: true,
    });
    const alternate = await createRelationship(db, ids, ids.supplierB, 'alternate-hosting', 'Alternate hosting', {
      annualSpendMinor: 4000000,
      currency: 'USD',
      criticality: 'high',
    });
    const service = (await relationships.createBusinessService(db, {
      workspaceId: ids.workspaceId,
      actorId: ids.actorId,
      serviceKey: 'digital-payments',
      name: 'Digital payments',
      criticality: 'critical',
      impactToleranceHours: 4,
      rtoHours: 2,
      rpoHours: 1,
      regulatoryDesignations: ['Material business service'],
    })).businessService;
    await relationships.linkBusinessService(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      businessServiceId: service.id,
      actorId: ids.actorId,
      dependencyType: 'essential',
      criticality: 'critical',
      maximumOutageHours: 2,
      reason: 'Payments cannot operate without the primary hosting service.',
    });
    await relationships.addDependencyEdge(db, {
      workspaceId: ids.workspaceId,
      sourceRelationshipId: primary.id,
      targetRelationshipId: alternate.id,
      actorId: ids.actorId,
      edgeKey: 'continuity-target',
      dependencyType: 'infrastructure',
      serviceDescription: 'Warm continuity environment and backup replication.',
      dataAccess: 'restricted',
      countries: ['US'],
      criticality: 'high',
      status: 'approved',
      reason: 'Record the approved portfolio relationship dependency.',
    });
    const sharedEntity = (await relationships.createDependencyEntity(db, {
      workspaceId: ids.workspaceId,
      actorId: ids.actorId,
      entityKey: 'shared-identity-platform',
      name: 'Shared Identity Platform Inc',
      entityType: 'fourth_party',
      legalCountryCode: 'US',
      source: 'provider_disclosed',
    })).dependencyEntity;
    for (const relationship of [primary, alternate]) {
      await relationships.addDependencyEdge(db, {
        workspaceId: ids.workspaceId,
        sourceRelationshipId: relationship.id,
        dependencyEntityId: sharedEntity.id,
        actorId: ids.actorId,
        edgeKey: `identity-${relationship.id}`,
        dependencyType: 'identity',
        serviceDescription: 'Identity and access platform used by the hosting service.',
        dataAccess: 'confidential',
        countries: ['US', 'IE'],
        criticality: 'critical',
        concentrationKey: 'shared-identity',
        singlePointOfFailure: true,
        status: 'approved',
        reason: 'Record the disclosed shared identity dependency and concentration.',
      });
    }
    await relationships.addLocationExposure(db, {
      workspaceId: ids.workspaceId,
      relationshipId: primary.id,
      actorId: ids.actorId,
      locationKey: 'primary-data-store',
      exposureType: 'data_storage',
      countryCode: 'US',
      dataCategories: ['Customer data'],
      transferMechanism: 'local_only',
      criticality: 'critical',
      status: 'current',
      effectiveFrom: '2026-01-01',
      expectedCurrentLocationId: null,
      reason: 'Record the current contracted primary data-hosting location.',
    });
    const concentration = await relationships.concentrationProjection(db, ids.workspaceId);
    assert.equal(concentration.externalIntelligenceApplied, false);
    assert.equal(concentration.totals.relationships, 2);
    assert.equal(concentration.totals.spendByCurrency.USD, 14000000);
    assert.equal(concentration.fourthParties[0].relationship_count, 2);
    assert.equal(concentration.concentrationFlags.fourthPartiesSharedAcrossServices.length, 1);
    assert.equal(concentration.businessServices[0].singleProviderDependency, true);
    assert.deepEqual(concentration.dataQuality.relationshipsMissingCurrentLocation, [alternate.id]);

    const chains = await relationships.criticalChainProjection(db, {
      workspaceId: ids.workspaceId,
      businessServiceId: service.id,
    });
    assert.equal(chains.externalIntelligenceApplied, false);
    assert.ok(chains.chains.some(chain => chain.path.some(node => node.type === 'external_dependency_entity' && node.id === sharedEntity.id)));
    assert.ok(chains.singlePointsOfFailure.some(item => item.type === 'service_relationship' && item.id === primary.id));
    await assert.rejects(async () => relationships.addDependencyEdge(db, {
      workspaceId: ids.workspaceId,
      sourceRelationshipId: alternate.id,
      targetRelationshipId: primary.id,
      actorId: ids.actorId,
      dependencyType: 'infrastructure',
      serviceDescription: 'This reverse dependency would create a cycle.',
      reason: 'Attempt to create a circular dependency chain.',
    }), error => error.code === 'TPRM_DEPENDENCY_CYCLE');

    const exit = await relationships.exitReadinessProjection(db, { workspaceId: ids.workspaceId, relationshipId: primary.id });
    assert.equal(exit.externalIntelligenceApplied, false);
    assert.equal(exit.assessments.length, 1);
    assert.ok(exit.assessments[0].blockers.includes('Sole-source relationship has no validated substitute.'));
    assert.ok(exit.assessments[0].missingActions.length > 0);
  } finally {
  }
});

test('composite foreign keys reject cross-workspace relationship and dependency linkage', async () => {
  const ids = await setupDomain();
  const { db } = ids;
  try {
    const primary = await createRelationship(db, ids, ids.supplierA, 'tenant-one-primary', 'Tenant one hosting');
    const otherWorkspaceId = Number((await db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
      SELECT firm_id,'Other client','[]' FROM workspaces WHERE id=?`).run(ids.workspaceId)).lastInsertRowid);
    await db.prepare(`INSERT INTO tprm_modules
      (workspace_id,service_model,status,activation_reason,created_by)
      VALUES (?,'managed_lifecycle','active','Cross-tenant boundary test fixture',?)`).run(otherWorkspaceId, ids.actorId);
    const otherSupplierId = Number((await db.prepare(`INSERT INTO suppliers(workspace_id,name,service_provided,lifecycle_stage)
      VALUES (?,'Other provider','Other service','active')`).run(otherWorkspaceId)).lastInsertRowid);
    const other = (await relationships.createRelationship(db, {
      workspaceId: otherWorkspaceId,
      supplierId: otherSupplierId,
      actorId: ids.actorId,
      relationshipKey: 'other-client-service',
      relationshipName: 'Other client service',
      serviceDescription: 'Service belongs to another client workspace.',
      status: 'active',
      reason: 'Create another client relationship for tenancy testing.',
    })).relationship;
    await assert.rejects(async () => relationships.addDependencyEdge(db, {
      workspaceId: ids.workspaceId,
      sourceRelationshipId: primary.id,
      targetRelationshipId: other.id,
      actorId: ids.actorId,
      dependencyType: 'other',
      serviceDescription: 'Cross-client linkage must not be possible.',
      reason: 'Attempt a cross-client dependency edge.',
    }), error => error.code === 'TPRM_RELATIONSHIP_NOT_FOUND');
    await assert.rejects(async () => await db.prepare(`INSERT INTO tprm_dependency_edges
      (workspace_id,source_relationship_id,edge_key,target_relationship_id,dependency_type,
       service_description,request_fingerprint,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        ids.workspaceId, primary.id, 'raw-cross-tenant-edge', other.id, 'other',
        'Raw cross-client edge', 'f'.repeat(64), ids.actorId
      ), /violates foreign key constraint/);
  } finally {
  }
});
