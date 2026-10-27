'use strict';
const crypto = require('crypto');
const fs = require('fs');
const rbac = require('../lib/rbac');
const ctlReads = require('../lib/control-reads');
const docLinks = require('../lib/doc-links');
const documentHtml = require('../lib/document-html');
const outcomeScope = require('../lib/engagement-outcome-scope');
const reqOpts = require('../lib/requirement-options');

const hashAuditorToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function register(app, deps) {
  const {
    db, enc, mdRenderer, logAction,
    getActiveMethodology, methodologyBand,
    auditPack, escapeHtml,
    resolveUploadPath,
    fs, path
  } = deps;
  const requireAuditorService = outcomeScope.requirePostGapService(
    'External certification-auditor access is outside this gap-assessment-only engagement. Use the controlled assessment report for client delivery.');

  async function requireAuditorToken(req, res, next) {
    const token = req.params.token;
    if (!token) return res.status(404).render('error', { user: null, message: 'Auditor link missing token.' });
    if (typeof token !== 'string' || token.length < 16 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return res.status(404).render('error', { user: null, message: 'This auditor link is not valid. It may have been revoked or the URL is wrong.' });
    }
    const tokenHash = hashAuditorToken(token);
    let share = await db.prepare(`SELECT * FROM auditor_shares WHERE token_hash=?`).get(tokenHash);
    if (!share) {
      share = await db.prepare(`SELECT * FROM auditor_shares WHERE token_hash IS NULL AND token=?`).get(token);
      if (share) {
        await db.prepare(`UPDATE auditor_shares
          SET token_hash=?, token_last4=?, token='migrated:' || id
          WHERE id=? AND token_hash IS NULL`).run(tokenHash, token.slice(-4), share.id);
        share = await db.prepare(`SELECT * FROM auditor_shares WHERE id=?`).get(share.id);
      }
    }
    if (!share) {
      return res.status(404).render('error', { user: null, message: 'This auditor link is not valid. It may have been revoked or the URL is wrong.' });
    }
    if (share.revoked_at) {
      return res.status(403).render('error', { user: null, message: 'This auditor link has been revoked by the consultant. Contact them for a new one.' });
    }
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(403).render('error', { user: null, message: 'This auditor link has expired. Contact the consultant for a new one.' });
    }
    const workspace = await db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(share.workspace_id);
    if (!workspace) return res.status(404).render('error', { user: null, message: 'Workspace not found.' });

    try {
      await db.prepare(`UPDATE auditor_shares SET access_count = access_count + 1, last_accessed_at = utc_now_text() WHERE id=?`).run(share.id);
      await logAction(0, workspace.id, 'auditor_access', 'auditor_share', share.id,
        { path: req.path, share_id: share.id },
        { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    } catch (_) { }

    req.share = share;
    req.workspace = workspace;
    res.locals.auditorToken = token;
    next();
  }

  function fmtDate(d) { return d ? String(d).slice(0, 10) : '-'; }
  function bytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function renderAuditorView(res, view, locals) {
    res.render(view, Object.assign({ token: res.locals.auditorToken, share: locals.share, ws: locals.workspace, fmtDate, bytes }, locals));
  }

  app.get('/auditor/:token', requireAuditorToken, requireAuditorService, async (req, res) => {
    const counts = {
      soa_total: (await db.prepare(`SELECT COUNT(*) c FROM v_control_states WHERE workspace_id=?`).get(req.workspace.id)).c,
      soa_snapshots: (await db.prepare(`SELECT COUNT(*) c FROM soa_snapshots WHERE workspace_id=?`).get(req.workspace.id)).c,
      risks: (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(req.workspace.id)).c,
      risks_open: (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open'`).get(req.workspace.id)).c,
      evidence: (await db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(req.workspace.id)).c,
      documents: (await db.prepare(`SELECT COUNT(*) c FROM generated_docs
        WHERE workspace_id=? AND status IN ('approved','published') AND retired_at IS NULL`).get(req.workspace.id)).c,
      ncs_open: (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status='open'`).get(req.workspace.id)).c,
      ncs_total: (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?`).get(req.workspace.id)).c,
      audits: (await db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`).get(req.workspace.id)).c,
      mrms: (await db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?`).get(req.workspace.id)).c
    };
    const firm = (await db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id)) || {};
    renderAuditorView(res, 'auditor_landing', { share: req.share, workspace: req.workspace, counts, firm });
  });

  app.get('/auditor/:token/soa', requireAuditorToken, requireAuditorService, async (req, res) => {
    const snapshot = await db.prepare(`SELECT * FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(req.workspace.id);
    let rows = [], from = 'live';
    if (snapshot) {
      try { rows = JSON.parse(enc.decryptIfNeeded(snapshot.payload, req.workspace.id)); from = 'snapshot'; } catch (_) {}
    }
    if (from === 'live') {
      const T = ctlReads.tables(db, req.workspace.id);
      rows = await db.prepare(`SELECT i.id, i.title, i.category,
            COALESCE(cs.applicability,'undecided') AS applicability,
            COALESCE(cs.status,'Not Assessed') AS status,
            cs.inclusion_justification, cs.exclusion_justification
          FROM iso_items i
          LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
          WHERE i.type='control'
          ORDER BY i.sort_order`).all(req.workspace.id);
    }
    const counts = {
      total: rows.length,
      included: rows.filter(r => r.applicability === 'included').length,
      excluded: rows.filter(r => r.applicability === 'excluded').length,
      undecided: rows.filter(r => !['included','excluded'].includes(r.applicability)).length
    };
    const allSnaps = await db.prepare(`SELECT id, label, created_at, payload_hash, included_count FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_soa', { share: req.share, workspace: req.workspace, rows, from, snapshot, counts, allSnaps });
  });

  app.get('/auditor/:token/soa/snapshots/:id(\\d+)', requireAuditorToken, requireAuditorService, async (req, res) => {
    const snapshot = await db.prepare(`SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!snapshot) return res.status(404).render('error', { user: null, message: 'Snapshot not found.' });
    let rows = [];
    try { rows = JSON.parse(enc.decryptIfNeeded(snapshot.payload, req.workspace.id)); } catch (_) {}
    const allSnaps = await db.prepare(`SELECT id, label, created_at, payload_hash, included_count FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
    const counts = {
      total: rows.length,
      included: rows.filter(r => r.applicability === 'included').length,
      excluded: rows.filter(r => r.applicability === 'excluded').length,
      undecided: rows.filter(r => !['included','excluded'].includes(r.applicability)).length
    };
    renderAuditorView(res, 'auditor_soa', { share: req.share, workspace: req.workspace, rows, from: 'snapshot', snapshot, counts, allSnaps });
  });

  app.get('/auditor/:token/risks', requireAuditorToken, requireAuditorService, async (req, res) => {
    const riskOwner = require('../lib/risk-owner');
    const system = riskOwner.primary(req.workspace);
    const methodology = await getActiveMethodology(req.workspace.id, system);
    const risks = await db.prepare(`SELECT r.*, a.name AS asset_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.workspace_id = ? AND ${riskOwner.ownedSql('r', system)}
      ORDER BY (COALESCE(r.likelihood,0) * COALESCE(r.impact,0)) DESC, r.id`).all(req.workspace.id);
    const enriched = risks.map(r => ({ ...r, band: methodologyBand(methodology, r.likelihood, r.impact) }));
    renderAuditorView(res, 'auditor_risks', { share: req.share, workspace: req.workspace, risks: enriched, methodology });
  });

  app.get('/auditor/:token/evidence', requireAuditorToken, requireAuditorService, async (req, res) => {
    const evidence = await db.prepare(`SELECT e.id, e.filename, e.sha256, e.size_bytes, e.iso_item_id,
        e.uploaded_at, e.description, u.name AS uploader
      FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id = ?
      ORDER BY e.uploaded_at DESC`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_evidence', { share: req.share, workspace: req.workspace, evidence });
  });

  app.get('/auditor/:token/evidence/:id(\\d+)/download', requireAuditorToken, requireAuditorService, async (req, res) => {
    const ev = await db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).render('error', { user: null, message: 'Evidence file not found.' });
    const filepath = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (!filepath || !fs.existsSync(filepath)) return res.status(404).render('error', { user: null, message: 'Evidence file is no longer on disk. The consultant has been notified.' });
    await logAction(0, req.workspace.id, 'auditor_download_evidence', 'evidence', ev.id,
      { share_id: req.share.id, filename: ev.filename },
      { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    res.download(filepath, ev.filename);
  });

  app.get('/auditor/:token/documents', requireAuditorToken, requireAuditorService, async (req, res) => {
    const docs = await db.prepare(`SELECT d.id, d.name, d.category, d.status, d.version, d.next_review_date,
        d.published_at, d.approved_at, u.name AS approver,
        (SELECT COUNT(*) FROM ${docLinks.docControlsExpr()} dc WHERE dc.document_id = d.id) AS control_count
      FROM generated_docs d
      LEFT JOIN users u ON u.id = d.approved_by
      WHERE d.workspace_id = ? AND d.status IN ('approved','published') AND d.retired_at IS NULL
      ORDER BY d.category NULLS FIRST, d.name`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_documents', { share: req.share, workspace: req.workspace, docs });
  });

  app.get('/auditor/:token/documents/:id(\\d+)', requireAuditorToken, requireAuditorService, async (req, res) => {
    const doc = await db.prepare(`SELECT d.*, u.name AS approver FROM generated_docs d
      LEFT JOIN users u ON u.id = d.approved_by
      WHERE d.id = ? AND d.workspace_id = ?
        AND d.status IN ('approved','published') AND d.retired_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).render('error', { user: null, message: 'Document not found.' });
    const body = enc.decryptIfNeeded(doc.content || '', req.workspace.id);
    const rendered = body && /^<[a-z]/i.test(body.trim()) ? body : mdRenderer.render(body || ''); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
    const html = documentHtml.sanitizeDocumentHtml(rendered);
    const links = await db.prepare(`SELECT dc.iso_item_id, i.title, i.sort_order
      FROM ${docLinks.docControlsExpr()} dc INNER JOIN iso_items i ON i.id = dc.iso_item_id WHERE dc.document_id=?
      ORDER BY i.sort_order`).all(doc.id);
    renderAuditorView(res, 'auditor_document_detail', { share: req.share, workspace: req.workspace, doc, html, links });
  });

  app.get('/auditor/:token/audits', requireAuditorToken, requireAuditorService, async (req, res) => {
    const audits = await db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC NULLS LAST, id DESC`).all(req.workspace.id);
    const findingsByAudit = {};
    if (audits.length) {
      const findings = reqOpts.nameRows(req.workspace, await db.prepare(`SELECT f.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_findings f
        ${reqOpts.joinSql('f.iso_item_id')}
        INNER JOIN audits a ON a.id = f.audit_id
        WHERE a.workspace_id = ? ORDER BY f.created_at`).all(req.workspace.id));
      findings.forEach(f => { (findingsByAudit[f.audit_id] = findingsByAudit[f.audit_id] || []).push(f); });
    }
    const ncs = await db.prepare(`SELECT * FROM nonconformities WHERE workspace_id=? ORDER BY (status='open') DESC NULLS LAST, created_at DESC`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_audits', {
      share: req.share, workspace: req.workspace,
      audits: audits.map(a => ({ ...a, findings: findingsByAudit[a.id] || [] })),
      ncs
    });
  });

  app.get('/auditor/:token/audit-pack', requireAuditorToken, requireAuditorService, async (req, res) => {
    try {
      const data = await auditPack.gatherAuditPackData(
        { db, enc, methodologyBand, getActiveMethodology },
        req.workspace.id,
        {}
      );
      const html = await new Promise((resolve, reject) => {
        app.render('audit_pack', data, (err, h) => err ? reject(err) : resolve(h));
      });
      const firm = (await db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id)) || {};
      const pdfRaw = await auditPack.renderPDF(html, {
        headerLeft: firm.name || '',
        headerRight: `${req.workspace.client_name} · ISMS Audit Pack`,
        footerLeft: 'Confidential · For audit and management review purposes only'
      });
      const pdf = Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw);
      await logAction(0, req.workspace.id, 'auditor_download_pack', 'audit_pack', null,
        { share_id: req.share.id, bytes: pdf.length },
        { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
      const fname = `audit-pack-${req.workspace.client_name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0,10)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(pdf);
    } catch (e) {
      console.error('auditor audit-pack error:', e);
      res.status(500).render('error', { user: null, message: 'Could not generate the audit pack PDF. Refresh and try again - if it persists, contact the consultant.' });
    }
  });

  const { requireAuth, requireWorkspace, requirePermission } = deps;

  async function renderAuditorConsole(req, res, newShare = null) {
    const shares = await db.prepare(`SELECT s.id, s.workspace_id, s.label, s.expires_at,
        s.created_by, s.created_at, s.last_accessed_at, s.access_count,
        s.revoked_at, s.token_last4, u.name AS creator
      FROM auditor_shares s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.workspace_id = ? ORDER BY (s.revoked_at IS NULL) DESC, s.created_at DESC`).all(req.workspace.id);
    const recentLog = await db.prepare(`SELECT al.created_at, al.action, al.entity_type, al.entity_id, al.details
      FROM audit_log al
      WHERE al.workspace_id = ? AND al.action ILIKE 'auditor_%'
      ORDER BY al.created_at DESC LIMIT 50`).all(req.workspace.id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const canManage = rbac.hasPermission(req.userPerms, 'auditor_share.manage');
    res.render('auditor_access', {
      user: req.user, ws: req.workspace, shares, recentLog, baseUrl,
      canManage, newShare
    });
  }

  app.get('/workspaces/:wsId/auditor-access', requireAuth, requireWorkspace, requireAuditorService, requirePermission('auditor_share.view'), async (req, res) => {
    await renderAuditorConsole(req, res);
  });

  app.post('/workspaces/:wsId/auditor-access', requireAuth, requireWorkspace, requireAuditorService, requirePermission('auditor_share.manage'), async (req, res) => {
    const label = (req.body.label || '').toString().trim() || 'Auditor share';
    const days = Math.max(1, Math.min(365, parseInt(req.body.expires_days || '30', 10)));
    const token = crypto.randomBytes(24).toString('base64url');
    const tokenHash = hashAuditorToken(token);
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const id = (await db.prepare(`INSERT INTO auditor_shares
      (workspace_id, token, token_hash, token_last4, label, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, `sha256:${tokenHash}`, tokenHash, token.slice(-4), label, expiresAt, req.user.id)).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_auditor_share', 'auditor_share', id,
      { label, expires_at: expiresAt, days },
      { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    await renderAuditorConsole(req, res, {
      id: Number(id), token, url: `${req.protocol}://${req.get('host')}/auditor/${token}`
    });
  });

  app.post('/workspaces/:wsId/auditor-access/:id(\\d+)/revoke', requireAuth, requireWorkspace, requireAuditorService, requirePermission('auditor_share.manage'), async (req, res) => {
    const share = await db.prepare(`SELECT id, label, revoked_at FROM auditor_shares WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!share) return res.redirect(`/workspaces/${req.workspace.id}/auditor-access`);
    await db.prepare(`UPDATE auditor_shares SET revoked_at = utc_now_text() WHERE id=?`).run(share.id);
    await logAction(req.user.id, req.workspace.id, 'revoke_auditor_share', 'auditor_share', share.id,
      { label: share.label },
      { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    res.redirect(`/workspaces/${req.workspace.id}/auditor-access`);
  });
}

module.exports = { register };
