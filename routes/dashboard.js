'use strict';

const rbac = require('../lib/rbac');
const email = require('../lib/email');
const ctlReads = require('../lib/control-reads');
const { todayFor, ymdInZone, workspaceTimeZone, shiftMonth } = require('../lib/dates');
const { computeReadiness } = require('../lib/readiness');
const { buildWorkspaceTruth } = require('../lib/grc-truth');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');
const isoLifecycle = require('../lib/iso-lifecycle');
const outcomeScope = require('../lib/engagement-outcome-scope');
const gapFieldwork = require('../lib/gap-fieldwork');
const { buildGapAssessmentOverview } = require('../lib/workspace-outcome-overview');

const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, ok: 2 });

function workKey(value) {
  return String(value || '')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function groupWork(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.kind}::${workKey(item.groupTitle || item.title)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        kind: item.kind,
        title: item.groupTitle || item.title,
        earliest: item.due_date,
        latest: item.due_date,
        items: [],
      });
    }
    const group = groups.get(key);
    group.items.push(item);
    if (item.due_date < group.earliest) group.earliest = item.due_date;
    if (item.due_date > group.latest) group.latest = item.due_date;
  }
  for (const group of groups.values()) {
    const byClient = new Map();
    for (const item of group.items) {
      const seen = byClient.get(item.workspace_id);
      if (!seen) {
        byClient.set(item.workspace_id, { client: item.client, href: item.href, due_date: item.due_date, count: 1 });
      } else {
        seen.count++;
        if (item.due_date < seen.due_date) { seen.due_date = item.due_date; seen.href = item.href; }
      }
    }
    group.clients = [...byClient.values()]
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.client.localeCompare(b.client));
  }
  return [...groups.values()]
    .sort((a, b) => a.earliest.localeCompare(b.earliest) || b.items.length - a.items.length);
}

function serviceSummary(workspace, progress, mode, readiness, truth, gapAssessment) {
  if (mode === outcomeScope.MODE.CERTIFICATION) {
    const days = readiness && readiness.daysToTarget !== undefined ? readiness.daysToTarget : null;
    return {
      mode,
      path: 'Full certification support',
      position: truth.verdict.label,
      detail: truth.lifecycle.label,
      metric: `${readiness.stage1}% maturity`,
      target: workspace.target_cert_date || 'No certification target',
      targetDetail: days !== null ? `${days} days` : '',
      tone: truth.verdict.tone,
    };
  }
  if (mode === outcomeScope.MODE.GAP_ASSESSMENT) {
    return {
      mode,
      path: gapAssessment.servicePath,
      position: gapAssessment.currentPhaseLabel,
      detail: gapAssessment.reportState,
      metric: `${gapAssessment.coveragePct}% assessment coverage`,
      target: gapAssessment.endpointState,
      targetDetail: 'Controlled gap-assessment report',
      tone: gapAssessment.contractClosed ? 'success' : gapAssessment.activeBlockers ? 'danger' : 'warning',
    };
  }
  return {
    mode,
    path: 'Consulting engagement',
    position: progress.assessed > 0 ? 'Assessment in progress' : 'Programme setup',
    detail: progress.total ? `${progress.assessed} of ${progress.total} assessed` : 'Scope and delivery tracking',
    metric: progress.total ? `${progress.percent}% assessment coverage` : 'No assessment baseline',
    target: 'Programme delivery',
    targetDetail: '',
    tone: 'neutral',
  };
}

function register(app, deps) {
  const { db, requireAuth, logAction, isFirmUser, isFirmOwner, getActiveFirmId,
          listWorkspaces, workspaceProgress } = deps;

  app.get('/dashboard', requireAuth, async (req, res) => {
    const workspaces = await listWorkspaces(req.user);
    if (req.user.user_type === 'client') {
      if (workspaces.length) return res.redirect(`/workspaces/${workspaces[0].id}/client-portal`);
      return res.status(403).render('error', {
        user: req.user,
        message: 'Your account is not assigned to an active client engagement. Contact your engagement team for access.'
      });
    }
    const firmClock = (await db.prepare(`SELECT timezone AS firm_timezone FROM firms WHERE id=?`).get(req.user.firm_id)) || {};
    const firmTimeZone = workspaceTimeZone(firmClock);
    const firmToday = todayFor(firmClock);
    const workspacesWithProgress = await Promise.all(workspaces.map(async w => {
      const localToday = todayFor(w,firmClock);
      const progress = await workspaceProgress(w.id);
      const mode = outcomeScope.workspaceMode(w);
      const readiness = mode === outcomeScope.MODE.CERTIFICATION ? await computeReadiness(w) : null;
      const truth = mode === outcomeScope.MODE.CERTIFICATION ? await buildWorkspaceTruth(db, w, readiness) : null;
      const gapAssessment = mode === outcomeScope.MODE.GAP_ASSESSMENT
        ? buildGapAssessmentOverview(await gapFieldwork.assessmentContext(db, w))
        : null;
      const openMajorNCs = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(w.id)).c;
      const overdueNCs = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date < ?`).get(w.id,localToday)).c;
      return {
        ...w, progress, readiness, truth, gapAssessment, mode, openMajorNCs, overdueNCs,
        service: serviceSummary(w, progress, mode, readiness, truth, gapAssessment),
        derivedStage: truth ? truth.lifecycle : null,
      };
    }));

    const certificationWorkspaces = workspacesWithProgress.filter(w => w.mode === outcomeScope.MODE.CERTIFICATION);
    const totals = {
      total: workspacesWithProgress.length,
      certification: certificationWorkspaces.length,
      gapOnly: workspacesWithProgress.filter(w => w.mode === outcomeScope.MODE.GAP_ASSESSMENT).length,
      avgStage1: certificationWorkspaces.length
        ? Math.round(certificationWorkspaces.reduce((s, w) => s + w.readiness.stage1, 0) / certificationWorkspaces.length)
        : null,
      nearCert: certificationWorkspaces.filter(w => w.readiness.daysToTarget !== null && w.readiness.daysToTarget < 90).length,
      redFlags: workspacesWithProgress.filter(w => w.openMajorNCs > 0 || w.overdueNCs > 0 ||
        (w.mode === outcomeScope.MODE.CERTIFICATION && (w.truth.counts.critical > 0 || w.truth.counts.high > 2)) ||
        (w.mode === outcomeScope.MODE.GAP_ASSESSMENT && w.gapAssessment.activeBlockers > 0)).length,
      totalOpenNCs: workspacesWithProgress.reduce((s, w) => s + w.openMajorNCs + w.overdueNCs, 0)
    };

    let firmUsers = [];
    if (isFirmUser(req.user)) {
      firmUsers = await db.prepare(`SELECT id, name, email, firm_role FROM users
        WHERE firm_id = ? AND user_type = 'firm' AND active = 1 ORDER BY name`).all(req.user.firm_id);
    }

    const portfolioRisk = await Promise.all(workspacesWithProgress.map(async w => {
      const isIsoService = w.mode !== outcomeScope.MODE.GENERIC;
      const lastPass = isIsoService ? await db.prepare(`SELECT pass_number, status, started_at, completed_at
        FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(w.id) : null;
      const staleControls = isIsoService ? (await db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, w.id).cs} cs
        INNER JOIN iso_items i ON i.id = cs.iso_item_id
        WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
          AND (cs.last_verified_at IS NULL OR cs.last_verified_at < utc_text(now() + ('-365 days')::interval))
          AND cs.status NOT IN ('Not Assessed','Not Applicable')`).get(w.id)).c : 0;
      const overdueNCs = w.overdueNCs || 0;
      const overdueObj = (await db.prepare(`SELECT COUNT(*) c FROM security_objectives
        WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < ? AND status NOT IN ('achieved','paused')`).get(w.id,todayFor(w,firmClock))).c;
      const noPassFor90 = lastPass && lastPass.completed_at
        && lastPass.completed_at < new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
      const reasons = [];
      let severity = 'ok';
      if (w.mode === outcomeScope.MODE.CERTIFICATION && w.truth.counts.critical > 0) { reasons.push(`${w.truth.counts.critical} critical truth conflict${w.truth.counts.critical === 1 ? '' : 's'}`); severity = 'high'; }
      if (w.mode === outcomeScope.MODE.CERTIFICATION && w.truth.counts.high > 0) { reasons.push(`${w.truth.counts.high} high-priority readiness gap${w.truth.counts.high === 1 ? '' : 's'}`); if (severity !== 'high') severity = 'medium'; }
      if (w.mode === outcomeScope.MODE.GAP_ASSESSMENT && w.gapAssessment.activeBlockers > 0) {
        reasons.push(`${w.gapAssessment.activeBlockers} active gap-assessment blocker${w.gapAssessment.activeBlockers === 1 ? '' : 's'}`);
        severity = 'high';
      }
      if (overdueNCs > 0) { reasons.push(`${overdueNCs} overdue NC`); severity = 'high'; }
      if (w.openMajorNCs > 0) { reasons.push(`${w.openMajorNCs} open major NC`); severity = 'high'; }
      if (w.mode === outcomeScope.MODE.CERTIFICATION && w.readiness.daysToTarget !== null && w.readiness.daysToTarget < 30) { reasons.push('cert target < 30 days'); severity = 'high'; }
      if (overdueObj > 0) { reasons.push(`${overdueObj} overdue objective`); if (severity !== 'high') severity = 'medium'; }
      if (staleControls > 5) { reasons.push(`${staleControls} stale controls`); if (severity !== 'high') severity = 'medium'; }
      if (isIsoService && noPassFor90 && (!lastPass || lastPass.status !== 'in_progress')) {
        reasons.push('no active pass · last completed > 90d'); if (severity !== 'high') severity = 'medium';
      }
      if (isIsoService && !lastPass && w.progress.assessed === 0) { reasons.push('no gap assessment started'); if (severity !== 'high') severity = 'medium'; }
      if (isIsoService && !lastPass && w.progress.assessed > 0) { reasons.push('assessment history predates formal passes'); if (severity !== 'high') severity = 'medium'; }
      return { ...w, lastPass, staleControls, overdueObj, severity, reasons };
    }));
    const riskById = new Map(portfolioRisk.map(row => [row.id, row]));
    const REASON_ORDER = [
      /truth conflict/i, /gap-assessment blocker/i, /overdue NC/i, /open major NC/i,
      /cert target/i, /no gap assessment started/i, /overdue objective/i,
      /readiness gap/i, /stale controls/i, /no active pass/i, /predates/i,
    ];
    const reasonRank = reason => {
      const index = REASON_ORDER.findIndex(pattern => pattern.test(reason));
      return index === -1 ? REASON_ORDER.length : index;
    };
    for (const workspace of workspacesWithProgress) {
      const risk = riskById.get(workspace.id);
      const reasons = risk ? [...risk.reasons].sort((a, b) => reasonRank(a) - reasonRank(b)) : [];
      workspace.attention = {
        severity: risk ? risk.severity : 'ok',
        reasons,
        primary: reasons.length ? reasons[0] : null,
        more: reasons.length > 1 ? reasons.length - 1 : 0,
        rest: reasons.slice(1),
      };
    }
    workspacesWithProgress.sort((a, b) =>
      SEVERITY_RANK[a.attention.severity] - SEVERITY_RANK[b.attention.severity]
      || String(a.brand_display_name || a.client_name).localeCompare(String(b.brand_display_name || b.client_name)));

    totals.needsAttention = workspacesWithProgress.filter(w => w.attention.severity === 'high').length;
    totals.watch = workspacesWithProgress.filter(w => w.attention.severity === 'medium').length;

    const today = firmToday;
    const weekFromNow = ymdInZone(new Date(Date.now() + 7 * 86400000),firmTimeZone);
    const wsIds = workspacesWithProgress.map(w => w.id);
    const wsNameById = {};
    for (const w of workspacesWithProgress) wsNameById[w.id] = w.brand_display_name || w.client_name;

    const thisWeek = { overdue: [], dueThisWeek: [], byClient: {} };
    if (wsIds.length) {
      const placeholders = wsIds.map(() => '?').join(',');
      const tasks = await db.prepare(`SELECT id, workspace_id, title, due_date, priority, status FROM tasks
        WHERE workspace_id IN (${placeholders}) AND status NOT IN ('done','closed','cancelled')
        AND due_date IS NOT NULL`).all(...wsIds);
      const ncs = await db.prepare(`SELECT id, workspace_id, title, due_date, severity, status FROM nonconformities
        WHERE workspace_id IN (${placeholders}) AND status NOT IN ('closed','verified')
        AND due_date IS NOT NULL`).all(...wsIds);
      const audits = await db.prepare(`SELECT id, workspace_id, title, audit_date AS due_date, status FROM audits
        WHERE workspace_id IN (${placeholders}) AND status NOT IN ('completed','cancelled')
        AND audit_date IS NOT NULL`).all(...wsIds);
      const mrms = await db.prepare(`SELECT id, workspace_id, ('MRM ' || meeting_date) AS title, meeting_date AS due_date, status FROM mrms
        WHERE workspace_id IN (${placeholders}) AND status NOT IN ('completed','cancelled')
        AND meeting_date IS NOT NULL`).all(...wsIds);

      const enrich = (items, kind) => items.map(it => ({
        kind, id: it.id, workspace_id: it.workspace_id, client: wsNameById[it.workspace_id] || '?',
        title: it.title,
        groupTitle: kind === 'mrm' ? 'Management review meeting' : it.title,
        due_date: it.due_date, severity: it.severity || it.priority || null,
        bucket: it.due_date < today ? 'overdue' : it.due_date <= weekFromNow ? 'thisWeek' : 'later',
        href: kind === 'task' ? `/workspaces/${it.workspace_id}/tasks` :
              kind === 'nc' ? `/workspaces/${it.workspace_id}/nonconformities/${it.id}` :
              kind === 'audit' ? `/workspaces/${it.workspace_id}/audits/${it.id}` :
              kind === 'mrm' ? `/workspaces/${it.workspace_id}/mrms/${it.id}` :
              `/workspaces/${it.workspace_id}`,
      }));

      const all = [
        ...enrich(tasks, 'task'),
        ...enrich(ncs, 'nc'),
        ...enrich(audits, 'audit'),
        ...enrich(mrms, 'mrm'),
      ];
      thisWeek.overdue = all.filter(i => i.bucket === 'overdue').sort((a, b) => a.due_date.localeCompare(b.due_date));
      thisWeek.dueThisWeek = all.filter(i => i.bucket === 'thisWeek').sort((a, b) => a.due_date.localeCompare(b.due_date));
      thisWeek.totalActionable = thisWeek.overdue.length + thisWeek.dueThisWeek.length;
      thisWeek.overdueGroups = groupWork(thisWeek.overdue);
      thisWeek.dueThisWeekGroups = groupWork(thisWeek.dueThisWeek);

      for (const item of all) {
        if (item.bucket === 'later') continue;
        const k = item.workspace_id;
        thisWeek.byClient[k] = thisWeek.byClient[k] || { name: item.client, ws_id: k, overdue: 0, thisWeek: 0 };
        if (item.bucket === 'overdue') thisWeek.byClient[k].overdue++;
        else thisWeek.byClient[k].thisWeek++;
      }
    }

    let onboarding = null;
    try {
      const tenantsModule = require('./tenants');
      onboarding = await tenantsModule.getOnboardingProgress(db, req.user.firm_id);
      if (onboarding) {
        const wsCount = (await db.prepare('SELECT COUNT(*) AS c FROM workspaces WHERE firm_id=?').get(req.user.firm_id)).c;
        const dismissed = onboarding.skipped || onboarding.completed;
        const stillFirstTime = wsCount < 2;
        if (onboarding.done >= onboarding.total) onboarding = null;
        else if (!stillFirstTime || dismissed) onboarding = null;
      }
    } catch (_) {}

    res.render('dashboard', {
      user: req.user, workspaces: workspacesWithProgress, firmUsers, totals, thisWeek, onboarding,
      outcomeOptions: isoLifecycle.OUTCOME_OPTIONS,
    });
  });

  async function computeEngagementHealth(w) {
    const mode = outcomeScope.workspaceMode(w);
    const isIsoService = mode !== outcomeScope.MODE.GENERIC;
    const readiness = mode === outcomeScope.MODE.CERTIFICATION ? await computeReadiness(w) : null;
    const truth = mode === outcomeScope.MODE.CERTIFICATION ? await buildWorkspaceTruth(db, w, readiness) : null;
    const progress = await workspaceProgress(w.id);
    const gapAssessment = mode === outcomeScope.MODE.GAP_ASSESSMENT
      ? buildGapAssessmentOverview(await gapFieldwork.assessmentContext(db, w))
      : null;
    const service = serviceSummary(w, progress, mode, readiness, truth, gapAssessment);

    const localToday = todayFor(w,(await db.prepare(`SELECT timezone FROM firms WHERE id=?`).get(w.firm_id)) || {});
    const overdueNCs = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < ?`).get(w.id,localToday)).c;
    const majorNCs = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(w.id)).c;
    const staleControls = isIsoService ? (await db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, w.id).cs} cs
        INNER JOIN iso_items i ON i.id = cs.iso_item_id
        WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
          AND (cs.last_verified_at IS NULL OR cs.last_verified_at < utc_text(now() + ('-365 days')::interval))
          AND cs.status NOT IN ('Not Assessed','Not Applicable')`).get(w.id)).c : 0;
    const overdueObj = (await db.prepare(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < ? AND status NOT IN ('achieved','paused')`).get(w.id,localToday)).c;
    const overdueTasks = (await db.prepare(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status NOT IN ('done','closed','cancelled') AND due_date IS NOT NULL AND due_date < ?`).get(w.id,localToday)).c;
    const highRisks = (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status NOT IN ('closed','accepted') AND (likelihood * impact) >= 15`).get(w.id)).c;
    const lastPass = isIsoService
      ? await db.prepare(`SELECT pass_number, status, completed_at FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(w.id)
      : null;
    const phaseScope = outcomeScope.phaseSqlForWorkspace(w, 'ph');
    const deliveryPlan = (await db.prepare(`SELECT p.id,p.target_completion_date,p.forecast_completion_date,p.baseline_version,
      (SELECT COUNT(*) FROM engagement_delivery_phases ph WHERE ph.plan_id=p.id AND ${phaseScope} AND ph.is_continuous=0) phase_count,
      (SELECT COUNT(*) FROM engagement_delivery_milestones m JOIN engagement_delivery_phases ph ON ph.id=m.phase_id WHERE m.plan_id=p.id AND ${phaseScope}) milestones,
      (SELECT COUNT(*) FROM engagement_delivery_milestones m JOIN engagement_delivery_phases ph ON ph.id=m.phase_id WHERE m.plan_id=p.id AND ${phaseScope} AND m.status='complete') complete_milestones,
      (SELECT COUNT(*) FROM engagement_delivery_milestones m JOIN engagement_delivery_phases ph ON ph.id=m.phase_id WHERE m.plan_id=p.id AND ${phaseScope} AND m.owner_id IS NULL) unassigned_milestones,
      (SELECT COUNT(*) FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones dm ON dm.id=d.milestone_id JOIN engagement_delivery_phases ph ON ph.id=dm.phase_id WHERE d.plan_id=p.id AND ${phaseScope} AND d.is_required=1) required_deliverables,
      (SELECT COUNT(*) FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones dm ON dm.id=d.milestone_id JOIN engagement_delivery_phases ph ON ph.id=dm.phase_id WHERE d.plan_id=p.id AND ${phaseScope} AND d.is_required=1 AND d.status='accepted') accepted_deliverables,
      (SELECT COUNT(*) FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones dm ON dm.id=d.milestone_id JOIN engagement_delivery_phases ph ON ph.id=dm.phase_id WHERE d.plan_id=p.id AND ${phaseScope} AND d.due_date<? AND d.status NOT IN ('accepted','superseded')) overdue_deliverables,
      (SELECT COUNT(*) FROM engagement_delivery_gate_decisions g JOIN engagement_delivery_phases ph ON ph.id=g.phase_id WHERE ph.plan_id=p.id AND ${phaseScope} AND g.decision IN ('passed','waived') AND g.id=(SELECT MAX(g2.id) FROM engagement_delivery_gate_decisions g2 WHERE g2.phase_id=ph.id)) gates_passed
      FROM engagement_delivery_plans p WHERE p.workspace_id=?`).get(localToday,w.id)) || null;
    if (deliveryPlan) deliveryPlan.variance_days = deliveryPlan.target_completion_date && deliveryPlan.forecast_completion_date
      ? Math.round((Date.parse(deliveryPlan.forecast_completion_date) - Date.parse(deliveryPlan.target_completion_date)) / 86400000) : null;

    const stage1 = readiness ? (readiness.stage1 || 0) : null;
    const daysToTarget = readiness && readiness.daysToTarget !== undefined ? readiness.daysToTarget : null;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    let certPenalty = 0;
    if (mode === outcomeScope.MODE.CERTIFICATION && daysToTarget !== null && daysToTarget < 90) {
      const urgency = clamp((90 - daysToTarget) / 90, 0, 1);
      const gateTotal = Math.max(readiness.stage1GateTotal || 0, 1);
      const gateGap = clamp((gateTotal - (readiness.stage1GatePassed || 0)) / gateTotal, 0, 1);
      const gap = readiness.stage1Ready ? 0 : Math.max(gateGap, clamp((100 - stage1) / 100, 0, 1));
      certPenalty = Math.round(urgency * gap * 35);
    }

    const started = !!lastPass || progress.assessed > 0;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    let passPenalty = 0;
    if (isIsoService && !started) passPenalty = 18;
    else if (lastPass && lastPass.status !== 'in_progress' && lastPass.completed_at && lastPass.completed_at < ninetyDaysAgo) passPenalty = 8;

    const contrib = [
      { label: truth ? `${truth.counts.critical} critical truth conflict${truth.counts.critical === 1 ? '' : 's'}` : null, n: truth?.counts.critical || 0, penalty: truth ? clamp(truth.counts.critical * 8, 0, 32) : 0 },
      { label: truth ? `${truth.counts.high} high-priority readiness gap${truth.counts.high === 1 ? '' : 's'}` : null, n: truth?.counts.high || 0, penalty: truth ? clamp(truth.counts.high * 3, 0, 15) : 0 },
      { label: gapAssessment ? `${gapAssessment.activeBlockers} active gap-assessment blocker${gapAssessment.activeBlockers === 1 ? '' : 's'}` : null, n: gapAssessment?.activeBlockers || 0, penalty: gapAssessment ? clamp(gapAssessment.activeBlockers * 6, 0, 24) : 0 },
      { label: overdueNCs === 1 ? '1 overdue NC' : `${overdueNCs} overdue NCs`, n: overdueNCs, penalty: clamp(overdueNCs * 9, 0, 27) },
      { label: majorNCs === 1 ? '1 open major NC' : `${majorNCs} open major NCs`, n: majorNCs, penalty: clamp(majorNCs * 7, 0, 21) },
      { label: daysToTarget !== null && truth ? `cert in ${daysToTarget}d · ${truth.verdict.label.toLowerCase()}` : null, n: certPenalty, penalty: certPenalty },
      { label: highRisks === 1 ? '1 high risk untreated' : `${highRisks} high risks untreated`, n: highRisks, penalty: clamp(highRisks * 2.5, 0, 15) },
      { label: `${staleControls} stale controls`, n: staleControls, penalty: clamp(staleControls * 1, 0, 12) },
      { label: `${overdueTasks} overdue tasks`, n: overdueTasks, penalty: clamp(overdueTasks * 1.5, 0, 12) },
      { label: `${overdueObj} overdue objectives`, n: overdueObj, penalty: clamp(overdueObj * 3, 0, 9) },
      { label: deliveryPlan?.overdue_deliverables === 1 ? '1 overdue delivery' : `${deliveryPlan?.overdue_deliverables || 0} overdue deliveries`, n: deliveryPlan?.overdue_deliverables || 0, penalty: clamp((deliveryPlan?.overdue_deliverables || 0) * 2, 0, 10) },
      { label: deliveryPlan?.variance_days > 0 ? `delivery forecast ${deliveryPlan.variance_days}d late` : null, n: Math.max(0, deliveryPlan?.variance_days || 0), penalty: clamp(Math.ceil(Math.max(0, deliveryPlan?.variance_days || 0) / 10), 0, 8) },
      { label: !started ? 'no gap assessment started' : 'last pass > 90d, none active', n: passPenalty, penalty: passPenalty },
    ];

    const totalPenalty = contrib.reduce((s, c) => s + c.penalty, 0);
    const score = Math.round(clamp(100 - totalPenalty, 0, 100));
    const band = score >= 75 ? 'healthy' : score >= 50 ? 'watch' : 'at_risk';
    const reasons = contrib
      .filter(c => c.penalty > 0 && c.n > 0 && c.label)
      .sort((a, b) => b.penalty - a.penalty)
      .slice(0, 4)
      .map(c => c.label);

    return {
      id: w.id,
      name: w.brand_display_name || w.client_name,
      mode,
      service,
      gapAssessment,
      stage: truth ? truth.lifecycle : { key: mode, label: service.position },
      verdict: truth ? truth.verdict : { key: mode, label: service.position, tone: service.tone },
      quality: truth ? truth.quality : null,
      qualityCounts: truth ? truth.counts : { critical: 0, high: 0, medium: 0, low: 0 },
      score, band, reasons, stage1, daysToTarget, deliveryPlan,
      signals: { overdueNCs, majorNCs, staleControls, overdueObj, overdueTasks, highRisks, assessedPct: progress.percent },
    };
  }

  app.get('/portfolio', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.cross_view')) {
      return res.status(403).render('error', { user: req.user, message: 'The portfolio board is for firm managers and senior consultants.' });
    }
    const engagements = (await Promise.all((await listWorkspaces(req.user))
      .map(async w => await computeEngagementHealth(w))))
      .sort((a, b) => a.score - b.score);
    const summary = {
      total: engagements.length,
      atRisk: engagements.filter(e => e.band === 'at_risk').length,
      watch: engagements.filter(e => e.band === 'watch').length,
      healthy: engagements.filter(e => e.band === 'healthy').length,
      avgScore: engagements.length ? Math.round(engagements.reduce((s, e) => s + e.score, 0) / engagements.length) : 0,
      overdueNCs: engagements.reduce((s, e) => s + e.signals.overdueNCs, 0),
    };
    res.render('portfolio', { user: req.user, ws: null, active: 'portfolio', engagements, summary });
  });

  async function collectManagerSchedule(user) {
    const wss = await listWorkspaces(user);
    const wsIds = wss.map(w => w.id);
    const wsName = {};
    const wsById = {};
    wss.forEach(w => {
      wsName[w.id] = w.brand_display_name || w.client_name;
      wsById[w.id] = w;
    });

    const projects = await Promise.all(
      wss.filter(w => outcomeScope.isCertificationSupport(w) && w.target_cert_date).map(async w => {
        let stage = null;
        try { stage = (await buildWorkspaceTruth(db, w)).verdict.label; } catch (_) {}
        return {
          wsId: w.id,
          name: wsName[w.id],
          start: (w.created_at || '').slice(0, 10) || null,
          end: String(w.target_cert_date).slice(0, 10),
          stage,
          link: `/workspaces/${w.id}`,
        };
      })
    );

    const people = await db.prepare(
      `SELECT id, name, email, firm_role FROM users
       WHERE firm_id = ? AND user_type = 'firm' AND active = 1 ORDER BY name`
    ).all(user.firm_id);
    const byName = {};
    people.forEach(p => { if (p.name) byName[p.name.trim().toLowerCase()] = p.id; });
    const resolveName = (txt) => txt ? (byName[String(txt).trim().toLowerCase()] || null) : null;

    const items = [];
    if (!wsIds.length) return { items, people, wsName, projects, docsNeedingReviewDate: 0 };
    const ph = wsIds.map(() => '?').join(',');
    const push = (o) => items.push(o);

    (await db.prepare(`SELECT id, workspace_id, title, due_date, status, assignee_id
                FROM tasks WHERE workspace_id IN (${ph})`).all(...wsIds)).forEach(t => {
      push({ kind:'task', title:t.title, date:t.due_date||null, status:t.status, open:t.status!=='done',
        countsWorkload:true, wsId:t.workspace_id, wsName:wsName[t.workspace_id],
        link:`/workspaces/${t.workspace_id}/tasks`, ownerId:t.assignee_id||null, ownerLabel:null });
    });

    (await db.prepare(`SELECT id, workspace_id, title, due_date, status, responsible
                FROM nonconformities WHERE workspace_id IN (${ph})`).all(...wsIds)).forEach(n => {
      push({ kind:'nc', title:n.title, date:n.due_date||null, status:n.status, open:n.status!=='closed',
        countsWorkload:true, wsId:n.workspace_id, wsName:wsName[n.workspace_id],
        link:`/workspaces/${n.workspace_id}/nonconformities/${n.id}`,
        ownerId:resolveName(n.responsible), ownerLabel:n.responsible||null });
    });

    (await db.prepare(`SELECT id, workspace_id, title, due_date, status, owner_name
                FROM improvements WHERE workspace_id IN (${ph})`).all(...wsIds)).forEach(i => {
      push({ kind:'improvement', title:i.title, date:i.due_date||null, status:i.status,
        open:(i.status==='open'||i.status==='in_progress'),
        countsWorkload:true, wsId:i.workspace_id, wsName:wsName[i.workspace_id],
        link:`/workspaces/${i.workspace_id}/improvements`,
        ownerId:resolveName(i.owner_name), ownerLabel:i.owner_name||null });
    });

    (await db.prepare(`SELECT id, workspace_id, title, due_date, status, owner_name, risk_id, closed_at
                FROM risk_treatment_actions WHERE workspace_id IN (${ph})`).all(...wsIds)).forEach(a => {
      push({ kind:'treatment', title:a.title||'Treatment action', date:a.due_date||null, status:a.status,
        open:(!a.closed_at && a.status!=='done' && a.status!=='closed'),
        countsWorkload:true, wsId:a.workspace_id, wsName:wsName[a.workspace_id],
        link:`/workspaces/${a.workspace_id}/risks/${a.risk_id}`,
        ownerId:resolveName(a.owner_name), ownerLabel:a.owner_name||null });
    });

    (await db.prepare(`SELECT workspace_id, iso_item_id, due_date, status, owner_id, applicability
                FROM v_control_states WHERE workspace_id IN (${ph}) AND owner_id IS NOT NULL`).all(...wsIds)).forEach(c => {
      push({ kind:'control', title:`Control ${c.iso_item_id}`, date:c.due_date||null, status:c.status,
        open:(c.status!=='Implemented'&&c.applicability!=='excluded'),
        countsWorkload:true, wsId:c.workspace_id, wsName:wsName[c.workspace_id],
        link:`/workspaces/${c.workspace_id}/controls/${c.iso_item_id}`, ownerId:c.owner_id, ownerLabel:null });
    });

    (await db.prepare(`SELECT id, workspace_id, title, audit_date, status
                FROM audits WHERE workspace_id IN (${ph}) AND audit_date IS NOT NULL`).all(...wsIds)).forEach(a => {
      push({ kind:'audit', title:a.title||'Audit', date:a.audit_date, status:a.status, open:a.status!=='closed',
        countsWorkload:false, wsId:a.workspace_id, wsName:wsName[a.workspace_id],
        link:`/workspaces/${a.workspace_id}/audits/${a.id}`, ownerId:null, ownerLabel:null });
    });

    (await db.prepare(`SELECT id, workspace_id, meeting_date, status
                FROM mrms WHERE workspace_id IN (${ph}) AND meeting_date IS NOT NULL`).all(...wsIds)).forEach(m => {
      push({ kind:'mrm', title:'Management review', date:m.meeting_date, status:m.status,
        open:(m.status!=='completed'&&m.status!=='done'),
        countsWorkload:false, wsId:m.workspace_id, wsName:wsName[m.workspace_id],
        link:`/workspaces/${m.workspace_id}/mrms/${m.id}`, ownerId:null, ownerLabel:null });
    });

    (await db.prepare(`SELECT id, workspace_id, event_type, planned_date, status
                FROM cert_cycle_events WHERE workspace_id IN (${ph}) AND planned_date IS NOT NULL`).all(...wsIds)).forEach(e => {
      if (!outcomeScope.isCertificationSupport(wsById[e.workspace_id])) return;
      push({ kind:'cert', title:String(e.event_type||'Cert event').replace(/_/g,' '), date:e.planned_date, status:e.status,
        open:(e.status!=='completed'&&e.status!=='done'),
        countsWorkload:false, wsId:e.workspace_id, wsName:wsName[e.workspace_id],
        link:`/workspaces/${e.workspace_id}/cert-cycle`, ownerId:null, ownerLabel:null });
    });

    try {
      (await db.prepare(`SELECT m.id,p.workspace_id,m.title,COALESCE(m.forecast_end_date,m.planned_end_date) due_date,m.status,phase.phase_key
                  FROM engagement_delivery_milestones m
                  JOIN engagement_delivery_phases phase ON phase.id=m.phase_id
                  JOIN engagement_delivery_plans p ON p.id=m.plan_id
                  WHERE p.workspace_id IN (${ph}) AND COALESCE(m.forecast_end_date,m.planned_end_date) IS NOT NULL`)
        .all(...wsIds)).forEach(m => {
          if (!wsById[m.workspace_id] || !outcomeScope.isPhaseInContract(wsById[m.workspace_id], m.phase_key)) return;
          push({ kind:'plan-milestone', title:m.title, date:m.due_date, status:m.status,
            open:!['complete','waived'].includes(m.status), countsWorkload:false,
            wsId:m.workspace_id, wsName:wsName[m.workspace_id],
            link:`/workspaces/${m.workspace_id}/engagement-plan?view=timeline`, ownerId:null, ownerLabel:null });
        });
      (await db.prepare(`SELECT d.id,d.workspace_id,d.title,d.due_date,d.status,d.owner_id,phase.phase_key
                  FROM engagement_delivery_deliverables d
                  JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
                  JOIN engagement_delivery_phases phase ON phase.id=m.phase_id
                  WHERE d.workspace_id IN (${ph}) AND d.due_date IS NOT NULL AND d.status<>'superseded'`)
        .all(...wsIds)).forEach(d => {
          if (!wsById[d.workspace_id] || !outcomeScope.isPhaseInContract(wsById[d.workspace_id], d.phase_key)) return;
          push({ kind:'deliverable', title:d.title, date:d.due_date, status:d.status,
            open:d.status!=='accepted', countsWorkload:!!d.owner_id,
            wsId:d.workspace_id, wsName:wsName[d.workspace_id],
            link:`/workspaces/${d.workspace_id}/engagement-plan`, ownerId:d.owner_id||null, ownerLabel:null });
        });
    } catch (_) {}

    (await db.prepare(`SELECT id, workspace_id, name, next_review_date
                FROM generated_docs WHERE workspace_id IN (${ph}) AND next_review_date IS NOT NULL`).all(...wsIds)).forEach(d => {
      push({ kind:'doc-review', title:`Review: ${d.name}`, date:d.next_review_date, status:null, open:true,
        countsWorkload:false, wsId:d.workspace_id, wsName:wsName[d.workspace_id],
        link:`/workspaces/${d.workspace_id}/documents/${d.id}`, ownerId:null, ownerLabel:null });
    });

    try {
      (await db.prepare(`SELECT sr.id, sr.supplier_id, sr.next_review_date, s.workspace_id, s.name AS supplier_name
                  FROM supplier_reviews sr INNER JOIN suppliers s ON s.id = sr.supplier_id
                  WHERE s.workspace_id IN (${ph}) AND sr.next_review_date IS NOT NULL`).all(...wsIds)).forEach(r => {
        push({ kind:'supplier', title:`Supplier review: ${(r.supplier_name||'').trim()}`.trim(), date:r.next_review_date, status:null, open:true,
          countsWorkload:false, wsId:r.workspace_id, wsName:wsName[r.workspace_id],
          link:`/workspaces/${r.workspace_id}/vendors/${r.supplier_id}`, ownerId:null, ownerLabel:null });
      });
    } catch (_) {}

    try {
      (await db.prepare(`SELECT q.id,q.workspace_id,q.supplier_id,q.status,q.due_date,s.name AS supplier_name
                  FROM supplier_ddq_assessments q INNER JOIN suppliers s ON s.id=q.supplier_id
                  WHERE q.workspace_id IN (${ph}) AND q.due_date IS NOT NULL
                    AND q.status NOT IN ('complete','superseded')`).all(...wsIds)).forEach(qr => {
        push({ kind:'questionnaire', title:`${qr.supplier_name||'Vendor'} due diligence`,
          date:String(qr.due_date).slice(0,10), status:qr.status, open:true,
          countsWorkload:false, wsId:qr.workspace_id, wsName:wsName[qr.workspace_id],
          link:`/workspaces/${qr.workspace_id}/vendors/${qr.supplier_id}/due-diligence`,
          ownerId:null, ownerLabel:null });
      });
    } catch (_) {}

    let docsNeedingReviewDate = 0;
    try {
      docsNeedingReviewDate = (await db.prepare(
        `SELECT COUNT(*) n FROM generated_docs
         WHERE workspace_id IN (${ph}) AND status IN ('approved','published') AND next_review_date IS NULL`
      ).get(...wsIds)).n;
    } catch (_) {}

    return { items, people, wsName, projects, docsNeedingReviewDate };
  }

  app.get('/calendar', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.cross_view')) {
      return res.status(403).render('error', { user: req.user, message: 'The firm calendar is for managers and senior consultants.' });
    }
    const { items, people, wsName, projects, docsNeedingReviewDate } = await collectManagerSchedule(req.user);
    const firm = (await db.prepare(`SELECT timezone FROM firms WHERE id=?`).get(req.user.firm_id)) || {};
    const clock = { firm_timezone: firm.timezone };
    const timeZone = workspaceTimeZone(clock);
    const today = todayFor(clock);
    const weekEnd = ymdInZone(new Date(Date.now() + 7 * 86400000),timeZone);

    const thisMonth = today.slice(0,7);
    const thisYear = Number(today.slice(0,4));
    const view = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? 'month' : 'year';

    let monthStr = null, monthLabel = '', monthCount = 0, prevMo = null, nextMo = null;
    let cells = [], weeks = [], laneCount = 0, monthProjects = [];
    let year = thisYear, months = [], monthRows = [], prevYear = thisYear - 1, nextYear = thisYear + 1;

    if (view === 'month') {
      monthStr = req.query.month;
      const [yr, mo] = monthStr.split('-').map(n => parseInt(n, 10));
      const monthStart = `${monthStr}-01`;
      const nextMoStart = `${shiftMonth(monthStr,1)}-01`;
      prevMo = shiftMonth(monthStr,-1);
      nextMo = shiftMonth(monthStr,1);
      monthLabel = new Date(yr, mo - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' });

      const byDate = {};
      items.forEach(e => {
        if (!e.date || e.date < monthStart || e.date >= nextMoStart) return;
        (byDate[e.date] = byDate[e.date] || []).push(e);
        monthCount++;
      });
      Object.values(byDate).forEach(list => list.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

      const firstDay = new Date(yr, mo - 1, 1).getDay();
      const daysInMonth = new Date(yr, mo, 0).getDate();
      for (let i = 0; i < firstDay; i++) cells.push(null);
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${monthStr}-${String(d).padStart(2, '0')}`;
        cells.push({ day: d, date, events: byDate[date] || [] });
      }
      while (cells.length % 7 !== 0) cells.push(null);

      const monthEndDate = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
      monthProjects = (projects || [])
        .filter(p => p.start && p.end && p.start <= monthEndDate && p.end >= monthStart)
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.name || '').localeCompare(b.name || '')));

      for (let w = 0; w < cells.length / 7; w++) weeks.push({ days: cells.slice(w * 7, w * 7 + 7), bars: [] });

      monthProjects.forEach((p, lane) => {
        const cs = p.start < monthStart ? monthStart : p.start;
        const ce = p.end > monthEndDate ? monthEndDate : p.end;
        if (cs > ce) return;
        const gridStart = firstDay + parseInt(cs.slice(8, 10), 10) - 1;
        const gridEnd = firstDay + parseInt(ce.slice(8, 10), 10) - 1;
        const wStart = Math.floor(gridStart / 7);
        const wEnd = Math.floor(gridEnd / 7);
        const contLeft = p.start < monthStart;
        const contRight = p.end > monthEndDate;
        const daysToCert = Math.round((Date.parse(p.end) - Date.parse(today)) / 86400000);
        for (let w = wStart; w <= wEnd; w++) {
          const segStart = Math.max(gridStart, w * 7);
          const segEnd = Math.min(gridEnd, w * 7 + 6);
          weeks[w].bars.push({
            lane,
            startCol: segStart - w * 7,
            endCol: segEnd - w * 7,
            name: p.name, link: p.link, stage: p.stage,
            start: p.start, end: p.end, daysToCert,
            capLeft: (w === wStart) && !contLeft,
            capRight: (w === wEnd) && !contRight,
            labelHere: (w === wStart) || (segStart % 7 === 0),
          });
        }
      });
      laneCount = monthProjects.length;
      weeks.forEach(wk => { wk.laneRows = wk.bars.length ? Math.max(...wk.bars.map(b => b.lane)) + 1 : 0; });
    } else {
      year = (req.query.year && /^\d{4}$/.test(req.query.year)) ? parseInt(req.query.year, 10) : thisYear;
      prevYear = year - 1;
      nextYear = year + 1;
      const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
      for (let m = 0; m < 12; m++) {
        const ym = `${year}-${String(m + 1).padStart(2, '0')}`;
        months.push({
          ym,
          label: new Date(year, m, 1).toLocaleString('en', { month: 'short' }),
          start: `${ym}-01`,
          end: `${ym}-${String(new Date(year, m + 1, 0).getDate()).padStart(2, '0')}`,
          count: 0, overdue: 0, byKind: {},
          isCurrent: ym === thisMonth,
        });
      }
      items.forEach(e => {
        if (!e.date || e.date < yStart || e.date > yEnd) return;
        const b = months[parseInt(e.date.slice(5, 7), 10) - 1];
        b.count++;
        b.byKind[e.kind] = (b.byKind[e.kind] || 0) + 1;
        if (e.open && e.date < today) b.overdue++;
      });

      const COLS = 4;
      for (let r = 0; r < 12 / COLS; r++) {
        monthRows.push({ months: months.slice(r * COLS, r * COLS + COLS), bars: [] });
      }

      const yearProjects = (projects || [])
        .filter(p => p.start && p.end && p.start <= yEnd && p.end >= yStart)
        .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : (a.name || '').localeCompare(b.name || ''));
      yearProjects.forEach((p, lane) => {
        const contLeft = p.start < yStart;
        const contRight = p.end > yEnd;
        const startIdx = contLeft ? 0 : parseInt(p.start.slice(5, 7), 10) - 1;
        const endIdx = contRight ? 11 : parseInt(p.end.slice(5, 7), 10) - 1;
        if (startIdx > endIdx) return;
        const daysToCert = Math.round((Date.parse(p.end) - Date.parse(today)) / 86400000);
        const rStart = Math.floor(startIdx / COLS);
        const rEnd = Math.floor(endIdx / COLS);
        for (let r = rStart; r <= rEnd; r++) {
          const segStart = Math.max(startIdx, r * COLS);
          const segEnd = Math.min(endIdx, r * COLS + COLS - 1);
          monthRows[r].bars.push({
            lane,
            startCol: segStart - r * COLS,
            endCol: segEnd - r * COLS,
            name: p.name, link: p.link, stage: p.stage,
            start: p.start, end: p.end, daysToCert,
            capLeft: (segStart === startIdx) && !contLeft,
            capRight: (segEnd === endIdx) && !contRight,
            labelHere: (segStart === startIdx) || (segStart % COLS === 0),
          });
        }
      });
      monthRows.forEach(row => { row.laneRows = row.bars.length ? Math.max(...row.bars.map(b => b.lane)) + 1 : 0; });
    }

    const overdue = items
      .filter(e => e.open && e.date && e.date < today)
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    const pmap = {};
    people.forEach(p => { pmap[p.id] = { id: p.id, name: p.name, role: p.firm_role, total: 0, overdue: 0, dueSoon: 0, byKind: {} }; });
    const unassigned = { total: 0, overdue: 0, dueSoon: 0, byKind: {} };
    let openWork = 0;
    items.forEach(e => {
      if (!e.countsWorkload || !e.open) return;
      openWork++;
      const b = (e.ownerId && pmap[e.ownerId]) ? pmap[e.ownerId] : unassigned;
      b.total++;
      b.byKind[e.kind] = (b.byKind[e.kind] || 0) + 1;
      if (e.date && e.date < today) b.overdue++;
      else if (e.date && e.date <= weekEnd) b.dueSoon++;
    });
    const workload = Object.values(pmap).sort((a, b) => b.total - a.total || (a.name || '').localeCompare(b.name || ''));
    const maxLoad = Math.max(1, unassigned.total, ...workload.map(w => w.total));

    const kpi = {
      engagements: Object.keys(wsName).length,
      openItems: openWork,
      overdue: overdue.length,
      dueSoon: items.filter(e => e.open && e.date && e.date >= today && e.date <= weekEnd).length,
      unassigned: unassigned.total,
    };

    res.render('manager_calendar', {
      user: req.user, ws: null, active: 'firm-calendar',
      view, today, thisMonth, thisYear,
      cells, weeks, laneCount, monthProjects, monthCount, monthLabel,
      prevMo, nextMo, monthStr,
      year, months, monthRows, prevYear, nextYear,
      overdue, workload, unassigned, maxLoad, kpi,
      docsNeedingReviewDate: docsNeedingReviewDate || 0,
    });
  });

}

module.exports = { register };
