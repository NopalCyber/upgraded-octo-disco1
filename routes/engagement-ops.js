'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const archiver = require('archiver');
const contentDisposition = require('content-disposition');
const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const rbac = require('../lib/rbac');
const email = require('../lib/email');
const jobs = require('../lib/jobs');
const ctlReads = require('../lib/control-reads');
const tprmDomain = require('../lib/tprm-domain');
const serviceCapabilities = require('../lib/tprm-capabilities');
const ctlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const evReads = require('../lib/evidence-reads');
const reqOpts = require('../lib/requirement-options');
const auditChecklists = require('../lib/audit-checklists');
const reports = require('../lib/reports');
const handoverExport = require('../lib/handover-export');
const reportTemplateAccess = require('../lib/report-template-access');
const assessmentPassQuality = require('../lib/assessment-pass-quality');
const gapAssessmentReport = require('../lib/gap-assessment-report');
const auditPack = require('../lib/audit-pack');
const { computeReadiness } = require('../lib/readiness');
const delivery = require('../lib/engagement-delivery');
const outcomeScope = require('../lib/engagement-outcome-scope');
const performanceObjectives = require('../lib/performance-objectives');
const { ymdLocal, ymLocal, isValidTimeZone, workspaceTimeZone } = require('../lib/dates');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml, parseFormArray, extractMentions } = require('../lib/http-helpers');
const generateDocxBuffer = require('../lib/workers').generateDocx;
const htmlToDocxPooled = require('../lib/workers').htmlToDocxPooled;

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState,
          getActiveMethodology, methodologyBand, activeEntityFilter,
          resolveUploadPath, upload, csvUpload, qUploadAny, resolveQuestionnaireFirm, computeClientStage, permissionsFor, persistQuestionnaireFiles,
          verifyAuditChain, listWorkspaces, workspaceProgress } = deps;
  const requireReadinessService = outcomeScope.requirePostGapService(
    'Certification readiness is outside this gap-assessment-only engagement. Use the assessment findings and controlled report instead.');
  const requireInternalAuditService = outcomeScope.requirePostGapService(
    'Internal audit delivery is outside this gap-assessment-only engagement. Assessment findings and client-owned recommendations remain available.');
  const requireDocumentImplementation = outcomeScope.requirePostGapService(
    'Policy and document implementation is outside this gap-assessment-only engagement. Existing client documents remain available as assessment inputs.');

  function requireExactPermission(permission) {
    return async (req, res, next) => {
      const permissions = req.userPerms || (await permissionsFor(req.user, req.workspace));
      const allowed = permissions === '*' || (permissions?.has
        ? (permissions.has('*') || permissions.has(permission))
        : Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(permission)));
      if (allowed) return next();
      await logAction(req.user.id, req.workspace.id, 'permission_denied', 'permission', permission,
        { route: `${req.method} ${req.path}` }, auditCtx(req));
      return res.status(403).render('error', {
        user: req.user,
        ws: req.workspace,
        message: `You don't have permission to do this (missing: ${permission}).`,
      });
    };
  }

  app.get('/workspaces/:wsId/exec-brief', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const readiness = await computeReadiness(ws);

    const velNow = (await db.prepare(`SELECT COUNT(*) c FROM control_state_history
      WHERE workspace_id=? AND status='Implemented'
      AND snapshot_at >= utc_text(now() + ('-30 days')::interval)`).get(ws.id)).c;
    const velPrior = (await db.prepare(`SELECT COUNT(*) c FROM control_state_history
      WHERE workspace_id=? AND status='Implemented'
      AND snapshot_at >= utc_text(now() + ('-60 days')::interval)
      AND snapshot_at < utc_text(now() + ('-30 days')::interval)`).get(ws.id)).c;
    const velocityDelta = velNow - velPrior;

    const tierBase = 50000;
    const openRisks = await db.prepare(`SELECT id, title, likelihood, impact, owner_name FROM risks
      WHERE workspace_id=? AND status NOT IN ('closed','accepted')`).all(ws.id);
    let aleSum = 0;
    for (const r of openRisks) {
      const aro = (r.likelihood || 3) / 5;
      const sle = (r.impact || 3) * tierBase;
      aleSum += aro * sle;
    }
    const residualAle = Math.round(aleSum);

    const topRisks = openRisks
      .map(r => ({ ...r, score: (r.likelihood || 0) * (r.impact || 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const topNCs = await db.prepare(`SELECT id, title, severity, due_date, status FROM nonconformities
      WHERE workspace_id=? AND status NOT IN ('closed','verified')
      ORDER BY CASE severity WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, due_date NULLS FIRST
      LIMIT 5`).all(ws.id);

    const ncTotals = await db.prepare(`SELECT
      SUM(CASE WHEN severity='major' AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS major,
      SUM(CASE WHEN severity='minor' AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS minor,
      SUM(CASE WHEN due_date < utc_today_text() AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS overdue
      FROM nonconformities WHERE workspace_id=?`).get(ws.id);

    const frameworks = Array.isArray(ws.frameworks) ? ws.frameworks : [];
    const planProjection = frameworks.includes('iso27001')
      ? await delivery.getProjection(db, ws, req.user.id)
      : null;
    const planTotal = planProjection?.summary.totalMilestones || 0;
    const planDone = planProjection?.summary.completeMilestones || 0;

    res.render('exec_brief', {
      user: req.user, ws,
      readiness,
      velocityNow: velNow, velocityPrior: velPrior, velocityDelta,
      residualAle, openRiskCount: openRisks.length,
      topRisks, topNCs, ncTotals,
      planTotal, planDone, planPct: planProjection?.summary.progressPct || 0,
      derivedStage: await computeClientStage(ws),
    });
  });


  const PLAYBOOKS = require('../data/playbooks');

  app.get('/playbooks', requireAuth, (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    res.render('playbooks_index', { user: req.user, ws: null, playbooks: PLAYBOOKS.PLAYBOOK_INDEX });
  });

  app.get('/playbooks/:id', requireAuth, (req, res) => {
    const pb = PLAYBOOKS.PLAYBOOKS[req.params.id];
    if (!pb) return res.status(404).render('error', { user: req.user, message: 'Playbook not found' });
    res.render('playbook_detail', { user: req.user, ws: null, playbook: pb });
  });

  function objectivePlan(workspace, b) {
    const text = (v, max = 4000) => (v == null ? null : (String(v).trim().slice(0, max) || null));
    const date = text(b.communicated_on, 10);
    return {
      plan_actions: text(b.plan_actions), resources: text(b.resources, 1000), evaluation_method: text(b.evaluation_method, 1000),
      communicated_on: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      framework: reqOpts.enabledCodes(workspace).includes('iso27001') ? 'iso27001' : null,
    };
  }

  app.get('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, async (req, res) => {
    const rows = await performanceObjectives.listObjectives(db, req.workspace.id);
    const metrics = await performanceObjectives.listAdoptedMetrics(db, req.workspace.id);
    const objectiveCounts = {
      total: rows.length,
      linked: rows.filter(row => row.metricDriven).length,
      onTrack: rows.filter(row => ['on_track', 'achieved'].includes(row.effectiveStatus)).length,
      attention: rows.filter(row => ['at_risk', 'off_track', 'no_data'].includes(row.effectiveStatus)).length,
    };
    res.render('objectives', {
      user: req.user, ws: req.workspace, title: 'Performance & objectives', active: 'objectives', rows, metrics, objectiveCounts
    });
  });

  app.post('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const b = req.body;
    if (!b.title || !b.title.trim()) return redirectBack(req, res, 'Objective title is required', 'error');
    const metric = b.metric_id ? await performanceObjectives.metricForWorkspace(db, b.metric_id, req.workspace.id) : null;
    if (b.metric_id && !metric) return redirectBack(req, res, 'Select a measure adopted by this client.', 'error');
    const plan = objectivePlan(req.workspace, b);
    await db.prepare(`INSERT INTO security_objectives
      (workspace_id, title, description, measurement, target_value, current_value, owner, due_date, status, notes, metric_id, status_mode,
       plan_actions, resources, evaluation_method, communicated_on, framework)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, b.title.trim(), b.description || null, b.measurement || null,
           b.target_value || null, b.current_value || null, b.owner || null,
           b.due_date || null, b.status || 'on_track', b.notes || null,
           metric ? metric.id : null, metric ? 'metric' : 'manual',
           plan.plan_actions, plan.resources, plan.evaluation_method, plan.communicated_on, plan.framework);
    await logAction(req.user.id, req.workspace.id, 'create_objective', 'objective', null, { title: b.title, metric_id: metric?.id || null });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/objectives`, metric ? 'Objective linked to live measure' : 'Objective added'));
  });

  app.post('/workspaces/:wsId/objectives/:id', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const b = req.body;
    if (!b.title || !b.title.trim()) return redirectBack(req, res, 'Objective title is required', 'error');
    const objective = await db.prepare(`SELECT id FROM security_objectives WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!objective) return res.status(404).render('error', { user: req.user, message: 'Objective not found.' });
    const metric = b.metric_id ? await performanceObjectives.metricForWorkspace(db, b.metric_id, req.workspace.id) : null;
    if (b.metric_id && !metric) return redirectBack(req, res, 'Select a measure adopted by this client.', 'error');
    const plan = objectivePlan(req.workspace, b);
    await db.prepare(`UPDATE security_objectives SET
      title=?, description=?, measurement=?, target_value=?, current_value=?, owner=?, due_date=?, status=?, notes=?,
      metric_id=?,status_mode=?, plan_actions=?, resources=?, evaluation_method=?, communicated_on=?, framework=?,
      updated_at=utc_now_text()
      WHERE id=? AND workspace_id=?`)
      .run(b.title.trim(), b.description || null, b.measurement || null,
           b.target_value || null, b.current_value || null, b.owner || null,
           b.due_date || null, b.status || 'on_track', b.notes || null,
           metric ? metric.id : null, metric ? 'metric' : 'manual',
           plan.plan_actions, plan.resources, plan.evaluation_method, plan.communicated_on, plan.framework,
           req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'update_objective', 'objective', objective.id, { metric_id: metric?.id || null });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/objectives`, 'Objective updated'));
  });

  app.post('/workspaces/:wsId/objectives/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare('DELETE FROM security_objectives WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/objectives`);
  });

  app.post('/workspaces/:wsId/soa/custom-controls', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const b = req.body;
    if (!b.code || !b.title) return redirectBack(req, res, 'Both code and title are required', 'error');
    await db.prepare(`INSERT INTO soa_custom_controls
      (workspace_id, code, title, description, source_framework, applicability, inclusion_justification, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, b.code.trim(), b.title.trim(),
           b.description || null, b.source_framework || null,
           b.applicability || 'included', b.inclusion_justification || null,
           b.status || 'Not Assessed');
    await logAction(req.user.id, req.workspace.id, 'create_custom_control', 'custom_control', null, { code: b.code });
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  app.post('/workspaces/:wsId/soa/custom-controls/:id', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const b = req.body;
    await db.prepare(`UPDATE soa_custom_controls SET
      code=?, title=?, description=?, source_framework=?, applicability=?, inclusion_justification=?, exclusion_justification=?, status=?, notes=?,
      updated_at=utc_now_text()
      WHERE id=? AND workspace_id=?`)
      .run(b.code, b.title, b.description || null, b.source_framework || null,
           b.applicability || 'included', b.inclusion_justification || null, b.exclusion_justification || null,
           b.status || 'Not Assessed', b.notes || null,
           req.params.id, req.workspace.id);
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  app.post('/workspaces/:wsId/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare('DELETE FROM soa_custom_controls WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  app.post('/workspaces/:wsId/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const b = req.body;
    const label = b.version ? `v${b.version}` : 'Metadata revision';
    const snap = captureSoASnapshot(req.workspace.id, req.user.id, null, label, 'Metadata saved');
    await db.prepare(`UPDATE soa_snapshots SET version=?, owner=?, approved_by=?, approved_at=? WHERE id=?`)
      .run(b.version || null, b.owner || null, b.approved_by || null, b.approved_at || null, snap.id);
    await logAction(req.user.id, req.workspace.id, 'update_soa_metadata', 'soa_snapshot', snap.id, b);
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function brandLogoDataUri(ws) {
    const raw = (ws && ws.brand_logo_path) ? String(ws.brand_logo_path).trim() : '';
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return null;
    const candidates = [];
    if (ws.firm_id) candidates.push(path.join(__dirname, 'uploads', `firm_${ws.firm_id}`, raw));
    candidates.push(path.join(__dirname, raw));
    if (path.isAbsolute(raw)) candidates.push(raw);
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const ext = path.extname(p).toLowerCase();
        const mime = ext === '.png'  ? 'image/png'
                   : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                   : ext === '.svg'  ? 'image/svg+xml'
                   : ext === '.webp' ? 'image/webp'
                   : ext === '.gif'  ? 'image/gif' : null;
        if (!mime) continue;
        const b64 = fs.readFileSync(p).toString('base64');
        return `data:${mime};base64,${b64}`;
      } catch (_) { }
    }
    return null;
  }

  function brandInitials(ws) {
    const name = (ws && (ws.brand_display_name || ws.client_name)) || 'ISMS';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }

  function brandColor(ws) {
    const c = ws && ws.brand_primary_color;
    if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) return c.trim();
    return '#4F46E5';
  }

  function deliverableCss(ws) {
    const accent = brandColor(ws);
    return `
      body{font-family:Calibri,sans-serif;font-size:11pt;line-height:1.45;color:#0F0F12;margin:0;}
      h1{font-size:22pt;color:#0F0F12;margin:0 0 4pt;letter-spacing:-0.01em;}
      h2{font-size:14pt;color:${accent};margin:18pt 0 6pt;border-bottom:1pt solid #ECECEF;padding-bottom:3pt;}
      h3{font-size:12pt;color:#0F0F12;margin:12pt 0 4pt;}
      .meta{color:#71717A;font-size:9.5pt;}
      table{border-collapse:collapse;width:100%;margin:6pt 0;font-size:9.5pt;}
      th,td{border:1pt solid #D6D6DB;padding:4pt 6pt;text-align:left;vertical-align:top;}
      th{background:#F4F4F5;color:#0F0F12;font-weight:500;}
      .tag{display:inline-block;padding:1pt 5pt;border-radius:3pt;font-size:8.5pt;font-weight:500;}
      .tag-impl{background:#dcfce7;color:#15803d;}
      .tag-partial{background:#fef3c7;color:#a16207;}
      .tag-wip{background:#dbeafe;color:#1d4ed8;}
      .tag-noimpl{background:#fee2e2;color:#b91c1c;}
      .tag-na{background:#e5e7eb;color:#71717A;}
    `;
  }

  function deliverableCoverHtml(title, ws) {
    const accent = brandColor(ws);
    const logo = brandLogoDataUri(ws);
    const initials = brandInitials(ws);
    const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
    const sector = ws.sector ? escHtml(ws.sector) : (ws.industry ? escHtml(ws.industry) : '');
    const today = new Date().toISOString().slice(0, 10);

    const logoLine = logo
      ? `<p style="margin:0 0 22pt 0;"><img src="${logo}" alt="" style="width:64pt;height:64pt;"></p>`
      : `<p style="margin:0 0 18pt 0;font-size:14pt;font-weight:700;color:#FFFFFF;letter-spacing:0.05em;">${escHtml(initials)}</p>`;

    const metaCells = [];
    if (sector) metaCells.push(`<td style="border:none;padding:0 24pt 0 0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Sector</strong><br>${sector}</td>`);
    metaCells.push(`<td style="border:none;padding:0 24pt 0 0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Generated</strong><br>${today}</td>`);
    if (ws.target_cert_date) {
      metaCells.push(`<td style="border:none;padding:0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Target certification</strong><br>${escHtml(ws.target_cert_date)}</td>`);
    }

    return `
      <table style="width:100%;border-collapse:collapse;border:none;margin:0 0 28pt 0;">
        <tr>
          <td style="background-color:${accent};color:#FFFFFF;padding:48pt 40pt 48pt 40pt;border:none;">
            ${logoLine}
            <p style="margin:0 0 6pt 0;font-size:10pt;font-weight:500;color:#FFFFFF;letter-spacing:0.10em;">${escHtml(title.toUpperCase())}</p>
            <p style="margin:0;font-size:30pt;font-weight:700;line-height:1.15;color:#FFFFFF;">${clientName}</p>
          </td>
        </tr>
      </table>
      <table style="width:100%;border:none;border-collapse:collapse;margin:0 0 8pt 0;">
        <tr>${metaCells.join('')}</tr>
      </table>
      <div class="page-break" style="page-break-after: always;"></div>
    `;
  }

  function deliverableHeaderHtml(title, ws) {
    const accent = brandColor(ws);
    const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${deliverableCss(ws)}</style></head><body>
      <table style="width:100%;border:none;border-collapse:collapse;font-size:9pt;color:#71717A;margin:0;">
        <tr>
          <td style="border:none;padding:0 0 3pt 0;text-align:left;"><strong style="color:#0F0F12;">${clientName}</strong></td>
          <td style="border:none;padding:0 0 3pt 0;text-align:right;">${escHtml(title)}</td>
        </tr>
      </table>
      <table style="width:100%;border:none;border-collapse:collapse;margin:0;">
        <tr><td style="background-color:${accent};border:none;padding:0;height:1.5pt;line-height:1.5pt;font-size:1pt;">&nbsp;</td></tr>
      </table>
    </body></html>`;
  }

  function deliverableFooterHtml(ws) {
    const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
    const today = new Date().toISOString().slice(0, 10);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${deliverableCss(ws)}</style></head><body>
      <table style="width:100%;border:none;font-size:8.5pt;color:#9C9CA5;margin:0;">
        <tr>
          <td style="border:none;padding:0;text-align:left;">${clientName}</td>
          <td style="border:none;padding:0;text-align:center;">${today}</td>
          <td style="border:none;padding:0;text-align:right;">Page </td>
        </tr>
      </table>
    </body></html>`;
  }

  function deliverableHtmlShell(title, ws, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
      <style>${deliverableCss(ws)}</style></head><body>
      ${deliverableCoverHtml(title, ws)}
      <div style="padding:0 6pt;">
        <h1>${escHtml(title)}</h1>
        ${bodyHtml}
      </div>
      </body></html>`;
  }

  async function brandedDocx(ws, title, bodyHtml) {
    const html = deliverableHtmlShell(title, ws, bodyHtml);
    return await require('../lib/workers').htmlToDocxPooled(
      html,
      deliverableHeaderHtml(title, ws),
      {
        title,
        subject: `${ws.client_name || ''} · ${title}`,
        creator: 'ISMS tool',
        header: true,
        footer: true,
        pageNumber: true,
        skipFirstHeaderFooter: true,
        table: { row: { cantSplit: true } }
      },
      deliverableFooterHtml(ws)
    );
  }
  function statusTag(s) {
    if (!s) return '<span class="tag tag-na">-</span>';
    const cls = s === 'Implemented' ? 'tag-impl'
      : s === 'Partially Implemented' ? 'tag-partial'
      : s === 'Work In Progress' ? 'tag-wip'
      : s === 'Not Implemented' ? 'tag-noimpl'
      : 'tag-na';
    return `<span class="tag ${cls}">${escHtml(s)}</span>`;
  }

  app.get('/workspaces/:wsId/export/rtp.docx', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('risk.view'),
    requirePermission('control.view'), async (req, res) => {
    const ws = req.workspace;
    const risks = await db.prepare(`SELECT r.* FROM risks r
      WHERE r.workspace_id=? AND r.management_system='iso27001'
      ORDER BY (r.likelihood * r.impact) DESC, r.id`).all(ws.id);
    const actionsByRisk = {};
    const ctrlByRisk = {};
    const acceptanceByRisk = {};
    if (risks.length) {
      const rids = risks.map(r => r.id);
      const ph = rids.map(() => '?').join(',');
      (await db.prepare(`SELECT * FROM risk_treatment_actions WHERE risk_id IN (${ph}) ORDER BY due_date IS NULL, due_date`)
        .all(...rids)).forEach(a => { (actionsByRisk[a.risk_id] = actionsByRisk[a.risk_id] || []).push(a); });
      (await db.prepare(`SELECT rc.risk_id, rc.iso_item_id, i.title FROM risk_controls rc
        INNER JOIN iso_items i ON i.id = rc.iso_item_id WHERE rc.risk_id IN (${ph}) ORDER BY i.sort_order`)
        .all(...rids)).forEach(c => { (ctrlByRisk[c.risk_id] = ctrlByRisk[c.risk_id] || []).push(c); });
      (await db.prepare(`SELECT risk_id, accepter_name AS signed_by_name, signed_at, expires_at FROM risk_acceptances
        WHERE risk_id IN (${ph}) AND revoked_at IS NULL ORDER BY signed_at NULLS FIRST`).all(...rids))
        .forEach(a => { acceptanceByRisk[a.risk_id] = a; });
    }

    let body = `<h2>Methodology</h2><p>This Risk Treatment Plan documents, for every risk in the register, the chosen treatment option, the controls applied, the responsible owner, and the implementation timeframe - as required by ISO/IEC 27001:2022 clause 6.1.3.</p>`;
    body += `<p>Risks: <strong>${risks.length}</strong></p>`;
    body += '<h2>Treatment plan by risk</h2>';
    if (risks.length === 0) {
      body += '<p><em>No risks recorded yet.</em></p>';
    } else {
      body += `<table><thead><tr><th width="8%">ID</th><th>Risk</th><th width="10%">L×I</th><th width="10%">Treatment</th><th width="12%">Owner</th><th>Controls applied</th><th>Actions</th><th width="10%">Residual</th></tr></thead><tbody>`;
      for (const r of risks) {
        const ctrls = (ctrlByRisk[r.id] || []).map(c => escHtml(c.title)).join('<br>') || '<em class="meta">-</em>';
        const acts = (actionsByRisk[r.id] || []).map(a => `<strong>${escHtml(a.title)}</strong><br><span class="meta">${escHtml(a.owner_name || a.assignee_role || '')}${a.due_date ? ' · due ' + escHtml(a.due_date) : ''} · ${escHtml(a.status || '')}</span>`).join('<br><br>') || '<em class="meta">-</em>';
        const acc = acceptanceByRisk[r.id];
        const residual = (r.residual_likelihood && r.residual_impact ? `${r.residual_likelihood}×${r.residual_impact}` : '-')
          + (acc ? `<br><span class="meta">accepted by ${escHtml(acc.signed_by_name || '')}${acc.signed_at ? ' on ' + escHtml(String(acc.signed_at).slice(0, 10)) : ''}</span>` : '');
        body += `<tr><td>R-${r.id}</td><td><strong>${escHtml(r.title)}</strong>${r.description ? '<br><span class="meta">' + escHtml(r.description) + '</span>' : ''}</td><td>${r.likelihood || '-'}×${r.impact || '-'}</td><td>${escHtml(r.treatment || '-')}</td><td>${escHtml(r.owner_name || '-')}</td><td>${ctrls}</td><td>${acts}</td><td>${residual}</td></tr>`;
      }
      body += '</tbody></table>';
    }
    const buf = await brandedDocx(ws, 'Risk Treatment Plan', body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="risk-treatment-plan-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
    res.send(buf);
  });

  async function loadReportPass(req, framework = 'iso27001') {
    const ws = req.workspace;
    const passId = req.query.pass ? parseInt(req.query.pass, 10) : null;
    if (!passId) return null;
    const table = gapAssessmentReport.profileFor(framework).passTable;
    return (await db.prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`).get(passId, ws.id)) || null;
  }

  async function gapReportData(req, res, framework = 'iso27001') {
    const ws = req.workspace;
    const profile = gapAssessmentReport.profileFor(framework);
    const pass = await loadReportPass(req, framework);
    if (req.query.pass && !pass) {
      res.redirect(withToast(`/workspaces/${ws.id}/${profile.gapPath}`,
        'The selected assessment pass no longer exists. Download the current status report instead.', 'error'));
      return null;
    }
    return await gapAssessmentReport.buildGapAssessmentReportData(db, ws, pass, { currentState: !pass, framework });
  }

  const reportPara = (v) => (v ? String(v).split(/\n{2,}/).map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('') : '<p class="meta">Not recorded.</p>');
  const reportDate = (v) => (v ? String(v).slice(0, 10) : 'Not recorded');
  const reportFacts = (rows) => `<table><tbody>${rows.map(([k, v]) => `<tr><th width="30%">${escHtml(k)}</th><td>${escHtml(v == null || v === '' ? 'Not recorded' : v)}</td></tr>`).join('')}</tbody></table>`;

  async function managementReviewReport(workspace, mrmId) {
    const m = await db.prepare('SELECT * FROM mrms WHERE id=? AND workspace_id=?').get(mrmId, workspace.id);
    if (!m) return null;
    const sections = [
      ['Status of actions from previous reviews', m.prior_actions_status],
      ['Changes in external and internal issues', m.context_changes],
      ['Changes in the needs and expectations of interested parties', m.interested_party_changes],
      ['Performance of the management system', m.performance_review],
      ['Feedback from interested parties', m.feedback_interested_parties],
      ['Results of risk assessment and status of risk treatment', m.risk_treatment_status],
      ['Opportunities for continual improvement', m.improvement_opportunities],
    ];
    let body = reportFacts([['Meeting date', reportDate(m.meeting_date)], ['Attendees', m.attendees], ['Status', m.status]]);
    body += '<h2>Inputs considered</h2>';
    for (const [label, value] of sections) body += `<h3>${escHtml(label)}</h3>${reportPara(value)}`;
    body += `<h2>Decisions</h2>${reportPara(m.decisions)}<h2>Actions</h2>${reportPara(m.action_items)}`;
    return { title: `Management Review Minutes - ${reportDate(m.meeting_date)}`, body, filename: `management-review-${m.id}` };
  }

  async function internalAuditReport(workspace, auditId) {
    const a = await db.prepare('SELECT * FROM audits WHERE id=? AND workspace_id=?').get(auditId, workspace.id);
    if (!a) return null;
    const findings = await db.prepare(`SELECT f.*, i.title AS iso_title FROM audit_findings f
      LEFT JOIN iso_items i ON i.id = f.iso_item_id WHERE f.audit_id=? ORDER BY f.created_at, f.id`).all(a.id);
    const observations = await db.prepare(`SELECT o.*, i.title AS iso_title FROM audit_observations o
      LEFT JOIN iso_items i ON i.id = o.iso_item_id WHERE o.audit_id=? ORDER BY o.id`).all(a.id);
    const samples = await db.prepare(`SELECT s.*, i.title AS iso_title FROM audit_samples s
      LEFT JOIN iso_items i ON i.id = s.iso_item_id WHERE s.audit_id=? ORDER BY s.sample_taken_at NULLS FIRST, s.id`).all(a.id);
    let body = reportFacts([
      ['Audit', a.title], ['Scope', a.scope], ['Date', reportDate(a.audit_date)], ['Auditor', a.auditor_name],
      ['Auditor competence', a.auditor_competence], ['Auditor independence', a.auditor_independence],
      ['Stage', a.lifecycle_stage], ['Sample', a.sample_size && a.population_size ? `${a.sample_size} of ${a.population_size}` : a.sample_size],
    ]);
    body += `<h2>Summary</h2>${reportPara(a.summary)}`;
    if (a.sampling_justification) body += `<h3>Sampling</h3>${reportPara(a.sampling_justification)}`;
    body += `<h2>Findings (${findings.length})</h2>`;
    body += findings.length
      ? `<table><thead><tr><th width="16%">Type</th><th width="10%">Severity</th><th width="28%">Requirement</th><th>Finding</th><th width="10%">Status</th></tr></thead><tbody>${findings.map((f) => `<tr><td>${escHtml(String(f.finding_type || '').replace(/_/g, ' '))}</td><td>${escHtml(f.severity)}</td><td>${escHtml(f.iso_title || '-')}</td><td>${escHtml(f.description)}${f.nonconformity_id ? `<br><span class="meta">Nonconformity NC-${f.nonconformity_id}</span>` : ''}</td><td>${escHtml(f.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p>No findings were raised.</p>';
    body += `<h2>Audit checklist (${observations.length})</h2>`;
    body += observations.length
      ? `<table><thead><tr><th width="30%">Requirement</th><th>Result</th><th width="10%">Status</th></tr></thead><tbody>${observations.map((o) => `<tr><td>${escHtml(o.iso_title || '-')}</td><td>${escHtml(o.description || '')}${o.recommendation ? `<br><span class="meta">Recommendation: ${escHtml(o.recommendation)}</span>` : ''}</td><td>${escHtml(o.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p>No checklist items were recorded.</p>';
    if (samples.length) {
      body += `<h2>Samples taken (${samples.length})</h2><table><thead><tr><th width="28%">Requirement</th><th>What was sampled</th><th width="14%">Size</th><th width="24%">Result</th></tr></thead><tbody>${samples.map((s) => `<tr><td>${escHtml(s.iso_title || '-')}</td><td>${escHtml(s.description)}</td><td>${escHtml(s.sample_size && s.population_size ? `${s.sample_size} of ${s.population_size}` : '-')}</td><td>${escHtml(s.finding || '-')}</td></tr>`).join('')}</tbody></table>`;
    }
    return { title: `Internal Audit Report - ${a.title}`, body, filename: `internal-audit-${a.id}` };
  }

  const sendReport = async (req, res, report, action, entity, entityId) => {
    if (!report) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'That record was not found.' });
    const buf = await brandedDocx(req.workspace, report.title, report.body);
    await logAction(req.user.id, req.workspace.id, action, entity, entityId, { bytes: buf.length }, auditCtx(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}-${new Date().toISOString().slice(0, 10)}.docx"`);
    res.send(buf);
  };
  const requireAuditService = outcomeScope.requirePostGapService('Internal audit delivery is outside this gap-assessment-only engagement.');
  const requireReviewService = outcomeScope.requirePostGapService('Management review delivery is outside this gap-assessment-only engagement.');

  app.get('/workspaces/:wsId/mrms/:id(\\d+)/minutes.docx', requireAuth, requireWorkspace, requireReviewService,
    requirePermission('workspace.export'), async (req, res) => {
    await sendReport(req, res, await managementReviewReport(req.workspace, Number(req.params.id)), 'export_mrm_minutes', 'mrm', Number(req.params.id));
  });

  app.get('/workspaces/:wsId/audits/:id(\\d+)/report.docx', requireAuth, requireWorkspace, requireAuditService,
    requirePermission('workspace.export'), async (req, res) => {
    await sendReport(req, res, await internalAuditReport(req.workspace, Number(req.params.id)), 'export_internal_audit_report', 'audit', Number(req.params.id));
  });

  app.get('/workspaces/:wsId/export/gap-report.docx', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'),
    requirePermission('evidence.view'), requirePermission('evidence.export'),
    requirePermission('task.manage'),
    requirePermission('nc.manage'), requirePermission('members.view'),
    requirePermission('audit.manage'), async (req, res) => {
    const data = await gapReportData(req, res);
    if (!data) return;
    const title = data.currentState
      ? 'ISO/IEC 27001:2022 Gap Assessment - Current Status'
      : `ISO/IEC 27001:2022 Gap Assessment - Pass ${data.pass.pass_number}`;
    const html = gapAssessmentReport.renderGapAssessmentHtml(data);
    const buf = await htmlToDocxPooled(html, gapAssessmentReport.reportHeader(data), {
      title,
      subject: `${data.workspace.client_name} - ${title}`,
      creator: data.firmName,
      header: true,
      footer: true,
      pageNumber: true,
      skipFirstHeaderFooter: false,
      table: { row: { cantSplit: true } }
    }, gapAssessmentReport.reportFooter(data));
    await logAction(req.user.id, data.workspace.id, 'export_gap_assessment_docx', data.currentState ? 'assessment_status' : 'assessment_pass', data.currentState ? data.reportId : data.pass.id,
      { report_id: data.reportId, report_mode: data.currentState ? 'current_state' : 'assessment_pass', not_assessed: data.notAssessedCount, snapshot_hash: data.reportHash, bytes: buf.length }, auditCtx(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${data.reportId}-${new Date().toISOString().slice(0,10)}.docx"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  });

  app.get('/workspaces/:wsId/export/gap-report.pdf', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'),
    requirePermission('evidence.view'), requirePermission('evidence.export'),
    requirePermission('task.manage'),
    requirePermission('nc.manage'), requirePermission('members.view'),
    requirePermission('audit.manage'), async (req, res) => {
    const data = await gapReportData(req, res);
    if (!data) return;
    const html = gapAssessmentReport.renderGapAssessmentHtml(data);
    const raw = await auditPack.renderPDF(html, {
      headerLeft: data.firmName,
      headerRight: `ISO/IEC 27001:2022 GAP ASSESSMENT - ${data.workspace.client_name}`,
      footerLeft: `CONFIDENTIAL - CLIENT COPY - ${data.reportId} - REV ${data.revision}`
    });
    const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    await logAction(req.user.id, data.workspace.id, 'export_gap_assessment_pdf', data.currentState ? 'assessment_status' : 'assessment_pass', data.currentState ? data.reportId : data.pass.id,
      { report_id: data.reportId, report_mode: data.currentState ? 'current_state' : 'assessment_pass', not_assessed: data.notAssessedCount, snapshot_hash: data.reportHash, bytes: pdf.length }, auditCtx(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${data.reportId}-${new Date().toISOString().slice(0,10)}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  });

  app.get('/workspaces/:wsId/export/recommendations.docx', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'), async (req, res) => {
    const ws = req.workspace;
    const pass = await db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=?
      ORDER BY (status='in_progress') DESC, pass_number DESC LIMIT 1`).get(ws.id);
    const quality = await assessmentPassQuality.qualityForPass(db, ws.id, pass);
    if (!quality.ready) {
      return res.redirect(withToast(`/workspaces/${ws.id}/gap-assessment`,
        `Recommendations memo unavailable. ${assessmentPassQuality.gateMessage(quality)}`, 'error'));
    }
    const items = await db.prepare(`SELECT i.id, i.type, i.title, COALESCE(cs.status,'Not Assessed') AS status,
        cs.maturity, cs.notes
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') AND COALESCE(cs.status,'Not Assessed') IN ('Not Implemented','Partially Implemented','Work In Progress')
      ORDER BY (CASE COALESCE(cs.status,'Not Assessed')
        WHEN 'Not Implemented' THEN 0
        WHEN 'Partially Implemented' THEN 1
        WHEN 'Work In Progress' THEN 2 ELSE 3 END), i.sort_order`).all(ws.id);

    let body = '<h2>How to read this memo</h2><p>This memo lists recommended remediation activity from the most recent gap assessment, ranked by current implementation status. Each row identifies the clause / control, the current status, and the consultant\'s notes from the assessment. Implementation is the client\'s responsibility; the consultant will return to verify each item once the client signals it is complete.</p>';
    body += `<p>Items requiring action: <strong>${items.length}</strong></p>`;
    body += '<h2>Recommendations</h2>';
    if (items.length === 0) {
      body += '<p><em>No outstanding recommendations - every assessed item is at "Implemented".</em></p>';
    } else {
      body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th>Recommendation / consultant notes</th></tr></thead><tbody>';
      for (const r of items) {
        const code = r.id.replace(/^annex-/,'').replace(/^clause-/,'').toUpperCase();
        const cleanTitle = r.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
        body += `<tr><td>${escHtml(code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${escHtml(r.notes || '')}</td></tr>`;
      }
      body += '</tbody></table>';
    }

    const buf = await brandedDocx(ws, 'Recommendations Memo', body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="recommendations-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
    res.send(buf);
  });

  app.get('/workspaces/:wsId/export/readiness-pack.zip', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('evidence.download'), requirePermission('workspace.export'),
    requireReadinessService,
    requirePermission('control.view'), requirePermission('risk.view'),
    requirePermission('audit.manage'), requirePermission('mrm.manage'),
    async (req, res) => {
    const ws = req.workspace;
    const stage = (req.query.stage === '2') ? 2 : 1;
    const dateLabel = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="readiness-pack-stage${stage}-${ws.id}-${dateLabel}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { try { res.status(500).send(String(err)); } catch (_) {} });
    archive.pipe(res);

    const soaRows = await db.prepare(`SELECT i.id, i.title, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' ORDER BY i.sort_order`).all(ws.id);
    const customRows = await db.prepare(`SELECT * FROM soa_custom_controls WHERE workspace_id=? ORDER BY code`).all(ws.id);
    const csvLines = ['id,title,applicability,status,justification'];
    function csvEsc(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
    for (const r of soaRows) {
      csvLines.push([r.id.replace('annex-','').toUpperCase(), csvEsc(r.title.replace(/^A\.[0-9.]+ /,'')), r.applicability, r.status, csvEsc(r.applicability === 'excluded' ? r.exclusion_justification : r.inclusion_justification)].join(','));
    }
    for (const c of customRows) {
      csvLines.push([csvEsc(c.code), csvEsc(c.title), c.applicability, c.status, csvEsc(c.applicability === 'excluded' ? c.exclusion_justification : c.inclusion_justification)].join(','));
    }
    archive.append(csvLines.join('\n'), { name: '01_soa.csv' });

    const risks = await db.prepare(`SELECT r.* FROM risks r
      WHERE r.workspace_id=? ORDER BY (r.likelihood*r.impact) DESC, r.id`).all(ws.id);
    let rtpBody = `<p>Risks: ${risks.length}</p><table><thead><tr><th>ID</th><th>Risk</th><th>L×I</th><th>Treatment</th><th>Owner</th></tr></thead><tbody>`;
    for (const r of risks) {
      rtpBody += `<tr><td>R-${r.id}</td><td>${escHtml(r.title)}</td><td>${r.likelihood || ''}×${r.impact || ''}</td><td>${escHtml(r.treatment || '')}</td><td>${escHtml(r.owner_name || '')}</td></tr>`;
    }
    rtpBody += '</tbody></table>';
    const rtpDocx = await brandedDocx(ws, 'Risk Treatment Plan', rtpBody);
    archive.append(rtpDocx, { name: '02_risk_treatment_plan.docx' });

    const audits = await db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC NULLS LAST`).all(ws.id);
    const auditCsv = ['id,title,scope,audit_date,auditor,status,summary'];
    for (const a of audits) {
      auditCsv.push([a.id, csvEsc(a.title || ''), csvEsc(a.scope || ''), a.audit_date || '', csvEsc(a.auditor_name || ''), a.status || '', csvEsc(a.summary || '')].join(','));
    }
    archive.append(auditCsv.join('\n'), { name: '03_internal_audits.csv' });

    const mrms = await db.prepare(`SELECT * FROM mrms WHERE workspace_id=? ORDER BY meeting_date DESC NULLS LAST`).all(ws.id);
    const mrmCsv = ['id,meeting_date,status,attendees'];
    for (const m of mrms) {
      mrmCsv.push([m.id, m.meeting_date || '', m.status || '', csvEsc(m.attendees || '')].join(','));
    }
    archive.append(mrmCsv.join('\n'), { name: '04_management_reviews.csv' });

    const ip = await db.prepare(`SELECT * FROM interested_parties WHERE workspace_id=? ORDER BY party`).all(ws.id);
    const ipCsv = ['party,party_type,needs,how_addressed,owner,review_cadence,last_reviewed,next_review'];
    for (const r of ip) {
      ipCsv.push([csvEsc(r.party), csvEsc(r.party_type), csvEsc(r.needs), csvEsc(r.how_addressed), csvEsc(r.owner), csvEsc(r.review_cadence), r.last_reviewed || '', r.next_review || ''].join(','));
    }
    archive.append(ipCsv.join('\n'), { name: '05_interested_parties.csv' });

    const objs = await db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=? ORDER BY due_date IS NULL, due_date`).all(ws.id);
    const objCsv = ['title,measurement,target_value,current_value,owner,due_date,status'];
    for (const o of objs) {
      objCsv.push([csvEsc(o.title), csvEsc(o.measurement), csvEsc(o.target_value), csvEsc(o.current_value), csvEsc(o.owner), o.due_date || '', o.status || ''].join(','));
    }
    archive.append(objCsv.join('\n'), { name: '06_objectives.csv' });

    const evidence = await db.prepare(`SELECT e.*, u.name AS uploader,
      ${evReads.linkedControlsSubquery()} AS linked_controls
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id=? AND e.superseded_at IS NULL ORDER BY e.uploaded_at`).all(ws.id);
    const evCsv = ['id,filename,sha256,uploader,uploaded_at,period,valid_from,valid_until,linked_controls,description'];
    for (const e of evidence) {
      evCsv.push([e.id, csvEsc(e.filename), e.sha256 || '', csvEsc(e.uploader), e.uploaded_at ? e.uploaded_at.slice(0,19) : '', csvEsc(e.period_label), e.valid_from || '', e.valid_until || '', csvEsc(e.linked_controls), csvEsc(e.description)].join(','));
    }
    archive.append(evCsv.join('\n'), { name: '07_evidence_manifest.csv' });
    for (const e of evidence) {
      const found = resolveUploadPath(e.stored_path, ws.firm_id);
      if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
        archive.file(found, { name: `evidence/${e.id}-${e.filename}` });
      }
    }

    archive.append(
  `Stage ${stage} readiness pack - ${ws.client_name || 'Workspace ' + ws.id}
  Generated ${new Date().toISOString()}

  Contents:
    01_soa.csv                - Statement of Applicability (Annex A + custom controls)
    02_risk_treatment_plan.docx - Formal RTP (clause 6.1.3.e)
    03_internal_audits.csv    - Internal audit programme history
    04_management_reviews.csv - MRM history
    05_interested_parties.csv - Clause 4.2 register
    06_objectives.csv         - Clause 6.2 register
    07_evidence_manifest.csv  - Index of every evidence file with SHA-256 + linked controls
    evidence/                 - Actual evidence artefacts (filename: <id>-<name>)

  This is the artefact set a Stage ${stage} certification audit will request.
  SHA-256 in the manifest lets the auditor verify nothing was altered after export.
  `, { name: 'README.txt' });

    archive.finalize();
  });

  app.get('/workspaces/:wsId/documents/tree', requireAuth, requireWorkspace, requirePermission('document.view'), async (req, res) => {
    const docs = await db.prepare(`SELECT id, name, category, status, parent_doc_id, doc_kind, reference_code, version
      FROM generated_docs WHERE workspace_id=? ORDER BY parent_doc_id IS NOT NULL, name`).all(req.workspace.id);
    res.render('documents_tree', { user: req.user, ws: req.workspace, docs });
  });

  app.post('/workspaces/:wsId/documents/:id/parent', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.edit'), async (req, res) => {
    const pid = req.body.parent_doc_id ? parseInt(req.body.parent_doc_id, 10) : null;
    if (pid && pid == req.params.id) return redirectBack(req, res);
    await db.prepare('UPDATE generated_docs SET parent_doc_id=?, doc_kind=?, reference_code=? WHERE id=? AND workspace_id=?')
      .run(pid, req.body.doc_kind || null, req.body.reference_code || null, req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'reparent_document', 'document', req.params.id, { parent_doc_id: pid }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/documents/${req.params.id}`);
  });

  app.get('/workspaces/:wsId/audit-programme', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    let programme = await db.prepare('SELECT * FROM audit_programmes WHERE workspace_id=? AND year=?').get(req.workspace.id, year);
    if (!programme) {
      await db.prepare('INSERT INTO audit_programmes (workspace_id, year) VALUES (?, ?)').run(req.workspace.id, year);
      programme = await db.prepare('SELECT * FROM audit_programmes WHERE workspace_id=? AND year=?').get(req.workspace.id, year);
    }
    const audits = await db.prepare(`SELECT * FROM audits WHERE workspace_id=? AND audit_date BETWEEN ? AND ? ORDER BY audit_date`)
      .all(req.workspace.id, `${year}-01-01`, `${year}-12-31`);
    res.render('audit_programme', { user: req.user, ws: req.workspace, programme, audits, year });
  });

  app.post('/workspaces/:wsId/audit-programme/:id', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const { description, approved_by } = req.body;
    const sets = [];
    const vals = [];
    if (description !== undefined) { sets.push('description=?'); vals.push(description || null); }
    if (approved_by) { sets.push('approved_by=?', 'approved_at=utc_now_text()'); vals.push(approved_by); }
    if (sets.length) {
      vals.push(req.params.id, req.workspace.id);
      await db.prepare(`UPDATE audit_programmes SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    }
    await logAction(req.user.id, req.workspace.id, 'update_programme', 'programme', req.params.id, null, auditCtx(req));
    redirectBack(req, res);
  });

  app.get('/api/sample-size', (req, res) => {
    const N = Math.max(0, parseInt(req.query.population || 0, 10));
    const n0 = 384.16;
    if (N === 0) return res.json({ recommended: 0, note: 'Provide a population size.' });
    const adjusted = Math.ceil(n0 / (1 + (n0 - 1) / N));
    const idxs = [];
    const seen = new Set();
    while (idxs.length < Math.min(adjusted, N)) {
      const r = 1 + Math.floor(Math.random() * N);
      if (!seen.has(r)) { seen.add(r); idxs.push(r); }
    }
    idxs.sort((a, b) => a - b);
    res.json({ population: N, recommended: Math.min(adjusted, N), method: '95% CI / 5% margin (Cochran)', sample_indices: idxs });
  });

  const incidentDetailPath = req => `/workspaces/${req.workspace.id}/incidents/${req.params.id}`;

  app.post('/workspaces/:wsId/incidents/:id/events', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    const { phase, event_at, description, actor } = req.body;
    if (!phase || !description) return res.redirect(incidentDetailPath(req));
    await db.prepare(`INSERT INTO incident_events (workspace_id, incident_id, phase, event_at, description, actor)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, phase,
      event_at || new Date().toISOString(), description, actor || req.user.name);
    const phaseColumnMap = { detect: null, contain: 'contained_at', eradicate: 'eradicated_at', recover: 'recovered_at' };
    if (phaseColumnMap[phase]) {
      await db.prepare(`UPDATE incidents SET ${phaseColumnMap[phase]}=COALESCE(${phaseColumnMap[phase]}, ?) WHERE id=? AND workspace_id=?`) // nosemgrep: javascript.express.security.injection.tainted-sql-string.tainted-sql-string
        .run(event_at || new Date().toISOString(), req.params.id, req.workspace.id);
    }
    await logAction(req.user.id, req.workspace.id, 'add_incident_event', 'incident', req.params.id, { phase }, auditCtx(req));
    res.redirect(incidentDetailPath(req));
  });

  app.post('/workspaces/:wsId/incidents/:id/runbook', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    const detailPath = incidentDetailPath(req);
    const rawRunbookId = String(req.body.runbook_id || '').trim();
    let rid = null;
    if (rawRunbookId) {
      rid = Number(rawRunbookId);
      if (!Number.isSafeInteger(rid) || rid < 1) {
        return res.redirect(withToast(detailPath, 'Choose a valid runbook.', 'error'));
      }
      const allowedRunbook = await db.prepare(`SELECT id FROM runbooks
        WHERE id=? AND (is_system=1 OR firm_id=?)`).get(rid, req.workspace.firm_id);
      if (!allowedRunbook) {
        return res.redirect(withToast(detailPath, 'That runbook is not available to this firm.', 'error'));
      }
    }
    const updated = await db.prepare('UPDATE incidents SET runbook_id=? WHERE id=? AND workspace_id=?')
      .run(rid, req.params.id, req.workspace.id);
    if (!updated.changes) return res.status(404).send('Incident not found');
    await logAction(req.user.id, req.workspace.id, 'attach_runbook', 'incident', req.params.id, { runbook_id: rid }, auditCtx(req));
    res.redirect(withToast(detailPath, rid ? 'Runbook attached' : 'Runbook removed'));
  });

  app.post('/workspaces/:wsId/incidents/:id/regulator-clock', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    const { detected_at, regulator, hours } = req.body;
    if (!detected_at || !hours) return res.redirect(incidentDetailPath(req));
    const due = new Date(new Date(detected_at).getTime() + parseFloat(hours) * 3600 * 1000).toISOString();
    await db.prepare('UPDATE incidents SET notification_required_by=? WHERE id=? AND workspace_id=?').run(due, req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'set_regulator_clock', 'incident', req.params.id, { regulator, due }, auditCtx(req));
    res.redirect(incidentDetailPath(req));
  });

  app.post('/workspaces/:wsId/incidents/:id/notify-sent', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    await db.prepare('UPDATE incidents SET notification_sent_at=utc_now_text() WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    res.redirect(incidentDetailPath(req));
  });

  app.post('/workspaces/:wsId/incidents/:id/pir', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    await db.prepare('UPDATE incidents SET pir_completed=1, pir_summary=? WHERE id=? AND workspace_id=?').run(req.body.pir_summary || null, req.params.id, req.workspace.id);
    res.redirect(incidentDetailPath(req));
  });

  app.post('/workspaces/:wsId/vendors/:id/monitoring', requireAuth, requireWorkspace,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.MONITORING_SIGNALS),
    requirePermission('tprm.monitoring.manage'), async (req, res) => {
    const { source, score, grade, recorded_at, notes } = req.body;
    if (!source) return redirectBack(req, res);
    const supplier = await db.prepare('SELECT id,name FROM suppliers WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!supplier) return res.status(404).render('error', { user:req.user, ws:req.workspace, message:'Third party not found.' });
    const numericScore = score === '' || score == null ? null : Number(score);
    const severity = numericScore == null ? 'info' : numericScore < 40 ? 'critical' : numericScore < 60 ? 'high' : numericScore < 80 ? 'moderate' : 'low';
    const observedAt = recorded_at || new Date().toISOString().slice(0,10);
    try {
      await db.transaction(async () => {
        const legacyId = Number((await db.prepare(`INSERT INTO supplier_monitoring (workspace_id, supplier_id, source, score, grade, recorded_at, notes, recorded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          req.workspace.id, supplier.id, source,
          Number.isFinite(numericScore) ? numericScore : null, grade || null,
          observedAt, notes || null, req.user.id)).lastInsertRowid);
        await tprmDomain.recordMonitoringSignal(db, {
          workspaceId:req.workspace.id, supplierId:supplier.id,
          source:String(source).trim(), sourceReference:`supplier_monitoring:${legacyId}`,
          signalType:'other', severity,
          title:`${supplier.name} monitoring update`, detail:notes || null,
          observedAt, requiresReassessment:req.body.requires_reassessment === '1' || ['high','critical'].includes(severity),
          actorId:req.user.id, actorType:'consultant', actorName:req.user.name,
          metadata:{ score:Number.isFinite(numericScore) ? numericScore : null, grade:grade || null },
        });
      })();
    } catch (error) {
      return res.status([400,403,409].includes(Number(error.status)) ? Number(error.status) : 409)
        .render('error', { user:req.user, ws:req.workspace, message:error.message || 'Monitoring signal could not be recorded.' });
    }
    res.redirect(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#monitoring`);
  });

  app.post('/workspaces/:wsId/vendors/:id/termination/start', requireAuth, requireWorkspace,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE),
    requirePermission('tprm.monitoring.manage'), async (req, res) => {
    const supplier = await db.prepare('SELECT id FROM suppliers WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!supplier) return res.status(404).render('error', { user:req.user, ws:req.workspace, message:'Third party not found.' });
    const items = [
      ['access_revoked', 'Logical access revoked'],
      ['vpn_keys_revoked', 'VPN / API keys revoked'],
      ['data_returned', 'Data returned'],
      ['data_destroyed', 'Data securely destroyed'],
      ['certificate_received', 'Certificate of destruction received'],
      ['final_audit', 'Final audit / attestation collected'],
      ['contract_closed', 'Contract formally closed'],
      ['communications_done', 'Internal stakeholders notified']
    ];
    try {
      await db.transaction(async () => {
        const cycle = (await tprmDomain.ensureCurrentCycle(db, {
          workspaceId:req.workspace.id, supplierId:supplier.id, actorId:req.user.id,
          cycleType:'triggered', triggerReason:'Governed third-party exit initiated.',
        })).cycle;
        const projection = await tprmDomain.lifecycleProjection(db, req.workspace.id, supplier.id);
        if (projection.stage !== 'offboarding') {
          await tprmDomain.transition(db, {
            workspaceId:req.workspace.id, supplierId:supplier.id, cycleId:cycle.id,
            expectedStage:projection.stage, fromStage:projection.stage, toStage:'offboarding',
            actorId:req.user.id, actorType:'consultant',
            reason:String(req.body.reason || 'Third-party exit and access revocation initiated.').trim(),
          });
        }
        const ins = db.prepare(`INSERT INTO supplier_termination_items (workspace_id, supplier_id, item_key, label) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`);

        for (const [k, l] of items) {
          await ins.run(req.workspace.id, supplier.id, k, l);
        }

        await db.prepare(`UPDATE suppliers SET termination_started_at=COALESCE(termination_started_at,utc_now_text()), termination_owner=? WHERE id=? AND workspace_id=?`)
          .run(req.body.termination_owner || req.user.name, supplier.id, req.workspace.id);
      })();
    } catch (error) {
      return res.status([400,403,404,409].includes(Number(error.status)) ? Number(error.status) : 409)
        .render('error', { user:req.user, ws:req.workspace, message:error.message || 'Offboarding could not be started.' });
    }
    await logAction(req.user.id, req.workspace.id, 'start_termination', 'supplier', req.params.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/tprm/third-parties/${req.params.id}#offboarding`);
  });

  app.post('/workspaces/:wsId/vendors/:id/termination/:itemId', requireAuth, requireWorkspace,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE),
    requirePermission('tprm.monitoring.manage'), async (req, res) => {
    const done = req.body.done === '1' ? 1 : 0;
    await db.prepare(`UPDATE supplier_termination_items SET done=?, done_at=CASE WHEN ?=1 THEN utc_now_text() ELSE NULL END, evidence=?, notes=? WHERE id=? AND supplier_id=? AND workspace_id=?`)
      .run(done, done, req.body.evidence || null, req.body.notes || null, req.params.itemId, req.params.id, req.workspace.id);
    const remaining = (await db.prepare('SELECT COUNT(*) c FROM supplier_termination_items WHERE supplier_id=? AND workspace_id=? AND done=0').get(req.params.id, req.workspace.id)).c;
    if (remaining === 0) {
      try {
        await db.transaction(async () => {
          const projection = await tprmDomain.lifecycleProjection(db, req.workspace.id, req.params.id);
          if (projection.stage !== 'offboarding') throw new tprmDomain.TprmDomainError('TPRM_EXIT_STATE_INVALID', 'The governed lifecycle is not in offboarding.', 409);
          await tprmDomain.transition(db, {
            workspaceId:req.workspace.id, supplierId:req.params.id, cycleId:projection.cycle.id,
            expectedStage:'offboarding', fromStage:'offboarding', toStage:'closed',
            actorId:req.user.id, actorType:'consultant', reason:'Every governed offboarding control was completed.',
          });
          await db.prepare(`UPDATE suppliers SET terminated_at=utc_now_text(), data_return_completed=1 WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
        })();
      } catch (error) {
        return res.status([400,403,404,409].includes(Number(error.status)) ? Number(error.status) : 409)
          .render('error', { user:req.user, ws:req.workspace, message:error.message || 'Offboarding could not be completed.' });
      }
    }
    res.redirect(`/workspaces/${req.workspace.id}/tprm/third-parties/${req.params.id}#offboarding`);
  });

  app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/share', requireAuth, requireWorkspace,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT),
    requirePermission('tprm.assessment.manage'), (req, res) => {
    res.status(410).render('error', { user: req.user, ws: req.workspace,
      message: 'This questionnaire workflow is retired. Issue the governed due-diligence assessment from the third-party record.' });
  });

  app.all('/q/:token', (req, res) => {
    res.status(410).send('This provider questionnaire link has been retired. Ask your engagement contact for a new governed provider due-diligence link.');
  });

  app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/share', requireAuth, requireWorkspace,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT),
    requirePermission('tprm.assessment.manage'), async (req, res) => {
    const toEmail = (req.body.email || '').trim().toLowerCase();
    const toName = (req.body.name || '').trim() || null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${req.params.id}/questionnaires/${req.params.qId}`, 'Enter a valid vendor email address.', 'error'));
    }
    const questionnaire = await db.prepare(`SELECT q.*, s.entity_id, s.name AS supplier_name, t.description AS tpl_description
      FROM supplier_questionnaires q INNER JOIN suppliers s ON s.id=q.supplier_id
      LEFT JOIN questionnaire_templates t ON t.id=q.template_id
      WHERE q.id=? AND q.supplier_id=? AND q.workspace_id=?`).get(req.params.qId, req.params.id, req.workspace.id);
    if (!questionnaire) return res.status(404).send('Questionnaire not found');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    await db.transaction(async () => {
      await db.prepare(`UPDATE external_assessment_tokens SET revoked_at=utc_now_text() WHERE questionnaire_id=? AND revoked_at IS NULL AND completed_at IS NULL`).run(questionnaire.id);
      await db.prepare(`INSERT INTO external_assessment_tokens
        (workspace_id,assessment_id,entity_id,questionnaire_id,email,name,token_hash,expires_at,created_by)
        VALUES (?,NULL,?,?,?,?,?,?,?)`).run(req.workspace.id, questionnaire.entity_id || null, questionnaire.id, toEmail, toName, tokenHash, expiresAt, req.user.id);
      await db.prepare(`UPDATE supplier_questionnaires
          SET external_token=NULL, external_email=?, external_contact_name=?, external_expires_at=?, external_completed_at=NULL,
              external_opened_at=NULL, external_last_saved_at=NULL, invitation_status='sent', sent_at=utc_now_text(),
              status=CASE WHEN status IN ('draft','responded','reviewed') THEN 'sent' ELSE status END
          WHERE id=? AND workspace_id=?`)
        .run(toEmail, toName, expiresAt, questionnaire.id, req.workspace.id);
    })();
    const base = `/workspaces/${req.workspace.id}/vendors/${req.params.id}/questionnaires/${req.params.qId}`;
    const link = `${req.protocol}://${req.get('host')}/q/${token}`;
    if (req.session) req.session.lastQuestionnaireInvite = { questionnaireId: questionnaire.id, url: link };
    let sendResult;
    try {
      sendResult = await email.sendSupplierQuestionnaireEmail({
        toEmail, toName,
        supplierName: questionnaire.supplier_name,
        templateName: questionnaire.template_name || 'Security questionnaire',
        templateDescription: questionnaire.tpl_description,
        questionCount: questionnaire.total_questions,
        workspaceName: req.workspace.brand_display_name || req.workspace.client_name,
        workspaceId: req.workspace.id, firmId: req.workspace.firm_id,
        token, expiresAt, questionnaireId: questionnaire.id
      });
    } catch (err) {
      sendResult = { ok: false, error: err && err.message };
    }
    await logAction(req.user.id, req.workspace.id, 'questionnaire_shared', 'questionnaire', questionnaire.id,
      { to: toEmail, emailed: !!(sendResult && sendResult.ok), expiresAt }, auditCtx(req));
    const msg = sendResult && sendResult.ok
      ? `Questionnaire emailed to ${toEmail}. The secure link expires in 30 days.`
      : `The invitation was created, but email delivery failed${sendResult && sendResult.error ? `: ${sendResult.error}` : '.'} Copy the one-time link shown below.`;
    res.redirect(withToast(base, msg, sendResult && sendResult.ok ? 'success' : 'error'));
  });

  app.get('/q/:token', async (req, res) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const q = await db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description,
        COALESCE(w.brand_display_name, w.client_name) AS requester_name, et.id AS invitation_id,
        et.expires_at AS token_expires_at, et.completed_at AS token_completed_at, et.revoked_at AS token_revoked_at
      FROM supplier_questionnaires q
      INNER JOIN suppliers s ON s.id=q.supplier_id
      LEFT JOIN questionnaire_templates t ON t.id=q.template_id
      LEFT JOIN workspaces w ON w.id=q.workspace_id
      INNER JOIN external_assessment_tokens et ON et.questionnaire_id=q.id
      WHERE et.token_hash=? AND et.revoked_at IS NULL`).get(tokenHash);
    const blank = { sections: {}, respMap: {}, token: req.params.token };
    if (!q) return res.status(404).render('external_questionnaire', { q: null, state: 'invalid', ...blank });
    if (q.external_completed_at || q.token_completed_at) return res.render('external_questionnaire', { q, state: 'done', ...blank });
    if (q.token_expires_at && new Date(q.token_expires_at) < new Date())
      return res.status(410).render('external_questionnaire', { q, state: 'expired', ...blank });
    await db.prepare(`UPDATE supplier_questionnaires SET external_opened_at=COALESCE(external_opened_at,utc_now_text()),invitation_status=CASE WHEN invitation_status='sent' THEN 'opened' ELSE invitation_status END WHERE id=?`).run(q.id);
    const questions = await db.prepare('SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order NULLS FIRST').all(q.template_id);
    const responses = await db.prepare('SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?').all(q.id);
    const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
    const attachMap = {};
    (await db.prepare(`SELECT * FROM questionnaire_attachments WHERE questionnaire_id=? ORDER BY uploaded_at`).all(q.id))
      .forEach(a => { const key = a.question_id == null ? 'general' : a.question_id; (attachMap[key] = attachMap[key] || []).push(a); });
    const sections = {};
    questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
    res.render('external_questionnaire', { q, sections, respMap, attachMap, token: req.params.token, state: 'open', saved: req.query.saved === '1' });
  });

  app.post('/q/:token', resolveQuestionnaireFirm, qUploadAny, async (req, res) => {
    const q = req._questionnaire;

    if (req._uploadError) {
      const e = req._uploadError;
      const tooBig = e && e.code === 'LIMIT_FILE_SIZE';
      const tooMany = e && e.code === 'LIMIT_FILE_COUNT';
      const uploadMsg = tooBig
        ? 'One of your files is larger than 25 MB. Please attach a smaller file (or split it) and submit again - your answers were not saved yet.'
        : tooMany
          ? 'Too many files were attached at once (limit 40). Please reduce the number of attachments and submit again - your answers were not saved yet.'
          : 'We could not process one of your attachments. Please remove it and submit again - your answers were not saved yet.';
      (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(413).render('external_questionnaire', {
        q, sections: {}, respMap: {}, token: req.params.token, state: 'uploaderror', uploadMsg
      });
    }

    const qIds = Object.keys(req.body).filter(k => k.startsWith('answer_')).map(k => parseInt(k.replace('answer_',''), 10));
    const upsert = db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id, question_id, answer, comment)
      VALUES (?, ?, ?, ?) ON CONFLICT(questionnaire_id, question_id) DO UPDATE SET answer=excluded.answer, comment=excluded.comment`);
    for (const qid of qIds) {
      await upsert.run(q.id, qid, req.body['answer_' + qid] || null, req.body['comment_' + qid] || null);
    }
    const allQ = await db.prepare(`SELECT q.id, q.weight, q.expected_answer, r.answer FROM questionnaire_questions q
      LEFT JOIN supplier_questionnaire_responses r ON r.question_id=q.id AND r.questionnaire_id=?
      WHERE q.template_id=?`).all(q.id, q.template_id);
    let totalWeight = 0, achieved = 0;
    allQ.forEach(qu => {
      totalWeight += qu.weight;
      if (qu.answer && qu.expected_answer && qu.answer.toLowerCase() === qu.expected_answer.toLowerCase()) achieved += qu.weight;
    });
    const score = totalWeight ? Math.round((achieved / totalWeight) * 100) : null;
    const rating = score === null ? null : (score >= 80 ? 'low' : score >= 60 ? 'medium' : 'high');
    const isDraftSave = req.body.action === 'save';
    await db.prepare(`UPDATE supplier_questionnaires SET answered_questions=?, score=?, risk_rating=?,
        status=CASE WHEN ?=1 THEN 'sent' ELSE 'responded' END,
        invitation_status=CASE WHEN ?=1 THEN 'in_progress' ELSE 'submitted' END,
        external_last_saved_at=utc_now_text(),
        responded_at=CASE WHEN ?=0 THEN utc_now_text() ELSE responded_at END,
        external_completed_at=CASE WHEN ?=0 THEN utc_now_text() ELSE external_completed_at END
      WHERE id=?`).run(allQ.filter(qu => qu.answer).length, score, rating, isDraftSave ? 1 : 0, isDraftSave ? 1 : 0, isDraftSave ? 1 : 0, isDraftSave ? 1 : 0, q.id);
    if (!isDraftSave) await db.prepare(`UPDATE external_assessment_tokens SET completed_at=utc_now_text() WHERE id=?`).run(q.invitation_id);

    let attachSaved = 0;
    try {
      attachSaved = await persistQuestionnaireFiles({
        files: req.files, questionnaireId: q.id, workspaceId: q.workspace_id, source: 'vendor', uploadedBy: null
      });
    } catch (e) { console.error('[questionnaire attach]', e && e.message); }

    await logAction(0, q.workspace_id, isDraftSave ? 'external_questionnaire_save' : 'external_questionnaire_submit', 'questionnaire', q.id,
      { score, rating, attachments: attachSaved }, { ip: (req.ip || ''), userAgent: req.get('user-agent') || '' });

    if (isDraftSave) return res.redirect(`/q/${req.params.token}?saved=1`);

    const supName = q.supplier_name || 'A supplier';
    try {
      const ratingLabel = rating ? rating.charAt(0).toUpperCase() + rating.slice(1) : 'n/a';
      const attachNote = attachSaved ? ` ${attachSaved} file${attachSaved === 1 ? '' : 's'} attached.` : '';
      await jobs.notify(q.workspace_id, null, 'questionnaire_responded', score !== null && score < 60 ? 'high' : 'medium',
        `${supName} returned their questionnaire: ${q.template_name}`,
        `Score ${score === null ? 'n/a' : score + '%'} · risk ${ratingLabel}.${attachNote} Review and confirm the rating.`,
        `/workspaces/${q.workspace_id}/vendors/${q.supplier_id}/questionnaires/${q.id}`);
    } catch (e) { console.error('[questionnaire notify]', e && e.message); }

    res.render('external_questionnaire', {
      q, sections: {}, respMap: {}, token: req.params.token, state: 'submitted',
      rejectedUploads: req._rejectedUploads || [], attachSaved
    });
  });

  app.get('/workspaces/:wsId/task-templates', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    const templates = await db.prepare(`SELECT * FROM task_templates WHERE workspace_id=? OR is_system=1 OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
    res.render('task_templates', { user: req.user, ws: req.workspace, templates });
  });

  app.post('/workspaces/:wsId/tasks/from-template/:tplId', requireAuth, requireWorkspace, requirePermission('task.manage'), async (req, res) => {
    const tpl = await db.prepare('SELECT * FROM task_templates WHERE id=? AND (is_system=1 OR firm_id=? OR workspace_id=?)').get(req.params.tplId, req.workspace.firm_id, req.workspace.id);
    if (!tpl) return redirectBack(req, res);
    const steps = JSON.parse(tpl.steps || '[]');
    const baseDate = req.body.base_date ? new Date(req.body.base_date) : new Date();
    for (const s of steps) {
      const due = new Date(baseDate.getTime() + (s.days_offset || 0) * 86400000).toISOString().slice(0,10);
      await db.prepare(`INSERT INTO tasks (workspace_id, entity_id, title, description, assignee_id, due_date, status, created_by, template_id)
        VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`).run(
        req.workspace.id, req.entityScopeId || null,
        s.title, tpl.name + ' - step',
        req.body.assignee_id || null, due, req.user.id, tpl.id);
    }
    await logAction(req.user.id, req.workspace.id, 'spawn_template', 'task_template', tpl.id, { name: tpl.name, steps: steps.length }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/tasks`, `Created ${steps.length} tasks from "${tpl.name}"`));
  });

  app.post('/workspaces/:wsId/assets/:id/relationships', requireAuth, requireWorkspace, requirePermission('asset.update'), async (req, res) => {
    const asset = await db.prepare('SELECT id FROM assets WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!asset) return res.status(404).send('Asset not found');
    const { child_asset_id, relation, notes } = req.body;
    if (!child_asset_id || !relation) return redirectBack(req, res);
    try {
      await db.prepare(`INSERT INTO asset_relationships (workspace_id, parent_asset_id, child_asset_id, relation, notes)
        VALUES (?, ?, ?, ?, ?)`).run(req.workspace.id, req.params.id, child_asset_id, relation, notes || null);
    } catch (_) {}
    res.redirect(`/workspaces/${req.workspace.id}/assets/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/assets/relationships/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.update'), async (req, res) => {
    await db.prepare('DELETE FROM asset_relationships WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    redirectBack(req, res);
  });

  app.get('/workspaces/:wsId/assets/:id', requireAuth, requireWorkspace, requirePermission('asset.view'), async (req, res) => {
    const asset = await db.prepare(`SELECT a.*, e.name AS entity_name FROM assets a LEFT JOIN entities e ON e.id=a.entity_id WHERE a.id=? AND a.workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!asset) return res.status(404).send('Not found');
    const parents = await db.prepare(`SELECT r.*, p.name AS asset_name FROM asset_relationships r INNER JOIN assets p ON p.id=r.parent_asset_id WHERE r.child_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
    const children = await db.prepare(`SELECT r.*, c.name AS asset_name FROM asset_relationships r INNER JOIN assets c ON c.id=r.child_asset_id WHERE r.parent_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
    const allAssets = await db.prepare('SELECT id, name FROM assets WHERE workspace_id=? AND id != ? ORDER BY name').all(req.workspace.id, asset.id);
    const linkedRisks = await db.prepare(`SELECT r.* FROM risks r WHERE r.workspace_id=? AND r.asset_id=?`).all(req.workspace.id, asset.id);
    const controlsInScope = await db.prepare(`
      SELECT DISTINCT i.id, i.title, i.category, i.sort_order,
        COALESCE(cs.applicability,'undecided') AS applicability,
        COALESCE(cs.status,'Not Assessed') AS status,
        (SELECT COUNT(*) FROM ${docLinks.docControlsExpr('iso27001')} dc INNER JOIN generated_docs d ON d.id=dc.document_id WHERE dc.iso_item_id=i.id AND d.workspace_id=?) AS doc_count
      FROM iso_items i
      INNER JOIN risk_controls rc ON rc.iso_item_id = i.id
      INNER JOIN risks r ON r.id = rc.risk_id
      LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE r.asset_id = ? AND r.workspace_id = ?
      ORDER BY i.sort_order
    `).all(req.workspace.id, req.workspace.id, asset.id, req.workspace.id);
    res.render('asset_detail', {
      user: req.user, ws: req.workspace, asset, parents, children, allAssets, linkedRisks, controlsInScope,
      editMode: req.query.edit === '1'
    });
  });

  app.post('/workspaces/:wsId/members/bulk', requireAuth, requireWorkspace, requirePermission('members.add'), async (req, res) => {
    const lines = (req.body.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = lines.map(ln => {
      const [name, email, submittedRole] = ln.split(',').map(s => s.trim());
      const normalizedRole = rbac.normalizeRole(submittedRole || 'contributor');
      const role = rbac.CLIENT_ROLES.includes(normalizedRole) ? normalizedRole : 'contributor';
      return { name, email, role };
    });
    if (parsed.some(row => row.role !== 'contributor') &&
        !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user,
        message: 'Bulk assignment of privileged client roles requires member role-assignment permission.'
      });
    }
    let added = 0;
    for (const row of parsed) {
      const { name, email, role: r } = row;
      if (!name || !email) continue;
      const e = email.toLowerCase();
      let user = await db.prepare('SELECT * FROM users WHERE email=?').get(e);
      if (user && user.user_type !== 'client') continue;
      if (!user) {
        const hash = bcrypt.hashSync('temporary-' + crypto.randomBytes(8).toString('hex'), 10);
        const uid = (await db.prepare(`INSERT INTO users (email, password_hash, name, user_type) VALUES (?, ?, ?, 'client')`).run(e, hash, name)).lastInsertRowid;
        user = { id: uid };
      }
      try {
        await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, user.id, r);
        added++;
      } catch (_) { }
    }
    await logAction(req.user.id, req.workspace.id, 'bulk_invite', 'members', null, { added }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/members`, `Added ${added} members`));
  });

  app.get('/workspaces/:wsId/members/:userId/stats', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const u = await db.prepare('SELECT id, name, email, last_active_at FROM users WHERE id=?').get(req.params.userId);
    if (!u) return res.status(404).send('Not found');
    const stats = {
      controls_owned: (await db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, req.workspace.id).cs} WHERE workspace_id=? AND owner_id=?`).get(req.workspace.id, u.id)).c,
      docs_created: (await db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND created_by=?`).get(req.workspace.id, u.id)).c,
      evidence_uploaded: (await db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND uploaded_by=?`).get(req.workspace.id, u.id)).c,
      tasks_owned: (await db.prepare(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND assignee_id=?`).get(req.workspace.id, u.id)).c,
      actions_logged: (await db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id)).c,
      signatures: (await db.prepare(`SELECT COUNT(*) c FROM doc_signatures WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id)).c
    };
    res.render('member_stats', { user: req.user, ws: req.workspace, member: u, stats });
  });

  app.get('/workspaces/:wsId/access-reviews', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const reviews = await db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM access_review_items WHERE review_id=r.id) AS total,
      (SELECT COUNT(*) FROM access_review_items WHERE review_id=r.id AND decision IS NOT NULL) AS decided
      FROM access_reviews r WHERE r.workspace_id=? ORDER BY r.created_at DESC`).all(req.workspace.id);
    res.render('access_reviews', { user: req.user, ws: req.workspace, reviews });
  });

  app.post('/workspaces/:wsId/access-reviews', requireAuth, requireWorkspace, requirePermission('members.assign_role'), async (req, res) => {
    const today = new Date().toISOString().slice(0,10);
    const start = req.body.period_start || new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
    const reviewId = (await db.prepare(`INSERT INTO access_reviews (workspace_id, period_start, period_end, status, reviewer)
      VALUES (?, ?, ?, 'open', ?)`).run(req.workspace.id, start, today, req.body.reviewer || req.user.name)).lastInsertRowid;
    const members = await db.prepare(`SELECT m.user_id, m.role, u.name FROM workspace_members m INNER JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?`).all(req.workspace.id);
    const ins = db.prepare('INSERT INTO access_review_items (review_id, user_id, "current_role") VALUES (?, ?, ?)');

    for (const m of members) {
      await ins.run(reviewId, m.user_id, m.role);
    }

    await logAction(req.user.id, req.workspace.id, 'open_access_review', 'access_review', reviewId, { members: members.length }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${reviewId}`);
  });

  app.get('/workspaces/:wsId/access-reviews/:id', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const review = await db.prepare('SELECT * FROM access_reviews WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!review) return res.status(404).send('Not found');
    const items = await db.prepare(`SELECT i.*, u.name, u.email FROM access_review_items i INNER JOIN users u ON u.id=i.user_id WHERE i.review_id=? ORDER BY u.name`).all(review.id);
    res.render('access_review_detail', { user: req.user, ws: req.workspace, review, items });
  });

  app.post('/workspaces/:wsId/access-reviews/:id/items/:itemId', requireAuth, requireWorkspace, requirePermission('members.assign_role'), async (req, res) => {
    await db.prepare(`UPDATE access_review_items SET decision=?, decision_reason=?, reviewer=?, decided_at=utc_now_text() WHERE id=? AND review_id=?`)
      .run(req.body.decision || null, req.body.decision_reason || null, req.user.name, req.params.itemId, req.params.id);
    if (req.body.decision === 'remove') {
      const item = await db.prepare('SELECT user_id FROM access_review_items WHERE id=?').get(req.params.itemId);
      if (item) {
        await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(req.workspace.id, item.user_id);
        await logAction(req.user.id, req.workspace.id, 'access_review_remove', 'user', item.user_id, null, auditCtx(req));
      }
    }
    res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/access-reviews/:id/close', requireAuth, requireWorkspace, requirePermission('members.assign_role'), async (req, res) => {
    await db.prepare(`UPDATE access_reviews SET status='closed', closed_at=utc_now_text(), outcome=? WHERE id=? AND workspace_id=?`)
      .run(req.body.outcome || null, req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'close_access_review', 'access_review', req.params.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${req.params.id}`);
  });

  app.get('/workspaces/:wsId/access/who-has/:perm', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const perm = req.params.perm;
    const users = await db.prepare(`SELECT u.id, u.name, u.email, u.user_type, u.firm_role, COALESCE(m.role, '-') AS member_role
      FROM users u LEFT JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=?
      WHERE u.firm_id=? AND u.user_type='firm' AND u.active=1
      UNION
      SELECT u.id, u.name, u.email, u.user_type, NULL, m.role
      FROM users u INNER JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=?`).all(req.workspace.id, req.workspace.firm_id, req.workspace.id);
    const has = await Promise.all(users.map(async u => ({
      ...u,
      has: rbac.hasPermission(await permissionsFor(u, req.workspace), perm)
    })));
    res.render('permission_lookup', { user: req.user, ws: req.workspace, perm, results: has, allPerms: rbac.PERMISSIONS });
  });

  app.post('/workspaces/:wsId/access/apply-template', requireAuth, requireWorkspace, requirePermission('members.override_perms'), async (req, res) => {
    const tpl = await db.prepare('SELECT * FROM permission_templates WHERE id=? AND (firm_id IS NULL OR firm_id=?)').get(req.body.template_id, req.workspace.firm_id);
    if (!tpl) return redirectBack(req, res);
    const userId = parseInt(req.body.user_id, 10);
    if (!userId) return redirectBack(req, res);
    const expires = req.body.expires_at || null;
    const perms = JSON.parse(tpl.permissions);
    const ins = db.prepare(`INSERT INTO workspace_role_overrides (workspace_id, user_id, permission, granted, granted_by, reason, expires_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id, permission) DO UPDATE SET granted=1, granted_by=excluded.granted_by, reason=excluded.reason, expires_at=excluded.expires_at`);

    for (const p of perms) {
      await ins.run(req.workspace.id, userId, p, req.user.id, `Template: ${tpl.name}` + (req.body.reason ? ' - ' + req.body.reason : ''), expires);
    }

    await logAction(req.user.id, req.workspace.id, 'apply_perm_template', 'user', userId, { template: tpl.name, expires_at: expires }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/access`);
  });

  app.get('/workspaces/:wsId/activity-log/verify', requireAuth, requireWorkspace, requirePermission('audit_log.view'), async (req, res) => {
    const issues = await verifyAuditChain(req.workspace.id);
    res.render('audit_chain_verify', { user: req.user, ws: req.workspace, issues, total: (await db.prepare('SELECT COUNT(*) c FROM audit_log WHERE workspace_id=?').get(req.workspace.id)).c });
  });

  app.get('/workspaces/:wsId/activity-log/timeline', requireAuth, requireWorkspace, requirePermission('audit_log.view'), async (req, res) => {
    const userId = parseInt(req.query.user_id || req.user.id, 10);
    const day = req.query.day || new Date().toISOString().slice(0,10);
    const log = await db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND a.user_id=? AND substr(a.created_at, 1, 10)=substr(?::text, 1, 10) ORDER BY a.created_at`)
      .all(req.workspace.id, userId, day);
    const users = await db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
    res.render('audit_timeline', { user: req.user, ws: req.workspace, log, users, userId, day });
  });

  app.get('/workspaces/:wsId/activity-log/anomalies', requireAuth, requireWorkspace, requirePermission('audit_log.view'), async (req, res) => {
    const flags = [];
    const after = await db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND to_char(utc_ts(a.created_at) AT TIME ZONE 'UTC', 'HH24')::int < 6 ORDER BY a.created_at DESC LIMIT 50`).all(req.workspace.id);
    if (after.length) flags.push({ kind: 'after_hours', label: `${after.length} after-hours actions (00:00–06:00 UTC)`, items: after });
    const burst = await db.prepare(`SELECT user_id, to_char(utc_ts(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS m, COUNT(*) c
      FROM audit_log WHERE workspace_id=? GROUP BY user_id, m HAVING COUNT(*) > 20 ORDER BY c DESC LIMIT 10`).all(req.workspace.id);
    if (burst.length) flags.push({ kind: 'burst', label: `Bursts of >20 actions per minute`, items: burst });
    const ipChange = await db.prepare(`SELECT user_id, substr(created_at, 1, 10) d, COUNT(DISTINCT ip_address) ips
      FROM audit_log WHERE workspace_id=? AND ip_address IS NOT NULL GROUP BY user_id, d HAVING COUNT(DISTINCT ip_address) > 2`).all(req.workspace.id);
    if (ipChange.length) flags.push({ kind: 'ip_change', label: `Same user from >2 IPs in a single day`, items: ipChange });
    const denials = await db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND a.action='permission_denied' ORDER BY a.created_at DESC LIMIT 50`).all(req.workspace.id);
    if (denials.length) flags.push({ kind: 'denials', label: `${denials.length} permission denials`, items: denials });
    res.render('audit_anomalies', { user: req.user, ws: req.workspace, flags });
  });

  app.get('/api/workspaces/:wsId/burndown', requireAuth, requireWorkspace, async (req, res) => {
    const wsId = req.workspace.id;
    const days = 90;
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0,10);
      const openNcs = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND created_at <= ? AND (closed_at IS NULL OR closed_at > ?)`).get(wsId, k + ' 23:59:59', k + ' 23:59:59')).c;
      series.push({ d: k, open_ncs: openNcs });
    }
    res.json({ series });
  });

  app.get('/workspaces/:wsId/readiness/auditor', requireAuth, requireWorkspace, requireReadinessService, requirePermission('control.view'), async (req, res) => {
    const items = await db.prepare(`SELECT i.id, i.title, i.type, i.category, i.evidence_needed, i.documentation_needed,
      cs.status, cs.applicability, cs.last_updated, cs.notes,
      (SELECT COUNT(*) FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=i.id) AS evidence_count,
      (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?) AS risk_links
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id);
    res.render('readiness_auditor', { user: req.user, ws: req.workspace, items });
  });

  app.get('/workspaces/:wsId/controls/export.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'), async (req, res) => {
    const rows = await db.prepare(`SELECT i.id, i.type, i.category, i.title,
      COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.maturity, cs.notes, cs.due_date,
      (SELECT name FROM users WHERE id=cs.owner_id) AS owner
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      ORDER BY i.sort_order`).all(req.workspace.id);
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
    const lines = ['id,type,category,title,status,applicability,maturity,notes,due_date,owner'];
    rows.forEach(r => lines.push([r.id, r.type, r.category, r.title, r.status, r.applicability, r.maturity || '', r.notes || '', r.due_date || '', r.owner || ''].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="controls-${req.workspace.client_name.replace(/[^\w]+/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });

  app.post('/workspaces/:wsId/controls/import', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), async (req, res) => {
    const csv = req.body.csv || '';
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return redirectBack(req, res);
    const header = lines.shift().split(',').map(s => s.trim().toLowerCase());
    const ix = (k) => header.indexOf(k);
    const wcImp = ctlWrites.converged(db, req.workspace.id);
    let updated = 0;
    for (const ln of lines) {
      const parts = ln.match(/"[^"]*"|[^,]+/g)?.map(p => p.replace(/^"|"$/g,'').replace(/""/g,'"').trim()) || [];
      const id = ix('id') >= 0 ? parts[ix('id')] : null;
      if (!id) continue;
      await getOrCreateState(req.workspace.id, id);
      const set = []; const vals = [];
      if (ix('status') >= 0 && parts[ix('status')]) { set.push('status=?'); vals.push(parts[ix('status')]); }
      if (ix('applicability') >= 0 && parts[ix('applicability')]) { set.push('applicability=?'); vals.push(parts[ix('applicability')]); }
      if (ix('maturity') >= 0 && parts[ix('maturity')]) { set.push('maturity=?'); vals.push(parseInt(parts[ix('maturity')]) || 0); }
      if (ix('notes') >= 0 && parts[ix('notes')]) { set.push('notes=?'); vals.push(parts[ix('notes')]); }
      if (set.length) {
        set.push('last_updated=utc_now_text()');
        const rid = wcImp ? await ctlWrites.requirementId(db, 'iso27001', id) : null;
        if (wcImp && rid) {
          const c = ctlWrites.convergeSets(set, vals);
          await db.prepare(`UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...c.vals, req.workspace.id, rid);
        } else {
          vals.push(req.workspace.id, id);
          await db.prepare(`UPDATE control_states SET ${set.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
        }
        updated++;
      }
    }
    await logAction(req.user.id, req.workspace.id, 'import_controls', 'control', null, { updated }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/controls`, `Updated ${updated} controls`));
  });

  app.get('/workspaces/:wsId/controls/kanban', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const rows = await db.prepare(`SELECT i.id, i.title, i.type, i.category,
      COALESCE(cs.status,'Not Assessed') AS status, cs.maturity,
      (SELECT name FROM users WHERE id=cs.owner_id) AS owner
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' ORDER BY i.sort_order`).all(req.workspace.id);
    res.render('controls_kanban', { user: req.user, ws: req.workspace, rows });
  });

  app.get('/workspaces/:wsId/risk-appetite', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    let app_ = await db.prepare('SELECT * FROM risk_appetites WHERE workspace_id=?').get(req.workspace.id);
    if (!app_) {
      await db.prepare(`INSERT INTO risk_appetites (workspace_id, statement, appetite_low_max, appetite_med_max) VALUES (?, ?, ?, ?)`)
        .run(req.workspace.id, '', 6, 12);
      app_ = await db.prepare('SELECT * FROM risk_appetites WHERE workspace_id=?').get(req.workspace.id);
    }
    res.render('risk_appetite', { user: req.user, ws: req.workspace, appetite: app_ });
  });

  app.post('/workspaces/:wsId/risk-appetite', requireAuth, requireWorkspace, requirePermission('risk.methodology'), async (req, res) => {
    const { statement, appetite_low_max, appetite_med_max, auto_accept_below, approver_role } = req.body;
    await db.prepare(`UPDATE risk_appetites SET statement=?, appetite_low_max=?, appetite_med_max=?, auto_accept_below=?, approver_role=?, updated_at=utc_now_text() WHERE workspace_id=?`)
      .run(statement || '', parseFloat(appetite_low_max)||0, parseFloat(appetite_med_max)||0, auto_accept_below === 'on' ? 1 : 0, approver_role || null, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'update_appetite', 'appetite', null, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risk-appetite`);
  });

  app.post('/workspaces/:wsId/risks/:id/accept', requireAuth, requireWorkspace, requirePermission('risk.update'), async (req, res) => {
    const risk = await db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return redirectBack(req, res);
    const { accepter_name, accepter_role, rationale, expires_at, attestation } = req.body;
    if (attestation !== '1' || !accepter_name || !rationale) {
      return res.status(400).render('error', { user: req.user, message: 'Acceptance requires accepter name, rationale, and attestation tickbox.' });
    }
    const residual = (risk.residual_likelihood || risk.likelihood) * (risk.residual_impact || risk.impact);
    const ts = new Date().toISOString();
    const payload = `accept|${risk.id}|${accepter_name}|${residual}|${ts}`;
    const sig = enc.signHmac(payload, req.workspace.id);
    const id = (await db.prepare(`INSERT INTO risk_acceptances (workspace_id, risk_id, accepter_name, accepter_role, accepter_user_id, rationale, residual_score, expires_at, signature, ip_address, user_agent, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, risk.id, accepter_name, accepter_role || null, req.user.id,
      rationale, residual, expires_at || null, sig,
      auditCtx(req).ip, auditCtx(req).userAgent, ts)).lastInsertRowid;
    await db.prepare(`UPDATE risks SET status='accepted', accepted_until=?, last_acceptance_id=? WHERE id=? AND workspace_id=?`)
      .run(expires_at || null, id, risk.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'accept_risk', 'risk', risk.id, { acceptance_id: id, expires_at }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/${risk.id}`, 'Risk acceptance recorded'));
  });

  app.get('/workspaces/:wsId/risks/:id/acceptances', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const risk = await db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Not found');
    const list = await db.prepare(`SELECT * FROM risk_acceptances WHERE risk_id=? ORDER BY signed_at DESC NULLS LAST`).all(risk.id);
    res.render('risk_acceptances', { user: req.user, ws: req.workspace, risk, list });
  });

  app.get('/workspaces/:wsId/risks/:id/acceptances/:aid/record.docx', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const risk = await db.prepare(`SELECT * FROM risks WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const a = await db.prepare(`SELECT * FROM risk_acceptances WHERE id=? AND workspace_id=? AND risk_id=?`).get(req.params.aid, req.workspace.id, risk.id);
    if (!a) return res.status(404).send('Acceptance record not found');

    const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })], ...opts });
    const heading = (text, level) => new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })], spacing: { before: 300, after: 120 } });
    const row = (label, value) => new TableRow({ children: [
      new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, shading: { fill: 'F4F4F5' },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })] }),
      new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: value || '-' })] })] })
    ]});

    const score = (risk.likelihood || 0) * (risk.impact || 0);
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Risk acceptance record' })], alignment: AlignmentType.CENTER }),
          para(`${req.workspace.client_name || 'Workspace'} - generated ${new Date().toISOString().slice(0,10)}`, { italics: true }),
          para(''),

          heading('Risk', HeadingLevel.HEADING_2),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
            row('Risk ID', `R-${risk.id}`),
            row('Title', risk.title),
            row('Description', risk.description || '-'),
            row('Likelihood × Impact', `${risk.likelihood} × ${risk.impact} = ${score}`),
            row('Treatment option chosen', 'Accept (residual risk)'),
            row('Risk owner', risk.owner_name || '-'),
          ]}),

          heading('Residual position', HeadingLevel.HEADING_2),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
            row('Residual L × I', risk.residual_likelihood && risk.residual_impact
              ? `${risk.residual_likelihood} × ${risk.residual_impact} = ${risk.residual_likelihood * risk.residual_impact}`
              : (a.residual_score != null ? String(a.residual_score) : '-')),
            row('Inherent L × I', `${risk.likelihood} × ${risk.impact} = ${score}`),
          ]}),

          heading('Acceptance rationale', HeadingLevel.HEADING_2),
          para(a.rationale || '-'),

          heading('Attestation', HeadingLevel.HEADING_2),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
            row('Accepter (full name)', a.accepter_name),
            row('Role', a.accepter_role || '-'),
            row('Signed at', a.signed_at),
            row('IP address', a.ip_address || '-'),
            row('User agent', a.user_agent || '-'),
            row('Signature hash', a.signature ? a.signature.slice(0, 32) + '…' : '-'),
            row('Expires / re-review by', a.expires_at || 'No fixed expiry - reviewed at each management review'),
            row('Status', a.revoked_at ? `REVOKED at ${a.revoked_at}` : 'Active'),
          ]}),
          para(''),

          new Paragraph({ children: [new TextRun({
            text: 'I attest under my own authority that this residual risk has been considered and is hereby formally accepted. ' +
                  'This electronic signature is bound to my identity, the recorded IP, and the timestamp above. ' +
                  'The signature hash is anchored in the workspace audit log and tamper-evident.',
            italics: true
          })] }),
          para(''),
          para('Risk owner sign-off (clause 6.1.3.f): _________________________  Date: __________', { size: 22 }),
        ]
      }]
    });

    const buf = await Packer.toBuffer(doc);
    const safeTitle = (risk.title || `risk-${risk.id}`).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 60);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="risk-acceptance-R${risk.id}-${safeTitle}.docx"`);
    res.send(buf);
  });

  app.post('/workspaces/:wsId/risks/:id/acceptances/:aid/revoke', requireAuth, requireWorkspace, requirePermission('risk.update'), async (req, res) => {
    const risk = await db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    await db.prepare(`UPDATE risk_acceptances SET revoked_at=utc_now_text() WHERE id=? AND risk_id=?`).run(req.params.aid, risk.id);
    const remaining = (await db.prepare(`SELECT COUNT(*) c FROM risk_acceptances WHERE risk_id=? AND revoked_at IS NULL`).get(risk.id)).c;
    if (remaining === 0) await db.prepare(`UPDATE risks SET status='open', accepted_until=NULL WHERE id=? AND workspace_id=?`).run(risk.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'revoke_acceptance', 'risk', req.params.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/acceptances`);
  });

  app.get('/workspaces/:wsId/search', requireAuth, requireWorkspace, async (req, res) => {
    const q = (req.query.q || '').trim();
    const results = q ? await fts.search(req.workspace.id, q) : [];
    res.render('search', { user: req.user, ws: req.workspace, q, results });
  });

  app.post('/workspaces/:wsId/search/rebuild', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    const n = await fts.rebuildAll(req.workspace.id);
    res.redirect(withToast(`/workspaces/${req.workspace.id}/search`, `Rebuilt ${n} entries`));
  });

  app.get('/workspaces/:wsId/handover', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('evidence.download'),
    requirePermission('workspace.export'), requirePermission('control.view'),
    requirePermission('risk.view'), requirePermission('asset.view'),
    requirePermission('entity.view'), requirePermission('document.view'),
    requirePermission('audit.manage'), requirePermission('nc.manage'),
    requirePermission('mrm.manage'), requirePermission('incident.manage'),
    requirePermission('task.manage'), requirePermission('audit_log.view'),
    requirePermission('audit_log.export'), requirePermission('tprm.third_party.view'),
    requirePermission('tprm.assurance.view'), requirePermission('tprm.assurance.export'),
    requireExactPermission('tprm.assurance.export'),
    requirePermission('members.view'), async (req, res) => {
    const ws = req.workspace;
    const safeName = ws.client_name.replace(/[^\w]+/g, '_');
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="handover-${safeName}-${today}.zip"`);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', err => { console.error(err); res.status(500).end(); });
    zip.pipe(res);

    for (const t of handoverExport.handoverTableNames()) {
      try {
        const rows = await handoverExport.loadHandoverRows(db, t, ws.id);
        rows.forEach(r => {
          Object.keys(r).forEach(k => {
            if (typeof r[k] === 'string' && r[k].startsWith('enc:v1:')) {
              try { r[k] = enc.decryptIfNeeded(r[k], ws.id); } catch (_) {}
            }
          });
        });
        zip.append(JSON.stringify(rows, null, 2), { name: `data/${t}.json` });
      } catch (e) { }
    }

    const evidence = await db.prepare(`SELECT * FROM evidence WHERE workspace_id=?`).all(ws.id);
    for (const e of evidence) {
      const fp = resolveUploadPath(e.stored_path, ws.firm_id);
      if (fp && fs.existsSync(fp)) zip.file(fp, { name: `evidence/${e.id}_${e.filename}` });
    }
    const supDocs = await db.prepare(`SELECT d.* FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=?`).all(ws.id);
    for (const d of supDocs) {
      if (d.stored_path) {
        const fp = resolveUploadPath(d.stored_path, ws.firm_id);
        if (fp && fs.existsSync(fp)) zip.file(fp, { name: `supplier-files/${d.id}_${d.filename}` });
      }
    }

    const readme = `ISMS handover package - ${ws.client_name}
  ==========================================================

  Generated: ${new Date().toISOString()}
  Workspace ID: ${ws.id}
  Client: ${ws.client_name}

  Contents:
    data/*.json     - every database row scoped to this workspace, decrypted for portability
    evidence/       - every evidence file uploaded against any control
    supplier-files/ - every supplier attestation / contract

  To import this elsewhere:
    1. Stand up an ISMS instance (any version >= today's).
    2. Restore the JSON files into the corresponding tables - preserving primary keys
       where possible. \`workspaces\` first, then everything keyed off workspace_id.
    3. Place evidence/* and supplier-files/* into the new instance's uploads/ directory
       using the same filenames.
    4. Re-encrypt sensitive fields under the new instance's master key (or run the
       /workspaces/:id/handover/import migration helper if available).
    5. Verify the audit-log hash chain at /workspaces/<id>/activity-log/verify.
  `;
    zip.append(readme, { name: 'README.txt' });
    await zip.finalize();
    await logAction(req.user.id, ws.id, 'handover_export', 'workspace', ws.id, null, auditCtx(req));
  });

  app.post('/workspaces/:wsId/bulk/:type', requireAuth, requireWorkspace, async (req, res) => {
    const allowed = { risks: { perm: 'risk.delete' }, assets: { perm: 'asset.delete' }, tasks: { perm: 'task.manage' }, suppliers: { perm: 'supplier.manage' }, ncs: { perm: 'nc.manage' }, incidents: { perm: 'incident.manage' } };
    const cfg = allowed[req.params.type];
    if (!cfg) return res.status(400).send('unknown type');
    if (!rbac.hasPermission(await permissionsFor(req.user, req.workspace), cfg.perm)) return res.status(403).render('error', { user: req.user, message: 'forbidden' });
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : [])).map(Number).filter(Boolean);
    if (!ids.length) return redirectBack(req, res);
    const op = req.body.op;
    const tableMap = { risks: 'risks', assets: 'assets', tasks: 'tasks', suppliers: 'suppliers', ncs: 'nonconformities', incidents: 'incidents' };
    const table = tableMap[req.params.type];
    if (op === 'delete') {
      const stmt = db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace_id=?`); // nosemgrep: javascript.express.security.injection.tainted-sql-string.tainted-sql-string
      const tx = db.transaction(async () => { for (const id of ids) await stmt.run(id, req.workspace.id); });
      await tx();
    } else if (op === 'reassign' && req.body.assignee) {
      const cols = { risks: 'owner_name', assets: 'owner_name', tasks: 'assignee_id', suppliers: 'approved_by', ncs: 'responsible', incidents: 'reported_by' };
      const col = cols[req.params.type];
      const stmt = db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=? AND workspace_id=?`);
      const tx = db.transaction(async () => { for (const id of ids) await stmt.run(req.body.assignee, id, req.workspace.id); });
      await tx();
    } else if (op === 'archive' && (req.params.type === 'tasks' || req.params.type === 'incidents' || req.params.type === 'ncs')) {
      const stmt = db.prepare(`UPDATE ${table} SET status='closed' WHERE id=? AND workspace_id=?`);
      const tx = db.transaction(async () => { for (const id of ids) await stmt.run(id, req.workspace.id); });
      await tx();
    }
    await logAction(req.user.id, req.workspace.id, 'bulk_' + op, req.params.type, null, { count: ids.length }, auditCtx(req));
    redirectBack(req, res);
  });

  app.get('/workspaces/:wsId/reports', requireAuth, requireWorkspace, requirePermission('workspace.export'), async (req, res) => {
    const list = await reportTemplateAccess.listVisibleReportTemplates(db, req.workspace);
    res.render('reports', { user: req.user, ws: req.workspace, list });
  });

  const reportSourcePermissions = [
    'control.view', 'risk.view', 'audit.manage', 'nc.manage',
    'mrm.manage', 'tprm.third_party.view', 'tprm.assurance.view',
    'tprm.assurance.export', 'document.view', 'task.manage',
  ].map(permission => requirePermission(permission));
  reportSourcePermissions.push(requireExactPermission('tprm.assurance.export'));

  app.get('/workspaces/:wsId/reports/:id', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), ...reportSourcePermissions, async (req, res) => {
    const tpl = await reportTemplateAccess.loadVisibleReportTemplate(db, req.workspace, req.params.id);
    if (!tpl) return res.status(404).send('Not found');
    const ctx = await reports.buildContext(req.workspace.id);
    const body = reports.render(tpl.body, ctx); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
    res.render('report_view', { user: req.user, ws: req.workspace, tpl, body });
  });

  app.get('/workspaces/:wsId/reports/:id/docx', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), ...reportSourcePermissions, async (req, res) => {
    const tpl = await reportTemplateAccess.loadVisibleReportTemplate(db, req.workspace, req.params.id);
    if (!tpl) return res.status(404).send('Not found');
    const ctx = await reports.buildContext(req.workspace.id);
    const body = reports.render(tpl.body, ctx); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
    const fakeDoc = { name: tpl.name, version: 1, status: 'report', content: body };
    try {
      const buf = await generateDocxBuffer(fakeDoc, req.workspace);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${tpl.name.replace(/[^\w\- ]+/g,'_')}.docx"`);
      res.send(buf);
    } catch (e) { res.status(500).send('docx error: ' + e.message); }
  });

  app.post('/workspaces/:wsId/reports', requireAuth, requireWorkspace, requirePermission('workspace.update'), async (req, res) => {
    const { name, description, body } = req.body;
    if (!name || !body) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO report_templates (workspace_id, firm_id, name, description, body, is_system) VALUES (?, NULL, ?, ?, ?, 0)`)
      .run(req.workspace.id, name, description || null, body)).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_report_template', 'report', id, { name }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/reports`);
  });

  app.post('/workspaces/:wsId/audits/:id/checklist-from-soa', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');

    const rows = await auditChecklists.includedControls(db, req.workspace);

    if (!rows.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`,
        'No controls marked included on the SoA - decide applicability before generating an audit checklist', 'error'));
    }

    const existing = new Set((await db.prepare(`SELECT iso_item_id FROM audit_observations WHERE audit_id=? AND iso_item_id IS NOT NULL`)
      .all(audit.id)).map(r => r.iso_item_id));
    const toInsert = rows.filter(r => !existing.has(r.id));

    const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
    const tx = db.transaction(async () => {
      for (const r of toInsert) {
        await ins.run(audit.id, r.id, auditChecklists.soaItemText(req.workspace, r));
      }
    });
    await tx();
    await logAction(req.user.id, req.workspace.id, 'generate_audit_checklist_from_soa', 'audit', audit.id,
      { added: toInsert.length, skipped_existing: rows.length - toInsert.length }, auditCtx(req));
    const skipped = rows.length - toInsert.length;
    const msg = skipped > 0
      ? `Added ${toInsert.length} new checklist item${toInsert.length === 1 ? '' : 's'} · ${skipped} already existed and were kept`
      : `Generated ${toInsert.length} checklist item${toInsert.length === 1 ? '' : 's'} from SoA · sample-size hints + linkage included`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, msg));
  });

  app.post('/workspaces/:wsId/audits/:id/checklist', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');
    const section = auditChecklists.parseSection(req.workspace, req.body.category);
    if (!section) return redirectBack(req, res);
    const controls = await auditChecklists.sectionItems(db, section);

    const existing = new Set((await db.prepare(`SELECT iso_item_id FROM audit_observations WHERE audit_id=? AND iso_item_id IS NOT NULL`)
      .all(audit.id)).map(r => r.iso_item_id));
    const toInsert = controls.filter(c => !existing.has(c.id));

    const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
    const tx = db.transaction(async () => {
      for (const c of toInsert) {
        await ins.run(audit.id, c.id, auditChecklists.sectionItemText(req.workspace, section.framework, c));
      }
    });
    await tx();
    await logAction(req.user.id, req.workspace.id, 'generate_audit_checklist', 'audit', audit.id,
      { framework: section.framework, category: section.category, added: toInsert.length, skipped_existing: controls.length - toInsert.length }, auditCtx(req));
    const skipped = controls.length - toInsert.length;
    const msg = skipped > 0
      ? `Added ${toInsert.length} new checklist item${toInsert.length === 1 ? '' : 's'} · ${skipped} already existed and were kept`
      : `Generated ${toInsert.length} checklist item${toInsert.length === 1 ? '' : 's'} - fill in findings against each`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, msg));
  });

  app.post('/workspaces/:wsId/audits/:id/observations', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const { iso_item_id, description, recommendation } = req.body;
    if (!description) return redirectBack(req, res);
    const requirement = iso_item_id && (await reqOpts.belongs(db, req.workspace, iso_item_id)) ? iso_item_id : null;
    await db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, recommendation) VALUES (?, ?, ?, ?)`)
      .run(req.params.id, requirement, description, recommendation || null);
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/close', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    await db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=? AND audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`).run(req.params.obsId, req.workspace.id);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/audits/:id/checklist/clear', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const audit = await db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');
    const result = await db.prepare(`DELETE FROM audit_observations WHERE audit_id=? AND status='open'`).run(audit.id);
    await logAction(req.user.id, req.workspace.id, 'clear_audit_checklist', 'audit', audit.id, { deleted: result.changes }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`,
      `Cleared ${result.changes} open checklist item${result.changes === 1 ? '' : 's'} (closed items kept)`));
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/reopen', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    await db.prepare(`UPDATE audit_observations SET status='open' WHERE id=? AND audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`).run(req.params.obsId, req.workspace.id);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/notes', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const obs = await db.prepare(`SELECT o.id, o.audit_id FROM audit_observations o
      INNER JOIN audits a ON a.id = o.audit_id
      WHERE o.id=? AND a.workspace_id=?`).get(req.params.obsId, req.workspace.id);
    if (!obs) return res.status(404).send('Not found');
    await db.prepare(`UPDATE audit_observations SET recommendation=? WHERE id=?`).run(req.body.recommendation || null, obs.id);
    await logAction(req.user.id, req.workspace.id, 'update_audit_observation', 'audit_observation', obs.id, {}, auditCtx(req));
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/promote', requireAuth, requireWorkspace, requireInternalAuditService, requirePermission('audit.manage'), async (req, res) => {
    const obs = await db.prepare(`SELECT o.* FROM audit_observations o
      INNER JOIN audits a ON a.id = o.audit_id
      WHERE o.id=? AND a.workspace_id=?`).get(req.params.obsId, req.workspace.id);
    if (!obs) return res.status(404).send('Not found');
    const finding_type = ['observation','ofi','minor_nc','major_nc'].includes(req.body.finding_type) ? req.body.finding_type : 'observation';
    const severity = ['low','medium','high'].includes(req.body.severity) ? req.body.severity : 'medium';
    const description = (req.body.description || obs.recommendation || obs.description || '').trim();
    if (!description) return redirectBack(req, res);
    const tx = db.transaction(async () => {
      await db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, severity, description, status)
                  VALUES (?, ?, ?, ?, ?, 'open')`)
        .run(obs.audit_id, obs.iso_item_id || null, finding_type, severity, description);
      await db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=?`).run(obs.id);
    });
    await tx();
    await logAction(req.user.id, req.workspace.id, 'promote_observation_to_finding', 'audit_observation', obs.id,
      { finding_type, severity }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${obs.audit_id}`,
      `Promoted to ${finding_type.replace('_',' ')} finding`));
  });

  app.get('/workspaces/:wsId/system', requireAuth, requireWorkspace, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).render('error', { user: req.user, message: 'Firm owner only.' });
    const firm = await db.prepare(`SELECT id,name,timezone FROM firms WHERE id=?`).get(req.workspace.firm_id);
    const timezones = ['UTC','Europe/London','Europe/Dublin','Europe/Paris','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Tokyo','Australia/Sydney'];
    res.render('system', { user: req.user, ws: req.workspace, firm, timezones,
      effectiveTimezone: workspaceTimeZone(req.workspace, firm) });
  });

  app.post('/workspaces/:wsId/system/timezone', requireAuth, requireWorkspace, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('forbidden');
    const firmTimezone = String(req.body.firm_timezone || '').trim();
    const workspaceTimezone = String(req.body.workspace_timezone || '').trim();
    if (!isValidTimeZone(firmTimezone) || (workspaceTimezone && !isValidTimeZone(workspaceTimezone))) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/system`, 'Choose a valid IANA timezone.', 'error'));
    }
    await db.transaction(async () => {
      await db.prepare(`UPDATE firms SET timezone=? WHERE id=?`).run(firmTimezone, req.workspace.firm_id);
      await db.prepare(`UPDATE workspaces SET timezone=?,updated_at=utc_now_text() WHERE id=? AND firm_id=?`)
        .run(workspaceTimezone || null, req.workspace.id, req.workspace.firm_id);
    })();
    await logAction(req.user.id, req.workspace.id, 'update_timezone_policy', 'workspace', req.workspace.id,
      { firmTimezone, workspaceTimezone: workspaceTimezone || null }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/system`, `Calendar timezone set to ${workspaceTimezone || firmTimezone}.`));
  });

  const platformOperationUnavailable = (_req, res) => res.status(404).send('Not found');
  app.post('/workspaces/:wsId/system/backup', requireAuth, requireWorkspace, platformOperationUnavailable);
  app.post('/workspaces/:wsId/system/rotate-key', requireAuth, requireWorkspace, platformOperationUnavailable);

  app.get('/workspaces/:wsId/evidence/:id/preview', requireAuth, requireWorkspace,
    requirePermission('evidence.download'), async (req, res) => {
    const ev = await db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
    const ext = path.extname(ev.filename).toLowerCase();
    const inlineTypes = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain' };
    const ct = inlineTypes[ext];
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(ev.filename, { type: ct ? 'inline' : 'attachment' }));
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(fp); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
  });

  app.post('/workspaces/:wsId/comments/:id/mentions', requireAuth, requireWorkspace, async (req, res) => {
    const c = await db.prepare('SELECT * FROM comments WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!c) return redirectBack(req, res);
    const decBody = enc.decryptIfNeeded(c.body, req.workspace.id);
    const handles = extractMentions(decBody);
    if (!handles.length) return redirectBack(req, res);
    const users = await db.prepare(`SELECT id, name FROM users WHERE active=1`).all();
    const ins = db.prepare(`INSERT INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`);
    let mentioned = 0;
    for (const h of handles) {
      const u = users.find(u => u.name.toLowerCase().replace(/\s+/g,'') === h.toLowerCase());
      if (u) { await ins.run(c.id, u.id); mentioned++;
        await jobs.notify(req.workspace.id, u.id, 'mention', 'info', `@${h} you were mentioned`, decBody.slice(0,140), `/workspaces/${req.workspace.id}`); }
    }
    if (mentioned > 0) await db.prepare('UPDATE comments SET has_mentions=1 WHERE id=?').run(c.id);
    redirectBack(req, res);
  });

}

module.exports = { register };
