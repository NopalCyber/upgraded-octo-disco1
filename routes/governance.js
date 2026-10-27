'use strict';

const fts = require('../lib/fts');
const ctlWrites = require('../lib/control-writes');
const delivery = require('../lib/engagement-delivery');
const outcomeScope = require('../lib/engagement-outcome-scope');
const reqOpts = require('../lib/requirement-options');
const auditChecklists = require('../lib/audit-checklists');
const frameworks = require('../lib/frameworks');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, workspaceProgress } = deps;
  const requireInternalAuditService = outcomeScope.requirePostGapService(
    'Internal audit delivery is outside this gap-assessment-only engagement. Assessment findings and client-owned recommendations remain available.');
  const requireManagementReviewService = outcomeScope.requirePostGapService(
    'Management review delivery is outside this gap-assessment-only engagement. Use the controlled gap-assessment report for the contracted outcome.');
  const syncCertificationCompletion = async req => {
    if (!(await db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(req.workspace.id))) return;
    await delivery.syncOutcomePlanStatus(db, req.workspace, req.user.id);
  };

  const requirementOf = async (req, field = 'iso_item_id') => {
    const id = String(req.body[field] || '').trim();
    return id && (await reqOpts.belongs(db, req.workspace, id)) ? id : null;
  };

  app.get('/workspaces/:wsId/audits', requireAuth, requireWorkspace, requireInternalAuditService, async (req, res) => {
    const audits = await db.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id) AS finding_count,
      (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id AND status = 'open') AS open_findings
      FROM audits a WHERE a.workspace_id = ? ORDER BY a.audit_date DESC NULLS LAST, a.created_at DESC`).all(req.workspace.id);
    res.render('audits', { user: req.user, ws: req.workspace, audits });
  });

  app.post('/workspaces/:wsId/audits', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const { title, scope, audit_date, auditor_name } = req.body;
    if (!title) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO audits (workspace_id, title, scope, audit_date, auditor_name, created_by)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, title, scope || null, audit_date || null, auditor_name || null, req.user.id)).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_audit', 'audit', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/audits/' + id, 'Audit created'));
  });

  app.get('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, requireInternalAuditService, async (req, res) => {
    const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');
    const named = (rows) => reqOpts.nameRows(req.workspace, rows);
    const findings = named(await db.prepare(`SELECT f.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_findings f
      ${reqOpts.joinSql('f.iso_item_id')}
      WHERE f.audit_id = ? ORDER BY f.created_at`).all(audit.id));
    const requirementGroups = await reqOpts.grouped(db, req.workspace);
    const samples = named(await db.prepare(`SELECT s.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_samples s
      ${reqOpts.joinSql('s.iso_item_id')}
      WHERE s.audit_id=? ORDER BY s.sample_taken_at IS NULL, s.sample_taken_at DESC`).all(audit.id));
    const observations = named(await db.prepare(`SELECT o.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_observations o
      ${reqOpts.joinSql('o.iso_item_id')}
      WHERE o.audit_id=? ORDER BY o.status='closed', o.created_at`).all(audit.id));
    const checklistSources = auditChecklists.sources(req.workspace);
    res.render('audit_detail', { user: req.user, ws: req.workspace, audit, findings, requirementGroups, samples, observations, checklistSources });
  });

  app.post('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const { title, scope, audit_date, auditor_name, status, summary } = req.body;
    const updated = await db.prepare(`UPDATE audits SET title=?, scope=?, audit_date=?, auditor_name=?, status=?, summary=?
                WHERE id=? AND workspace_id=?`)
      .run(title, scope || null, audit_date || null, auditor_name || null,
           status || 'planned', summary || null, req.params.id, req.workspace.id);
    if (updated.changes) {
      await logAction(req.user.id, req.workspace.id, 'update_audit', 'audit', req.params.id,
        { title, status: status || 'planned', audit_date: audit_date || null }, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
  });

  app.get('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, async (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT * FROM improvements WHERE workspace_id=?`;
    if (filter === 'open') q += ` AND status NOT IN ('done','cancelled')`;
    const pgImp = await paginate(db, req, {
      count: q.replace('SELECT *', 'SELECT COUNT(*) c'),
      rows: q + ` ORDER BY (CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`,
      params: [req.workspace.id], perPage: 100,
    });
    res.render('improvements', { user: req.user, ws: req.workspace, items: pgImp.rows, filter,
      pg: pgImp, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const { title, description, source, source_ref, owner_name, due_date } = req.body;
    if (!title || !title.trim()) return redirectBack(req, res);
    await db.prepare(`INSERT INTO improvements (workspace_id, title, description, source, source_ref, owner_name, due_date, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, title.trim(), description || null,
      source || null, source_ref || null, owner_name || null, due_date || null, req.user.id
    );
    await logAction(req.user.id, req.workspace.id, 'add_improvement', 'improvement', null, { title }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/improvements`);
  });

  app.post('/workspaces/:wsId/improvements/:id', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const { title, description, source, source_ref, owner_name, due_date, status, impact_notes } = req.body;
    const updated = await db.prepare(`UPDATE improvements SET
      title=?, description=?, source=?, source_ref=?, owner_name=?, due_date=?, status=?, impact_notes=?,
      closed_at=CASE WHEN ? IN ('done','cancelled') AND closed_at IS NULL THEN utc_now_text()
                     WHEN ? NOT IN ('done','cancelled') THEN NULL
                     ELSE closed_at END
      WHERE id=? AND workspace_id=?`).run(
      title, description || null, source || null, source_ref || null, owner_name || null,
      due_date || null, status || 'open', impact_notes || null,
      status, status, req.params.id, req.workspace.id
    );
    if (updated.changes) {
      await logAction(req.user.id, req.workspace.id, 'update_improvement', 'improvement', req.params.id,
        { title, status: status || 'open' }, auditCtx(req));
    }
    res.redirect(`/workspaces/${req.workspace.id}/improvements`);
  });

  app.post('/workspaces/:wsId/improvements/:id/delete', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const item = await db.prepare('SELECT id, title, status, source, source_ref, owner_name FROM improvements WHERE id=? AND workspace_id=?')
      .get(req.params.id, req.workspace.id);
    if (item) {
      await db.transaction(async () => {
        const removed = await db.prepare(`DELETE FROM improvements WHERE id=? AND workspace_id=?`).run(item.id, req.workspace.id);
        if (removed.changes) {
          await logAction(req.user.id, req.workspace.id, 'delete_improvement', 'improvement', item.id, {
            title: item.title, status: item.status, source: item.source, source_ref: item.source_ref, owner_name: item.owner_name,
          }, { ...auditCtx(req), strict: true });
        }
      })();
    }
    res.redirect(`/workspaces/${req.workspace.id}/improvements`);
  });

  app.post('/workspaces/:wsId/audits/:id/sampling', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const { sampling_justification, sample_size, population_size } = req.body;
    const sampleSize = sample_size ? parseInt(sample_size, 10) : null;
    const populationSize = population_size ? parseInt(population_size, 10) : null;
    const updated = await db.prepare(`UPDATE audits SET sampling_justification=?, sample_size=?, population_size=?
                WHERE id=? AND workspace_id=?`).run(
      sampling_justification || null,
      sampleSize,
      populationSize,
      req.params.id, req.workspace.id
    );
    if (updated.changes) {
      await logAction(req.user.id, req.workspace.id, 'update_audit_sampling', 'audit', req.params.id,
        { sample_size: sampleSize, population_size: populationSize }, auditCtx(req));
    }
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/samples', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const { description, sample_taken_at, population_size, sample_size, finding } = req.body;
    if (!description) return redirectBack(req, res);
    const isoItemId = await requirementOf(req);
    const sampleId = (await db.prepare(`INSERT INTO audit_samples
      (audit_id, iso_item_id, description, sample_taken_at, population_size, sample_size, finding)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      audit.id, isoItemId, description.trim(),
      sample_taken_at || null,
      population_size ? parseInt(population_size, 10) : null,
      sample_size ? parseInt(sample_size, 10) : null,
      finding || null
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'add_audit_sample', 'audit_sample', sampleId,
      { audit_id: audit.id, iso_item_id: isoItemId }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/samples/:sid/delete', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id, title FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const sample = await db.prepare(`SELECT id, iso_item_id, description, sample_taken_at, population_size, sample_size
      FROM audit_samples WHERE id=? AND audit_id=?`).get(req.params.sid, audit.id);
    if (sample) {
      await db.transaction(async () => {
        const removed = await db.prepare(`DELETE FROM audit_samples WHERE id=? AND audit_id=?`).run(sample.id, audit.id);
        if (removed.changes) {
          await logAction(req.user.id, req.workspace.id, 'delete_audit_sample', 'audit_sample', sample.id, {
            audit_id: audit.id, audit_title: audit.title, iso_item_id: sample.iso_item_id,
            description: String(sample.description || '').slice(0, 200), sample_taken_at: sample.sample_taken_at,
            population_size: sample.population_size, sample_size: sample.sample_size,
          }, { ...auditCtx(req), strict: true });
        }
      })();
    }
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/lifecycle', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const { stage } = req.body;
    const allowed = ['planned','fieldwork','findings_review','report','follow_up','closed'];
    if (!allowed.includes(stage)) return redirectBack(req, res);
    const sets = ['lifecycle_stage=?'];
    const vals = [stage];
    if (stage === 'fieldwork') { sets.push('fieldwork_started_at=COALESCE(fieldwork_started_at, utc_now_text())'); }
    if (stage === 'report')    { sets.push('report_issued_at=COALESCE(report_issued_at, utc_now_text())'); }
    if (stage === 'closed')    { sets.push('closed_at=COALESCE(closed_at, utc_now_text())'); }
    vals.push(req.params.id, req.workspace.id);
    await db.prepare(`UPDATE audits SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    await logAction(req.user.id, req.workspace.id, 'audit_lifecycle', 'audit', req.params.id, { stage }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/findings', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const { finding_type, description, severity } = req.body;
    if (!description) return redirectBack(req, res);
    const isoItemId = await requirementOf(req);
    const findingId = (await db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, description, severity)
                VALUES (?, ?, ?, ?, ?)`)
      .run(audit.id, isoItemId, finding_type || 'observation',
           description, severity || 'medium')).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'add_audit_finding', 'audit_finding', findingId, {
      audit_id: audit.id, finding_type: finding_type || 'observation', severity: severity || 'medium', iso_item_id: isoItemId,
    }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
  });

  app.post('/workspaces/:wsId/audits/:id/findings/:fId/promote', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const f = await db.prepare('SELECT * FROM audit_findings WHERE id = ? AND audit_id = ?')
      .get(req.params.fId, audit.id);
    if (!f) return redirectBack(req, res);
    if (f.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + f.nonconformity_id);
    const sev = f.finding_type === 'major_nc' ? 'major' : 'minor';
    const ncId = (await db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity, iso_item_id)
                             VALUES (?, ?, 'internal_audit', ?, ?, ?, ?)`)
      .run(req.workspace.id, f.description.substring(0, 100),
           'Audit #' + req.params.id, f.description, sev, f.iso_item_id)).lastInsertRowid;
    await db.prepare('UPDATE audit_findings SET nonconformity_id = ? WHERE id = ?').run(ncId, f.id);
    await fts.refresh(req.workspace.id, 'nc', ncId);
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
  });

  app.post('/workspaces/:wsId/audits/:id/delete', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare(`SELECT a.id, a.title, a.audit_date, a.status, a.lifecycle_stage, a.auditor_name,
        (SELECT COUNT(*) FROM audit_findings WHERE audit_id=a.id) AS findings,
        (SELECT COUNT(*) FROM audit_samples WHERE audit_id=a.id) AS samples
      FROM audits a WHERE a.id = ? AND a.workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (audit) {
      await db.transaction(async () => {
        const removed = await db.prepare('DELETE FROM audits WHERE id = ? AND workspace_id = ?').run(audit.id, req.workspace.id);
        if (removed.changes) {
          await logAction(req.user.id, req.workspace.id, 'delete_audit', 'audit', audit.id, {
            title: audit.title, audit_date: audit.audit_date, status: audit.status,
            lifecycle_stage: audit.lifecycle_stage, auditor_name: audit.auditor_name,
            findings: audit.findings, samples: audit.samples,
          }, { ...auditCtx(req), strict: true });
        }
      })();
    }
    res.redirect('/workspaces/' + req.workspace.id + '/audits');
  });

  app.get('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, requireManagementReviewService, async (req, res) => {
    const mrms = await db.prepare(`SELECT * FROM mrms WHERE workspace_id = ?
                             ORDER BY meeting_date DESC NULLS LAST, created_at DESC`).all(req.workspace.id);
    const pack932Preview = await compute932InputPack(req.workspace);
    res.render('mrms', { user: req.user, ws: req.workspace, mrms, pack932Preview });
  });

  function systemName(workspace) {
    const names = reqOpts.enabledCodes(workspace)
      .map((code) => (frameworks.frameworkMeta(code) || {}).systemCode)
      .filter(Boolean);
    return names.length ? names.join(' and ') : 'management system';
  }

  async function compute932InputPack(workspace) {
    const wsId = workspace.id;
    const today = new Date().toISOString().slice(0,10);

    const ncOpen = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')`).get(wsId)).c;
    const ncMajor = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(wsId)).c;
    const ncOverdue = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date < ?`).get(wsId, today)).c;
    const auditsLast12 = (await db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date > utc_date_text(now() + ('-12 months')::interval)`).get(wsId)).c;
    const findingsLast12 = (await db.prepare(`SELECT COUNT(*) c FROM audit_findings af INNER JOIN audits a ON a.id=af.audit_id WHERE a.workspace_id=? AND a.audit_date > utc_date_text(now() + ('-12 months')::interval)`).get(wsId)).c;
    const openRisks = (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open'`).get(wsId)).c;
    const highRisks = (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open' AND (likelihood * impact) >= 16`).get(wsId)).c;
    const treatmentOpen = (await db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=? AND status NOT IN ('done','cancelled')`).get(wsId)).c;
    const treatmentDone = (await db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=? AND status='done'`).get(wsId)).c;
    const lastMrm = await db.prepare(`SELECT meeting_date, action_items FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC NULLS LAST LIMIT 1`).get(wsId);

    const sinceClause = lastMrm ? '?' : "utc_date_text(now() + ('-12 months')::interval)";
    const lastMrmParams = lastMrm ? [wsId, lastMrm.meeting_date] : [wsId];
    let newSuppliers = 0;
    try {
      newSuppliers = (await db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND substr(created_at, 1, 10) > ${sinceClause}`).get(...lastMrmParams)).c;
    } catch (_) {}

    let incidents = { total: 0, open: 0, last12m: 0 };
    try {
      const row = await db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN created_at > utc_text(now() + ('-12 months')::interval) THEN 1 ELSE 0 END) AS last12m
        FROM incidents WHERE workspace_id=?`).get(wsId);
      if (row) incidents = { total: row.total || 0, open: row.open || 0, last12m: row.last12m || 0 };
    } catch (_) {}

    let parties = { total: 0, added: 0, changed: 0, obligations: 0, recent: [] };
    try {
      const since = lastMrm ? lastMrm.meeting_date : null;
      const sinceSql = since ? '?' : "utc_date_text(now() + ('-12 months')::interval)";
      const sinceParams = since ? [since] : [];
      parties.total = (await db.prepare(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=?`).get(wsId)).c;
      parties.obligations = (await db.prepare(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=? AND requirement_kind IN ('legal','regulatory','contractual')`).get(wsId)).c;
      parties.added = (await db.prepare(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=? AND substr(created_at, 1, 10) > ${sinceSql}`).get(wsId, ...sinceParams)).c;
      parties.changed = (await db.prepare(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=? AND substr(created_at, 1, 10) <= ${sinceSql} AND substr(updated_at, 1, 10) > ${sinceSql}`)
        .get(wsId, ...sinceParams, ...sinceParams)).c;
      parties.recent = await db.prepare(`SELECT party, needs FROM interested_parties WHERE workspace_id=? AND substr(updated_at, 1, 10) > ${sinceSql} ORDER BY updated_at DESC LIMIT 5`)
        .all(wsId, ...sinceParams);
    } catch (_) {}

    const improvementsOpen = (await db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=? AND status IN ('open','in_progress')`).get(wsId)).c;
    const improvementsDone = (await db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=? AND status='done'`).get(wsId)).c;
    const recentImprovements = await db.prepare(`SELECT title, source FROM improvements WHERE workspace_id=? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 5`).all(wsId);

    let supplierReview = { total: 0, overdue: 0 };
    try {
      const row = await db.prepare(`SELECT
        COUNT(DISTINCT s.id) AS total,
        SUM(CASE WHEN s.next_review_date IS NULL OR s.next_review_date < utc_today_text() THEN 1 ELSE 0 END) AS overdue
        FROM suppliers s WHERE s.workspace_id=?`).get(wsId);
      if (row) supplierReview = { total: row.total || 0, overdue: row.overdue || 0 };
    } catch (_) {}

    let risksAddedSinceLast = 0, risksClosedSinceLast = 0;
    if (lastMrm) {
      risksAddedSinceLast = (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND substr(created_at, 1, 10) > ?`).get(wsId, lastMrm.meeting_date)).c;
      risksClosedSinceLast = (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status IN ('closed','treated')`).get(wsId)).c;
    }

    const pack = {
      prior_actions_status: lastMrm
        ? `Last MRM (${lastMrm.meeting_date}) actions:\n${lastMrm.action_items || '(none recorded)'}\n\n[Review status of each above before this meeting.]`
        : 'No prior management review on record. This is the first one.',

      context_changes: lastMrm
        ? `Changes since last MRM (${lastMrm.meeting_date}):\n  New suppliers onboarded: ${newSuppliers}\n\n[Add narrative on regulatory updates, organisational changes, technology shifts, threat-landscape evolution, and changes in the needs / expectations of interested parties identified during gap assessment.]`
        : `Baseline context (no prior MRM):\n  Suppliers on file: ${supplierReview.total}\n\n[Document the external + internal context relevant to the ${systemName(workspace)} - regulations, market, technology, organisation. Note the interested parties identified during gap assessment (clause 4.2).]`,

      interested_party_changes: parties.total
        ? `Interested parties on record: ${parties.total} (${parties.obligations} with a legal, regulatory or contractual obligation)\n  Added ${lastMrm ? `since last MRM (${lastMrm.meeting_date})` : 'in the last 12 months'}: ${parties.added}\n  Requirements changed: ${parties.changed}${parties.recent.length ? '\n\nRecently added or changed:\n' + parties.recent.map(p => `  - ${p.party}${p.needs ? ': ' + p.needs : ''}`).join('\n') : ''}\n\n[Note what customers, regulators, affected people and employees now need or expect that they did not before, and what the management system will do about it.]`
        : '[No interested parties are recorded yet. Note what customers, regulators, employees and others now need or expect that they did not at the last review.]',

      performance_review: `Internal audit programme (last 12 months):\n  Audits run: ${auditsLast12}\n  Findings raised: ${findingsLast12}\n\nNonconformity status:\n  Open: ${ncOpen} (Major: ${ncMajor}, Overdue: ${ncOverdue})\n\nRisk treatment plan:\n  Open actions: ${treatmentOpen}\n  Closed actions: ${treatmentDone}\n\nIncidents (last 12 months):\n  Total: ${incidents.last12m} (${incidents.open} still open)\n\nSupplier reviews:\n  ${supplierReview.total} suppliers · ${supplierReview.overdue} overdue review${supplierReview.overdue === 1 ? '' : 's'}\n\n[Add commentary on KPIs, monitoring metrics (9.1), trends, root-cause patterns.]`,

      feedback_interested_parties: `[Summarise feedback received in the period from interested parties identified in clause 4.2 - customer concerns / contractual security asks, regulator queries, employee survey results, supplier feedback, board observations. Quantify where possible (NPS, audit findings against customer SoWs, complaint volumes).]`,

      risk_treatment_status: `Risk register snapshot (today):\n  Total open risks: ${openRisks}\n  High-residual (L×I ≥ 16): ${highRisks}${lastMrm ? `\n\nSince last MRM (${lastMrm.meeting_date}):\n  Risks added: ${risksAddedSinceLast}\n  Risks closed/treated: ${risksClosedSinceLast}` : ''}\n\n[Add narrative on top risks, treatment progress, residual-risk acceptance.]`,

      improvement_opportunities: improvementsOpen === 0 && improvementsDone === 0
        ? 'No improvement actions recorded yet. Capture observations from audits, MRMs, incidents, and monitoring under Improvements (Clause 10.1).'
        : `Improvement log:\n  Active: ${improvementsOpen}\n  Completed: ${improvementsDone}${recentImprovements.length ? '\n\nActive items:\n' + recentImprovements.map(i => `  - ${i.title}${i.source ? ' [' + i.source + ']' : ''}`).join('\n') : ''}\n\n[Identify themes from this period's data: recurring NCs, gaps surfaced by audits, technology refresh, training needs, control automation candidates.]`,

      refreshedAt: new Date().toISOString()
    };
    return pack;
  }

  app.post('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, requireManagementReviewService, requirePermission('mrm.manage'), async (req, res) => {
    const { meeting_date, attendees } = req.body;
    const pack = await compute932InputPack(req.workspace);
    const id = (await db.prepare(`INSERT INTO mrms
      (workspace_id, meeting_date, attendees,
       prior_actions_status, context_changes, interested_party_changes, performance_review, feedback_interested_parties,
       risk_treatment_status, improvement_opportunities,
       created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, meeting_date || null, attendees || null,
           pack.prior_actions_status, pack.context_changes, pack.interested_party_changes, pack.performance_review,
           pack.feedback_interested_parties, pack.risk_treatment_status, pack.improvement_opportunities,
           req.user.id)).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_mrm', 'mrm', id, null);
    res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + id);
  });

  app.post('/workspaces/:wsId/mrms/:id/refresh-inputs', requireAuth, requireWorkspace, requireManagementReviewService, requirePermission('mrm.manage'), async (req, res) => {
    const mrm = await db.prepare('SELECT id, status FROM mrms WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!mrm) return res.status(404).send('Not found');
    const pack = await compute932InputPack(req.workspace);
    await db.prepare(`UPDATE mrms SET
        prior_actions_status=?, context_changes=?, interested_party_changes=?, performance_review=?,
        feedback_interested_parties=?, risk_treatment_status=?, improvement_opportunities=?
      WHERE id=? AND workspace_id=?`)
      .run(pack.prior_actions_status, pack.context_changes, pack.interested_party_changes, pack.performance_review,
           pack.feedback_interested_parties, pack.risk_treatment_status, pack.improvement_opportunities,
           mrm.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'refresh_mrm_inputs', 'mrm', mrm.id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/mrms/${mrm.id}`, 'MRM inputs refreshed from current data'));
  });

  app.get('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, requireManagementReviewService, async (req, res) => {
    const mrm = await db.prepare('SELECT * FROM mrms WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
    if (!mrm) return res.status(404).send('Not found');

    const audits = await db.prepare(`SELECT title, status, audit_date FROM audits
                               WHERE workspace_id = ? ORDER BY audit_date DESC NULLS LAST LIMIT 10`).all(req.workspace.id);
    const ncs = await db.prepare(`SELECT title, severity, status FROM nonconformities
                            WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.workspace.id);
    const riskSummary = await db.prepare(`SELECT status, COUNT(*) AS c FROM risks
                                    WHERE workspace_id = ? GROUP BY status ORDER BY status NULLS FIRST`).all(req.workspace.id);
    const progress = await workspaceProgress(req.workspace.id);

    const incidentSummary = await (async () => {
      try {
        return (await db.prepare(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN created_at > utc_text(now() + ('-12 months')::interval) THEN 1 ELSE 0 END) AS last12m
          FROM incidents WHERE workspace_id=?`).get(req.workspace.id)) || {};
      } catch (e) { return {}; }
    })();
    const supplierReviewStatus = await (async () => {
      try {
        return (await db.prepare(`SELECT
          COUNT(DISTINCT s.id) AS total_suppliers,
          SUM(CASE WHEN (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) > utc_date_text(now() + ('-12 months')::interval)
                   THEN 1 ELSE 0 END) AS reviewed_last_year,
          SUM(CASE WHEN (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) IS NULL
                    OR (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) < utc_date_text(now() + ('-12 months')::interval)
                   THEN 1 ELSE 0 END) AS overdue
          FROM suppliers s WHERE s.workspace_id=?`).get(req.workspace.id)) || {};
      } catch (e) { return {}; }
    })();
    const priorMrm = await db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND id != ? AND status='complete' ORDER BY meeting_date DESC NULLS LAST LIMIT 1`).get(req.workspace.id, mrm.id);
    const priorActions = priorMrm
      ? await db.prepare(`SELECT title, status, due_date FROM tasks WHERE workspace_id=? AND created_at >= ? AND created_at < utc_text(utc_ts(sqlite_date_ymd(?)) + interval '30 days') ORDER BY due_date NULLS FIRST`).all(req.workspace.id, priorMrm.meeting_date, priorMrm.meeting_date)
      : [];

    res.render('mrm_detail', {
      user: req.user, ws: req.workspace, mrm, audits, ncs, riskSummary, progress,
      incidentSummary, supplierReviewStatus, priorActions, priorMrm
    });
  });

  app.post('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, requireManagementReviewService, requirePermission('mrm.manage'), async (req, res) => {
    const f = ['meeting_date','attendees','status','context_changes','interested_party_changes','prior_actions_status',
               'performance_review','feedback_interested_parties','risk_treatment_status',
               'improvement_opportunities','decisions','action_items'];
    const set = [];const vals = [];

    for (const __item of f) await (async k => {
      if (req.body[k] === undefined) return;
      set.push(`${k}=?`);
      vals.push(k === 'iso_item_id' ? await requirementOf(req) : (req.body[k] || null));
    })(__item);

    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      await db.prepare(`UPDATE mrms SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      await logAction(req.user.id, req.workspace.id, 'update_mrm', 'mrm', req.params.id, null);
    }
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/mrms/' + req.params.id, 'Management review saved'));
  });

  app.post('/workspaces/:wsId/mrms/:id/delete', requireAuth, requireWorkspace, requireManagementReviewService, requirePermission('mrm.manage'), async (req, res) => {
    const mrm = await db.prepare('SELECT id, meeting_date, status, attendees FROM mrms WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (mrm) {
      await db.transaction(async () => {
        const removed = await db.prepare('DELETE FROM mrms WHERE id = ? AND workspace_id = ?').run(mrm.id, req.workspace.id);
        if (removed.changes) {
          await logAction(req.user.id, req.workspace.id, 'delete_mrm', 'mrm', mrm.id, {
            meeting_date: mrm.meeting_date, status: mrm.status, attendees: String(mrm.attendees || '').slice(0, 500) || null,
          }, { ...auditCtx(req), strict: true });
        }
      })();
    }
    res.redirect('/workspaces/' + req.workspace.id + '/mrms');
  });

  app.get('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, async (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT n.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM nonconformities n
             ${reqOpts.joinSql('n.iso_item_id')}
             WHERE n.workspace_id = ?`;
    if (filter === 'open') q += ` AND n.status NOT IN ('closed','verified')`;
    const pgN = await paginate(db, req, {
      count: q.replace(/SELECT n\.\*.*?FROM nonconformities n/s, 'SELECT COUNT(*) c FROM nonconformities n'),
      rows: q + ` ORDER BY n.created_at DESC`,
      params: [req.workspace.id], perPage: 100,
    });
    res.render('nonconformities', { user: req.user, ws: req.workspace, ncs: reqOpts.nameRows(req.workspace, pgN.rows), filter,
      pg: pgN, pagerHref: p => pageHref(req, p), requirementGroups: await reqOpts.grouped(db, req.workspace) });
  });

  app.post('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const { title, source, description, severity } = req.body;
    if (!title) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, description, severity, iso_item_id)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, title, source || 'other', description || null,
           severity || 'minor', await requirementOf(req))).lastInsertRowid;
    await fts.refresh(req.workspace.id, 'nc', id);
    await logAction(req.user.id, req.workspace.id, 'create_nc', 'nonconformity', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/nonconformities/' + id, 'Nonconformity created'));
  });

  app.get('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, async (req, res) => {
    const nc = await db.prepare('SELECT * FROM nonconformities WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!nc) return res.status(404).send('Not found');
    const certificationLineage = await delivery.certificationFindingLineage(db, req.workspace.id, nc.id);
    const findingEvidence = await db.prepare(`SELECT l.*,e.filename,e.sha256,e.uploaded_at,u.name AS linked_by_name
      FROM nonconformity_evidence_links l
      JOIN evidence e ON e.id=l.evidence_id AND e.workspace_id=l.workspace_id
      LEFT JOIN users u ON u.id=l.linked_by
      WHERE l.workspace_id=? AND l.nonconformity_id=?
      ORDER BY CASE l.evidence_role WHEN 'validation' THEN 0 ELSE 1 END,l.linked_at,l.id`)
      .all(req.workspace.id, nc.id);
    const evidenceCatalog = await db.prepare(`SELECT id,filename,sha256,uploaded_at
      FROM evidence WHERE workspace_id=? AND superseded_at IS NULL
      ORDER BY uploaded_at DESC,id DESC LIMIT 250`).all(req.workspace.id);
    const requirementGroups = await reqOpts.grouped(db, req.workspace);
    const correctiveTasks = await db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.workspace_id=? AND t.nonconformity_id=? ORDER BY t.created_at DESC`).all(req.workspace.id, nc.id);
    res.render('nonconformity_detail', {
      user: req.user, ws: req.workspace, nc, requirementGroups, correctiveTasks,
      certificationLineage, findingEvidence, evidenceCatalog,
    });
  });

  app.post('/workspaces/:wsId/nonconformities/:id/evidence', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const nc = await db.prepare('SELECT id FROM nonconformities WHERE id=? AND workspace_id=?')
      .get(req.params.id, req.workspace.id);
    if (!nc) return res.status(404).send('Not found');
    const evidence = await db.prepare(`SELECT id FROM evidence
      WHERE id=? AND workspace_id=? AND superseded_at IS NULL`)
      .get(Number(req.body.evidence_id), req.workspace.id);
    if (!evidence) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/nonconformities/${nc.id}`,
        'Choose current evidence from this client workspace.', 'error'));
    }
    const role = String(req.body.evidence_role || 'remediation').toLowerCase();
    if (!['remediation', 'validation'].includes(role)) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/nonconformities/${nc.id}`,
        'Choose whether the evidence proves remediation or independent validation.', 'error'));
    }
    const result = await db.prepare(`INSERT INTO nonconformity_evidence_links
      (workspace_id,nonconformity_id,evidence_id,evidence_role,linked_by)
      VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`).run(req.workspace.id, nc.id, evidence.id, role, req.user.id);
    if (result.changes) {
      await logAction(req.user.id, req.workspace.id, 'link_nonconformity_evidence', 'nonconformity', nc.id, {
        evidence_id: evidence.id, evidence_role: role,
      }, auditCtx(req));
    }
    res.redirect(withToast(`/workspaces/${req.workspace.id}/nonconformities/${nc.id}`,
      result.changes ? 'Evidence linked into the retained CAPA record.' : 'That evidence and role are already linked.'));
  });

  app.post('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const before = await db.prepare('SELECT * FROM nonconformities WHERE id=? AND workspace_id=?')
      .get(req.params.id, req.workspace.id);
    if (!before) return res.status(404).send('Not found');
    const retainedLineage = await delivery.certificationFindingLineage(db, req.workspace.id, before.id);
    const requestedSource = req.body.source === undefined ? before.source : (req.body.source || null);
    const requestedSourceRef = req.body.source_ref === undefined ? before.source_ref : (req.body.source_ref || null);
    const requestedCertEvent = await delivery.certificationEventForSourceRef(db, req.workspace.id, requestedSourceRef);
    const mutatesRetainedLineage = retainedLineage
      && (String(requestedSource || '').toLowerCase() !== 'external_audit'
        || String(requestedSourceRef || '') !== String(before.source_ref || ''));
    const forgesCertificationLineage = !retainedLineage && !!requestedCertEvent;
    if (mutatesRetainedLineage || forgesCertificationLineage) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/nonconformities/${before.id}`,
        'Certification finding lineage is immutable. Record Stage 1 and Stage 2 findings from the certification-cycle event.', 'error'));
    }
    const f = ['title','source','source_ref','description','severity','iso_item_id',
               'root_cause','corrective_action','responsible','due_date','effectiveness_check','status'];
    const set = [];const vals = [];

    for (const __item of f) await (async k => {
      if (req.body[k] === undefined) return;
      set.push(`${k}=?`);
      vals.push(k === 'iso_item_id' ? await requirementOf(req) : (req.body[k] || null));
    })(__item);

    const requestedStatus = req.body.status === undefined ? before.status : req.body.status;
    const closing = (requestedStatus === 'closed' || requestedStatus === 'verified');
    if (retainedLineage && closing) {
      const finalValue = key => String(req.body[key] === undefined ? (before[key] || '') : (req.body[key] || '')).trim();
      const finalSeverity = finalValue('severity').toLowerCase();
      const missing = [];
      if (['major', 'minor'].includes(finalSeverity) && !finalValue('root_cause')) missing.push('root-cause analysis');
      if (!finalValue('corrective_action')) missing.push('corrective action');
      if (!finalValue('effectiveness_check')) missing.push('effectiveness conclusion');
      const validationEvidence = (await db.prepare(`SELECT COUNT(*) c FROM nonconformity_evidence_links
        WHERE workspace_id=? AND nonconformity_id=? AND evidence_role='validation'`)
        .get(req.workspace.id, before.id)).c;
      if (!validationEvidence) missing.push('independent validation evidence');
      if (missing.length) {
        return res.redirect(withToast(`/workspaces/${req.workspace.id}/nonconformities/${before.id}`,
          `Certification finding cannot be ${requestedStatus}. Add ${missing.join(', ')} first.`, 'error'));
      }
    }
    if (closing) {
      set.push('closed_at=utc_now_text()');
    } else if (req.body.status !== undefined
      && ['closed', 'verified'].includes(String(before.status || '').toLowerCase())
      && ['open', 'in_progress'].includes(String(requestedStatus || '').toLowerCase())) {
      set.push('closed_at=NULL');
    }
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      await db.prepare(`UPDATE nonconformities SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      await fts.refresh(req.workspace.id, 'nc', req.params.id);
      await logAction(req.user.id, req.workspace.id, 'update_nc', 'nonconformity', req.params.id, null);

      if (req.body.status !== undefined && String(req.body.status) !== String(before.status)) {
        await delivery.reconcileCompletionState(db, req.workspace, req.user.id, {
          reason: 'A nonconformity or observation status changed after delivery completion.',
          details: {
            finding_id: before.id,
            certification_event_id: retainedLineage?.cert_event_id || null,
            audit_stage: retainedLineage?.event_type || null,
            from_status: before.status,
            to_status: req.body.status
          }
        });
        await syncCertificationCompletion(req);
      }

      if (closing) {
        const ncRow = await db.prepare('SELECT iso_item_id FROM nonconformities WHERE id=?').get(req.params.id);
        if (ncRow && ncRow.iso_item_id) {
          const ncFramework = await reqOpts.frameworkOf(db, ncRow.iso_item_id);
          const ridNc = ncFramework ? await ctlWrites.requirementId(db, ncFramework, ncRow.iso_item_id) : null;
          if (ridNc) {
            await db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING`).run(req.workspace.id, ridNc);
            await db.prepare(`UPDATE control_instances SET last_verified_at = utc_now_text() WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(req.workspace.id, ridNc);
          }
        }
      }
    }
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + req.params.id);
  });

  app.post('/workspaces/:wsId/nonconformities/:id/spawn-task', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const nc = await db.prepare('SELECT * FROM nonconformities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!nc) return res.status(404).send('Not found');
    const title = `Corrective action: ${nc.title}`;
    const due = req.body.due_date || nc.due_date || null;
    const description = nc.corrective_action || nc.description || '';
    const taskId = (await db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, due_date, status, created_by, nonconformity_id)
                                VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`)
      .run(req.workspace.id, title, description, nc.iso_item_id || null, due, req.user.id, nc.id)).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'spawn_corrective_task', 'task', taskId, { nonconformity_id: nc.id }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + nc.id);
  });

  app.post('/workspaces/:wsId/nonconformities/:id/delete', requireAuth, requireWorkspace, requirePermission('nc.manage'), async (req, res) => {
    const finding = await db.prepare('SELECT * FROM nonconformities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!finding) return res.redirect(`/workspaces/${req.workspace.id}/nonconformities`);
    if (await delivery.certificationFindingLineage(db, req.workspace.id, finding.id)) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/nonconformities/${finding.id}`,
        'Certification findings cannot be deleted. Close or verify the retained record so its audit lineage remains available.', 'error'));
    }
    await db.transaction(async () => {
      const removed = await db.prepare('DELETE FROM nonconformities WHERE id = ? AND workspace_id = ?').run(finding.id, req.workspace.id);
      if (removed.changes) {
        await logAction(req.user.id, req.workspace.id, 'delete_nc', 'nonconformity', finding.id, {
          title: finding.title, severity: finding.severity, status: finding.status,
          source: finding.source, source_ref: finding.source_ref, iso_item_id: finding.iso_item_id,
        }, { ...auditCtx(req), strict: true });
      }
    })();
    await fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'nc', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities');
  });

}

module.exports = { register };
