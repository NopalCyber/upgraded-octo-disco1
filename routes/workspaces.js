'use strict';

const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rbac = require('../lib/rbac');
const ctlReads = require('../lib/control-reads');
const email = require('../lib/email');
const { hashToken, INVITE_TTL_MS } = require('./auth');
const { ALLOWED_FRAMEWORKS } = require('../lib/frameworks');
const { clientSetup, needsSetup } = require('../lib/client-setup');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');
const { buildWorkspaceTruth } = require('../lib/grc-truth');
const { deleteWorkspace, workspaceStoredPaths } = require('../lib/workspace-deletion');
const engagementDelivery = require('../lib/engagement-delivery');
const isoLifecycle = require('../lib/iso-lifecycle');
const outcomeScope = require('../lib/engagement-outcome-scope');
const gapFieldwork = require('../lib/gap-fieldwork');
const { buildGapAssessmentOverview } = require('../lib/workspace-outcome-overview');
const tprmDomain = require('../lib/tprm-domain');
const { confirmationMatchesRenderedName } = require('../lib/typography');

function submittedFrameworks(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return [...new Set(values.filter(code => ALLOWED_FRAMEWORKS.includes(code)))];
}

const NO_PROGRAMME = 'Choose at least one programme for this client: ISO 27001 or the third-party risk service.';
const hasService = (ws) => Number(ws && ws.tprm_enabled || 0) === 1;

function firmUserCan(user, permission) {
  if (!user || user.user_type !== 'firm') return false;
  return rbac.rolePermissions(rbac.normalizeRole(user.firm_role) || 'consultant').includes(permission);
}

function renderNewWorkspace(res, user, form = {}, formError = null, status = 200) {
  return res.status(status).render('workspace_new', {
    user,
    ws: null,
    form,
    formError,
    outcomeOptions: isoLifecycle.OUTCOME_OPTIONS,
  });
}

async function hasIsoDeliveryHistory(db, workspaceId) {
  return !!(await db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=? LIMIT 1').get(workspaceId));
}

async function hasFullCertificationDeliveryHistory(db, workspaceId) {
  const fullPlan = await db.prepare(`SELECT 1 FROM engagement_delivery_plans p
    WHERE p.workspace_id=? AND (
      p.name='ISO 27001 certification support delivery plan'
      OR p.objective ILIKE '%Stage 1 and Stage 2%'
      OR p.completion_criteria ILIKE '%Stage 1%Stage 2%'
      OR EXISTS (
        SELECT 1 FROM engagement_delivery_events ev
        WHERE ev.plan_id=p.id AND ev.action='contract_outcome_expanded'
      )
    ) LIMIT 1`).get(workspaceId);
  return !!fullPlan;
}

async function syncCertificationDeadlineAnswer(db, workspace, targetDate, actorId) {
  const frameworks = isoLifecycle.isoFrameworkCodes(workspace);
  if (frameworks.includes('iso27001')) {
    if (!targetDate) await db.prepare("DELETE FROM engagement_intake WHERE workspace_id=? AND question_id='cert-deadline'").run(workspace.id);
    else await db.prepare(`INSERT INTO engagement_intake (workspace_id,question_id,answer,answered_by,answered_at)
      VALUES (?,'cert-deadline',?,?,utc_now_text())
      ON CONFLICT(workspace_id,question_id) DO UPDATE SET
        answer=excluded.answer,answered_by=excluded.answered_by,answered_at=utc_now_text()`)
      .run(workspace.id, targetDate, actorId);
  }
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          isFirmUser, computeReadiness, workspaceProgress, computeNextStep,
          computeRoadmap, computeClientStage, computeNeedsAttention, resolveUploadPath } = deps;

  app.get('/workspaces/new', requireAuth, (req, res) => {
    if (!firmUserCan(req.user, 'workspace.create')) return res.status(403).render('error', { user: req.user, message: 'You do not have permission to create client workspaces.' });
    return renderNewWorkspace(res, req.user);
  });

  app.post('/workspaces', requireAuth, async (req, res) => {
    if (!firmUserCan(req.user, 'workspace.create')) return res.status(403).send('Forbidden');
    const { client_name, industry, scope, target_cert_date, engagement_outcome } = req.body;
    if (!client_name) return res.redirect('/dashboard');
    const frameworks = submittedFrameworks(req.body.frameworks);
    const tprmRequested = String(req.body.tprm_enabled || '') === '1';
    const tprmServiceModel = String(req.body.tprm_service_model || '').trim();
    if (tprmRequested && !tprmDomain.OFFERED_SERVICE_MODELS.includes(tprmServiceModel)) {
      return renderNewWorkspace(res, req.user, req.body,
        'Choose how the Third-party risk service will be delivered.', 400);
    }
    if (!frameworks.length && !tprmRequested) {
      return renderNewWorkspace(res, req.user, req.body, NO_PROGRAMME, 400);
    }
    const hasIso = isoLifecycle.hasIsoManagementSystem(frameworks);
    if (hasIso && !isoLifecycle.isValidOutcome(engagement_outcome)) {
      return renderNewWorkspace(res, req.user, req.body,
        'Choose whether this engagement ends after the gap-assessment report or continues through certification support.', 400);
    }
    const outcome = hasIso
      ? isoLifecycle.normalizeOutcome(engagement_outcome)
      : 'certification_support';
    const storedTargetDate = !hasIso || isoLifecycle.isGapOnly(outcome) ? null : (target_cert_date || null);
    const id = await db.transaction(async () => {
      const workspaceId = Number((await db.prepare(`INSERT INTO workspaces
        (firm_id,client_name,industry,scope,target_cert_date,lead_consultant_id,frameworks,engagement_outcome)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(req.user.firm_id, client_name.trim(), industry || null,
          scope || null, storedTargetDate, req.user.id,
          JSON.stringify(frameworks), outcome)).lastInsertRowid);
      if (hasIso) await syncCertificationDeadlineAnswer(db, { id: workspaceId, frameworks }, storedTargetDate, req.user.id);
      if (hasIso) {
        const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
        workspace.frameworks = frameworks;
        await engagementDelivery.syncCertificationTarget(db, workspace, req.user.id);
      }
      if (tprmRequested) {
        await tprmDomain.enableModule(db, {
          workspaceId,
          serviceModel: tprmServiceModel,
          actorId: req.user.id,
          reason: 'Enabled during governed client onboarding.',
        });
      }
      return workspaceId;
    })();
    await logAction(req.user.id, id, 'create_workspace', 'workspace', id,
      {
        client_name,
        frameworks,
        engagement_outcome: hasIso ? outcome : null,
        tprm_enabled: tprmRequested,
        tprm_service_model: tprmRequested ? tprmServiceModel : null,
      });
    const enabled = [
      ...frameworks,
      ...(tprmRequested ? ['tprm'] : []),
    ];
    if (enabled.length === 1) {
      const direct = {
        iso27001: `/workspaces/${id}/intake`,
        tprm: `/workspaces/${id}/tprm`,
      }[enabled[0]];
      if (direct) return res.redirect(withToast(direct, 'Client created - start the scoping'));
    }
    res.redirect(withToast(`/workspaces/${id}/setup`, enabled.length
      ? `Client created - ${enabled.length} services to scope`
      : 'Client created - assign a programme to begin'));
  });

  app.get('/workspaces/:wsId/setup', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const tprmModule = await tprmDomain.moduleForWorkspace(db, ws.id);
    res.render('client_setup', {
      user: req.user,
      ws,
      active: 'setup',
      setup: await clientSetup(db, ws),
      canUpdateWorkspace: rbac.hasPermission(res.locals.userPerms || [], 'workspace.update'),
      isoContract: isoLifecycle.hasIsoManagementSystem(ws) ? { label: isoLifecycle.frameworkLabel(ws), outcome: isoLifecycle.normalizeOutcome(ws.engagement_outcome), options: isoLifecycle.OUTCOME_OPTIONS } : null,
      hasTprm: !!tprmModule,
      canEnableTprm: rbac.hasPermission(res.locals.userPerms || [], 'tprm.methodology.manage'),
    });
  });

  app.get('/workspaces/:wsId', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const frameworkCodes = Array.isArray(ws.frameworks) ? ws.frameworks : [];
    const tprmModule = await tprmDomain.moduleForWorkspace(db, ws.id);

    if (frameworkCodes.length === 0 && tprmModule && tprmModule.status === 'active') {
      return res.redirect(`/workspaces/${ws.id}/tprm`);
    }

    if (!req.query.skipSetupRedirect && (await needsSetup(db, ws))) {
      return res.redirect(`/workspaces/${ws.id}/setup`);
    }
    const intakeAnswered = (await db.prepare(`SELECT COUNT(*) AS c FROM engagement_intake
      WHERE workspace_id=? AND question_id<>'cert-deadline'
        AND answer IS NOT NULL AND length(trim(answer)) > 0`).get(ws.id)).c;
    const setupIncomplete = intakeAnswered > 0 && intakeAnswered < 8 && !ws.scope_confirmed_at;

    if (frameworkCodes.length === 0) {
      return res.render('workspace_unassigned', {
        user:req.user, ws, setupIncomplete, intakeAnswered,
        frameworkOptions:ALLOWED_FRAMEWORKS,
        outcomeOptions:isoLifecycle.OUTCOME_OPTIONS,
        canEnableTprm:rbac.hasPermission(res.locals.userPerms || [], 'tprm.methodology.manage'),
      });
    }

    const progress = await workspaceProgress(ws.id);

    const T = ctlReads.tables(db, ws.id);
    const STATUSES = ['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable','Not Assessed'];
    const stateRows = await db.prepare(`SELECT i.id, i.type, i.category, COALESCE(cs.status,'Not Assessed') AS status
                                  FROM iso_items i
                                  LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?`)
      .all(ws.id);

    const breakdown = { clauses: {}, annex: {} };
    STATUSES.forEach(s => { breakdown.clauses[s] = 0; breakdown.annex[s] = 0; });
    stateRows.forEach(r => {
      if (r.type === 'clause') breakdown.clauses[r.status]++;
      else breakdown.annex[r.status]++;
    });

    const themes = {
      requirements: { label: 'Requirements', total: 0, assessed: 0, implemented: 0 },
      org:          { label: 'A.5 Org',      total: 0, assessed: 0, implemented: 0 },
      people:       { label: 'A.6 People',   total: 0, assessed: 0, implemented: 0 },
      physical:     { label: 'A.7 Physical', total: 0, assessed: 0, implemented: 0 },
      tech:         { label: 'A.8 Tech',     total: 0, assessed: 0, implemented: 0 }
    };
    stateRows.forEach(r => {
      let key = null;
      if (r.type === 'clause') key = 'requirements';
      else if (themes[r.category]) key = r.category;
      if (!key) return;
      themes[key].total++;
      if (r.status !== 'Not Assessed') themes[key].assessed++;
      if (r.status === 'Implemented') themes[key].implemented++;
    });

    const riskCount = (await db.prepare('SELECT COUNT(*) AS c FROM risks WHERE workspace_id = ?').get(ws.id)).c;
    const openRisks = await db.prepare(`SELECT * FROM risks WHERE workspace_id = ? AND status = 'open'
                                  ORDER BY (likelihood * impact) DESC NULLS LAST LIMIT 5`).all(ws.id);
    const assetCount = (await db.prepare('SELECT COUNT(*) AS c FROM assets WHERE workspace_id = ?').get(ws.id)).c;
    const evidenceCount = (await db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE workspace_id = ?').get(ws.id)).c;
    const openTasks = await db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t
      LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.workspace_id = ? AND t.status NOT IN ('done') ORDER BY t.due_date ASC NULLS FIRST LIMIT 10`).all(ws.id);

    const actionItems = await db.prepare(`SELECT i.id, i.title, cs.status FROM iso_items i
      INNER JOIN ${T.cs} cs ON cs.iso_item_id = i.id
      WHERE cs.workspace_id = ? AND cs.status IN ('Not Implemented','Partially Implemented')
      ORDER BY i.sort_order NULLS FIRST LIMIT 20`).all(ws.id);

    const docCount = (await db.prepare('SELECT COUNT(*) AS c FROM generated_docs WHERE workspace_id = ?').get(ws.id)).c;
    const auditCount = (await db.prepare('SELECT COUNT(*) AS c FROM audits WHERE workspace_id = ?').get(ws.id)).c;
    const mrmCount = (await db.prepare('SELECT COUNT(*) AS c FROM mrms WHERE workspace_id = ?').get(ws.id)).c;
    const ncOpen = (await db.prepare(`SELECT COUNT(*) AS c FROM nonconformities
      WHERE workspace_id = ? AND status NOT IN ('closed','verified')`).get(ws.id)).c;
    const recentActivity = await db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
      INNER JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = ? ORDER BY a.created_at DESC NULLS LAST LIMIT 8`).all(ws.id);

    const readiness = await computeReadiness(ws);

    const sparkRows = await db.prepare(`SELECT utc_date_text(utc_ts(created_at)) AS d, COUNT(*) AS c
      FROM audit_log WHERE workspace_id = ? AND created_at >= utc_date_text(now() + ('-29 days')::interval)
      GROUP BY utc_date_text(utc_ts(created_at))`).all(ws.id);
    const sparkMap = Object.fromEntries(sparkRows.map(r => [r.d, r.c]));
    const sparkline = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      sparkline.push({ d: key, c: sparkMap[key] || 0 });
    }

    const roadmap = await computeRoadmap(ws, { stateRows, assetCount, riskCount, ncOpen });
    const needsAttention = (await computeNeedsAttention(ws.id)).slice(0, 8);
    const truth = await buildWorkspaceTruth(db, ws, readiness);
    const computedNextStep = await computeNextStep(ws);
    const nextStep = truth.nextAction ? {
      title: truth.nextAction.title,
      why: truth.nextAction.impact,
      href: truth.nextAction.href,
      cta: truth.nextAction.cta
    } : computedNextStep;
    const derivedStage = { key: truth.verdict.key, label: truth.verdict.label };
    let activePass = null;
    try {
      activePass = (await db.prepare(`SELECT id, pass_number, label, started_at, status
        FROM assessment_passes WHERE workspace_id=? AND status='in_progress'
        ORDER BY pass_number DESC LIMIT 1`).get(ws.id)) || null;
    } catch (_) {}

    const engagementOutcome = isoLifecycle.normalizeOutcome(ws.engagement_outcome);
    const gapAssessmentOverview = isoLifecycle.isGapOnly(engagementOutcome)
      ? buildGapAssessmentOverview(await gapFieldwork.assessmentContext(db, ws))
      : null;

    res.render('workspace', {
      user: req.user, ws, progress, breakdown, themes, riskCount, openRisks,
      assetCount, evidenceCount, openTasks, actionItems,
      docCount, auditCount, mrmCount, ncOpen, recentActivity, readiness, sparkline,
      roadmap, needsAttention, nextStep, activePass,
      setupIncomplete, intakeAnswered, derivedStage, truth,
      engagementOutcome,
      engagementOutcomeLabel: isoLifecycle.label(ws.engagement_outcome),
      lifecycleOutcomes: isoLifecycle.OUTCOME_OPTIONS,
      gapAssessmentOverview,
    });
  });

  app.get('/workspaces/:wsId/roadmap', requireAuth, requireWorkspace, (req, res) => {
    res.redirect(`/workspaces/${req.workspace.id}/engagement-plan?view=timeline`);
  });

  app.post('/workspaces/:wsId/frameworks', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    const frameworks = submittedFrameworks(req.body.frameworks);
    const currentFrameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    const requestedHasIso = isoLifecycle.hasIsoManagementSystem(frameworks);
    const deliveryHistory = await hasIsoDeliveryHistory(db, req.workspace.id);
    const fullDeliveryHistory = await hasFullCertificationDeliveryHistory(db, req.workspace.id);
    const storedOutcome = isoLifecycle.normalizeOutcome(req.workspace.engagement_outcome);
    const removedIso = isoLifecycle.isoFrameworkCodes(currentFrameworks).filter(code => !frameworks.includes(code));
    if (removedIso.length && deliveryHistory) {
      return res.status(409).render('error', {
        user: req.user,
        message: `${isoLifecycle.frameworkLabel(removedIso)} cannot be removed after its contracted delivery engagement has been created. Use the governed engagement cancellation process instead.`
      });
    }
    if (!frameworks.length && !hasService(req.workspace)) {
      return res.status(400).render('error', { user: req.user, message: NO_PROGRAMME });
    }
    if (requestedHasIso && !isoLifecycle.isValidOutcome(req.body.engagement_outcome)) {
      return res.status(400).render('error', {
        user: req.user,
        message: `Choose whether the ${isoLifecycle.frameworkLabel(frameworks)} engagement ends at the gap-assessment report or continues through full certification support.`
      });
    }
    const requestedOutcome = requestedHasIso
      ? isoLifecycle.normalizeOutcome(req.body.engagement_outcome)
      : storedOutcome;
    if (deliveryHistory && (fullDeliveryHistory || !isoLifecycle.isGapOnly(storedOutcome)) && isoLifecycle.isGapOnly(requestedOutcome)) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Full certification support cannot be shortened to gap assessment only, including by disabling and re-enabling an ISO programme.'
      });
    }
    if (deliveryHistory && !fullDeliveryHistory && isoLifecycle.isGapOnly(storedOutcome) && !isoLifecycle.isGapOnly(requestedOutcome)
      && req.body.confirm_outcome_upgrade !== '1') {
      return res.status(400).render('error', {
        user: req.user,
        message: 'Confirm the one-way change to full certification support before expanding this engagement.'
      });
    }
    const storedTargetDate = requestedHasIso && !isoLifecycle.isGapOnly(requestedOutcome)
      ? (req.body.target_cert_date || null)
      : null;
    await db.transaction(async () => {
      await db.prepare(`UPDATE workspaces SET frameworks=?,engagement_outcome=?,target_cert_date=?,updated_at=utc_now_text() WHERE id=?`)
        .run(JSON.stringify(frameworks), requestedOutcome, storedTargetDate, req.workspace.id);
      if (requestedHasIso) {
        const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.workspace.id);
        workspace.frameworks = frameworks;
        await engagementDelivery.syncCertificationTarget(db, workspace, req.user.id);
        await syncCertificationDeadlineAnswer(db, workspace, storedTargetDate, req.user.id);
      }
    })();
    await logAction(req.user.id,req.workspace.id,'update_workspace_frameworks','workspace',req.workspace.id,{
      frameworks,
      engagement_outcome: requestedHasIso ? requestedOutcome : null,
    },auditCtx(req));
    const message = frameworks.length ? 'Assessment programmes updated' : 'Client left without an assigned assessment programme';
    res.redirect(withToast(`/workspaces/${req.workspace.id}`,message));
  });

  app.post('/workspaces/:wsId/modules/tprm', requireAuth, requireWorkspace,
    requirePermission('tprm.methodology.manage'), async (req, res) => {
      const serviceModel = String(req.body.service_model || '').trim();
      if (!tprmDomain.OFFERED_SERVICE_MODELS.includes(serviceModel)) {
        return res.status(400).render('error', {
          user:req.user, ws:req.workspace,
          message:'Choose a valid Third-party risk service model before enabling the module.'
        });
      }
      try {
        const result = await tprmDomain.enableModule(db, {
          workspaceId:req.workspace.id,
          serviceModel,
          actorId:req.user.id,
          reason:String(req.body.reason || 'Enabled from governed client programme setup.').trim(),
          idempotencyKey:req.body.idempotency_key || null,
        });
        await logAction(req.user.id, req.workspace.id,
          result.classified ? 'classify_tprm_module' : 'enable_tprm_module',
          'tprm_module', result.module.id, {
            service_model:result.module.service_model,
            created:Boolean(result.created),
            classified:Boolean(result.classified),
          }, auditCtx(req));
        const message = result.classified
          ? 'Historic Third-party risk records classified and activated'
          : result.created ? 'Third-party risk enabled' : 'Third-party risk is already active';
        return res.redirect(withToast(`/workspaces/${req.workspace.id}/tprm`, message));
      } catch (error) {
        const status = [400,403,404,409].includes(Number(error.status)) ? Number(error.status) : 409;
        return res.status(status).render('error', {
          user:req.user, ws:req.workspace,
          message:error.message || 'Third-party risk could not be enabled.'
        });
      }
    });

  app.post('/workspaces/:wsId/update', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    const {
      client_name, industry, scope, target_cert_date, stage, lead_consultant_id,
      brand_display_name, brand_primary_color, brand_logo_path, sector,
      updated_at_snapshot,
    } = req.body;
    const currentLeadId = parseInt(req.workspace.lead_consultant_id, 10) || null;
    const leadWasSubmitted = Object.prototype.hasOwnProperty.call(req.body || {}, 'lead_consultant_id');
    const requestedLeadId = leadWasSubmitted ? (parseInt(lead_consultant_id, 10) || null) : currentLeadId;
    if (requestedLeadId !== currentLeadId) {
      if (!rbac.hasPermission(req.userPerms, 'members.assign_role')) {
        return res.status(403).render('error', {
          user: req.user,
          message: 'Changing the engagement lead requires member role-assignment permission.'
        });
      }
      if (requestedLeadId) {
        const lead = await db.prepare(`SELECT id FROM users
          WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`)
          .get(requestedLeadId, req.workspace.firm_id);
        if (!lead) {
          return res.status(400).render('error', {
            user: req.user,
            message: 'The selected engagement lead is not an active consultant in this firm.'
          });
        }
      }
    }
    const safeColor = (typeof brand_primary_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(brand_primary_color.trim()))
      ? brand_primary_color.trim() : null;
    const frameworks = req.body.frameworks_present === '1'
      ? submittedFrameworks(req.body.frameworks)
      : (Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : []);
    const currentFrameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    const currentHasIso = isoLifecycle.hasIsoManagementSystem(currentFrameworks);
    const requestedHasIso = isoLifecycle.hasIsoManagementSystem(frameworks);
    const deliveryHistory = await hasIsoDeliveryHistory(db, req.workspace.id);
    const fullDeliveryHistory = await hasFullCertificationDeliveryHistory(db, req.workspace.id);
    const storedOutcome = isoLifecycle.normalizeOutcome(req.workspace.engagement_outcome);
    const currentOutcome = currentHasIso
      ? storedOutcome
      : null;
    const outcomeWasSubmitted = Object.prototype.hasOwnProperty.call(req.body || {}, 'engagement_outcome');
    if (requestedHasIso && (!outcomeWasSubmitted || !isoLifecycle.isValidOutcome(req.body.engagement_outcome))) {
      return res.status(400).render('error', {
        user: req.user,
        message: `Choose whether the ${isoLifecycle.frameworkLabel(frameworks)} engagement ends at the gap-assessment report or continues through full certification support.`
      });
    }
    const requestedOutcome = requestedHasIso
      ? isoLifecycle.normalizeOutcome(req.body.engagement_outcome)
      : storedOutcome;
    const removedIso = isoLifecycle.isoFrameworkCodes(currentFrameworks).filter(code => !frameworks.includes(code));
    if (removedIso.length && deliveryHistory) {
      return res.status(409).render('error', {
        user: req.user,
        message: `${isoLifecycle.frameworkLabel(removedIso)} cannot be removed after its contracted delivery engagement has been created. Use the governed engagement cancellation process instead.`
      });
    }
    if (req.body.frameworks_present === '1' && !frameworks.length && !hasService(req.workspace)) {
      return res.status(400).render('error', { user: req.user, message: NO_PROGRAMME });
    }
    if (deliveryHistory && (fullDeliveryHistory || !isoLifecycle.isGapOnly(storedOutcome)) && isoLifecycle.isGapOnly(requestedOutcome)) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Full certification support cannot be shortened to gap assessment only, including by disabling and re-enabling an ISO programme. Create a separately scoped gap-assessment engagement if that is the new requirement.'
      });
    }
    if (deliveryHistory && !fullDeliveryHistory && isoLifecycle.isGapOnly(storedOutcome)
      && !isoLifecycle.isGapOnly(requestedOutcome)
      && req.body.confirm_outcome_upgrade !== '1') {
      return res.status(400).render('error', {
        user: req.user,
        message: 'Confirm the one-way change to full certification support before expanding this engagement.'
      });
    }
    const storedTargetDate = !requestedHasIso || isoLifecycle.isGapOnly(requestedOutcome)
      ? null
      : (target_cert_date || null);
    const usingCAS = !!updated_at_snapshot;
    const sql = usingCAS
      ? `UPDATE workspaces
           SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?, engagement_outcome=?,
               brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?, frameworks=?,
               updated_at=utc_now_text()
         WHERE id=? AND updated_at=?`
      : `UPDATE workspaces
           SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?, engagement_outcome=?,
               brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?, frameworks=?,
               updated_at=utc_now_text()
         WHERE id=?`;
    const args = [
      client_name, industry || null, scope || null, storedTargetDate,
      stage || 'gap_assessment', requestedLeadId, requestedOutcome,
      (brand_display_name || '').trim() || null,
      safeColor,
      (brand_logo_path || '').trim() || null,
      (sector || '').trim() || null,
      JSON.stringify(frameworks),
      req.workspace.id,
    ];
    if (usingCAS) args.push(updated_at_snapshot);
    const result = await db.transaction(async () => {
      const update = await db.prepare(sql).run(...args);
      if (update.changes && requestedHasIso) {
        const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.workspace.id);
        workspace.frameworks = frameworks;
        await engagementDelivery.syncCertificationTarget(db, workspace, req.user.id);
        await syncCertificationDeadlineAnswer(db, workspace, storedTargetDate, req.user.id);
      }
      return update;
    })();
    if (usingCAS && result.changes === 0) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Another consultant updated this client\'s settings while you were editing. Reload the workspace settings page to see the latest values, then re-apply your changes.'
      });
    }
    await logAction(req.user.id, req.workspace.id, 'update_workspace', 'workspace', req.workspace.id, {
      frameworks,
      engagement_outcome: requestedHasIso ? requestedOutcome : null,
      previous_engagement_outcome: currentOutcome,
    });
    res.redirect('/workspaces/' + req.workspace.id);
  });

  app.post('/workspaces/:wsId/delete', requireAuth, requireWorkspace, requirePermission('workspace.delete'), async (req, res) => {
    const ws = req.workspace;
    const confirm = (req.body.confirm_name || '').trim();
    if (!confirmationMatchesRenderedName(confirm, ws.client_name)) {
      return res.redirect(withToast('/workspaces/' + ws.id + '#workspace-settings',
        'Confirmation name did not match - nothing deleted', 'error'));
    }

    const storedPaths = await workspaceStoredPaths(db, ws);

    try {
      await deleteWorkspace(db, ws.id);
    } catch (error) {
      console.error(`[delete-workspace] workspace ${ws.id} could not be deleted:`, error.message);
      await logAction(req.user.id, ws.id, 'delete_workspace_failed', 'workspace', ws.id,
        { client_name: ws.client_name, error: error.message });
      return res.redirect(withToast(`/workspaces/${ws.id}#workspace-settings`,
        'Client could not be deleted. No data was removed.', 'error'));
    }

    for (const storedPath of storedPaths) {
      try {
        const abs = resolveUploadPath(storedPath, ws.firm_id);
        if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (_) {}
    }

    await logAction(req.user.id, null, 'delete_workspace', 'workspace', ws.id, ws.client_name);
    res.redirect(withToast('/dashboard', `Client "${ws.client_name}" deleted`, 'success'));
  });

  app.get('/workspaces/:wsId/members', requireAuth, requireWorkspace, async (req, res) => {
    const members = await db.prepare(`SELECT m.*, u.name, u.email, u.user_type, u.firm_role
      FROM workspace_members m INNER JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY u.name`).all(req.workspace.id);
    const firmConsultants = isFirmUser(req.user) ?
      await db.prepare(`SELECT id, name, email FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`).all(req.user.firm_id) :
      [];
    res.render('members', { user: req.user, ws: req.workspace, members, firmConsultants });
  });

  app.post('/workspaces/:wsId/members/client', requireAuth, requireWorkspace, requirePermission('members.add'), async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || password.length < 8) return res.redirect('/workspaces/' + req.workspace.id + '/members');
    const e = email.toLowerCase().trim();
    const r = rbac.CLIENT_ROLES.includes(role) ? role : 'contributor';
    if (r !== 'contributor' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a privileged client role requires member role-assignment permission.'
      });
    }

    let user = await db.prepare('SELECT * FROM users WHERE email = ?').get(e);
    if (!user) {
      const hash = bcrypt.hashSync(password, 10);
      const userId = (await db.prepare(`INSERT INTO users (email, password_hash, name, user_type)
                                 VALUES (?, ?, ?, 'client')`).run(e, hash, name.trim(), )).lastInsertRowid;
      user = { id: userId };
    }
    try {
      await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
        .run(req.workspace.id, user.id, r);
    } catch (e) { }
    await logAction(req.user.id, req.workspace.id, 'add_client_user', 'user', user.id, { email: e, role: r });
    res.redirect('/workspaces/' + req.workspace.id + '/members');
  });

  app.post('/workspaces/:wsId/members/firm', requireAuth, requireWorkspace, requirePermission('members.add'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const { user_id, role } = req.body;
    const allowedRoles = ['senior_consultant','consultant'];
    const r = allowedRoles.includes(role) ? role : 'consultant';
    if (r !== 'consultant' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a senior consultant requires member role-assignment permission.'
      });
    }
    const candidate = await db.prepare(`SELECT id FROM users
      WHERE id=? AND firm_id=? AND user_type='firm' AND active=1`).get(user_id, req.workspace.firm_id);
    if (!candidate) return res.status(400).render('error', {
      user: req.user, message: 'The selected consultant is not an active user in this firm.'
    });
    try {
      await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
        .run(req.workspace.id, user_id, r);
    } catch (e) { }
    res.redirect('/workspaces/' + req.workspace.id + '/members');
  });

  app.post('/workspaces/:wsId/members/:memberId/remove', requireAuth, requireWorkspace, requirePermission('members.remove'), async (req, res) => {
    await db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?')
      .run(req.params.memberId, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/members');
  });

  app.get('/workspaces/:wsId/team', requireAuth, requireWorkspace, async (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'Only firm consultants can manage the engagement team.' });
    }
    const ws = req.workspace;
    const firmPool = await db.prepare(`SELECT id, name, email, firm_role FROM users
       WHERE firm_id = ? AND user_type = 'firm' AND active = 1
       ORDER BY (firm_role = 'manager') DESC NULLS LAST, name`).all(ws.firm_id);
    const leadConsultant = ws.lead_consultant_id
      ? await db.prepare(`SELECT id, name, email, firm_role FROM users WHERE id = ?`).get(ws.lead_consultant_id)
      : null;
    const firmMembers = await db.prepare(`SELECT wm.id AS member_id, wm.role, u.id AS user_id, u.name, u.email, u.firm_role
       FROM workspace_members wm INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND u.user_type = 'firm' AND u.active = 1
       ORDER BY (wm.role = 'senior_consultant') DESC, u.name`).all(ws.id);
    const clientMembers = await db.prepare(`SELECT wm.id AS member_id, wm.role, u.id AS user_id, u.name, u.email, u.last_active_at
       FROM workspace_members wm INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND u.user_type = 'client'
       ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END, u.name`).all(ws.id);
    const pendingInvites = await db.prepare(`SELECT id, email, name, workspace_role, expires_at, created_at
       FROM user_invitations
       WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > utc_now_text()
       ORDER BY created_at DESC NULLS LAST`).all(ws.id);

    res.render('team_setup', {
      user: req.user, ws, active: 'team',
      firmPool, leadConsultant, firmMembers, clientMembers, pendingInvites,
      scopeConfirmed: !!ws.scope_confirmed_at,
      notice: req.query.notice || null,
      error: req.query.error || null
    });
  });

  app.post('/workspaces/:wsId/team/set-lead', requireAuth, requireWorkspace, requirePermission('members.assign_role'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const leadId = parseInt(req.body.lead_consultant_id, 10) || null;
    if (leadId) {
      const exists = await db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(leadId, req.workspace.firm_id);
      if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('That user is not in your firm.'));
    }
    await db.prepare(`UPDATE workspaces SET lead_consultant_id = ?, updated_at = utc_now_text() WHERE id = ?`)
      .run(leadId, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'set_lead_consultant', 'workspace', req.workspace.id, { lead_consultant_id: leadId }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Engagement lead updated.'));
  });

  app.post('/workspaces/:wsId/team/add-firm-member', requireAuth, requireWorkspace, requirePermission('members.add'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const userId = parseInt(req.body.user_id, 10);
    const role = ['senior_consultant', 'consultant'].includes(req.body.role) ? req.body.role : 'consultant';
    if (role !== 'consultant' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a senior consultant requires member role-assignment permission.'
      });
    }
    if (!userId) return res.redirect('/workspaces/' + req.workspace.id + '/team');
    const exists = await db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(userId, req.workspace.firm_id);
    if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('Pick a firm consultant.'));
    try {
      await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, userId, role);
    } catch (_) { }
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant added to engagement.'));
  });

  app.post('/workspaces/:wsId/team/remove-firm-member/:memberId', requireAuth, requireWorkspace, requirePermission('members.remove'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    await db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?').run(req.params.memberId, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant removed from engagement.'));
  });

  app.post('/workspaces/:wsId/team/invite-client', requireAuth, requireWorkspace, requirePermission('members.add'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim() || null;
    const role = ['client_owner', 'isms_manager', 'contributor'].includes(b.workspace_role) ? b.workspace_role : 'contributor';
    if (role !== 'contributor' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a privileged client role requires member role-assignment permission.'
      });
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('A valid email is required.'));
    }
    const existing = await db.prepare(`SELECT id, active FROM users WHERE email = ?`).get(email);
    if (existing) {
      const which = existing.active ? 'active' : 'deactivated';
      return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent(
        `An ${which} account already exists for ${email}. Open Admin → Users & access to reactivate, reset password, or add them to this workspace.`));
    }
    await db.prepare(`UPDATE user_invitations SET revoked_at = utc_now_text()
       WHERE firm_id = ? AND workspace_id = ? AND email = ?
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > utc_now_text()`)
      .run(req.user.firm_id, req.workspace.id, email);

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    await db.prepare(`INSERT INTO user_invitations
        (email, name, firm_id, user_type, workspace_id, workspace_role, token_hash, expires_at, invited_by)
        VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?)`)
      .run(email, name, req.user.firm_id, req.workspace.id, role, tokenHash, expiresAt, req.user.id);

    let sendError = null;
    try {
      const emailLib = require('../lib/email');
      const firmRow = await db.prepare(`SELECT name FROM firms WHERE id = ?`).get(req.user.firm_id);
      const r = await emailLib.sendInviteEmail({
        toEmail: email, toName: name, inviterName: req.user.name,
        firmName: firmRow && firmRow.name,
        role: `Client-side - ${rbac.ROLE_LABELS[role] || role}`,
        token: raw, expiresAt, firmId: req.user.firm_id
      });
      if (!r.ok) sendError = r.error || 'Email delivery failed';
    } catch (e) { sendError = e && e.message; }

    if (sendError) {
      return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' +
        encodeURIComponent(`Invitation created but email failed (${sendError}). Share the link manually: /invite/${raw}`));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' +
      encodeURIComponent(`Invitation sent to ${email}. Link expires in 7 days.`));
  });

  app.post('/workspaces/:wsId/team/revoke-invite/:invId', requireAuth, requireWorkspace, requirePermission('members.remove'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const inv = await db.prepare(`SELECT id, workspace_id FROM user_invitations WHERE id = ?`).get(req.params.invId);
    if (!inv || inv.workspace_id !== req.workspace.id) return res.redirect('/workspaces/' + req.workspace.id + '/team');
    await db.prepare(`UPDATE user_invitations SET revoked_at = utc_now_text() WHERE id = ?`).run(inv.id);
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Invitation revoked.'));
  });

}

module.exports = { register };
