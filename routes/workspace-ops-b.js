'use strict';

const express = require('express');
const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const rbac = require('../lib/rbac');
const ctlReads = require('../lib/control-reads');
const reqOpts = require('../lib/requirement-options');
const riskLinks = require('../lib/risk-control-links');
const riskOwner = require('../lib/risk-owner');
const ctlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const changesSince = require('../lib/changes-since');
const { seedFirmRiskLibraryIfEmpty } = require('../lib/firm-library');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml, parseFormArray } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState,
          getActiveMethodology, defaultMethodology, methodologyBand, ensureWorkspaceMethodology,
          activeEntityFilter, computeNeedsAttention, getWorkspace, listWorkspaces, permissionsFor } = deps;

  app.post('/workspaces/:wsId/bulk-controls', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), async (req, res) => {
    const { ids, status, applicability, owner_id } = req.body;
    const idList = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    const wcBulkCtl = ctlWrites.converged(db, req.workspace.id);
    let count = 0;
    for (const id of idList) {
      await getOrCreateState(req.workspace.id, id);
      const sets = []; const vals = [];
      if (status) { sets.push('status=?'); vals.push(status); }
      if (applicability) { sets.push('applicability=?'); vals.push(applicability); }
      if (owner_id !== undefined && owner_id !== '') { sets.push('owner_id=?'); vals.push(owner_id); }
      if (sets.length) {
        sets.push('last_updated=utc_now_text()');
        const rid = wcBulkCtl ? await ctlWrites.requirementId(db, 'iso27001', id) : null;
        if (wcBulkCtl && rid) {
          const c = ctlWrites.convergeSets(sets, vals);
          await db.prepare(`UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...c.vals, req.workspace.id, rid);
        } else {
          vals.push(req.workspace.id, id);
          await db.prepare(`UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
        }
        count++;
      }
    }
    await logAction(req.user.id, req.workspace.id, 'bulk_update_controls', 'control', null, { count, status, applicability });
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/controls/:isoId/autosave', requireAuth, requireWorkspace, requirePermission('control.update'), express.json(), async (req, res) => {
    await getOrCreateState(req.workspace.id, req.params.isoId);
    const allowed = ['status','applicability','inclusion_justification','exclusion_justification',
                     'maturity','notes','owner_id','due_date'];
    if (isFirmUser(req.user)) allowed.push('internal_notes');
    const sets = []; const vals = [];
    Object.keys(req.body).forEach(k => {
      if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(req.body[k] || null); }
    });
    if (!sets.length) return res.json({ ok: true, saved_at: new Date().toISOString() });

    const clientStamp = req.body.last_updated || null;
    sets.push('last_updated=utc_now_text()');
    const wcAuto = ctlWrites.converged(db, req.workspace.id);
    const ridAuto = wcAuto ? await ctlWrites.requirementId(db, 'iso27001', req.params.isoId) : null;
    let result;
    const curStamp = (wcAuto && ridAuto)
      ? async () => await db.prepare(`SELECT last_updated FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(req.workspace.id, ridAuto)
      : async () => await db.prepare(`SELECT last_updated FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, req.params.isoId);
    if (wcAuto && ridAuto) {
      const c = ctlWrites.convergeSets(sets, vals);
      const cVals = c.vals.slice();
      let sql = `UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`;
      cVals.push(req.workspace.id, ridAuto);
      if (clientStamp) { sql += ` AND last_updated = ?`; cVals.push(clientStamp); }
      result = await db.prepare(sql).run(...cVals);
    } else {
      vals.push(req.workspace.id, req.params.isoId);
      let sql = `UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`;
      if (clientStamp) { sql += ` AND last_updated = ?`; vals.push(clientStamp); }
      result = await db.prepare(sql).run(...vals);
    }
    if (clientStamp && result.changes === 0) {
      const current = curStamp();
      return res.status(409).json({
        ok: false, conflict: true,
        message: 'Another consultant updated this control. Reload to see their changes.',
        current_last_updated: current ? current.last_updated : null
      });
    }
    const cur = curStamp();
    res.json({ ok: true, saved_at: new Date().toISOString(), last_updated: cur ? cur.last_updated : null });
  });

  app.get('/api/search', requireAuth, async (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    const wsId = req.query.wsId ? parseInt(req.query.wsId, 10) : null;
    if (!q) return res.json([]);
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const results = [];

    const clientMode = req.user.user_type === 'client' || req.query.clientMode === '1';
    if (clientMode) {
      if (!wsId) return res.json([]);
      const ws = await getWorkspace(wsId, req.user);
      if (!ws) return res.json([]);
      const preview = req.user.user_type === 'firm' && req.query.clientMode === '1';
      const pages = [
        ['Home', 'Engagement summary, programmes and contacts', 'home', 'overview dashboard contact team'],
        ['My actions', 'Requests, deliverables and approvals', 'actions', 'request evidence approval task deliverable'],
        ['Progress', 'Assessment stages and programme progress', 'progress', 'assessment fieldwork validation report roadmap'],
        ['Findings and remediation', 'Confirmed findings and improvement actions', 'findings', 'gap issue remediation action'],
        ['Reports', 'Published reports and completed work', 'reports', 'report download published completed work'],
      ];
      for (const [label,sublabel,view,aliases] of pages) {
        if (!label.toLowerCase().includes(q) && !sublabel.toLowerCase().includes(q) && !aliases.includes(q)) continue;
        const params = new URLSearchParams({ view });
        if (preview) params.set('preview','client');
        results.push({ type:'Page',label,sublabel,href:`/workspaces/${wsId}/client-portal?${params}` });
      }
      return res.json(results);
    }

    const wsList = (await listWorkspaces(req.user)).filter(w => w.client_name.toLowerCase().includes(q) || (w.industry && w.industry.toLowerCase().includes(q)));
    wsList.slice(0, 5).forEach(w => results.push({
      type: 'Client', label: w.client_name, sublabel: w.industry || w.stage,
      href: '/workspaces/' + w.id, badge: w.stage.replace(/_/g, ' ')
    }));

    if (wsId) {
      const ws = await getWorkspace(wsId, req.user);
      if (ws) {
        const items = await db.prepare(`SELECT rq.ref AS id, rq.title, rq.req_type AS type, f.code AS framework
                                   FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                                   WHERE f.code = 'iso27001' AND rq.req_type IN ('clause','control')
                                     AND (lower(rq.title) ILIKE ? OR lower(rq.ref) ILIKE ?)
                                   ORDER BY rq.sort_order NULLS FIRST LIMIT 8`).all(like, like);
        items.forEach(i => results.push({
          type: i.type === 'clause' ? 'Clause' : 'Control',
          label: reqOpts.displayTitle(ws, i.framework, i.title),
          sublabel: reqOpts.codeOf(i),
          href: '/workspaces/' + wsId + '/controls/' + i.id
        }));

        const risks = await db.prepare(`SELECT id, title FROM risks WHERE workspace_id = ? AND lower(title) ILIKE ? LIMIT 5`).all(wsId, like);
        risks.forEach(r => results.push({ type: 'Risk', label: r.title, sublabel: 'R-' + String(r.id).padStart(3,'0'), href: '/workspaces/' + wsId + '/risks/' + r.id }));

        const assets = await db.prepare(`SELECT id, name, type FROM assets WHERE workspace_id = ? AND lower(name) ILIKE ? LIMIT 5`).all(wsId, like);
        assets.forEach(a => results.push({ type: 'Asset', label: a.name, sublabel: a.type, href: '/workspaces/' + wsId + '/assets' }));

        const docs = await db.prepare(`SELECT id, name, status FROM generated_docs WHERE workspace_id = ? AND lower(name) ILIKE ? LIMIT 5`).all(wsId, like);
        docs.forEach(d => results.push({ type: 'Document', label: d.name, sublabel: d.status, href: '/workspaces/' + wsId + '/documents/' + d.id }));

        const ncs = await db.prepare(`SELECT id, title FROM nonconformities WHERE workspace_id = ? AND lower(title) ILIKE ? LIMIT 5`).all(wsId, like);
        ncs.forEach(n => results.push({ type: 'NC', label: n.title, sublabel: 'NC-' + String(n.id).padStart(3,'0'), href: '/workspaces/' + wsId + '/nonconformities/' + n.id }));

        const nav = [
          ['Overview', '', 'dashboard home'],
          ['Readiness', '/readiness', 'stage 1 stage 2 cert ready'],
          ['Gap assessment', '/gap-assessment', 'pass passes re-assessment reassess diff'],
          ['Roadmap', '/roadmap', 'pdca implementation plan needs attention'],
          ['Controls', '/controls', 'annex a clauses wizard'],
          ['Assets', '/assets', 'inventory asset register'],
          ['Risks', '/risks', 'risk register'],
          ['Performance & objectives', '/objectives', 'clause 6.2 clause 9.1 information security objectives metrics measures readings kpi'],
          ['Risk methodology', '/risk-methodology', 'risk criteria scales'],
          ['Risk acceptances', '/risk-acceptances', 'accepted risks'],
          ['Statement of Applicability', '/soa', 'soa annex a inclusion exclusion'],
          ['SoA snapshots', '/soa/snapshots', 'soa version history'],
          ['Documents', '/documents', 'policies procedures'],
          ['Evidence library', '/evidence', 'audit evidence files'],
          ['Internal audits', '/audits', 'audit'],
          ['Audit programme', '/audit-programme', 'audit schedule annual'],
          ['Management review', '/mrms', 'mrm top management review'],
          ['Cert cycle', '/cert-cycle', 'certification stage 1 stage 2 surveillance recert'],
          ['Nonconformities', '/nonconformities', 'nc finding'],
          ['Incidents', '/incidents', 'security incident'],
          ['Improvements', '/improvements', 'continual improvement opportunity'],
          ['Suppliers', '/vendors', 'vendor third party tprm'],
          ['Tasks', '/tasks', 'task remediation'],
          ['Task templates', '/task-templates', 'task template'],
          ['Compliance calendar', '/calendar', 'calendar dates schedule'],
          ['Deliverables', '/deliverables', 'deliverable export report docx zip pack'],
          ['Report templates', '/reports', 'report template markdown'],
          ['Team & access', '/team', 'team members users access permissions rbac'],
          ['Activity log', '/activity-log', 'audit trail history']
        ];
        nav.filter(([n, , aliases]) => n.toLowerCase().includes(q) || (aliases && aliases.toLowerCase().includes(q)))
          .slice(0, 8)
          .forEach(([n, p]) => {
            results.push({ type: 'Page', label: n, sublabel: ws.client_name, href: '/workspaces/' + wsId + p });
          });
      }
    } else {
      if ('clients'.includes(q) || 'dashboard'.includes(q) || 'home'.includes(q)) {
        results.push({ type: 'Page', label: 'Clients', sublabel: 'All workspaces', href: '/dashboard' });
      }
    }

    if ('glossary'.includes(q) || 'terms'.includes(q) || 'dictionary'.includes(q) || 'definitions'.includes(q)) {
      results.push({ type: 'Reference', label: 'Glossary', sublabel: 'ISO 27001 & GRC terms', href: '/glossary' });
    }
    try {
      const GLOSSARY = require('../data/glossary');
      const matches = GLOSSARY.searchEntries(q, 'all', 'all').slice(0, 5);
      for (const m of matches) {
        results.push({
          type: 'Glossary',
          label: m.term,
          sublabel: m.plain ? (m.plain.length > 70 ? m.plain.slice(0, 70) + '…' : m.plain) : '',
          href: '/glossary/' + m.slug
        });
      }
    } catch (_) { }

    res.json(results.slice(0, 30));
  });

  app.get('/api/workspaces/:wsId/trends', requireAuth, requireWorkspace, async (req, res) => {
    const wsId = req.workspace.id;
    async function dayCounts(query, ...params) {
      const rows = await db.prepare(query).all(...params);
      const map = Object.fromEntries(rows.map(r => [r.d, r.c]));
      const series = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const k = d.toISOString().split('T')[0];
        series.push({ d: k, c: map[k] || 0 });
      }
      return series;
    }
    res.json({
      risks: await dayCounts(`SELECT utc_date_text(utc_ts(created_at)) AS d, COUNT(*) AS c FROM risks WHERE workspace_id=? AND created_at >= utc_date_text(now() + ('-29 days')::interval) GROUP BY utc_date_text(utc_ts(created_at))`, wsId),
      controls: await dayCounts(`SELECT utc_date_text(utc_ts(last_updated)) AS d, COUNT(*) AS c FROM ${ctlReads.tables(db, wsId).cs} WHERE workspace_id=? AND status='Implemented' AND last_updated >= utc_date_text(now() + ('-29 days')::interval) GROUP BY utc_date_text(utc_ts(last_updated))`, wsId),
      ncs_open: await dayCounts(`SELECT utc_date_text(utc_ts(created_at)) AS d, COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND created_at >= utc_date_text(now() + ('-29 days')::interval) GROUP BY utc_date_text(utc_ts(created_at))`, wsId),
      ncs_closed: await dayCounts(`SELECT utc_date_text(utc_ts(closed_at)) AS d, COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND closed_at >= utc_date_text(now() + ('-29 days')::interval) GROUP BY utc_date_text(utc_ts(closed_at))`, wsId)
    });
  });

  app.get('/workspaces/:wsId/access', requireAuth, requireWorkspace, requirePermission('members.view'), async (req, res) => {
    const members = await db.prepare(`SELECT m.*, u.name, u.email, u.user_type, u.firm_role
      FROM workspace_members m INNER JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
    const firmUsers = await db.prepare(`SELECT id, name, email, firm_role FROM users
      WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(req.workspace.firm_id);
    const overrides = await db.prepare(`SELECT o.*, u.name FROM workspace_role_overrides o
      INNER JOIN users u ON u.id=o.user_id WHERE o.workspace_id=? ORDER BY u.name, o.permission`).all(req.workspace.id);
    res.render('access', {
      user: req.user, ws: req.workspace, members, firmUsers, overrides,
      permissions: rbac.PERMISSIONS, roles: rbac.ROLE_LABELS, rolePerms: rbac.ROLE_PERMS,
      permsFor: async u => Array.from(await permissionsFor(u, req.workspace))
    });
  });

  app.post('/workspaces/:wsId/access/role', requireAuth, requireWorkspace, requirePermission('members.assign_role'), async (req, res) => {
    const { user_id, role } = req.body;
    if (!user_id || !rbac.ROLE_PERMS[role]) return redirectBack(req, res);
    const target = await db.prepare(`SELECT id,user_type,firm_id,active FROM users WHERE id=?`).get(user_id);
    if (!target || !target.active) {
      return res.status(403).render('error', { user: req.user, message: 'That user is not eligible for this workspace.' });
    }
    if (target.user_type === 'firm') {
      if (target.firm_id !== req.workspace.firm_id || !['senior_consultant','consultant'].includes(role)) {
        return res.status(403).render('error', { user: req.user, message: 'Firm roles can only be assigned to active consultants in this firm.' });
      }
    } else {
      const existingClientMember = await db.prepare(`SELECT 1 FROM workspace_members
        WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, target.id);
      if (!existingClientMember || !rbac.CLIENT_ROLES.includes(role)) {
        return res.status(403).render('error', { user: req.user, message: 'Client roles can only be changed for existing members of this workspace.' });
      }
    }
    const before = await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.workspace.id, user_id);
    if (before) {
      await db.prepare(`UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?`).run(role, req.workspace.id, user_id);
    } else {
      await db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`).run(req.workspace.id, user_id, role);
    }
    await logAction(req.user.id, req.workspace.id, 'assign_role', 'user', user_id,
      { role, previous: before?.role || null }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/access');
  });

  app.post('/workspaces/:wsId/access/override', requireAuth, requireWorkspace, requirePermission('members.override_perms'), async (req, res) => {
    const { user_id, permission, granted, reason } = req.body;
    if (!user_id || !permission || !rbac.PERMISSIONS[permission]) return redirectBack(req, res);
    const g = granted === '1' || granted === 'on' ? 1 : 0;
    await db.prepare(`INSERT INTO workspace_role_overrides (workspace_id, user_id, permission, granted, granted_by, reason)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id, permission) DO UPDATE SET granted=excluded.granted, granted_by=excluded.granted_by, reason=excluded.reason, created_at=utc_now_text()`)
      .run(req.workspace.id, user_id, permission, g, req.user.id, reason || null);
    await logAction(req.user.id, req.workspace.id, 'override_permission', 'user', user_id, { permission, granted: !!g, reason }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/access');
  });

  app.post('/workspaces/:wsId/access/override/:id/delete', requireAuth, requireWorkspace, requirePermission('members.override_perms'), async (req, res) => {
    const o = await db.prepare('SELECT * FROM workspace_role_overrides WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (o) {
      await db.prepare('DELETE FROM workspace_role_overrides WHERE id=?').run(o.id);
      await logAction(req.user.id, req.workspace.id, 'remove_override', 'user', o.user_id, { permission: o.permission }, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/access');
  });

  const methodSystem = req => riskOwner.requested(req.workspace, (req.body && req.body.standard) || req.query.standard);
  const methodPage = (req) => `/workspaces/${req.workspace.id}/risk-methodology`;
  const deactivateMethods = async (wsId, system) => await db.prepare(`UPDATE risk_methodologies SET is_active=0 WHERE workspace_id=? AND management_system=?`).run(wsId, system);

  app.get('/workspaces/:wsId/risk-methodology', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const system = methodSystem(req);
    const m = await getActiveMethodology(req.workspace.id, system);
    const all = await db.prepare('SELECT id, name, description, is_active, updated_at FROM risk_methodologies WHERE workspace_id=? AND management_system=? ORDER BY is_active DESC, name').all(req.workspace.id, system);
    res.render('risk_methodology', { user: req.user, ws: req.workspace, methodology: m, all, standard: system });
  });

  app.post('/workspaces/:wsId/risk-methodology', requireAuth, requireWorkspace, requirePermission('risk.methodology'), async (req, res) => {
    const { name, description, likelihood_scale, impact_scale, matrix, thresholds } = req.body;
    let lScale, iScale, mat, thr;
    try {
      lScale = JSON.parse(likelihood_scale);
      iScale = JSON.parse(impact_scale);
      mat = JSON.parse(matrix);
      thr = JSON.parse(thresholds);
      if (!Array.isArray(lScale) || !Array.isArray(iScale) || !Array.isArray(mat)) throw new Error('Bad shape');
      if (mat.length !== lScale.length) throw new Error(`Matrix rows (${mat.length}) must match likelihood scale (${lScale.length})`);
      if (mat.some(r => !Array.isArray(r) || r.length !== iScale.length)) throw new Error(`Matrix columns must match impact scale (${iScale.length})`);
      for (const lev of mat.flat()) {
        if (!thr[lev]) throw new Error(`Matrix references undefined threshold "${lev}"`);
      }
    } catch (e) {
      return res.status(400).render('error', { user: req.user, message: 'Invalid methodology: ' + e.message });
    }

    const system = methodSystem(req);
    const before = await getActiveMethodology(req.workspace.id, system);
    await deactivateMethods(req.workspace.id, system);
    const id = (await db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active, management_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
      req.workspace.id, name || 'Custom', description || null,
      JSON.stringify(lScale), JSON.stringify(iScale), JSON.stringify(mat), JSON.stringify(thr), system
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'update_risk_methodology', 'methodology', id,
      { name, management_system: system }, { ...auditCtx(req), before: { id: before.id, name: before.name }, after: { id, name } });
    res.redirect(withToast(methodPage(req), 'Methodology updated'));
  });

  app.post('/workspaces/:wsId/risk-methodology/reset', requireAuth, requireWorkspace, requirePermission('risk.methodology'), async (req, res) => {
    const system = methodSystem(req);
    await deactivateMethods(req.workspace.id, system);
    const m = defaultMethodology();
    await db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active, management_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
      req.workspace.id, m.name, m.description,
      JSON.stringify(m.likelihood_scale), JSON.stringify(m.impact_scale),
      JSON.stringify(m.matrix), JSON.stringify(m.thresholds), system);
    await logAction(req.user.id, req.workspace.id, 'reset_risk_methodology', 'methodology', null, { management_system: system }, auditCtx(req));
    res.redirect(methodPage(req));
  });

  app.get('/workspaces/:wsId/review-queue', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const filter = req.query.filter || 'open';
    const wsId = req.workspace.id;
    const T = ctlReads.tables(db, wsId);

    const iso27 = (await db.prepare(`SELECT cs.iso_item_id AS item_id, i.title, cs.review_status, cs.review_requested_at,
        cs.reviewed_at, cs.review_reason,
        ru.name AS requested_by_name, rv.name AS reviewed_by_name
      FROM ${T.cs} cs
      INNER JOIN iso_items i ON i.id = cs.iso_item_id
      LEFT JOIN users ru ON ru.id = cs.review_requested_by
      LEFT JOIN users rv ON rv.id = cs.reviewed_by
      WHERE cs.workspace_id=? AND cs.review_status != 'none'
      ORDER BY cs.review_requested_at DESC NULLS LAST`).all(wsId)).map(r => ({ ...r, framework: 'iso27001', link: `/workspaces/${wsId}/controls/assess/${r.item_id}` }));

    let all = [...iso27];
    if (filter === 'open') all = all.filter(r => ['requested','needs_changes'].includes(r.review_status));
    const counts = {
      requested: iso27.filter(r => r.review_status === 'requested').length,
      needs_changes: iso27.filter(r => r.review_status === 'needs_changes').length,
      reviewed: iso27.filter(r => r.review_status === 'reviewed').length
    };
    res.render('review_queue', { user: req.user, ws: req.workspace, rows: all, filter, counts });
  });

  app.get('/workspaces/:wsId/activity-log', requireAuth, requireWorkspace, requirePermission('audit_log.view'), async (req, res) => {
    const filters = {
      user_id: req.query.user_id || '',
      action: req.query.action || '',
      entity_type: req.query.entity_type || '',
      from: req.query.from || '',
      to: req.query.to || '',
      q: req.query.q || ''
    };
    const where = ['a.workspace_id=?']; const params = [req.workspace.id];
    if (filters.user_id) { where.push('a.user_id=?'); params.push(filters.user_id); }
    if (filters.action) { where.push('a.action=?'); params.push(filters.action); }
    if (filters.entity_type) { where.push('a.entity_type=?'); params.push(filters.entity_type); }
    if (filters.from) { where.push('a.created_at >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('a.created_at <= ?'); params.push(filters.to + ' 23:59:59'); }
    if (filters.q) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR a.details LIKE ?)'); const lk = '%'+filters.q+'%'; params.push(lk, lk, lk); }
    const pg = await paginate(db, req, {
      count: `SELECT COUNT(*) c FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE ${where.join(' AND ')}`,
      rows: `SELECT a.*, u.name AS user_name FROM audit_log a
        INNER JOIN users u ON u.id=a.user_id
        WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC NULLS LAST`,
      params, perPage: 100,
    });
    const users = await db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a
      INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
    const actions = (await db.prepare(`SELECT DISTINCT action FROM audit_log WHERE workspace_id=? ORDER BY action`).all(req.workspace.id)).map(r => r.action);
    const types = (await db.prepare(`SELECT DISTINCT entity_type FROM audit_log WHERE workspace_id=? AND entity_type IS NOT NULL ORDER BY entity_type`).all(req.workspace.id)).map(r => r.entity_type);
    res.render('activity_log', { user: req.user, ws: req.workspace, log: pg.rows, pg, pagerHref: p => pageHref(req, p), filters, users, actions, types });
  });

  app.get('/workspaces/:wsId/risks/:id/treatments', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const risk = await db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Not found');
    const treatments = reqOpts.nameRows(req.workspace, await db.prepare(`SELECT t.*, rq.title AS iso_title, rq_fw.code AS iso_framework
      FROM risk_treatments t ${reqOpts.joinSql('t.iso_item_id')}
      WHERE t.risk_id=? ORDER BY t.due_date IS NULL, t.due_date`).all(risk.id));
    const controlGroups = await riskLinks.pickerGroups(db, req.workspace, risk.id);
    res.render('risk_treatments', { user: req.user, ws: req.workspace, risk, treatments, controlGroups });
  });

  app.post('/workspaces/:wsId/risks/:id/treatments', requireAuth, requireWorkspace, requirePermission('risk.update'), async (req, res) => {
    const risk = await db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const { title, description, owner_name, due_date, status, cost_estimate, expected_residual_l, expected_residual_i, iso_item_id } = req.body;
    if (!title) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO risk_treatments (workspace_id, risk_id, title, description, owner_name, due_date, status, cost_estimate, expected_residual_l, expected_residual_i, iso_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, title, description || null, owner_name || null,
      due_date || null, status || 'planned', cost_estimate || null,
      expected_residual_l ? parseInt(expected_residual_l) : null,
      expected_residual_i ? parseInt(expected_residual_i) : null,
      iso_item_id && (await reqOpts.belongs(db, req.workspace, iso_item_id)) ? iso_item_id : null
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_treatment', 'treatment', id, { risk_id: req.params.id, title }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/treatments`);
  });

  app.post('/workspaces/:wsId/risks/:id/treatments/:tId', requireAuth, requireWorkspace, requirePermission('risk.update'), async (req, res) => {
    const risk = await db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const f = ['title','description','owner_name','due_date','completed_date','status','cost_estimate','expected_residual_l','expected_residual_i','iso_item_id'];
    const set = [];const vals = [];

    for (const __item of f) await (async k => {
      if (req.body[k] === undefined) return;
      set.push(`${k}=?`);
      vals.push(k === 'iso_item_id'
        ? (req.body[k] && (await reqOpts.belongs(db, req.workspace, req.body[k])) ? req.body[k] : null)
        : (req.body[k] || null));
    })(__item);

    if (req.body.status === 'done' && !req.body.completed_date) { set.push(`completed_date=utc_today_text()`); }
    if (set.length) {
      vals.push(req.params.tId, req.params.id);
      await db.prepare(`UPDATE risk_treatments SET ${set.join(',')} WHERE id=? AND risk_id=?`).run(...vals);
      await logAction(req.user.id, req.workspace.id, 'update_treatment', 'treatment', req.params.tId, null, auditCtx(req));
    }
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/treatments`);
  });

  app.post('/workspaces/:wsId/risks/:id/treatments/:tId/delete', requireAuth, requireWorkspace, requirePermission('risk.update'), async (req, res) => {
    const risk = await db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    await db.prepare('DELETE FROM risk_treatments WHERE id=? AND risk_id=?').run(req.params.tId, req.params.id);
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/treatments`);
  });

  const METHODOLOGY_PRESETS = require('../data/methodology-presets');

  app.post('/workspaces/:wsId/risk-methodology/preset/:key', requireAuth, requireWorkspace, requirePermission('risk.methodology'), async (req, res) => {
    const preset = METHODOLOGY_PRESETS[req.params.key];
    if (!preset) return redirectBack(req, res);
    const system = methodSystem(req);
    await deactivateMethods(req.workspace.id, system);
    await db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active, management_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
      req.workspace.id, preset.name, preset.description,
      JSON.stringify(preset.likelihood_scale), JSON.stringify(preset.impact_scale),
      JSON.stringify(preset.matrix), JSON.stringify(preset.thresholds), system);
    await logAction(req.user.id, req.workspace.id, 'apply_methodology_preset', 'methodology', null, { preset: req.params.key, management_system: system }, auditCtx(req));
    res.redirect(methodPage(req));
  });

  async function captureSoASnapshot(wsId, userId, entityId, label, reason) {
    const rows = await db.prepare(`SELECT i.id, i.title, i.category,
      COALESCE(cs.applicability,'undecided') AS applicability,
      COALESCE(cs.status,'Not Assessed') AS status,
      cs.inclusion_justification, cs.exclusion_justification
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' ORDER BY i.sort_order NULLS FIRST`).all(wsId);
    const payload = JSON.stringify(rows);
    const hash = enc.sha256(payload);
    const inc = rows.filter(r => r.applicability === 'included').length;
    const exc = rows.filter(r => r.applicability === 'excluded').length;
    const id = (await db.prepare(`INSERT INTO soa_snapshots (workspace_id, entity_id, label, reason, payload, payload_hash, control_count, included_count, excluded_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      wsId, entityId || null, label || null, reason || null,
      enc.encryptIfNeeded(payload, wsId, true), hash, rows.length, inc, exc, userId
    )).lastInsertRowid;
    return { id, hash, control_count: rows.length, included_count: inc, excluded_count: exc };
  }

  app.post('/workspaces/:wsId/soa/snapshot', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const snap = await captureSoASnapshot(req.workspace.id, req.user.id, null, req.body.label, req.body.reason);
    await logAction(req.user.id, req.workspace.id, 'snapshot_soa', 'soa', snap.id, snap, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/soa/snapshots`, 'Snapshot captured'));
  });

  app.get('/workspaces/:wsId/soa/snapshots', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const list = await db.prepare(`SELECT s.*, u.name AS author, e.name AS entity_name FROM soa_snapshots s
      LEFT JOIN users u ON u.id=s.created_by LEFT JOIN entities e ON e.id=s.entity_id
      WHERE s.workspace_id=? ORDER BY s.created_at DESC NULLS LAST, s.id DESC`).all(req.workspace.id);
    res.render('soa_snapshots', { user: req.user, ws: req.workspace, snapshots: list });
  });

  app.get('/workspaces/:wsId/soa/snapshots/diff', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const a = parseInt(req.query.a || 0, 10);
    const b = parseInt(req.query.b || 0, 10);
    const sa = a ? await db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(a, req.workspace.id) : null;
    const sb = b ? await db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(b, req.workspace.id) : null;
    let diff = null;
    if (sa && sb) {
      const ra = JSON.parse(enc.decryptIfNeeded(sa.payload, req.workspace.id));
      const rb = JSON.parse(enc.decryptIfNeeded(sb.payload, req.workspace.id));
      const map = (rows) => Object.fromEntries(rows.map(r => [r.id, r]));
      const ma = map(ra), mb = map(rb);
      const ids = new Set([...Object.keys(ma), ...Object.keys(mb)]);
      diff = [];
      for (const id of ids) {
        const x = ma[id], y = mb[id];
        const changes = [];
        if (!x) changes.push(`+ added`);
        else if (!y) changes.push(`− removed`);
        else {
          if (x.applicability !== y.applicability) changes.push(`applicability: ${x.applicability} → ${y.applicability}`);
          if (x.status !== y.status) changes.push(`status: ${x.status} → ${y.status}`);
          if ((x.inclusion_justification || '') !== (y.inclusion_justification || '')) changes.push(`inclusion justification changed`);
          if ((x.exclusion_justification || '') !== (y.exclusion_justification || '')) changes.push(`exclusion justification changed`);
        }
        if (changes.length) diff.push({ id, title: (y || x).title, changes });
      }
    }
    const all = await db.prepare('SELECT id, label, created_at FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC NULLS LAST, id DESC').all(req.workspace.id);
    res.render('soa_snapshot_diff', { user: req.user, ws: req.workspace, sa, sb, diff, all });
  });

  app.get('/workspaces/:wsId/soa/snapshots/:id(\\d+)', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const s = await db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!s) return res.status(404).render('error', { user: req.user, message: 'Snapshot not found. It may have been deleted, or the URL is wrong. Use the Snapshots tab to pick a current one.' });
    const rows = JSON.parse(enc.decryptIfNeeded(s.payload, req.workspace.id));
    res.render('soa_snapshot_detail', { user: req.user, ws: req.workspace, snapshot: s, rows });
  });

  app.post('/workspaces/:wsId/soa/auto-justify', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), async (req, res) => {
    const linked = await db.prepare(`SELECT i.id, i.title, COUNT(rc.id) AS rc, string_agg(DISTINCT r.title, ',') AS risks
      FROM iso_items i
      INNER JOIN risk_controls rc ON rc.iso_item_id=i.id
      INNER JOIN risks r ON r.id=rc.risk_id
      WHERE i.type='control' AND r.workspace_id=?
      GROUP BY i.id`).all(req.workspace.id);
    const wcAj = ctlWrites.converged(db, req.workspace.id);
    let updated = 0;
    for (const c of linked) {
      await getOrCreateState(req.workspace.id, c.id);
      const just = `Driven by risks: ${c.risks}`;
      const ridAj = wcAj ? await ctlWrites.requirementId(db, 'iso27001', c.id) : null;
      if (wcAj && ridAj) {
        await db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification=COALESCE(inclusion_justification, ?), last_updated=utc_now_text()
          WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND applicability != ?`)
          .run(ctlWrites.normApplic('included'), just, req.workspace.id, ridAj, ctlWrites.normApplic('excluded'));
      } else {
        await db.prepare(`UPDATE control_states SET applicability='included', inclusion_justification=COALESCE(inclusion_justification, ?), last_updated=utc_now_text()
          WHERE workspace_id=? AND iso_item_id=? AND applicability != 'excluded'`)
          .run(just, req.workspace.id, c.id);
      }
      updated++;
    }
    await logAction(req.user.id, req.workspace.id, 'soa_auto_justify', 'soa', null, { updated }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/soa`, `Auto-justified ${updated} controls`));
  });

  app.get('/workspaces/:wsId/inbox', requireAuth, requireWorkspace, async (req, res) => {
    const wsId = req.workspace.id;
    const computed = await computeNeedsAttention(wsId);
    const filter = req.query.filter === 'all' ? 'all' : 'unread';
    const notifications = (await require('../lib/notification-delivery').list(db,{workspaceId:wsId,actor:req.user,unreadOnly:filter==='unread',limit:200}))
      .map(row=>({...row,read_at:row.actor_read_at,dismissed_at:row.actor_dismissed_at}));
    res.render('client_inbox', {
      user: req.user, ws: req.workspace,
      computed, notifications, filter,
      monthlyPlan: req.workspace.monthly_plan || ''
    });
  });

  app.post('/workspaces/:wsId/inbox/plan', requireAuth, requireWorkspace, async (req, res) => {
    const plan = (req.body.monthly_plan || '').slice(0, 10000);
    await db.prepare(`UPDATE workspaces SET monthly_plan=? WHERE id=?`).run(plan, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'update_monthly_plan', 'workspace', req.workspace.id, null);
    res.redirect(withToast(`/workspaces/${req.workspace.id}/inbox`, 'Plan saved'));
  });

  app.get('/workspaces/:wsId/changes-since', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const since = (req.query.since || '').toString().trim() || null;
    const data = await changesSince.gather({ db, enc }, req.workspace.id, since);
    const anchors = {
      audits: await db.prepare(`SELECT id, title, audit_date, status FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL ORDER BY audit_date DESC`).all(req.workspace.id),
      snapshots: await db.prepare(`SELECT id, label, created_at FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC NULLS LAST, id DESC`).all(req.workspace.id)
    };
    res.render('changes_since', { user: req.user, ws: req.workspace, data, anchors });
  });

  app.get('/workspaces/:wsId/deliverables', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    res.redirect(`/workspaces/${req.workspace.id}/assurance`);
  });

  app.get('/firm/library', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    await seedFirmRiskLibraryIfEmpty(firmId);
    const counts = {
      risks: (await db.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(firmId)).c,
      templates: (await db.prepare('SELECT COUNT(*) c FROM doc_templates WHERE firm_id=? AND is_system=0').get(firmId)).c,
    };
    res.render('firm_library', { user: req.user, ws: null, counts });
  });

  app.get('/firm/library/templates', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    res.render('firm_library_templates', { user: req.user, ws: null, templates: await require('../lib/firm-templates').list(db, firmId),
      canManage: rbac.rolePermissions(req.user.firm_role).includes('firm.library.manage') });
  });

  app.post('/firm/library/templates/:id(\\d+)/delete', requireAuth, async (req, res) => {
    if (!requireFirmLibraryManage(req, res)) return;
    const firmId = await getActiveFirmId(req);
    const firmTemplates = require('../lib/firm-templates');
    try {
      const t = await firmTemplates.remove(db, firmId, Number(req.params.id));
      await logAction(req.user.id, null, 'delete_firm_template', 'doc_template', t.id, { name: t.name });
      res.redirect(withToast('/firm/library/templates', `Removed "${t.name}". Documents already made from it are unchanged.`));
    } catch (e) {
      if (!(e instanceof firmTemplates.FirmTemplateError)) throw e;
      res.redirect(withToast('/firm/library/templates', e.message, 'error'));
    }
  });

  app.get('/firm/library/risks', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    await seedFirmRiskLibraryIfEmpty(firmId);
    const filterSector = (req.query.sector || '').trim();
    const filterDomain = (req.query.domain || '').trim();
    const search = (req.query.q || '').trim().toLowerCase();
    let rows = await db.prepare(`SELECT * FROM firm_risk_library WHERE firm_id=? ORDER BY domain, title`).all(firmId);
    if (filterSector) rows = rows.filter(r => (r.sector || '').toLowerCase() === filterSector.toLowerCase());
    if (filterDomain) rows = rows.filter(r => (r.domain || '').toLowerCase() === filterDomain.toLowerCase());
    if (search) rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(search) ||
      (r.description || '').toLowerCase().includes(search) ||
      (r.tags || '').toLowerCase().includes(search));
    const sectors = [...new Set((await db.prepare('SELECT DISTINCT sector FROM firm_risk_library WHERE firm_id=? AND sector IS NOT NULL').all(firmId)).map(r => r.sector))];
    const domains = [...new Set((await db.prepare('SELECT DISTINCT domain FROM firm_risk_library WHERE firm_id=? AND domain IS NOT NULL').all(firmId)).map(r => r.domain))];
    const canManage = rbac.rolePermissions(req.user.firm_role).includes('firm.library.manage');
    res.render('firm_library_risks', { user: req.user, ws: null, rows, sectors, domains, filterSector, filterDomain, search, canManage });
  });

  function requireFirmLibraryManage(req, res) {
    if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.library.manage')) {
      res.status(403).render('error', {
        user: req.user, message: 'Managing the firm risk library requires a firm manager or senior consultant.' });
      return false;
    }
    return true;
  }

  app.post('/firm/library/risks', requireAuth, async (req, res) => {
    if (!requireFirmLibraryManage(req, res)) return;
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const { title, description, threat, vulnerability, domain, sector, tags,
      suggested_likelihood, suggested_impact, suggested_treatment, suggested_controls, notes } = req.body;
    if (!(title || '').trim()) return redirectBack(req, res, 'Title is required', 'error');
    await db.prepare(`INSERT INTO firm_risk_library
      (firm_id, title, description, threat, vulnerability, domain, sector, tags,
       suggested_likelihood, suggested_impact, suggested_treatment, suggested_controls, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(firmId, title.trim(), description || null, threat || null, vulnerability || null,
        domain || null, sector || null, tags || null,
        parseInt(suggested_likelihood, 10) || null, parseInt(suggested_impact, 10) || null,
        suggested_treatment || null, suggested_controls || null, notes || null);
    res.redirect('/firm/library/risks');
  });

  app.post('/firm/library/risks/:id/update', requireAuth, async (req, res) => {
    if (!requireFirmLibraryManage(req, res)) return;
    const firmId = await getActiveFirmId(req);
    const id = parseInt(req.params.id, 10);
    const { title, description, threat, vulnerability, domain, sector, tags,
      suggested_likelihood, suggested_impact, suggested_treatment, suggested_controls, notes } = req.body;
    await db.prepare(`UPDATE firm_risk_library SET title=?, description=?, threat=?, vulnerability=?,
      domain=?, sector=?, tags=?, suggested_likelihood=?, suggested_impact=?,
      suggested_treatment=?, suggested_controls=?, notes=?, updated_at=utc_now_text()
      WHERE id=? AND firm_id=?`)
      .run(title || '', description || null, threat || null, vulnerability || null,
        domain || null, sector || null, tags || null,
        parseInt(suggested_likelihood, 10) || null, parseInt(suggested_impact, 10) || null,
        suggested_treatment || null, suggested_controls || null, notes || null, id, firmId);
    res.redirect('/firm/library/risks');
  });

  app.post('/firm/library/risks/:id/delete', requireAuth, async (req, res) => {
    if (!requireFirmLibraryManage(req, res)) return;
    const firmId = await getActiveFirmId(req);
    const id = parseInt(req.params.id, 10);
    await db.prepare('DELETE FROM firm_risk_library WHERE id=? AND firm_id=?').run(id, firmId);
    res.redirect('/firm/library/risks');
  });

  app.post('/firm/library/risks/reseed', requireAuth, async (req, res) => {
    if (!requireFirmLibraryManage(req, res)) return;
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const SHIPPED = require('../data/risk-library');
    const have = new Set((await db.prepare('SELECT title FROM firm_risk_library WHERE firm_id=?').all(firmId)).map(r => r.title));
    const ins = db.prepare(`INSERT INTO firm_risk_library
      (firm_id, title, description, threat, vulnerability, suggested_likelihood, suggested_impact, suggested_controls, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    const tx = db.transaction(async () => {
      for (const r of SHIPPED) {
        if (have.has(r.title)) continue;
        await ins.run(firmId, r.title, r.description || null, r.threat || null, r.vulnerability || null,
          3, 3, (r.suggested_controls || []).join(','), r.domain || null);
        added++;
      }
    });
    await tx();
    res.redirect(withToast('/firm/library/risks', `Added ${added} starter risks`));
  });

  app.post('/workspaces/:wsId/risks/clone-firm-library', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    const firmId = req.workspace.firm_id;
    const lib = await db.prepare(`SELECT * FROM firm_risk_library WHERE firm_id=? ORDER BY domain, title`).all(firmId);
    const have = new Set((await db.prepare(`SELECT title FROM risks WHERE workspace_id=?`).all(req.workspace.id)).map(r => r.title));
    const ins = db.prepare(`INSERT INTO risks
      (workspace_id, title, description, threat, vulnerability, likelihood, impact, owner_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`);
    let added = 0;
    const clonedIds = [];
    const tx = db.transaction(async () => {
      for (const r of lib) {
        if (have.has(r.title)) continue;
        const info = await ins.run(req.workspace.id, r.title, r.description, r.threat, r.vulnerability,
          r.suggested_likelihood || 3, r.suggested_impact || 3, '');
        await riskOwner.assign(db, req.workspace, info.lastInsertRowid);
        clonedIds.push(info.lastInsertRowid);
        added++;
      }
    });
    await tx();

    for (const id of clonedIds) {
      await fts.refresh(req.workspace.id, 'risk', id);
    }

    await logAction(req.user.id, req.workspace.id, 'risk_clone_firm_library', 'risk', null, { added }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, `Cloned ${added} risks from firm library`));
  });

}

module.exports = { register };
