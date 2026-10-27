'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, openTestDb } = require('./helpers');

const domain = require('../lib/tprm-domain');
const relationships = require('../lib/tprm-relationships');

async function setupProductionDomain() {
  const env = await bootApp();
  const db = await openTestDb(env.dbUrl);
  const firm = await db.prepare('SELECT * FROM firms ORDER BY id LIMIT 1').get();
  const passwordHash = '!test-only';
  const addUser = async (email, name, type, role = null) => Number((await db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, passwordHash, name, type, firm.id, role)).lastInsertRowid);
  const makerId = await addUser('tprm-maker@example.test', 'TPRM Maker', 'firm', 'consultant');
  const checkerId = await addUser('tprm-checker@example.test', 'TPRM Quality Reviewer', 'firm', 'manager');
  const clientAuthorityId = await addUser('tprm-authority@example.test', 'Client Decision Authority', 'client');
  const otherClientId = await addUser('tprm-other-client@example.test', 'Other Client User', 'client');
  const workspaceId = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,frameworks) VALUES (?,'Standalone TPRM client','[]')`).run(firm.id)).lastInsertRowid);
  await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, clientAuthorityId);
  await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, otherClientId);
  await domain.enableModule(db, {
    workspaceId, serviceModel: 'managed_lifecycle', actorId: checkerId,
    reason: 'Test fixture explicitly contracts managed Third-party risk capabilities.',
  });
  const supplierId = Number((await db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Critical cloud provider','Hosted transaction processing','prospect','tier_2')`).run(workspaceId)).lastInsertRowid);
  const relationshipId = (await relationships.createRelationship(db, {
    workspaceId,
    supplierId,
    actorId: makerId,
    relationshipName: 'Hosted transaction processing service',
    serviceDescription: 'Production transaction processing and supporting managed cloud operations.',
    serviceCategory: 'Cloud transaction processing',
    provisionModel: 'managed_service',
    status: 'intake',
    criticality: 'high',
    dataAccess: 'restricted',
    privilegedAccess: true,
    businessOwner: 'Client Operations Director',
    relationshipOwner: 'Client Vendor Manager',
    isPrimary: true,
    reason: 'Create the exact service relationship governed by this assessment.',
  })).relationship.id;
  return { env, db, firm, makerId, checkerId, clientAuthorityId, otherClientId, workspaceId, supplierId, relationshipId };
}

async function linkCycleService(db, ids, cycleId) {
  return await relationships.linkAssessmentCycle(db, {
    workspaceId: ids.workspaceId,
    relationshipId: ids.relationshipId,
    cycleId,
    actorId: ids.makerId,
    scopeRole: 'primary',
    scopeRationale: 'The production hosted transaction-processing service is the exact assessment scope.',
  });
}

async function createCompletedArtifacts(db, ids, cycleId, suffix = 'A') {
  const inherentId = Number((await db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
     module_applicability_json,approved_at,approved_by,created_by)
    VALUES (?,?,'2026.1','approved','tier_2',0,'[]',utc_now_text(),?,?)`).run(
      ids.workspaceId, ids.supplierId, ids.checkerId, ids.makerId
    )).lastInsertRowid);
  const ddqId = Number((await db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
     completed_at,completed_by,created_by)
    VALUES (?,?,?,'2026.1','tier_2','complete',utc_now_text(),?,?)`).run(
      ids.workspaceId, ids.supplierId, inherentId, ids.makerId, ids.makerId
    )).lastInsertRowid);
  const contractId = Number((await db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,methodology_version,status,agreement_reference,agreement_date,
     inherent_assessment_id,reviewer_id,completed_at)
    VALUES (?,?,'2026.1','complete',?,'2026-08-01',?,?,utc_now_text())`).run(
      ids.workspaceId, ids.supplierId, `MSA-${suffix}`, inherentId, ids.makerId
    )).lastInsertRowid);
  await domain.linkCycleArtifacts(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId,
    inherentAssessmentId: inherentId, ddqAssessmentId: ddqId, contractReviewId: contractId,
    actorId: ids.makerId,
  });
  return { inherentId, ddqId, contractId };
}

test('consultancy recommendation and client decision remain separate, immutable and maker-checker governed', async () => {
  const ids = await setupProductionDomain();
  const { db } = ids;
  try {
    const enabled = await domain.enableModule(db, {
      workspaceId: ids.workspaceId, serviceModel: 'managed_lifecycle', actorId: ids.checkerId,
      reason: 'Client contracted a managed third-party risk lifecycle.',
    });
    assert.equal(enabled.module.status, 'active');
    assert.equal(await domain.isEnabled(db, ids.workspaceId), true);

    const firstCycle = (await domain.ensureCurrentCycle(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.makerId,
      cycleType: 'onboarding', clientDecisionAuthorityId: ids.clientAuthorityId,
    })).cycle;
    await linkCycleService(db, ids, firstCycle.id);
    assert.equal(firstCycle.client_decision_authority_id, ids.clientAuthorityId);
    const artifacts = await createCompletedArtifacts(db, ids, firstCycle.id);

    await assert.rejects(async () => domain.issueRecommendation(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      outcome: 'recommend_onboard', executiveSummary: 'Evidence supports onboarding.',
      rationale: 'All applicable assessment and contract gates have been completed.',
      authorId: ids.makerId, reviewerId: ids.makerId,
      qualityReviewRationale: 'The same person attempted both roles.',
    }), error => error.code === 'TPRM_MAKER_CHECKER_REQUIRED');

    const recommendationResult = await domain.issueRecommendation(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      outcome: 'recommend_with_conditions',
      executiveSummary: 'Evidence supports onboarding subject to a dated assurance condition.',
      rationale: 'Due diligence and contract assurance are complete and residual exposure is manageable.',
      residualRiskScore: 26, residualRiskBand: 'moderate',
      authorId: ids.makerId, reviewerId: ids.checkerId,
      qualityReviewRationale: 'Independent review confirmed the evidence, scope and conclusion.',
      expectedCurrentRecommendationId: null,
      conditions: [{
        conditionType: 'monitoring', title: 'Quarterly service assurance report',
        description: 'Provide the first quarterly service assurance report after onboarding.',
        severity: 'moderate', ownerType: 'client', ownerUserId: ids.clientAuthorityId,
        ownerName: 'Client Decision Authority',
        dueDate: '2027-01-31', verificationCriteria: 'Consultancy verifies the signed report and exceptions.',
      }],
    });
    const recommendation = recommendationResult.recommendation;
    const issuedArtifacts = JSON.parse(recommendation.artifact_snapshot_json);
    assert.deepEqual(issuedArtifacts.serviceRelationships.map(item => item.name), [
      'Hosted transaction processing service',
    ]);
    assert.equal(recommendation.outcome, 'recommend_with_conditions');
    assert.equal(recommendation.issued_by, ids.makerId);
    assert.equal(recommendation.quality_reviewed_by, ids.checkerId);
    assert.equal(recommendationResult.conditions.length, 1);
    await assert.rejects(async () => await db.prepare('UPDATE tprm_recommendations SET rationale=? WHERE id=?')
      .run('Tampered rationale', recommendation.id), /immutable/);

    await assert.rejects(async () => await domain.recordClientDecision(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      recommendationId: recommendation.id, actorId: ids.otherClientId,
      decision: 'onboard_with_conditions',
      rationale: 'A different client user attempted to exercise the assigned authority.',
      clientActorTitle: 'Security analyst', authorityBasis: 'Contributor role',
      expectedCurrentDecisionId: null,
    }), error => error.code === 'TPRM_DECISION_AUTHORITY_MISMATCH');

    const decisionResult = await domain.recordClientDecision(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      recommendationId: recommendation.id, actorId: ids.clientAuthorityId,
      decision: 'onboard_with_conditions',
      rationale: 'The client accepts the residual risk and authorises onboarding with the stated condition.',
      clientActorTitle: 'Chief Information Security Officer',
      authorityBasis: 'Delegated third-party onboarding authority',
      expectedCurrentDecisionId: null,
    });
    const decision = decisionResult.decision;
    assert.equal(decision.recommendation_id, recommendation.id);
    assert.equal(decision.recommendation_version, recommendation.version);
    assert.equal(decision.diverges_from_recommendation, 0);
    assert.deepEqual(JSON.parse(decision.decision_snapshot_json).serviceRelationships.map(item => item.id), [
      ids.relationshipId,
    ], 'the immutable client decision is bound to the exact service scope frozen in the recommendation');
    assert.equal(decisionResult.conditions.length, 1, 'client adoption creates the operative condition');
    assert.equal(decisionResult.schedule.next_review_date.length, 10);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM supplier_decisions WHERE supplier_id=?').get(ids.supplierId)).count, 0,
      'the new client decision never overwrites or impersonates legacy supplier_decisions');
    await assert.rejects(async () => await db.prepare('DELETE FROM tprm_client_decisions WHERE id=?').run(decision.id), /cannot be deleted/);

    const operativeConditions = await domain.listConditions(db, ids.workspaceId, ids.supplierId);
    assert.equal(operativeConditions.length, 1, 'proposed conditions are replaced by the adopted client-decision condition in operational views');
    const startedCondition = await domain.clientStartConditionWork(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      conditionId: operativeConditions[0].id, actorId: ids.clientAuthorityId,
      expectedRowVersion: operativeConditions[0].row_version,
    });
    const submittedCondition = await domain.clientSubmitCondition(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      conditionId: operativeConditions[0].id, actorId: ids.clientAuthorityId,
      completionStatement: 'The first signed quarterly service assurance report has been received and retained for review.',
      expectedRowVersion: startedCondition.condition.row_version,
    });
    const completed = await domain.verifyCondition(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      conditionId: operativeConditions[0].id, actorId: ids.checkerId,
      reviewNote: 'Signed report independently reviewed; no material exceptions were identified.',
      expectedRowVersion: submittedCondition.condition.row_version,
    });
    assert.equal(completed.condition.status, 'verified');

    const firstProjection = await domain.lifecycleProjection(db, ids.workspaceId, ids.supplierId);
    assert.equal(firstProjection.stage, 'monitoring');
    assert.equal(firstProjection.clientDecision.id, decision.id);

    const reassessment = (await domain.ensureCurrentCycle(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.makerId,
      cycleType: 'periodic', triggerReason: 'Scheduled periodic reassessment.',
      clientDecisionAuthorityId: ids.clientAuthorityId,
    })).cycle;
    await linkCycleService(db, ids, reassessment.id);
    assert.equal(reassessment.baseline_decision_id, decision.id);
    assert.equal((await db.prepare('SELECT status FROM supplier_inherent_assessments WHERE id=?').get(artifacts.inherentId)).status, 'approved');
    assert.equal((await db.prepare('SELECT decision_hash FROM tprm_client_decisions WHERE id=?').get(decision.id)).decision_hash, decision.decision_hash);
    const reassessmentProjection = await domain.lifecycleProjection(db, ids.workspaceId, ids.supplierId);
    assert.equal(reassessmentProjection.stage, 'intake');
    assert.equal(reassessmentProjection.operationalStatus, 'monitoring', 'the approved baseline remains operational during reassessment');
  } finally {
    await db.close();
  }
});

test('clarifications and monitoring signals preserve submitted evidence history', async () => {
  const ids = await setupProductionDomain();
  const { db } = ids;
  try {
    await domain.enableModule(db, {
      workspaceId: ids.workspaceId, serviceModel: 'managed_lifecycle', actorId: ids.checkerId,
      reason: 'Client contracted a governed managed TPRM lifecycle.',
    });
    const cycle = (await domain.ensureCurrentCycle(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.makerId,
      clientDecisionAuthorityId: ids.clientAuthorityId,
    })).cycle;
    await linkCycleService(db, ids, cycle.id);
    const inherentId = Number((await db.prepare(`INSERT INTO supplier_inherent_assessments
      (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
       module_applicability_json,approved_at,approved_by,created_by)
      VALUES (?,?,'2026.1','approved','tier_2',0,'[]',utc_now_text(),?,?)`).run(
        ids.workspaceId, ids.supplierId, ids.checkerId, ids.makerId
      )).lastInsertRowid);
    const ddqId = Number((await db.prepare(`INSERT INTO supplier_ddq_assessments
      (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
       submitted_at,created_by)
      VALUES (?,?,?,'2026.1','tier_2','submitted',utc_now_text(),?)`).run(
        ids.workspaceId, ids.supplierId, inherentId, ids.makerId
      )).lastInsertRowid);
    await domain.linkCycleArtifacts(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: cycle.id,
      inherentAssessmentId: inherentId, ddqAssessmentId: ddqId, actorId: ids.makerId,
    });
    const submittedBefore = await db.prepare('SELECT status,submitted_at FROM supplier_ddq_assessments WHERE id=?').get(ddqId);
    const requested = (await domain.requestClarification(db, {
      workspaceId: ids.workspaceId, cycleId: cycle.id, ddqAssessmentId: ddqId,
      questionId: 'DDQ-17', requestText: 'Provide the latest penetration-test executive summary and remediation status.',
      dueDate: '2027-02-15', actorId: ids.makerId,
    })).clarification;
    await assert.rejects(async () => await db.prepare('UPDATE tprm_clarifications SET request_text=? WHERE id=?')
      .run('Changed request', requested.id), /immutable/);
    const responded = (await domain.respondClarification(db, {
      clarificationId: requested.id, responderName: 'Provider security lead',
      responderEmail: 'security@provider.example',
      responseText: 'The executive summary and remediation tracker are attached to the evidence request.',
    })).clarification;
    assert.equal(responded.status, 'responded');
    await assert.rejects(async () => await db.prepare('UPDATE tprm_clarifications SET provider_response=? WHERE id=?')
      .run('Replacement response', requested.id), /immutable/);
    const resolved = (await domain.resolveClarification(db, {
      workspaceId: ids.workspaceId, clarificationId: requested.id, actorId: ids.checkerId,
      resolutionNote: 'Evidence reviewed and the clarification is satisfactorily resolved.',
    })).clarification;
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(await db.prepare('SELECT status,submitted_at FROM supplier_ddq_assessments WHERE id=?').get(ddqId), submittedBefore,
      'clarification workflow must not reopen or rewrite the submitted DDQ baseline');

    const documentId = Number((await db.prepare(`INSERT INTO supplier_documents
      (workspace_id,supplier_id,doc_type,name,filename,sha256,size_bytes,uploaded_by)
      VALUES (?,?,'assurance','Internal assurance report','assurance.pdf',?,1024,?)`).run(
        ids.workspaceId, ids.supplierId, 'a'.repeat(64), ids.makerId
      )).lastInsertRowid);
    assert.deepEqual((await domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientAuthorityId)).evidence, [],
      'client projection is deny-by-default even when internal evidence exists');
    const release = (await domain.releaseEvidence(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: cycle.id,
      sourceType: 'supplier_document', sourceId: documentId, actorId: ids.checkerId,
      clientLabel: 'Assurance report', clientDescription: 'Approved client-facing report metadata.',
      allowDownload: false,
    })).release;
    const releasedEvidence = (await domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientAuthorityId)).evidence;
    assert.equal(releasedEvidence.length, 1);
    assert.equal(releasedEvidence[0].filename, 'Assurance report');
    assert.equal(Object.hasOwn(releasedEvidence[0], 'stored_path'), false);
    await assert.rejects(async () => await db.prepare('UPDATE tprm_evidence_releases SET client_label=? WHERE id=?')
      .run('Rewritten label', release.id), /immutable/);
    await domain.withdrawEvidenceRelease(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, releaseId: release.id,
      actorId: ids.checkerId, reason: 'The report is being replaced by a corrected client-approved edition.',
    });
    assert.deepEqual((await domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientAuthorityId)).evidence, []);

    const signal = (await domain.recordMonitoringSignal(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      source: 'Regulatory feed', sourceReference: 'REG-2027-44', signalType: 'regulatory',
      severity: 'high', title: 'Provider received a regulatory enforcement notice',
      detail: 'Notice may affect the contracted processing service.', observedAt: '2027-01-10T09:30:00Z',
      requiresReassessment: true,
    })).signal;
    assert.equal(signal.status, 'new');
    const triaged = (await domain.triageMonitoringSignal(db, {
      workspaceId: ids.workspaceId, signalId: signal.id, actorId: ids.checkerId,
      status: 'escalated', note: 'Trigger a focused reassessment and request the provider response plan.',
    })).signal;
    assert.equal(triaged.status, 'escalated');
    await assert.rejects(async () => await db.prepare('UPDATE tprm_monitoring_signals SET title=? WHERE id=?')
      .run('Rewritten signal', signal.id), /immutable/);

    const events = await db.prepare('SELECT * FROM tprm_lifecycle_events WHERE supplier_id=? ORDER BY id').all(ids.supplierId);
    assert.ok(events.length >= 9);
    events.filter(event => event.event_hash).forEach((event, index, hashed) => {
      assert.match(event.event_hash, /^[0-9a-f]{64}$/);
      if (index) assert.equal(event.previous_event_hash, hashed[index - 1].event_hash);
    });
    await assert.rejects(async () => await db.prepare('DELETE FROM tprm_lifecycle_events WHERE id=?').run(events[0].id), /cannot be deleted/);
  } finally {
    await db.close();
  }
});

test('review dates use calendar-month cadence with end-of-month clamping', () => {
  assert.equal(domain.calculateNextReview('tier_1', '2026-08-31'), '2027-02-28');
  assert.equal(domain.calculateNextReview({ tier: 'tier_2', fromDate: '2028-02-29', cadenceMonths: 12 }), '2029-02-28');
  assert.equal(domain.calculateNextReview({ tier: 'tier_4', fromDate: '2026-01-31', cadenceMonths: 1 }), '2026-02-28');
});
