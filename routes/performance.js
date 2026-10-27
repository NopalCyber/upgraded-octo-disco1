'use strict';

const ctlReads = require('../lib/control-reads');
const reqOpts = require('../lib/requirement-options');
const evReads = require('../lib/evidence-reads');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');
const performanceObjectives = require('../lib/performance-objectives');
const { todayFor, ymdInZone, workspaceTimeZone } = require('../lib/dates');
const documentTruth = require('../lib/document-truth');
const { computeReadiness } = require('../lib/readiness');
const outcomeScope = require('../lib/engagement-outcome-scope');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, upload } = deps;
  const requireDocumentImplementation = outcomeScope.requirePostGapService(
    'Policy adoption tracking is outside this gap-assessment-only engagement. Existing client documents remain available as assessment inputs.');
  const requireManagementReviewService = outcomeScope.requirePostGapService(
    'Management review delivery is outside this gap-assessment-only engagement. Use the controlled gap-assessment report for the contracted outcome.');

  async function computeIsmsMetrics(workspace) {
    const wsId = workspace.id;
    const zone = workspaceTimeZone(workspace);
    const today = todayFor(workspace);
    const ninetyDaysAgo = ymdInZone(new Date(Date.now() - 90 * 86400000), zone);
    const oneEightyDaysAgo = ymdInZone(new Date(Date.now() - 180 * 86400000), zone);
    const oneYearAgo = ymdInZone(new Date(Date.now() - 365 * 86400000), zone);
    const cnt = async (sql, ...args) => { try { return (await db.prepare(sql).get(wsId, ...args))?.c || 0; } catch (_) { return 0; } };
    const safeAll = async (sql, ...args) => { try { return await db.prepare(sql).all(wsId, ...args); } catch (_) { return []; } };
    const Tm = ctlReads.tables(db, wsId);

    const stateViews = reqOpts.enabledCodes(workspace).includes('iso27001') ? [Tm.cs] : [];
    const sumViews = async (where) => {
      let total = 0;
      for (const v of stateViews) total += await cnt(`SELECT COUNT(*) c FROM ${v} WHERE workspace_id=? AND ${where}`);
      return total;
    };
    const controlImpl = await sumViews(`status='Implemented' AND applicability='included'`);
    const controlIncluded = await sumViews(`applicability='included'`);

    const trainAssigned = await cnt(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=?`);
    const trainComplete = await cnt(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=? AND status='completed'`);

    const ncOpen = await safeAll(`SELECT severity, COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND status != 'closed' GROUP BY severity`);
    const ncBySev = { major: 0, minor: 0, observation: 0, other: 0 };
    ncOpen.forEach(r => { ncBySev[r.severity || 'other'] = (ncBySev[r.severity || 'other'] || 0) + r.c; });
    const ncOpenTotal = ncBySev.major + ncBySev.minor + ncBySev.observation + ncBySev.other;

    const ncClosed90 = await safeAll(`SELECT days_between(closed_at, created_at) AS d FROM nonconformities
      WHERE workspace_id=? AND closed_at IS NOT NULL AND closed_at >= ?`, ninetyDaysAgo);
    const mttcDays = ncClosed90.length ? Math.round(ncClosed90.reduce((s, r) => s + (r.d || 0), 0) / ncClosed90.length) : null;

    const ncClosedPrior = await safeAll(`SELECT days_between(closed_at, created_at) AS d FROM nonconformities
      WHERE workspace_id=? AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?`, oneEightyDaysAgo, ninetyDaysAgo);
    const mttcPrior = ncClosedPrior.length ? Math.round(ncClosedPrior.reduce((s, r) => s + (r.d || 0), 0) / ncClosedPrior.length) : null;

    const tasksOpen = await cnt(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status != 'closed' AND status != 'completed'`);
    const tasksOverdue = await cnt(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status != 'closed' AND status != 'completed' AND due_date IS NOT NULL AND due_date < ?`, today);

    const risksHigh = await cnt(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status != 'closed' AND status != 'accepted' AND (likelihood * impact) >= 15`);
    const risksAccepted = await cnt(`SELECT COUNT(*) c FROM risk_acceptances WHERE workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`, today);

    const docsApproved = await cnt(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published')`);
    const docsOverdue = await cnt(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND next_review_date < ?`, today);

    let evidenceFresh = 0, evidenceTotalCtl = 0;
    try {
      const rows = await db.prepare(`SELECT i.id,
          (SELECT MAX(uploaded_at) FROM evidence WHERE workspace_id=? AND iso_item_id=i.id AND superseded_at IS NULL) AS last_ev
        FROM iso_items i
        INNER JOIN ${Tm.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
        WHERE i.type='control' AND cs.applicability='included'`).all(wsId, wsId);
      evidenceTotalCtl = rows.length;
      evidenceFresh = rows.filter(r => r.last_ev && r.last_ev >= oneYearAgo).length;
    } catch (_) {}

    const auditsRun = await cnt(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL AND audit_date >= ?`, oneYearAgo);

    let incidentMTTR = null;
    try {
      const inc = await db.prepare(`SELECT days_between(COALESCE(resolved_at, closed_at), detected_at) AS d FROM incidents
        WHERE workspace_id=? AND COALESCE(resolved_at, closed_at) IS NOT NULL AND COALESCE(resolved_at, closed_at) >= ?`).all(wsId, ninetyDaysAgo);
      if (inc.length) incidentMTTR = Math.round(inc.reduce((s, r) => s + (r.d || 0), 0) / inc.length * 10) / 10;
    } catch (_) {}

    const incidentsOpen = await cnt(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=? AND status NOT IN ('closed','resolved')`);

    return {
      controlImpl, controlIncluded,
      controlImplPct: controlIncluded ? Math.round((controlImpl / controlIncluded) * 100) : 0,
      trainAssigned, trainComplete,
      trainPct: trainAssigned ? Math.round((trainComplete / trainAssigned) * 100) : 0,
      ncBySev, ncOpenTotal,
      mttcDays, mttcPrior,
      tasksOpen, tasksOverdue,
      tasksOverduePct: tasksOpen ? Math.round((tasksOverdue / tasksOpen) * 100) : 0,
      risksHigh, risksAccepted,
      docsApproved, docsOverdue,
      docsReviewPct: docsApproved ? Math.round(((docsApproved - docsOverdue) / docsApproved) * 100) : 0,
      evidenceFresh, evidenceTotalCtl,
      evidenceFreshPct: evidenceTotalCtl ? Math.round((evidenceFresh / evidenceTotalCtl) * 100) : 0,
      auditsRun,
      incidentMTTR, incidentsOpen
    };
  }

  app.get('/workspaces/:wsId/metrics', requireAuth, requireWorkspace, (req, res) => {
    res.redirect('/workspaces/' + req.workspace.id + '/metrics/adopted');
  });

  app.get('/workspaces/:wsId/performance', requireAuth, requireWorkspace, (req, res) => {
    res.redirect('/workspaces/' + req.workspace.id + '/objectives');
  });

  app.post('/workspaces/:wsId/metrics/feed-to-mrm/:mrmId', requireAuth, requireWorkspace, requireManagementReviewService, requirePermission('mrm.manage'), async (req, res) => {
    const mrm = await db.prepare(`SELECT id FROM mrms WHERE id=? AND workspace_id=?`).get(req.params.mrmId, req.workspace.id);
    if (!mrm) return res.status(404).send('MRM not found');
    const m = await computeIsmsMetrics(req.workspace);
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let block = [
      `--- ISMS performance metrics (auto-fed ${ts}) ---`,
      `Control implementation: ${m.controlImpl}/${m.controlIncluded} included controls Implemented (${m.controlImplPct}%)`,
      `Training completion: ${m.trainComplete}/${m.trainAssigned} (${m.trainPct}%)`,
      `Open NCs: ${m.ncBySev.major} major, ${m.ncBySev.minor} minor, ${m.ncBySev.observation} observation (${m.ncOpenTotal} total)`,
      `NC mean time to close (last 90d): ${m.mttcDays == null ? 'n/a' : m.mttcDays + ' days'}${m.mttcPrior != null ? ` (prior 90d: ${m.mttcPrior} days)` : ''}`,
      `Tasks overdue: ${m.tasksOverdue}/${m.tasksOpen} (${m.tasksOverduePct}%)`,
      `High-severity open risks (L×I ≥ 15): ${m.risksHigh}`,
      `Active risk acceptances: ${m.risksAccepted}`,
      `Document review compliance: ${m.docsReviewPct}% (${m.docsOverdue} overdue of ${m.docsApproved} approved)`,
      `Evidence freshness (included controls with evidence in last 12 mo): ${m.evidenceFresh}/${m.evidenceTotalCtl} (${m.evidenceFreshPct}%)`,
      `Internal audits in last 12 mo: ${m.auditsRun}`,
      `Incident MTTR (last 90d): ${m.incidentMTTR == null ? 'n/a' : m.incidentMTTR + ' days'}`,
      `Open incidents: ${m.incidentsOpen}`
    ].join('\n');
    const adoptedFeed = await db.prepare(`
      SELECT m.name, m.ref, m.unit, m.direction, m.target_value,
        (SELECT value FROM isms_metric_readings r WHERE r.metric_id=m.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1) AS latest_value,
        (SELECT measured_at FROM isms_metric_readings r WHERE r.metric_id=m.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1) AS latest_at
      FROM isms_metrics m WHERE m.workspace_id=? ORDER BY m.category NULLS FIRST, m.name`).all(req.workspace.id);
    if (adoptedFeed.length) {
      const suffix = u => u === '%' ? '%' : u === 'days' ? ' d' : '';
      const lines = adoptedFeed.map(a => {
        const rag = ismsMetricRag(a.latest_value, a.target_value, a.direction);
        const val = a.latest_value == null ? 'no reading yet' : a.latest_value + suffix(a.unit) + (a.latest_at ? ` (as of ${a.latest_at})` : '');
        const tgt = a.target_value == null ? 'no target set' : `target ${a.target_value}${suffix(a.unit)}`;
        const status = rag ? ` [${rag === 'green' ? 'on target' : rag === 'amber' ? 'near target' : 'off target'}]` : '';
        return `${a.ref} ${a.name}: ${val}; ${tgt}${status}`;
      });
      block += `\n\n--- Adopted ISO/IEC 27004 measures (${adoptedFeed.length}) ---\n` + lines.join('\n');
    }
    const existing = await db.prepare(`SELECT performance_review FROM mrms WHERE id=?`).get(mrm.id);
    const merged = existing && existing.performance_review ? `${existing.performance_review}\n\n${block}` : block;
    await db.prepare(`UPDATE mrms SET performance_review=? WHERE id=?`).run(merged, mrm.id);
    await logAction(req.user.id, req.workspace.id, 'feed_metrics_to_mrm', 'mrm', mrm.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/mrms/${mrm.id}?notice=${encodeURIComponent('Metrics appended to performance review.')}`);
  });

  const ISO27004_METRICS = require('../data/iso27004-metrics');
  const ISO27004_BY_KEY = Object.fromEntries(ISO27004_METRICS.map(m => [m.key, m]));

  function ismsMetricRag(value, target, direction) {
    return performanceObjectives.metricRag(value, target, direction);
  }

  async function coverageControls(workspace) {
    const T = ctlReads.tables(db, workspace.id);
    const sources = { iso27001: ['iso_items', T.cs] };
    const rows = [];
    for (const code of reqOpts.enabledCodes(workspace)) {
      const src = sources[code];
      if (!src) continue;
      rows.push(...(await db.prepare(`SELECT i.id, i.title, i.category, i.type, i.evidence_to_look_for, ? AS framework,
          COALESCE(cs.status,'Not Assessed') AS status,
          COALESCE(cs.applicability,'undecided') AS applicability
        FROM ${src[0]} i
        LEFT JOIN ${src[1]} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type='control'
        ORDER BY i.sort_order`).all(code, workspace.id)));
    }
    return rows;
  }

  async function resolveControls(ids) {
    if (!ids || !ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT id, title, type FROM iso_items WHERE id IN (${ph})`).all(...ids);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    return ids.map(id => byId[id] || { id, title: id, type: 'control' });
  }

  app.get('/workspaces/:wsId/metrics/library', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const adoptedById = {};
    (await db.prepare(`SELECT m.id,m.metric_key,(SELECT COUNT(*) FROM security_objectives o WHERE o.metric_id=m.id) AS objective_count
      FROM isms_metrics m WHERE m.workspace_id=?`).all(req.workspace.id)).forEach(a => { adoptedById[a.metric_key] = a; });
    const byCategory = {};

    for (const m of ISO27004_METRICS) {
      (byCategory[m.category] = byCategory[m.category] || []).push({
        ...m, adoptedId: adoptedById[m.key]?.id || null, adopted: adoptedById[m.key] != null,
        objectiveCount: adoptedById[m.key]?.objective_count || 0, controlsResolved: await resolveControls(m.controls),
      });
    }

    const categories = [
      ...ISO27004_METRICS.CATEGORIES.filter(c => byCategory[c]),
      ...Object.keys(byCategory).filter(c => !ISO27004_METRICS.CATEGORIES.includes(c)).sort(),
    ];
    res.render('metrics_library', { user: req.user, ws: req.workspace, byCategory, categories, total: ISO27004_METRICS.length,
      adoptedCount: Object.keys(adoptedById).length, customCategories: ISO27004_METRICS.CATEGORIES });
  });

  app.post('/workspaces/:wsId/metrics/library', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const picked = parseFormArray(req.body.pick);
    if (!picked.length) return redirectBack(req, res, 'Select at least one metric to adopt.', 'warn');
    const ins = db.prepare(`INSERT INTO isms_metrics
      (workspace_id, metric_key, ref, name, category, unit, direction, formula, target_value, target_text, frequency, created_by, framework)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    let added = 0;
    const tx = db.transaction(async () => {
      for (const __item of picked) await (async key => {
        const m = ISO27004_BY_KEY[key];
        if (!m) return;
        const r = await ins.run(req.workspace.id, m.key, m.ref, m.name, m.category, m.unit, m.direction,
          m.formula, m.suggestedTarget ?? null, m.targetText || null, m.frequency || null, req.user.id,
          'iso27001');
        if (r.changes) added++;
      })(__item);
    });
    await tx();
    await logAction(req.user.id, req.workspace.id, 'adopt_isms_metrics', 'isms_metric', null, { count: added }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted',
      added ? `Adopted ${added} metric${added === 1 ? '' : 's'} - set targets and record readings` : 'Those metrics were already adopted'));
  });

  app.post('/workspaces/:wsId/metrics/custom', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 200);
    if (!name) return redirectBack(req, res, 'Name the measure.', 'error');
    const direction = req.body.direction === 'lower' ? 'lower' : 'higher';
    const target = req.body.target_value === '' || req.body.target_value == null ? null : Number(req.body.target_value);
    const framework = req.body.framework === 'iso27001' && reqOpts.enabledCodes(req.workspace).includes('iso27001') ? 'iso27001' : null;
    const key = `custom-${require('crypto').randomBytes(6).toString('hex')}`;
    const id = (await db.prepare(`INSERT INTO isms_metrics (workspace_id, metric_key, ref, name, category, unit, direction, formula, target_value, target_text, frequency, owner_name, notes, created_by, framework)
      VALUES (?, ?, 'Custom', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, key, name, String(req.body.category || 'Custom measures').trim().slice(0, 80) || 'Custom measures',
      String(req.body.unit || '').trim().slice(0, 20) || null, direction, String(req.body.formula || '').trim().slice(0, 1000) || null,
      Number.isFinite(target) ? target : null, String(req.body.target_text || '').trim().slice(0, 200) || null,
      String(req.body.frequency || '').trim().slice(0, 40) || null, String(req.body.owner_name || '').trim().slice(0, 120) || null,
      String(req.body.notes || '').trim().slice(0, 2000) || null, req.user.id, framework)).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_custom_metric', 'isms_metric', id, { name, framework }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/metrics/adopted/${id}`, 'Measure created - record its first reading'));
  });

  app.get('/workspaces/:wsId/metrics/adopted', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const rows = await performanceObjectives.listAdoptedMetrics(db, req.workspace.id);
    const readingCounts = new Map((await db.prepare(`SELECT metric_id,COUNT(*) AS c FROM isms_metric_readings
      WHERE metric_id IN (SELECT id FROM isms_metrics WHERE workspace_id=?) GROUP BY metric_id`).all(req.workspace.id))
      .map(row => [row.metric_id, row.c]));
    const byCategory = {};
    rows.forEach(m => {
      m.reading_count = readingCounts.get(m.id) || 0;
      (byCategory[m.category] = byCategory[m.category] || []).push(m);
    });
    const categories = [
      ...ISO27004_METRICS.CATEGORIES.filter(c => byCategory[c]),
      ...Object.keys(byCategory).filter(c => !ISO27004_METRICS.CATEGORIES.includes(c)).sort(),
    ];
    const ragCounts = { green: 0, amber: 0, red: 0, none: 0 };
    rows.forEach(m => ragCounts[m.rag || 'none']++);
    const upcomingMrms = await db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND status != 'closed' ORDER BY meeting_date IS NULL, meeting_date LIMIT 5`).all(req.workspace.id);
    res.render('metrics_adopted', { user: req.user, ws: req.workspace, byCategory, categories, total: rows.length, ragCounts, upcomingMrms });
  });

  app.get('/workspaces/:wsId/metrics/adopted/:id', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const metric = await db.prepare(`SELECT * FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
    const readings = await db.prepare(`SELECT r.*, u.name AS recorder FROM isms_metric_readings r LEFT JOIN users u ON u.id=r.recorded_by WHERE r.metric_id=? ORDER BY r.measured_at ASC, r.id ASC`).all(metric.id);
    readings.forEach(r => { r.rag = ismsMetricRag(r.value, metric.target_value, metric.direction); });
    const catalog = ISO27004_BY_KEY[metric.metric_key] || {};
    const controlsResolved = await resolveControls(catalog.controls || []);
    const latest = readings.length ? readings[readings.length - 1] : null;
    metric.rag = latest ? ismsMetricRag(latest.value, metric.target_value, metric.direction) : null;
    const linkedObjectives = await db.prepare(`SELECT id,title,due_date,status FROM security_objectives
      WHERE workspace_id=? AND metric_id=? ORDER BY due_date IS NULL,due_date,id`).all(req.workspace.id, metric.id);
    res.render('metric_detail', { user: req.user, ws: req.workspace, metric, readings, catalog, controlsResolved, latest, linkedObjectives });
  });

  app.get('/workspaces/:wsId/metrics/readings', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const readings = await db.prepare(`
      SELECT r.*,m.id AS metric_id,m.ref,m.name AS metric_name,m.unit,m.direction,m.target_value,
        u.name AS recorder,
        (SELECT string_agg(o.title,'||') FROM security_objectives o WHERE o.metric_id=m.id) AS objective_titles
      FROM isms_metric_readings r
      JOIN isms_metrics m ON m.id=r.metric_id
      LEFT JOIN users u ON u.id=r.recorded_by
      WHERE m.workspace_id=?
      ORDER BY r.measured_at DESC,r.id DESC`).all(req.workspace.id);
    readings.forEach(reading => {
      reading.rag = ismsMetricRag(reading.value, reading.target_value, reading.direction);
      reading.objectives = reading.objective_titles ? reading.objective_titles.split('||') : [];
      reading.valueDisplay = performanceObjectives.formatMetricValue(reading.value, reading.unit);
      reading.targetDisplay = performanceObjectives.formatMetricValue(reading.target_value, reading.unit);
    });
    const measures = await db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM isms_metric_readings r WHERE r.metric_id=m.id) THEN 1 ELSE 0 END) AS with_data
      FROM isms_metrics m WHERE m.workspace_id=? AND m.is_active=1`).get(req.workspace.id);
    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const thisMonth = readings.filter(reading => reading.measured_at >= monthStart).length;
    res.render('metric_readings', {
      user: req.user, ws: req.workspace, readings,
      summary: { total: readings.length, thisMonth, measures: measures.total || 0, withData: measures.with_data || 0 },
    });
  });

  app.post('/workspaces/:wsId/metrics/adopted/:id/readings', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const metric = await db.prepare(`SELECT * FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
    const value = parseFloat(req.body.value);
    if (!Number.isFinite(value)) return redirectBack(req, res, 'Enter a numeric value.', 'warn');
    const measured_at = (req.body.measured_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const status = ismsMetricRag(value, metric.target_value, metric.direction);
    await db.prepare(`INSERT INTO isms_metric_readings (metric_id, value, measured_at, status, notes, recorded_by) VALUES (?,?,?,?,?,?)`)
      .run(metric.id, value, measured_at, status, (req.body.notes || '').trim() || null, req.user.id);
    await logAction(req.user.id, req.workspace.id, 'record_metric_reading', 'isms_metric', metric.id, { value, measured_at }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted/' + metric.id, 'Reading recorded'));
  });

  app.post('/workspaces/:wsId/metrics/adopted/:id', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const metric = await db.prepare(`SELECT id FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
    const tv = req.body.target_value;
    const target_value = (tv === '' || tv == null || !Number.isFinite(parseFloat(tv))) ? null : parseFloat(tv);
    await db.prepare(`UPDATE isms_metrics SET target_value=?, owner_name=?, frequency=?, notes=? WHERE id=?`)
      .run(target_value, (req.body.owner_name || '').trim() || null, (req.body.frequency || '').trim() || null, (req.body.notes || '').trim() || null, metric.id);
    await logAction(req.user.id, req.workspace.id, 'update_isms_metric', 'isms_metric', metric.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted/' + metric.id, 'Metric updated'));
  });

  app.post('/workspaces/:wsId/metrics/adopted/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const metric = await db.prepare(`SELECT id FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
    const linked = (await db.prepare(`SELECT COUNT(*) AS c FROM security_objectives WHERE workspace_id=? AND metric_id=?`).get(req.workspace.id, metric.id)).c;
    if (linked) return redirectBack(req, res, `This measure drives ${linked} objective${linked === 1 ? '' : 's'}. Unlink it from those objectives before removing it.`, 'warn');
    await db.prepare(`DELETE FROM isms_metrics WHERE id=?`).run(metric.id);
    await logAction(req.user.id, req.workspace.id, 'remove_isms_metric', 'isms_metric', metric.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted', 'Metric removed'));
  });

  app.get('/workspaces/:wsId/policy-adoption', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('control.view'), async (req, res) => {
    const wsId = req.workspace.id;
    const zone = workspaceTimeZone(req.workspace);
    const today = todayFor(req.workspace);
    const soonDate = ymdInZone(new Date(Date.now() + 30 * 86400000), zone);
    const staleCutoff = ymdInZone(new Date(Date.now() - 365 * 86400000), zone);

    const docs = (await Promise.all((await documentTruth.workspaceDocuments(db,wsId)).map(async document => ({
      ...document,
      approved_by_name: document.approved_by ? ((await db.prepare(`SELECT name FROM users WHERE id=?`).get(document.approved_by)) || {}).name : null,
      tier: document.template_tier || 'recommended'
    })))).sort((a,b) =>
      ({ mandatory: 1, expected: 2, recommended: 3 }[a.tier] || 4) -
      ({ mandatory: 1, expected: 2, recommended: 3 }[b.tier] || 4) ||
      a.name.localeCompare(b.name)
    );

    const decorated = docs.map(d => {
      let reviewBand = 'unset';
      if (!d.next_review_date) reviewBand = 'unset';
      else if (d.next_review_date < today) reviewBand = 'overdue';
      else if (d.next_review_date < soonDate) reviewBand = 'due_soon';
      else reviewBand = 'current';
      const stale = d.updated_at && d.updated_at < staleCutoff && d.status === 'approved';
      return { ...d, reviewBand, stale };
    });

    const templateAdoption = await documentTruth.mandatoryTemplateAdoption(db, wsId);
    const readinessTruth = await computeReadiness(req.workspace);

    const kpis = {
      total: decorated.length,
      mandatory: decorated.filter(d => d.tier === 'mandatory').length,
      expected: decorated.filter(d => d.tier === 'expected').length,
      recommended: decorated.filter(d => d.tier === 'recommended').length,
      draft: decorated.filter(d => d.status === 'draft').length,
      inReview: decorated.filter(d => d.status === 'in_review').length,
      approved: decorated.filter(d => d.status === 'approved').length,
      published: decorated.filter(d => d.status === 'published').length,
      retired: decorated.filter(d => d.status === 'retired').length,
      overdue: decorated.filter(d => d.reviewBand === 'overdue').length,
      dueSoon: decorated.filter(d => d.reviewBand === 'due_soon').length,
      noReviewDate: decorated.filter(d => d.reviewBand === 'unset').length,
      mandatoryAdopted: templateAdoption.filter(t => t.adopted).length,
      mandatoryTotal: templateAdoption.length,
      requiredRecordsFound: readinessTruth.records.mandatory.found,
      requiredRecordsTotal: readinessTruth.records.mandatory.total,
      stale: decorated.filter(d => d.stale).length
    };
    kpis.mandatoryPct = kpis.mandatoryTotal ? Math.round((kpis.mandatoryAdopted / kpis.mandatoryTotal) * 100) : 0;

    res.render('policy_adoption', { user: req.user, ws: req.workspace, docs: decorated, kpis, templateAdoption, today });
  });

  app.get('/workspaces/:wsId/evidence-coverage', requireAuth, requireWorkspace,
    requirePermission('evidence.view'), requirePermission('control.view'), async (req, res) => {
    const wsId = req.workspace.id;
    const filter = req.query.filter || 'included';
    const today = todayFor(req.workspace);
    const staleCutoff = ymdInZone(new Date(Date.now() - 365 * 86400000),workspaceTimeZone(req.workspace));

    const rows = await coverageControls(req.workspace);

    const evidenceByControl = await evReads.coverageEvidenceByControl(db, wsId);

    const matrix = rows.map(r => {
      let expected = [];
      try { expected = JSON.parse(r.evidence_to_look_for || '[]') || []; } catch (_) {}
      const ev = evidenceByControl[r.id] || { attached: 0, last_uploaded_at: null };
      const expectedCount = expected.length;
      const attachedCount = ev.attached;
      const lastUp = ev.last_uploaded_at ? ev.last_uploaded_at.slice(0, 10) : null;
      const stale = lastUp && lastUp < staleCutoff;
      let band = 'red';
      if (expectedCount === 0) band = attachedCount > 0 ? 'green' : 'gray';
      else if (attachedCount >= expectedCount && !stale) band = 'green';
      else if (attachedCount > 0) band = 'amber';
      return {
        id: r.id, title: r.title, category: r.category, framework: r.framework,
        code: reqOpts.codeOf(r), frameworkLabel: reqOpts.label(r.framework),
        href: `/workspaces/${wsId}/controls/assess/${r.id}`,
        status: r.status, applicability: r.applicability,
        expected, expectedCount, attachedCount, lastUp, stale, band
      };
    });

    let filtered = matrix;
    if (filter === 'included') filtered = matrix.filter(m => m.applicability === 'included');
    else if (filter === 'missing') filtered = matrix.filter(m => m.applicability === 'included' && m.attachedCount === 0);
    else if (filter === 'stale') filtered = matrix.filter(m => m.applicability === 'included' && m.stale);

    const included = matrix.filter(m => m.applicability === 'included');
    const kpis = {
      included: included.length,
      linked: included.filter(m => m.attachedCount > 0).length,
      fullyCovered: included.filter(m => m.band === 'green').length,
      partial: included.filter(m => m.band === 'amber').length,
      missing: included.filter(m => m.band === 'red').length,
      stale: included.filter(m => m.stale).length
    };
    kpis.linkedPct = included.length ? Math.round((kpis.linked / included.length) * 100) : 0;
    kpis.sufficiencyPct = included.length ? Math.round((kpis.fullyCovered / included.length) * 100) : 0;

    res.render('evidence_coverage', { user: req.user, ws: req.workspace, rows: filtered, kpis, filter, today,
      multiFramework: new Set(matrix.map(m => m.framework)).size > 1 });
  });

  app.get('/workspaces/:wsId/evidence-coverage.csv', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('workspace.export'),
    requirePermission('control.view'), async (req, res) => {
    const wsId = req.workspace.id;
    const staleCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const rows = await coverageControls(req.workspace);
    const evidenceByControl = await evReads.coverageEvidenceByControl(db, wsId);
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['Framework,Code,Title,Category,Applicability,Expected count,Attached count,Last upload,Stale (>12mo),Status band'];
    for (const r of rows) {
      let expected = [];
      try { expected = JSON.parse(r.evidence_to_look_for || '[]') || []; } catch (_) {}
      const ev = evidenceByControl[r.id] || { attached: 0, last_uploaded_at: null };
      const lastUp = ev.last_uploaded_at ? ev.last_uploaded_at.slice(0, 10) : '';
      const stale = lastUp && lastUp < staleCutoff;
      const band = expected.length === 0 ? (ev.attached > 0 ? 'green' : 'gray')
                  : (ev.attached >= expected.length && !stale) ? 'green'
                  : ev.attached > 0 ? 'amber' : 'red';
      const code = reqOpts.codeOf(r);
      lines.push([reqOpts.label(r.framework), code, r.title, r.category, r.applicability, expected.length, ev.attached, lastUp, stale ? 'yes' : '', band].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-coverage-${(new Date()).toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\n'));
  });

  app.get('/workspaces/:wsId/training', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const courses = await db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM training_records r WHERE r.workspace_id=c.workspace_id AND r.training_name=c.name) AS assigned_count,
        (SELECT COUNT(*) FROM training_records r WHERE r.workspace_id=c.workspace_id AND r.training_name=c.name AND r.status='completed') AS completed_count
      FROM training_courses c WHERE c.workspace_id=? ORDER BY c.name`).all(req.workspace.id);
    const records = await db.prepare(`SELECT * FROM training_records WHERE workspace_id=? ORDER BY due_date IS NULL, due_date, user_name`).all(req.workspace.id);
    const today = (new Date()).toISOString().slice(0, 10);
    const stats = {
      total: records.length,
      completed: records.filter(r => r.status === 'completed').length,
      overdue: records.filter(r => r.status !== 'completed' && r.due_date && r.due_date < today).length,
      inflight: records.filter(r => r.status === 'assigned').length
    };
    stats.completionPct = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;
    res.render('training', { user: req.user, ws: req.workspace, courses, records, stats, today });
  });

  app.post('/workspaces/:wsId/training/courses', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { name, description, duration_minutes, validity_months, required_for_roles, content_url, passing_score } = req.body;
    if (!name) return res.redirect(`/workspaces/${req.workspace.id}/training`);
    await db.prepare(`INSERT INTO training_courses (workspace_id, name, description, duration_minutes, validity_months,
      required_for_roles, content_url, has_quiz, passing_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, name.trim(), description || null,
           duration_minutes ? parseInt(duration_minutes, 10) : null,
           validity_months ? parseInt(validity_months, 10) : 12,
           required_for_roles || null, content_url || null,
           passing_score ? 1 : 0, passing_score ? parseInt(passing_score, 10) : null);
    await logAction(req.user.id, req.workspace.id, 'add_training_course', 'training_course', null, { name }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/training`);
  });

  app.post('/workspaces/:wsId/training/courses/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM training_courses WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/training`);
  });

  app.post('/workspaces/:wsId/training/records', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { user_name, user_role, training_name, assigned_date, due_date } = req.body;
    if (!user_name || !training_name) return res.redirect(`/workspaces/${req.workspace.id}/training`);
    await db.prepare(`INSERT INTO training_records (workspace_id, user_name, user_role, training_name, assigned_date, due_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'assigned')`)
      .run(req.workspace.id, user_name.trim(), user_role || null, training_name.trim(),
           assigned_date || null, due_date || null);
    await logAction(req.user.id, req.workspace.id, 'assign_training', 'training_record', null, { user_name, training_name }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/training`);
  });

  app.post('/workspaces/:wsId/training/records/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { status, completed_date, score, notes } = req.body;
    await db.prepare(`UPDATE training_records SET status=COALESCE(?,status), completed_date=COALESCE(?,completed_date),
      score=COALESCE(?,score), notes=COALESCE(?,notes) WHERE id=? AND workspace_id=?`)
      .run(status || null, completed_date || null, score || null, notes || null, req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/training`);
  });

  app.post('/workspaces/:wsId/training/records/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM training_records WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/training`);
  });

  const competenceEvidence = async req => {
    const id = Number(req.body.evidence_id) || null;
    return id && (await db.prepare('SELECT 1 FROM evidence WHERE id=? AND workspace_id=?').get(id, req.workspace.id)) ? id : null;
  };
  app.get('/workspaces/:wsId/competence', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const roles = await db.prepare(`SELECT * FROM competence_roles WHERE workspace_id=? ORDER BY name`).all(req.workspace.id);
    const records = await db.prepare(`SELECT cr.*, r.name AS role_name, e.filename AS evidence_filename
      FROM competence_records cr INNER JOIN competence_roles r ON r.id=cr.role_id
      LEFT JOIN evidence e ON e.id=cr.evidence_id AND e.workspace_id=cr.workspace_id
      WHERE cr.workspace_id=? ORDER BY r.name, cr.person_name, cr.competence`).all(req.workspace.id);
    const evidenceFiles = await db.prepare(`SELECT id, filename, uploaded_at FROM evidence
      WHERE workspace_id=? AND superseded_at IS NULL ORDER BY uploaded_at DESC LIMIT 300`).all(req.workspace.id);
    const matrix = {};
    records.forEach(r => {
      const key = r.role_name;
      if (!matrix[key]) matrix[key] = {};
      if (!matrix[key][r.person_name]) matrix[key][r.person_name] = [];
      matrix[key][r.person_name].push(r);
    });
    const today = (new Date()).toISOString().slice(0, 10);
    const soon = (new Date(Date.now() + 90 * 86400000)).toISOString().slice(0, 10);
    const stats = {
      rolesCount: roles.length,
      recordsCount: records.length,
      expired: records.filter(r => r.expires_on && r.expires_on < today).length,
      expiringSoon: records.filter(r => r.expires_on && r.expires_on >= today && r.expires_on < soon).length
    };
    res.render('competence', { user: req.user, ws: req.workspace, roles, records, matrix, stats, today, soon, evidenceFiles });
  });

  app.post('/workspaces/:wsId/competence/roles', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { name, description, required_competences } = req.body;
    if (!name) return res.redirect(`/workspaces/${req.workspace.id}/competence`);
    await db.prepare(`INSERT INTO competence_roles (workspace_id, name, description, required_competences) VALUES (?, ?, ?, ?)`)
      .run(req.workspace.id, name.trim(), description || null, required_competences || null);
    await logAction(req.user.id, req.workspace.id, 'add_competence_role', 'competence_role', null, { name }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/competence`);
  });

  app.post('/workspaces/:wsId/competence/roles/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { name, description, required_competences } = req.body;
    await db.prepare(`UPDATE competence_roles SET name=COALESCE(?,name), description=?, required_competences=? WHERE id=? AND workspace_id=?`)
      .run(name || null, description || null, required_competences || null, req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/competence`);
  });

  app.post('/workspaces/:wsId/competence/roles/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM competence_roles WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/competence`);
  });

  app.post('/workspaces/:wsId/competence/records', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { role_id, person_name, person_email, competence, evidence_type, evidence_ref, recorded_at, expires_on, notes } = req.body;
    if (!role_id || !person_name || !competence) return res.redirect(`/workspaces/${req.workspace.id}/competence`);
    const role = await db.prepare(`SELECT id FROM competence_roles WHERE id=? AND workspace_id=?`).get(role_id, req.workspace.id);
    if (!role) return res.redirect(`/workspaces/${req.workspace.id}/competence`);
    await db.prepare(`INSERT INTO competence_records (workspace_id, role_id, person_name, person_email, competence, evidence_type, evidence_ref, recorded_at, expires_on, notes, evidence_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, role_id, person_name.trim(), person_email || null, competence.trim(),
           evidence_type || null, evidence_ref || null, recorded_at || null, expires_on || null, notes || null,
           await competenceEvidence(req));
    await logAction(req.user.id, req.workspace.id, 'add_competence_record', 'competence_record', null, { role_id, person_name, competence }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/competence`);
  });

  app.post('/workspaces/:wsId/competence/records/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { evidence_type, evidence_ref, recorded_at, expires_on, notes } = req.body;
    await db.prepare(`UPDATE competence_records SET evidence_type=?, evidence_ref=?, recorded_at=?, expires_on=?, notes=?, evidence_id=? WHERE id=? AND workspace_id=?`)
      .run(evidence_type || null, evidence_ref || null, recorded_at || null, expires_on || null, notes || null,
           await competenceEvidence(req), req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/competence`);
  });

  app.post('/workspaces/:wsId/competence/records/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM competence_records WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/competence`);
  });

  app.get('/workspaces/:wsId/communication-plan', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const items = await db.prepare(`SELECT * FROM communication_plan WHERE workspace_id=? ORDER BY next_due_date IS NULL, next_due_date, what`).all(req.workspace.id);
    const today = (new Date()).toISOString().slice(0, 10);
    const stats = {
      total: items.length,
      internal: items.filter(i => i.internal_external === 'internal').length,
      external: items.filter(i => i.internal_external === 'external').length,
      overdue: items.filter(i => i.next_due_date && i.next_due_date < today).length
    };
    res.render('communication_plan', { user: req.user, ws: req.workspace, items, stats, today });
  });

  app.post('/workspaces/:wsId/communication-plan', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { what, audience, channel, frequency, owner_name, internal_external, last_sent_date, next_due_date, trigger_event, notes } = req.body;
    if (!what) return res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
    await db.prepare(`INSERT INTO communication_plan (workspace_id, what, audience, channel, frequency, owner_name, internal_external,
      last_sent_date, next_due_date, trigger_event, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, what.trim(), audience || null, channel || null, frequency || null,
           owner_name || null, internal_external || 'internal',
           last_sent_date || null, next_due_date || null, trigger_event || null, notes || null);
    await logAction(req.user.id, req.workspace.id, 'add_communication_plan', 'communication_plan', null, { what }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
  });

  app.post('/workspaces/:wsId/communication-plan/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { what, audience, channel, frequency, owner_name, internal_external, last_sent_date, next_due_date, trigger_event, notes } = req.body;
    await db.prepare(`UPDATE communication_plan SET what=COALESCE(?,what), audience=?, channel=?, frequency=?, owner_name=?,
      internal_external=COALESCE(?,internal_external), last_sent_date=?, next_due_date=?, trigger_event=?, notes=?
      WHERE id=? AND workspace_id=?`)
      .run(what || null, audience || null, channel || null, frequency || null, owner_name || null,
           internal_external || null, last_sent_date || null, next_due_date || null, trigger_event || null, notes || null,
           req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
  });

  app.post('/workspaces/:wsId/communication-plan/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM communication_plan WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
  });

}

module.exports = { register };
