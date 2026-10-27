const { filterAsync } = require('../lib/async-array');

const INTAKE = require('../data/intake-questions');
const delivery = require('../lib/engagement-delivery');
const outcomeScope = require('../lib/engagement-outcome-scope');
const auditPack = require('../lib/audit-pack');
const enc = require('../lib/encryption');
const fs = require('fs');
const crypto = require('crypto');
const fts = require('../lib/fts');
const { requireInternalEvidenceMutation } = require('../lib/evidence-access');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, withToast, logAction, auditCtx, upload, resolveUploadPath } = deps;

  app.get('/workspaces/:wsId/intake', requireAuth, requireWorkspace, async (req, res) => {
    const rows = await db.prepare(`SELECT question_id, answer FROM engagement_intake WHERE workspace_id=?`)
      .all(req.workspace.id);
    const answers = {};
    for (const r of rows) answers[r.question_id] = r.answer || '';
    const flat = INTAKE.flatten();
    const total = flat.length;
    const answered = flat.filter(q => (answers[q.id] || '').trim().length > 0).length;
    const requiredAnswered = flat.filter(q => q.required && (answers[q.id] || '').trim().length > 0).length;
    const requiredTotal = flat.filter(q => q.required).length;
    const draftScope = INTAKE.draftScopeStatement(answers);
    const summary = INTAKE.computeEngagementSummary(answers);
    const crownJewelQuestions = INTAKE.crownJewelQuestions(answers);
    const crownJewelAssets = {};
    for (const item of INTAKE.crownJewelAnswers(answers)) {
      const asset = await db.prepare(`SELECT id,name FROM assets
        WHERE workspace_id=? AND ((source_type='engagement_intake' AND source_ref=?) OR lower(trim(name))=lower(trim(?)))
        ORDER BY CASE WHEN source_type='engagement_intake' AND source_ref=? THEN 0 ELSE 1 END,id LIMIT 1`)
        .get(req.workspace.id, item.id, item.name, item.id);
      if (asset) crownJewelAssets[item.id] = asset;
    }
    const readyToConfirm = requiredAnswered === requiredTotal && requiredTotal > 0;
    const scopeConfirmedAt = req.workspace.scope_confirmed_at || null;
    let scopeConfirmedBy = null;
    if (req.workspace.scope_confirmed_by) {
      try {
        scopeConfirmedBy = await db.prepare('SELECT name FROM users WHERE id=?').get(req.workspace.scope_confirmed_by);
      } catch (_) {}
    }
    res.render('intake', {
      user: req.user, ws: req.workspace,
      sections: INTAKE.SECTIONS, answers, total, answered, draftScope, summary,
      intakeQuestions: INTAKE,
      crownJewelQuestions, crownJewelAssets, maxCrownJewels: INTAKE.MAX_CROWN_JEWELS,
      requiredAnswered, requiredTotal, readyToConfirm,
      scopeConfirmedAt, scopeConfirmedBy
    });
  });

  async function syncCrownJewelAsset(wsId, questionId, rawName) {
    const number = INTAKE.crownJewelNumber(questionId);
    const name = String(rawName || '').trim();
    if (!number || !name) return { status: 'unchanged', assetId: null };

    let asset = await db.prepare(`SELECT * FROM assets
      WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref=?`).get(wsId, questionId);
    if (asset) {
      const sameName = await db.prepare(`SELECT * FROM assets
        WHERE workspace_id=? AND id<>? AND lower(trim(name))=lower(trim(?)) ORDER BY id LIMIT 1`)
        .get(wsId, asset.id, name);
      if (sameName) {
        await db.transaction(async () => {
          await db.prepare(`UPDATE assets SET source_type=NULL,source_ref=NULL WHERE id=? AND workspace_id=?`).run(asset.id, wsId);
          if (!sameName.source_type && !sameName.source_ref) {
            await db.prepare(`UPDATE assets SET source_type='engagement_intake',source_ref=?,
              business_criticality='critical',classification=COALESCE(NULLIF(classification,''),'restricted')
              WHERE id=? AND workspace_id=?`).run(questionId, sameName.id, wsId);
          } else {
            await db.prepare(`UPDATE assets SET business_criticality='critical' WHERE id=? AND workspace_id=?`).run(sameName.id, wsId);
          }
        })();
        await fts.refresh(wsId, 'asset', sameName.id);
        return { status: 'reused', assetId: Number(sameName.id) };
      }
      if (asset.name !== name || asset.business_criticality !== 'critical') {
        await db.prepare(`UPDATE assets SET name=?,business_criticality='critical' WHERE id=? AND workspace_id=?`)
          .run(name, asset.id, wsId);
        await fts.refresh(wsId, 'asset', asset.id);
        return { status: 'updated', assetId: Number(asset.id) };
      }
      return { status: 'linked', assetId: Number(asset.id) };
    }

    asset = await db.prepare(`SELECT * FROM assets WHERE workspace_id=? AND lower(trim(name))=lower(trim(?)) ORDER BY id LIMIT 1`)
      .get(wsId, name);
    if (asset) {
      if (!asset.source_type && !asset.source_ref) {
        await db.prepare(`UPDATE assets SET source_type='engagement_intake',source_ref=?,
          business_criticality='critical',classification=COALESCE(NULLIF(classification,''),'restricted')
          WHERE id=? AND workspace_id=?`).run(questionId, asset.id, wsId);
      } else {
        await db.prepare(`UPDATE assets SET business_criticality='critical' WHERE id=? AND workspace_id=?`).run(asset.id, wsId);
      }
      await fts.refresh(wsId, 'asset', asset.id);
      return { status: 'reused', assetId: Number(asset.id) };
    }

    const result = await db.prepare(`INSERT INTO assets
      (workspace_id,name,type,classification,cia_c,cia_i,cia_a,description,business_criticality,source_type,source_ref)
      VALUES (?,?,'information','restricted',3,3,3,?,'critical','engagement_intake',?)`)
      .run(wsId, name,
        'Identified as a crown-jewel information asset during client setup. Assign an owner and complete its business-impact and recovery details in the asset register.',
        questionId);
    const assetId = Number(result.lastInsertRowid);
    await fts.refresh(wsId, 'asset', assetId);
    return { status: 'created', assetId };
  }

  async function detachCrownJewelAsset(wsId, questionId) {
    const asset = await db.prepare(`SELECT id FROM assets
      WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref=?`).get(wsId, questionId);
    if (!asset) return { status: 'unchanged', assetId: null };
    await db.prepare(`UPDATE assets SET source_type=NULL,source_ref=NULL WHERE id=? AND workspace_id=?`).run(asset.id, wsId);
    return { status: 'retained', assetId: Number(asset.id) };
  }

  async function applyIntakeToClient(wsId, actorId) {
    const rows = await db.prepare(`SELECT question_id, answer FROM engagement_intake WHERE workspace_id=?`).all(wsId);
    const answers = {};
    for (const r of rows) answers[r.question_id] = r.answer || '';
    const scope = INTAKE.draftScopeStatement(answers);
    await db.prepare('UPDATE workspaces SET scope=? WHERE id=?').run(scope, wsId);
    const certDeadline = (answers['cert-deadline'] || '').trim();
    const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
    let frameworks = workspace?.frameworks || [];
    if (!Array.isArray(frameworks)) {
      try { frameworks = JSON.parse(frameworks || '[]'); } catch (_) { frameworks = []; }
    }
    if (frameworks.includes('iso27001')) {
      const targetDate = workspace.engagement_outcome === 'gap_assessment_only' ? null : (certDeadline || null);
      await db.prepare('UPDATE workspaces SET target_cert_date=? WHERE id=?').run(targetDate, wsId);
      const updatedWorkspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
      updatedWorkspace.frameworks = frameworks;
      await delivery.syncCertificationTarget(db, updatedWorkspace, actorId);
    }
    const answeredCrownJewels = INTAKE.crownJewelAnswers(answers);
    const answeredCrownIds = new Set(answeredCrownJewels.map(item => item.id));
    const linkedCrownIds = await db.prepare(`SELECT source_ref FROM assets
      WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref ~ '^crown-jewel-[0-9]'`).all(wsId);
    let retained = 0;
    for (const linked of linkedCrownIds) {
      if (!answeredCrownIds.has(linked.source_ref)) {
        const detached = await detachCrownJewelAsset(wsId, linked.source_ref);
        if (detached.status === 'retained') retained++;
      }
    }
    const assetSync = { created: 0, updated: 0, reused: 0, linked: 0, retained };
    for (const item of answeredCrownJewels) {
      const result = await syncCrownJewelAsset(wsId, item.id, item.name);
      if (Object.prototype.hasOwnProperty.call(assetSync, result.status)) assetSync[result.status]++;
    }
    return { assetSync };
  }

  function readAnswer(body, q) {
    if (q.type !== 'multiselect') return String(body[q.id] || '').trim();
    const raw = body[`${q.id}__opt`];
    const chosen = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
    return INTAKE.serializeMultiselect(q, chosen.map(String), body[`${q.id}__other`]);
  }

  app.post('/workspaces/:wsId/intake', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const flat = INTAKE.flatten();
    const insert = db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
      VALUES (?, ?, ?, ?, utc_now_text())
      ON CONFLICT(workspace_id, question_id) DO UPDATE SET
        answer=excluded.answer, answered_by=excluded.answered_by, answered_at=utc_now_text()`);
    const tx = db.transaction(async () => {
      for (const q of flat) {
        await insert.run(req.workspace.id, q.id, readAnswer(req.body, q), req.user.id);
      }
      for (const [id, rawValue] of Object.entries(req.body)) {
        const number = INTAKE.crownJewelNumber(id);
        if (!number || number <= 3) continue;
        const value = String(rawValue || '').trim();
        if (value) await insert.run(req.workspace.id, id, value, req.user.id);
        else await db.prepare(`DELETE FROM engagement_intake WHERE workspace_id=? AND question_id=?`).run(req.workspace.id, id);
      }
    });
    await tx();
    const applied = await applyIntakeToClient(req.workspace.id, req.user.id);
    await logAction(req.user.id, req.workspace.id, 'intake_save_apply', 'intake', null, null, auditCtx(req));
    const changedAssets = applied.assetSync.created + applied.assetSync.updated + applied.assetSync.reused;
    const message = changedAssets
      ? `Saved. Scope updated and ${changedAssets} crown-jewel asset${changedAssets === 1 ? '' : 's'} synchronised.`
      : 'Saved. Scope statement and linked assets are up to date.';
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, message));
  });

  app.post('/workspaces/:wsId/intake/field', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const id = (req.body.question_id || '').trim();
    const value = (req.body.answer || '').trim();
    const known = INTAKE.flatten().some(q => q.id === id) || !!INTAKE.crownJewelNumber(id);
    if (!known) return res.status(400).json({ ok: false, error: 'unknown question_id' });
    await db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
      VALUES (?, ?, ?, ?, utc_now_text())
      ON CONFLICT(workspace_id, question_id) DO UPDATE SET
        answer=excluded.answer, answered_by=excluded.answered_by, answered_at=utc_now_text()`)
      .run(req.workspace.id, id, value, req.user.id);
    let asset = null;
    if (INTAKE.crownJewelNumber(id)) {
      asset = value
        ? await syncCrownJewelAsset(req.workspace.id, id, value)
        : await detachCrownJewelAsset(req.workspace.id, id);
      if (['created', 'updated', 'reused'].includes(asset.status)) {
        await logAction(req.user.id, req.workspace.id, 'sync_intake_asset', 'asset', asset.assetId,
          { question_id: id, status: asset.status }, auditCtx(req));
      }
    }
    res.json({ ok: true, savedAt: new Date().toISOString(), asset });
  });

  app.post('/workspaces/:wsId/intake/apply', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await applyIntakeToClient(req.workspace.id, req.user.id);
    await logAction(req.user.id, req.workspace.id, 'intake_apply', 'intake', null, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Scope statement applied to client.'));
  });

  app.post('/workspaces/:wsId/scope/confirm', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    await applyIntakeToClient(req.workspace.id, req.user.id);
    await db.prepare(`UPDATE workspaces SET scope_confirmed_at=utc_now_text(), scope_confirmed_by=? WHERE id=?`)
      .run(req.user.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'confirm_scope', 'workspace', req.workspace.id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/team`,
      'Scope confirmed. Now assign the firm consultants and invite the client-side accounts who will work on this engagement.'));
  });

  app.post('/workspaces/:wsId/scope/unconfirm', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    await db.prepare(`UPDATE workspaces SET scope_confirmed_at=NULL, scope_confirmed_by=NULL WHERE id=?`)
      .run(req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'unconfirm_scope', 'workspace', req.workspace.id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Scope un-confirmed. Edit the answers and re-confirm when ready.'));
  });

  const planUrl = wsId => `/workspaces/${wsId}/engagement-plan`;
  const planUser = async (ws, id) => !id || (await db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.active=1 AND
    ((u.firm_id=? AND u.user_type='firm') OR u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id=?))`).get(id, ws.firm_id, ws.id));
  const clientPresentation = req => {
    const visible = !!req.body.client_visible;
    const clientTitle = String(req.body.client_title || '').trim();
    const clientDescription = String(req.body.client_description || '').trim();
    const frameworkCode = String(req.body.framework_code || 'iso27001').trim().toLowerCase();
    const requirementRefs = String(req.body.requirement_refs || '').trim();
    const enabled = new Set(outcomeScope.frameworkCodes(req.workspace));
    if (visible && !clientTitle) throw new Error('A client-facing title is required for a client-visible deliverable.');
    if (visible && !clientDescription) throw new Error('Client instructions are required for a client-visible deliverable.');
    if (!enabled.has(frameworkCode)) throw new Error('Choose a framework enabled for this engagement.');
    return { visible, clientTitle: clientTitle || null, clientDescription: clientDescription || null, frameworkCode, requirementRefs: requirementRefs || null };
  };
  const runPlanAction = async (req, res, action, success) => {
    try {
      await action();
      return res.redirect(withToast(planUrl(req.workspace.id), success || 'Delivery plan updated.'));
    } catch (error) {
      return res.redirect(withToast(planUrl(req.workspace.id), error.message || 'Could not update the delivery plan.', 'error'));
    }
  };
  const requireIso27001Plan = (req, res, next) => {
    const frameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    if (frameworks.includes('iso27001')) return next();
    return res.status(409).render('error', {
      user: req.user,
      ws: req.workspace,
      message: 'An ISO 27001 engagement plan is not enabled for this client.'
    });
  };
  app.use('/workspaces/:wsId/engagement-plan', requireAuth, requireWorkspace, requireIso27001Plan);
  const contractedProjection = async req => await delivery.getProjection(db, req.workspace, req.user.id);
  const requireContractedRow = async (req, type, id) => {
    const projection = await contractedProjection(req);
    const rows = type === 'phase' ? projection.phases
      : type === 'milestone' ? projection.milestones
        : type === 'deliverable' ? projection.deliverables
          : type === 'dependency' ? projection.dependencies : [];
    const row = rows.find(item => Number(item.id) === Number(id));
    if (!row) throw new Error(`That ${type} is outside the contracted ${projection.outcome.label} journey.`);
    return { projection, row };
  };

  app.get('/workspaces/:wsId/engagement-plan', requireAuth, requireWorkspace, async (req, res) => {
    const projection = await delivery.getProjection(db, req.workspace, req.user.id);
    const view = ['plan','timeline','gates'].includes(req.query.view) ? req.query.view : 'plan';
    const users = await db.prepare(`SELECT id,name FROM users WHERE active=1 AND (
      (firm_id=? AND user_type='firm') OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id=?)) ORDER BY name`)
      .all(req.workspace.firm_id, req.workspace.id);
    const baselines = await db.prepare(`SELECT b.id,b.version_number,b.label,b.reason,b.approved_at,u.name approved_by_name
      FROM engagement_delivery_baselines b LEFT JOIN users u ON u.id=b.approved_by WHERE b.plan_id=? ORDER BY b.version_number DESC`).all(projection.plan.id);
    const events = await db.prepare(`SELECT e.*,u.name actor_name FROM engagement_delivery_events e LEFT JOIN users u ON u.id=e.actor_id
      WHERE e.plan_id=? ORDER BY e.id DESC LIMIT 25`).all(projection.plan.id);
    const evidence = await db.prepare(`SELECT de.deliverable_id,e.id,e.filename,e.sha256,e.uploaded_at,u.name uploaded_by_name
      FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id LEFT JOIN users u ON u.id=e.uploaded_by
      WHERE de.workspace_id=? ORDER BY de.id DESC`).all(req.workspace.id);
    const comments = (await db.prepare(`SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.workspace_id=? AND c.parent_type='engagement_deliverable' ORDER BY c.id`).all(req.workspace.id))
      .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
    const evidenceCatalog = await db.prepare(`SELECT id,filename,description,uploaded_at FROM evidence WHERE workspace_id=? AND superseded_at IS NULL ORDER BY uploaded_at DESC,id DESC LIMIT 100`).all(req.workspace.id);
    const workQueue = {
      mine: projection.deliverables.filter(d => d.owner_id === req.user.id && !['accepted','superseded'].includes(d.status)).length,
      approvals: projection.deliverables.filter(d => d.approver_id === req.user.id && ['submitted','workspace_verified'].includes(d.effective_status)).length,
      overdue: projection.deliverables.filter(d => d.due_date && d.due_date < new Date().toISOString().slice(0,10) && !['accepted','superseded'].includes(d.status)).length,
      unassigned: projection.phases.filter(p => !p.owner_id).length
        + projection.milestones.filter(m => !m.owner_id).length
        + projection.deliverables.filter(d => !d.owner_id).length
        + projection.deliverables.filter(d => !d.approver_id).length
    };
    res.render('engagement_plan', {
      user: req.user, ws: req.workspace, ...projection, users, baselines, events, evidence, evidenceCatalog, comments, workQueue, view
    });
  });

  app.post('/workspaces/:wsId/engagement-plan/settings', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      if (req.body.status === 'completed') {
        const projection = await delivery.getProjection(db, req.workspace, req.user.id);
        if (!projection.summary.completionReady || projection.summary.openBlockers) {
          const requirements = projection.summary.completionBlockers || [];
          throw new Error(requirements.length
            ? `The engagement cannot be completed yet. ${requirements.join(' ')}`
            : 'The engagement cannot be completed until every contracted completion condition is satisfied.');
        }
      }
      const result = await db.prepare(`UPDATE engagement_delivery_plans SET name=?,objective=?,status=?,target_start_date=?,
        target_completion_date=?,forecast_completion_date=?,completion_criteria=?,updated_at=utc_now_text()
        WHERE id=? AND workspace_id=? AND updated_at=?`).run(
          String(req.body.name || '').trim() || 'ISO 27001 delivery plan', req.body.objective || null,
          req.body.status || 'active', req.body.target_start_date || null, req.body.target_completion_date || null,
          req.body.forecast_completion_date || null, req.body.completion_criteria || null,
          plan.id, req.workspace.id, req.body.updated_at_snapshot);
      if (!result.changes) throw new Error('The plan changed in another session. Reload and apply your update again.');
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'plan', plan.id, 'updated', null, req.body.status || 'active', null);
      await logAction(req.user.id, req.workspace.id, 'update_delivery_plan', 'engagement_plan', plan.id, null, auditCtx(req));
    }, 'Plan settings updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/baselines', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const id = await delivery.createBaseline(db, req.workspace, req.user.id, req.body.label, req.body.reason);
      await logAction(req.user.id, req.workspace.id, 'approve_delivery_baseline', 'engagement_baseline', id, { reason: req.body.reason }, auditCtx(req));
    }, 'A new approved baseline was frozen.');
  });

  app.post('/workspaces/:wsId/engagement-plan/phases/:phaseId', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      await requireContractedRow(req, 'phase', req.params.phaseId);
      const result = await db.prepare(`UPDATE engagement_delivery_phases SET owner_id=?,planned_start_date=?,planned_end_date=?,forecast_end_date=?,updated_at=utc_now_text()
        WHERE id=? AND plan_id=?`).run(req.body.owner_id || null, req.body.planned_start_date || null,
          req.body.planned_end_date || null, req.body.forecast_end_date || null, req.params.phaseId, plan.id);
      if (!result.changes) throw new Error('Phase not found.');
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'phase', req.params.phaseId, 'schedule_updated', null, null, req.body);
      await logAction(req.user.id, req.workspace.id, 'update_delivery_phase', 'engagement_phase', req.params.phaseId, null, auditCtx(req));
    }, 'Phase schedule updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/phases/:phaseId/gate', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const id = await delivery.decideGate(db, req.workspace, req.user.id, req.params.phaseId, req.body.decision, req.body.note, req.body.waiver_expires_at);
      await logAction(req.user.id, req.workspace.id, 'decide_delivery_gate', 'engagement_phase', req.params.phaseId,
        { decision_id: id, decision: req.body.decision, note: req.body.note }, auditCtx(req));
    }, req.body.decision === 'reopened' ? 'Phase gate reopened.' : 'Phase-gate decision recorded.');
  });

  app.post('/workspaces/:wsId/engagement-plan/milestones', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      const phase = (await requireContractedRow(req, 'phase', req.body.phase_id)).row;
      if (!phase || !String(req.body.title || '').trim()) throw new Error('A valid phase and milestone title are required.');
      const minimumDurationMonths = Number(req.body.minimum_duration_months || 0);
      if (!Number.isInteger(minimumDurationMonths) || minimumDurationMonths < 0 || minimumDurationMonths > 36) {
        throw new Error('Minimum duration must be a whole number from 0 to 36 months.');
      }
      const key = `custom-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
      const id = (await db.prepare(`INSERT INTO engagement_delivery_milestones
        (plan_id,phase_id,milestone_key,title,description,acceptance_criteria,priority,is_required,completion_mode,owner_id,planned_start_date,planned_end_date,forecast_end_date,minimum_duration_months)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(plan.id, phase.id, key, req.body.title.trim(), req.body.description || null,
          req.body.acceptance_criteria || null, req.body.priority || 'normal', req.body.is_required ? 1 : 0,
          req.body.completion_mode || 'deliverable', req.body.owner_id || null, req.body.planned_start_date || null,
          req.body.planned_end_date || null, req.body.forecast_end_date || req.body.planned_end_date || null,
          minimumDurationMonths)).lastInsertRowid;
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'milestone', id, 'created', null, 'not_started', { title: req.body.title });
      await logAction(req.user.id, req.workspace.id, 'create_delivery_milestone', 'engagement_milestone', id, { title: req.body.title }, auditCtx(req));
      await delivery.recalculateSchedule(db, req.workspace, req.user.id, 'milestone_created');
    }, 'Milestone added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/milestones/:milestoneId', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      const scoped = (await requireContractedRow(req, 'milestone', req.params.milestoneId)).row;
      if (scoped.governed) throw new Error('Governed gap-assessment milestones are updated from their source records, not edited here.');
      const minimumDurationMonths = Number(req.body.minimum_duration_months || 0);
      if (!Number.isInteger(minimumDurationMonths) || minimumDurationMonths < 0 || minimumDurationMonths > 36) {
        throw new Error('Minimum duration must be a whole number from 0 to 36 months.');
      }
      const result = await db.prepare(`UPDATE engagement_delivery_milestones SET title=?,description=?,acceptance_criteria=?,priority=?,is_required=?,owner_id=?,planned_start_date=?,planned_end_date=?,forecast_end_date=?,minimum_duration_months=?,updated_at=utc_now_text(),row_version=row_version+1
        WHERE id=? AND plan_id=? AND row_version=?`).run(req.body.title, req.body.description || null, req.body.acceptance_criteria || null,
          req.body.priority || 'normal', req.body.is_required ? 1 : 0, req.body.owner_id || null,
          req.body.planned_start_date || null, req.body.planned_end_date || null, req.body.forecast_end_date || null,
          minimumDurationMonths, req.params.milestoneId, plan.id, req.body.row_version);
      if (!result.changes) throw new Error('This milestone changed in another session. Reload before saving.');
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'milestone', req.params.milestoneId, 'updated', null, null, null);
      await logAction(req.user.id, req.workspace.id, 'update_delivery_milestone', 'engagement_milestone', req.params.milestoneId, null, auditCtx(req));
      await delivery.recalculateSchedule(db, req.workspace, req.user.id, 'milestone_updated');
    }, 'Milestone updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      const milestone = (await requireContractedRow(req, 'milestone', req.body.milestone_id)).row;
      if (milestone.governed) throw new Error('Governed gap-assessment milestones use the controlled fieldwork and report records; add work in that workflow instead.');
      if (!milestone || !String(req.body.title || '').trim()) throw new Error('A milestone and deliverable title are required.');
      if (!(await planUser(req.workspace, req.body.owner_id)) || !(await planUser(req.workspace, req.body.approver_id))) throw new Error('Owner and approver must belong to this engagement.');
      const presentation = clientPresentation(req);
      const id = (await db.prepare(`INSERT INTO engagement_delivery_deliverables
        (workspace_id,plan_id,milestone_id,title,description,acceptance_criteria,client_title,client_description,framework_code,requirement_refs,
         is_required,owner_id,approver_id,due_date,linked_record_type,linked_record_id,client_visible,requires_evidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.workspace.id, plan.id, milestone.id, req.body.title.trim(), req.body.description || null,
          req.body.acceptance_criteria || null, presentation.clientTitle, presentation.clientDescription, presentation.frameworkCode, presentation.requirementRefs,
          req.body.is_required ? 1 : 0, req.body.owner_id || null,
          req.body.approver_id || null, req.body.due_date || null, req.body.linked_record_type || null,
          req.body.linked_record_id || null, presentation.visible ? 1 : 0, req.body.requires_evidence ? 1 : 0)).lastInsertRowid;
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'deliverable', id, 'created', null, 'draft', { title: req.body.title });
      await logAction(req.user.id, req.workspace.id, 'create_delivery_deliverable', 'engagement_deliverable', id, { title: req.body.title }, auditCtx(req));
    }, 'Deliverable added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      await requireContractedRow(req, 'deliverable', req.params.deliverableId);
      if (!(await planUser(req.workspace, req.body.owner_id)) || !(await planUser(req.workspace, req.body.approver_id))) throw new Error('Owner and approver must belong to this engagement.');
      const presentation = clientPresentation(req);
      const result = await db.prepare(`UPDATE engagement_delivery_deliverables SET title=?,description=?,acceptance_criteria=?,client_title=?,client_description=?,
        framework_code=?,requirement_refs=?,is_required=?,owner_id=?,approver_id=?,due_date=?,client_visible=?,requires_evidence=?,updated_at=utc_now_text(),row_version=row_version+1
        WHERE id=? AND plan_id=? AND workspace_id=? AND row_version=?`).run(
        String(req.body.title || '').trim(), req.body.description || null, req.body.acceptance_criteria || null,
        presentation.clientTitle, presentation.clientDescription, presentation.frameworkCode, presentation.requirementRefs,
        req.body.is_required ? 1 : 0, req.body.owner_id || null, req.body.approver_id || null,
        req.body.due_date || null, presentation.visible ? 1 : 0, req.body.requires_evidence ? 1 : 0,
        req.params.deliverableId, plan.id, req.workspace.id, req.body.row_version);
      if (!result.changes) throw new Error('This deliverable changed in another session. Reload before saving.');
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'deliverable', req.params.deliverableId, 'updated', null, null, null);
      await logAction(req.user.id, req.workspace.id, 'update_delivery_deliverable', 'engagement_deliverable', req.params.deliverableId, null, auditCtx(req));
    }, 'Deliverable updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/submit', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      await requireContractedRow(req, 'deliverable', req.params.deliverableId);
      await delivery.transitionDeliverable(db, req.workspace, req.user.id, Number(req.params.deliverableId), 'submit', req.body.note);
      await logAction(req.user.id, req.workspace.id, 'submit_delivery_deliverable', 'engagement_deliverable', req.params.deliverableId, null, auditCtx(req));
    }, 'Deliverable submitted for sign-off.');
  });

  ['accept','changes','reject'].forEach(action => {
    app.post(`/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/${action}`, requireAuth, requireWorkspace, requirePermission('document.approve'), async (req, res) => {
      await runPlanAction(req, res, async () => {
        await requireContractedRow(req, 'deliverable', req.params.deliverableId);
        await delivery.transitionDeliverable(db, req.workspace, req.user.id, Number(req.params.deliverableId), action, req.body.note);
        await logAction(req.user.id, req.workspace.id, `${action}_delivery_deliverable`, 'engagement_deliverable', req.params.deliverableId, { note: req.body.note }, auditCtx(req));
      }, action === 'accept' ? 'Deliverable accepted and milestone progress reconciled.' : 'Deliverable decision recorded.');
    });
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/revise', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      await requireContractedRow(req, 'deliverable', req.params.deliverableId);
      await delivery.reviseDeliverable(db, req.workspace, req.user.id, Number(req.params.deliverableId), req.body.note);
      await logAction(req.user.id, req.workspace.id, 'revise_delivery_deliverable', 'engagement_deliverable', req.params.deliverableId, { note: req.body.note }, auditCtx(req));
    }, 'A new deliverable revision is open.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/comments', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      await requireContractedRow(req, 'deliverable', req.params.deliverableId);
      const row = await db.prepare(`SELECT d.id,d.plan_id FROM engagement_delivery_deliverables d WHERE d.id=? AND d.workspace_id=?`).get(req.params.deliverableId, req.workspace.id);
      const body = String(req.body.body || '').trim();
      if (!row || !body || body.length > 8000) throw new Error('A comment under 8,000 characters is required.');
      const encrypted = enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled);
      await db.prepare(`INSERT INTO comments (workspace_id,parent_type,parent_id,user_id,body,internal_only) VALUES (?,'engagement_deliverable',?,?,?,?)`)
        .run(req.workspace.id, String(row.id), req.user.id, encrypted, req.body.internal_only && req.user.user_type === 'firm' ? 1 : 0);
      await delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'commented', null, null, { internal: !!req.body.internal_only });
      await logAction(req.user.id, req.workspace.id, 'comment_delivery_deliverable', 'engagement_deliverable', row.id, { internal: !!req.body.internal_only }, auditCtx(req));
    }, 'Comment added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/evidence', requireAuth, requireWorkspace,
    requireInternalEvidenceMutation, requirePermission('evidence.upload'), upload.single('file'), async (req, res) => {
      const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_) {} };
      try {
        await requireContractedRow(req, 'deliverable', req.params.deliverableId);
        const row = await db.prepare(`SELECT d.id,d.plan_id,d.title FROM engagement_delivery_deliverables d WHERE d.id=? AND d.workspace_id=?`).get(req.params.deliverableId, req.workspace.id);
        if (!row || !req.file) throw new Error(!row ? 'Deliverable not found.' : 'Choose a file to upload.');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
        let evidenceId;
        let deduped = false;
        await db.transaction(async () => {
          const existing = await db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
          if (existing) { evidenceId = existing.id; deduped = true; cleanup(); }
          else evidenceId = (await db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,tags) VALUES (?,?,?,?,?,?,?,?)`)
            .run(req.workspace.id, req.file.originalname, req.file.filename, sha, req.file.size, req.user.id,
              String(req.body.description || '').trim() || row.title, `engagement-plan, deliverable-${row.id}`)).lastInsertRowid;
          await db.prepare(`INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`)
            .run(req.workspace.id, row.id, evidenceId, req.user.id);
          await delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'evidence_linked', null, null, { evidenceId, sha, deduped });
        })();
        await logAction(req.user.id, req.workspace.id, deduped ? 'link_existing_delivery_evidence' : 'upload_delivery_evidence', 'engagement_deliverable', row.id, { evidence_id: evidenceId, sha256: sha }, auditCtx(req));
        return res.redirect(withToast(planUrl(req.workspace.id), deduped ? 'Existing evidence linked.' : 'Evidence uploaded and linked.'));
      } catch (error) {
        cleanup();
        return res.redirect(withToast(planUrl(req.workspace.id), error.message || 'Could not upload evidence.', 'error'));
      }
    });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/evidence/link', requireAuth, requireWorkspace,
    requireInternalEvidenceMutation, requirePermission('evidence.upload'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      await requireContractedRow(req, 'deliverable', req.params.deliverableId);
      const row = await db.prepare(`SELECT id,plan_id FROM engagement_delivery_deliverables WHERE id=? AND workspace_id=?`).get(req.params.deliverableId, req.workspace.id);
      const evidenceRow = await db.prepare(`SELECT id,sha256 FROM evidence WHERE id=? AND workspace_id=? AND superseded_at IS NULL`).get(req.body.evidence_id, req.workspace.id);
      if (!row || !evidenceRow) throw new Error('Choose an evidence record from this workspace.');
      await db.prepare(`INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`).run(req.workspace.id,row.id,evidenceRow.id,req.user.id);
      await delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'existing_evidence_linked', null, null, { evidenceId: evidenceRow.id, sha: evidenceRow.sha256 });
      await logAction(req.user.id, req.workspace.id, 'link_existing_delivery_evidence', 'engagement_deliverable', row.id, { evidence_id: evidenceRow.id }, auditCtx(req));
    }, 'Existing evidence linked.');
  });

  app.get('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/evidence/:evidenceId/download', requireAuth, requireWorkspace,
    requirePermission('evidence.download'), async (req, res) => {
    try { await requireContractedRow(req, 'deliverable', req.params.deliverableId); }
    catch (_) { return res.status(404).send('Evidence not found'); }
    const row = await db.prepare(`SELECT e.* FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
      WHERE de.deliverable_id=? AND de.evidence_id=? AND de.workspace_id=? AND e.workspace_id=?`).get(req.params.deliverableId, req.params.evidenceId, req.workspace.id, req.workspace.id);
    if (!row) return res.status(404).send('Evidence not found');
    const filePath = resolveUploadPath(row.stored_path, req.workspace.firm_id);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Evidence file missing');
    await logAction(req.user.id, req.workspace.id, 'download_delivery_evidence', 'evidence', row.id, { deliverable_id: req.params.deliverableId }, auditCtx(req));
    res.download(filePath, row.filename);
  });

  app.post('/workspaces/:wsId/engagement-plan/dependencies', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const id = await delivery.addDependency(db, req.workspace, req.user.id, Number(req.body.predecessor_id), Number(req.body.successor_id), req.body.dependency_type, req.body.lag_days);
      await logAction(req.user.id, req.workspace.id, 'create_delivery_dependency', 'engagement_dependency', id, null, auditCtx(req));
      await delivery.recalculateSchedule(db, req.workspace, req.user.id, 'dependency_created');
    }, 'Dependency added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/dependencies/:dependencyId/delete', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const plan = await delivery.ensurePlan(db, req.workspace, req.user.id);
      await requireContractedRow(req, 'dependency', req.params.dependencyId);
      const result = await db.prepare('DELETE FROM engagement_delivery_dependencies WHERE id=? AND plan_id=?').run(req.params.dependencyId, plan.id);
      if (!result.changes) throw new Error('Dependency not found.');
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'dependency', req.params.dependencyId, 'deleted', 'active', null, null);
      await logAction(req.user.id, req.workspace.id, 'delete_delivery_dependency', 'engagement_dependency', req.params.dependencyId, null, auditCtx(req));
    }, 'Dependency removed.');
  });

  app.post('/workspaces/:wsId/engagement-plan/recalculate', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const result = await delivery.recalculateSchedule(db, req.workspace, req.user.id, 'manual');
      await logAction(req.user.id, req.workspace.id, 'recalculate_delivery_schedule', 'engagement_plan', null, result, auditCtx(req));
    }, 'Dependencies applied and the forecast recalculated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/fit-target', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const result = await delivery.fitScheduleToTarget(db, req.workspace, req.user.id);
      await logAction(req.user.id, req.workspace.id, 'fit_delivery_schedule_to_target', 'engagement_plan', null, result, auditCtx(req));
    }, 'Initial milestone durations fitted to the target window.');
  });

  app.post('/workspaces/:wsId/engagement-plan/bulk-assign', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const projection = await contractedProjection(req);
      const plan = projection.plan;
      const ownerId = req.body.owner_id || null;
      const deliverableOwnerId = req.body.deliverable_owner_id || null;
      const approverId = req.body.approver_id || null;
      if (!(await planUser(req.workspace, ownerId)) || !(await planUser(req.workspace, deliverableOwnerId)) || !(await planUser(req.workspace, approverId))) throw new Error('Owners and approver must belong to this engagement.');
      const onlyUnassigned = req.body.only_unassigned ? 1 : 0;
      const phaseIds = projection.phases.map(row => row.id);
      const milestoneIds = projection.milestones.map(row => row.id);
      const deliverableIds = projection.deliverables.map(row => row.id);
      const scopedUpdate = async (table, setSql, value, ids, unassignedColumn, versioned = false) => {
        if (!value || !ids.length) return 0;
        const placeholders = ids.map(() => '?').join(',');
        return (await db.prepare(`UPDATE ${table} SET ${setSql},updated_at=utc_now_text()${versioned ? ',row_version=row_version+1' : ''}
          WHERE plan_id=? AND id IN (${placeholders}) ${onlyUnassigned ? `AND ${unassignedColumn} IS NULL` : ''}`)
          .run(value, plan.id, ...ids)).changes;
      };
      const phases = await scopedUpdate('engagement_delivery_phases', 'owner_id=?', ownerId, phaseIds, 'owner_id');
      const milestones = await scopedUpdate('engagement_delivery_milestones', 'owner_id=?', ownerId, milestoneIds, 'owner_id', true);
      const deliverableOwners = await scopedUpdate('engagement_delivery_deliverables', 'owner_id=?', deliverableOwnerId, deliverableIds, 'owner_id', true);
      const deliverableApprovers = await scopedUpdate('engagement_delivery_deliverables', 'approver_id=?', approverId, deliverableIds, 'approver_id', true);
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'plan', plan.id, 'bulk_assigned', null, null, { phases, milestones, deliverableOwners, deliverableApprovers, ownerId, deliverableOwnerId, approverId, onlyUnassigned: !!onlyUnassigned });
      await logAction(req.user.id, req.workspace.id, 'bulk_assign_delivery_plan', 'engagement_plan', plan.id, { phases, milestones, deliverable_owners: deliverableOwners, deliverable_approvers: deliverableApprovers, owner_id: ownerId, deliverable_owner_id: deliverableOwnerId, approver_id: approverId }, auditCtx(req));
    }, 'Plan assignments updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/create-tasks', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    await runPlanAction(req, res, async () => {
      const projection = await contractedProjection(req);
      const plan = projection.plan;
      const hasOpenTask = db.prepare(`SELECT 1 FROM tasks WHERE workspace_id=? AND engagement_milestone_id=?
        AND status NOT IN ('done','closed','cancelled') LIMIT 1`);
      const milestones = await filterAsync(projection.milestones, async m => !m.governed
        && !['complete','waived'].includes(m.effective_status)
        && !(await hasOpenTask.get(req.workspace.id, m.id)));
      const insert = db.prepare(`INSERT INTO tasks (workspace_id,title,description,assignee_id,due_date,status,created_by,priority,engagement_milestone_id)
        VALUES (?,?,?,?,?,'todo',?,?,?)`);
      const tx = db.transaction(async () => {
        for (const m of milestones) {
          await insert.run(req.workspace.id, m.title,
            m.acceptance_criteria || m.description || 'Complete the plan milestone and retain accepted deliverables.',
            m.owner_id || null, m.forecast_end_date || m.planned_end_date || null, req.user.id, m.priority || 'normal', m.id);
        }
      });
      await tx();
      await delivery.event(db, req.workspace.id, plan.id, req.user.id, 'plan', plan.id, 'tasks_created', null, null, { count: milestones.length });
      await logAction(req.user.id, req.workspace.id, 'create_delivery_plan_tasks', 'engagement_plan', plan.id, { count: milestones.length }, auditCtx(req));
    }, 'Missing milestone tasks created and linked.');
  });

  app.get('/workspaces/:wsId/engagement-plan/export.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'),
    requirePermission('task.manage'), requirePermission('members.view'),
    requirePermission('evidence.view'), requirePermission('evidence.export'), async (req, res) => {
    const projection = await delivery.getProjection(db, req.workspace, req.user.id);
    const esc = value => value == null ? '' : `"${String(value).replace(/"/g, '""')}"`;
    const lines = ['Phase,Milestone,Milestone status,Owner,Priority,Planned start,Planned finish,Forecast finish,Baseline finish,Variance days,Critical path,Deliverable,Deliverable status,Approver,Due,Evidence files,Client visible'];
    projection.phases.forEach(phase => phase.milestones.forEach(m => m.deliverables.forEach(d => lines.push([
      phase.name,m.title,m.effective_status,m.owner_name,m.priority,m.planned_start_date,m.planned_end_date,m.forecast_end_date,
      m.baseline_end_date,m.baseline_variance_days,m.critical_path ? 'Yes' : 'No',d.title,d.effective_status,d.approver_name,d.due_date,d.evidence_count,d.client_visible ? 'Yes' : 'No'
    ].map(esc).join(',')))));
    await logAction(req.user.id, req.workspace.id, 'export_delivery_plan_csv', 'engagement_plan', projection.plan.id, null, auditCtx(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="engagement-plan-${req.workspace.client_name.replace(/[^\w-]+/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });

  app.get('/workspaces/:wsId/engagement-plan/report.pdf', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'),
    requirePermission('task.manage'), requirePermission('members.view'),
    requirePermission('evidence.view'), requirePermission('evidence.export'), async (req, res) => {
    try {
      const projection = await delivery.getProjection(db, req.workspace, req.user.id);
      const h = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const rows = projection.phases.map((phase, index) => `<section><h2>${index + 1}. ${h(phase.name)} <small>${h(phase.effective_status.replaceAll('_',' '))}</small></h2><p>${h(phase.description)}</p><table><thead><tr><th>Milestone</th><th>Owner</th><th>Status</th><th>Forecast</th><th>Acceptance</th></tr></thead><tbody>${phase.milestones.map(m => `<tr><td>${h(m.title)}${m.critical_path ? '<br><em>Critical path</em>' : ''}</td><td>${h(m.owner_name || 'Unassigned')}</td><td>${h(m.effective_status.replaceAll('_',' '))}</td><td>${h(m.forecast_end_date || m.planned_end_date || 'Unscheduled')}</td><td>${h(m.deliverables.map(d => `${d.title}: ${d.status}`).join('; '))}</td></tr>`).join('')}</tbody></table></section>`).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:11px Arial;color:#17252b}h1{font-size:26px}h2{font-size:16px;margin:22px 0 3px;border-bottom:1px solid #ccd5d8;padding-bottom:5px}small{float:right;text-transform:uppercase;color:#667}p{color:#58666b}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #d9e0e2;padding:6px;text-align:left;vertical-align:top}th{background:#eef2f3;font-size:9px;text-transform:uppercase}em{font-size:9px;color:#9a3412}.kpis{display:flex;gap:24px;padding:12px;background:#eef2f3}.kpis strong{font-size:18px;display:block}</style></head><body><h1>${h(projection.plan.name)}</h1><p>${h(req.workspace.brand_display_name || req.workspace.client_name)} · Generated ${new Date().toISOString().slice(0,10)} · Confidential</p><div class="kpis"><div><strong>${projection.summary.progressPct}%</strong>progress</div><div><strong>${projection.summary.phaseGatesPassed}/${projection.summary.phaseGatesTotal}</strong>gates</div><div><strong>${projection.summary.acceptedDeliverables}/${projection.summary.requiredDeliverables}</strong>accepted</div><div><strong>${projection.summary.varianceDays == null ? '-' : projection.summary.varianceDays + 'd'}</strong>variance</div></div>${rows}</body></html>`;
      const raw = await auditPack.renderPDF(html, { headerLeft: req.workspace.client_name, headerRight: 'Engagement delivery plan', footerLeft: 'Confidential · Controlled delivery record' });
      const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      await logAction(req.user.id, req.workspace.id, 'export_delivery_plan_pdf', 'engagement_plan', projection.plan.id, { bytes: pdf.length }, auditCtx(req));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="engagement-plan-${req.workspace.client_name.replace(/[^\w-]+/g,'_')}.pdf"`);
      res.send(pdf);
    } catch (error) {
      res.status(500).render('error', { user: req.user, ws: req.workspace, message: 'Could not generate the delivery report: ' + error.message });
    }
  });
}

module.exports = { register };
