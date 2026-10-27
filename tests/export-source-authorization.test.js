'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootApp, makeClient, openTestDb } = require('./helpers');
const assuranceReports = require('../lib/assurance-reports');

const PASSWORD = 'Export-source-test-password-1234';

async function login(client, email) {
  const page = await client.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF token missing for ${email}`);
  const signedIn = await client.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
  let warm = await client.get('/dashboard?legacy=1');
  if (warm.status === 302 && warm.location) warm = await client.get(warm.location);
  assert.equal(warm.status, 200, warm.text.slice(0, 300));
}

async function insertUser(db, { email, name, role = null, type = 'firm', firmId }) {
  return Number((await db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`)
    .run(email, bcrypt.hashSync(PASSWORD, 4), name, type, firmId, type === 'firm' ? role : null)).lastInsertRowid);
}

async function seedScenario(dbUrl) {
  const db = await openTestDb(dbUrl);
  const firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const managerId = await insertUser(db, {
    email: 'export-manager@test.local', name: 'Export Manager', role: 'manager', firmId,
  });
  const seniorId = await insertUser(db, {
    email: 'export-senior@test.local', name: 'Export Senior', role: 'senior_consultant', firmId,
  });
  const workspaceId = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,lead_consultant_id,frameworks,engagement_outcome)
    VALUES (?,'Export Source Workspace','Source permission regression scope',?,'["iso27001"]','certification_support')`)
    .run(firmId, managerId)).lastInsertRowid);
  const member = db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
  await member.run(workspaceId, seniorId, 'senior_consultant');
  await db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Source permission regression',?)`)
    .run(workspaceId, managerId);
  const supplierId = Number((await db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,'Assurance Source Supplier','Controlled hosting','active')`)
    .run(workspaceId)).lastInsertRowid);

  const reportTemplateId = Number((await db.prepare(`INSERT INTO report_templates
    (workspace_id,firm_id,name,description,body,is_system)
    VALUES (?,NULL,'SOURCE-AUTH-REPORT-TEMPLATE','Aggregate source authorization regression',?,0)`)
    .run(workspaceId, `# {{workspace.client_name}}

{{top_risks_table}}

{{audits_table}}

{{top_suppliers_table}}

{{calendar_table}}`)).lastInsertRowid);

  const commonAssuranceRun = await assuranceReports.createRun(
    db, workspaceId, seniorId, 'executive_posture', {
      selected_sections: assuranceReports.REPORTS.executive_posture.sections,
    },
  );
  const supplierAssuranceRun = await assuranceReports.createRun(
    db, workspaceId, seniorId, 'supplier_due_diligence', {
      supplier_id: supplierId,
      selected_sections: assuranceReports.REPORTS.supplier_due_diligence.sections,
    },
  );
  const insertArtifact = db.prepare(`INSERT INTO assurance_report_artifacts
    (run_id,format,filename,mime_type,content_blob,content_hash,size_bytes,generated_by)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const run of [commonAssuranceRun, supplierAssuranceRun]) {
    for (const [format, mime] of [
      ['pdf', 'application/pdf'],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['json', 'application/json'],
    ]) {
      const content = Buffer.from(`assurance-${run.id}-${format}`);
      await insertArtifact.run(
        run.id, format, `assurance-${run.id}.${format}`, mime, content,
        crypto.createHash('sha256').update(content).digest('hex'), content.length, seniorId,
      );
    }
  }
  await db.close();
  return {
    firmId, managerId, seniorId, workspaceId, reportTemplateId,
    supplierId, commonAssuranceRunId: commonAssuranceRun.id,
    supplierAssuranceRunId: supplierAssuranceRun.id,
  };
}

async function revokeOnly(dbUrl, ids, permission) {
  const db = await openTestDb(dbUrl);
  await db.prepare('DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=?')
    .run(ids.workspaceId, ids.seniorId);
  await db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,?,0,?,'Source-domain export regression')`)
    .run(ids.workspaceId, ids.seniorId, permission, ids.managerId);
  await db.close();
}

async function assertGetDenied(client, workspaceId, routes, permission) {
  for (const suffix of routes) {
    const route = `/workspaces/${workspaceId}${suffix}`;
    const response = await client.get(route);
    assert.equal(response.status, 403, `${route} must honor a ${permission} revoke`);
  }
}

test('bulk exports honor source-domain revokes', async (t) => {
  const { app, dbUrl } = await bootApp();
  const ids = await seedScenario(dbUrl);
  const senior = makeClient(app);
  t.after(async () => { await senior.close(); });
  await login(senior, 'export-senior@test.local');

  for (const suffix of [
    '/export/soa.csv',
    '/export/risks.csv',
    '/export/assets.csv',
    '/activity-log.csv',
    '/evidence-coverage.csv',
    '/evidence/pack.zip',
    '/vendors/export.csv',
    '/audit-pack',
    '/assurance',
    '/handover',
  ]) {
    const response = await senior.get(`/workspaces/${ids.workspaceId}${suffix}`);
    assert.equal(response.status, 200, `${suffix} must remain available to a senior consultant`);
  }
  const reportRoutes = [
    `/reports/${ids.reportTemplateId}`,
    `/reports/${ids.reportTemplateId}/docx`,
  ];
  assert.equal((await senior.get(
    `/workspaces/${ids.workspaceId}/reports/${ids.reportTemplateId}`
  )).status, 200, 'report preview must remain available before a source revoke');
  assert.equal((await senior.get(
    `/workspaces/${ids.workspaceId}/reports/999999999/docx`
  )).status, 404, 'authorized DOCX routing must reach the scoped template lookup');

  for (const [key, runId, extra] of [
    ['executive_posture', ids.commonAssuranceRunId, ''],
    ['supplier_due_diligence', ids.supplierAssuranceRunId, `&supplier_id=${ids.supplierId}`],
  ]) {
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance/new?type=${key}${extra}`
    )).status, 200, `${key} builder must remain available with every source permission`);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/assurance/runs`, {
      report_key: key,
      title: `Positive ${key} authorization run`,
      supplier_id: key === 'supplier_due_diligence' ? ids.supplierId : '',
      ack_quality: '1',
    })).status, 302, `${key} generation must remain available with every source permission`);
    for (const suffix of ['', '/preview', '/pdf', '/docx', '/json']) {
      assert.equal((await senior.get(
        `/workspaces/${ids.workspaceId}/assurance/runs/${runId}${suffix}`
      )).status, 200, `${key}${suffix || ' detail'} must remain available with every source permission`);
    }
  }

  for (const permission of [
    'control.view', 'risk.view', 'document.view', 'tprm.third_party.view',
    'tprm.assurance.view', 'tprm.assurance.export',
    'audit.manage', 'nc.manage', 'mrm.manage', 'task.manage',
  ]) {
    await revokeOnly(dbUrl, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, reportRoutes, permission);
  }

  const commonAssuranceRoutes = [
    `/assurance/runs/${ids.commonAssuranceRunId}`,
    `/assurance/runs/${ids.commonAssuranceRunId}/preview`,
    `/assurance/runs/${ids.commonAssuranceRunId}/pdf`,
    `/assurance/runs/${ids.commonAssuranceRunId}/docx`,
    `/assurance/runs/${ids.commonAssuranceRunId}/json`,
  ];
  for (const permission of [
    'control.view', 'risk.view', 'evidence.view', 'evidence.export', 'document.view',
    'audit.manage', 'mrm.manage', 'nc.manage',
  ]) {
    await revokeOnly(dbUrl, ids, permission);
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance/new?type=executive_posture`
    )).status, 403, `assurance builder must honor a ${permission} revoke`);
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance`
    )).status, 403, `assurance center must honor a ${permission} revoke`);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/assurance/runs`, {
      report_key: 'executive_posture', ack_quality: '1',
    })).status, 403, `assurance generation must honor a ${permission} revoke`);
    await assertGetDenied(senior, ids.workspaceId, commonAssuranceRoutes, permission);
    for (const action of ['submit', 'request-changes', 'publish']) {
      assert.equal((await senior.post(
        `/workspaces/${ids.workspaceId}/assurance/runs/${ids.commonAssuranceRunId}/${action}`, {}
      )).status, 403, `assurance ${action} must honor a ${permission} revoke`);
    }
  }

  const supplierAssuranceRoutes = [
    `/assurance/runs/${ids.supplierAssuranceRunId}`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/preview`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/pdf`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/docx`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/json`,
  ];
  for (const permission of [
    'tprm.third_party.view', 'tprm.assurance.view', 'tprm.assurance.export',
  ]) {
    await revokeOnly(dbUrl, ids, permission);
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance/new?type=supplier_due_diligence&supplier_id=${ids.supplierId}`
    )).status, 403, `supplier assurance builder must honor a ${permission} revoke`);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/assurance/runs`, {
      report_key: 'supplier_due_diligence', supplier_id: ids.supplierId, ack_quality: '1',
    })).status, 403, `supplier assurance generation must honor a ${permission} revoke`);
    await assertGetDenied(senior, ids.workspaceId, supplierAssuranceRoutes, permission);
  }

  for (const permission of [
    'evidence.export', 'evidence.view', 'evidence.download', 'control.view', 'risk.view',
    'asset.view', 'entity.view', 'document.view', 'audit.manage', 'nc.manage',
    'mrm.manage', 'incident.manage', 'task.manage', 'audit_log.view',
    'audit_log.export', 'tprm.third_party.view', 'tprm.assurance.view',
    'tprm.assurance.export', 'members.view',
  ]) {
    await revokeOnly(dbUrl, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, ['/handover'], permission);
  }

  for (const permission of ['audit.manage', 'nc.manage', 'mrm.manage']) {
    await revokeOnly(dbUrl, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, [
      '/audit-pack', '/audit-pack/preview', '/audit-pack/zip',
    ], permission);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403,
      `/audit-pack/pdf must honor a ${permission} revoke`);
  }

  for (const permission of ['audit.manage', 'mrm.manage']) {
    await revokeOnly(dbUrl, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, ['/export/readiness-pack.zip'], permission);
  }

  await revokeOnly(dbUrl, ids, 'evidence.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/evidence-coverage.csv', '/evidence/pack.zip',
    '/audit-pack', '/audit-pack/preview', '/audit-pack/zip',
    '/export/readiness-pack.zip',
  ], 'evidence.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403,
    '/audit-pack/pdf must honor an evidence.view revoke');

  await revokeOnly(dbUrl, ids, 'evidence.download');
  await assertGetDenied(senior, ids.workspaceId, [
    '/evidence/pack.zip', '/audit-pack/zip', '/export/readiness-pack.zip',
  ], 'evidence.download');

  await revokeOnly(dbUrl, ids, 'control.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/export/soa.csv',
    '/export/rtp.docx',
    '/export/gap-report.docx',
    '/export/gap-report.pdf',
    '/export/recommendations.docx',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
    '/export/readiness-pack.zip',
  ], 'control.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  for (const permission of [
    'evidence.view', 'evidence.export', 'task.manage', 'nc.manage',
    'members.view', 'audit.manage',
  ]) {
    await revokeOnly(dbUrl, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, [
      '/export/gap-report.docx', '/export/gap-report.pdf',
    ], permission);
    if (['evidence.view', 'evidence.export', 'task.manage', 'members.view'].includes(permission)) {
      await assertGetDenied(senior, ids.workspaceId, [
        '/engagement-plan/export.csv', '/engagement-plan/report.pdf',
      ], permission);
    }
    if (['evidence.view', 'evidence.export'].includes(permission)) {
      await assertGetDenied(senior, ids.workspaceId, [
        '/controls/assess/summary.docx',
      ], permission);
    }
  }

  await revokeOnly(dbUrl, ids, 'risk.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/export/soa.csv',
    '/export/risks.csv',
    '/export/rtp.docx',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
    '/export/readiness-pack.zip',
  ], 'risk.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  await revokeOnly(dbUrl, ids, 'asset.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/export/assets.csv', '/export/risks.csv',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
  ], 'asset.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  await revokeOnly(dbUrl, ids, 'document.view');
  await assertGetDenied(senior, ids.workspaceId, ['/audit-pack/zip'], 'document.view');

  await revokeOnly(dbUrl, ids, 'audit_log.export');
  await assertGetDenied(senior, ids.workspaceId, [
    '/audit-pack', '/audit-pack/preview', '/audit-pack/zip',
  ], 'audit_log.export');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  await revokeOnly(dbUrl, ids, 'audit_log.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/activity-log.csv',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
  ], 'audit_log.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  for (const permission of [
    'tprm.third_party.view', 'tprm.assurance.view', 'tprm.assurance.export',
  ]) {
    await revokeOnly(dbUrl, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, [
      '/vendors/export.csv',
      '/assurance',
    ], permission);
  }
});
