'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const enc = require('../lib/encryption');
const ctlReads = require('../lib/control-reads');
const auditPack = require('../lib/audit-pack');
const outcomeScope = require('../lib/engagement-outcome-scope');
const { listSignatures } = require('../lib/doc-versions');
const { methodologyBand, getActiveMethodology } = require('../db');
const { withToast, auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, resolveUploadPath } = deps;
  const requireReadinessService = outcomeScope.requirePostGapService(
    'Certification audit packs are outside this gap-assessment-only engagement. Use the controlled gap-assessment report and retained evidence instead.');

  app.get('/workspaces/:wsId/export/soa.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'),
    requirePermission('risk.view'), async (req, res) => {
    const T = ctlReads.tables(db, req.workspace.id);
    const rows = await db.prepare(`SELECT i.id, i.title, i.category,
      COALESCE(cs.applicability,'undecided') AS applicability,
      COALESCE(cs.status,'Not Assessed') AS status,
      cs.inclusion_justification, cs.exclusion_justification,
      (SELECT string_agg('R-' || r.id, '; ') FROM risk_controls rc
       INNER JOIN risks r ON r.id = rc.risk_id
       WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risks_treated
      FROM iso_items i
      LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control' ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id);

    const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['Control ID,Title,Category,Applicability,Status,Risks Treated (6.1.3.d.1),Inclusion Justification,Exclusion Justification'];
    rows.forEach(r => {
      lines.push([r.id.replace('annex-', '').toUpperCase(), r.title, r.category, r.applicability,
                  r.status, r.risks_treated || '', r.inclusion_justification, r.exclusion_justification].map(esc).join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="SoA-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });

  app.get('/workspaces/:wsId/export/risks.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('risk.view'),
    requirePermission('asset.view'), async (req, res) => {
    const riskOwner = require('../lib/risk-owner');
    const rows = await db.prepare(`SELECT r.*, a.name AS asset_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.workspace_id = ? AND ${riskOwner.ownedSql('r', riskOwner.primary(req.workspace))} ORDER BY (r.likelihood * r.impact) DESC NULLS LAST`).all(req.workspace.id);
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['ID,Title,Asset,Threat,Vulnerability,Likelihood,Impact,Score,Treatment,Owner,Status,Residual L,Residual I'];
    rows.forEach(r => {
      lines.push([r.id, r.title, r.asset_name, r.threat, r.vulnerability,
                  r.likelihood, r.impact, r.likelihood * r.impact,
                  r.treatment, r.owner_name, r.status,
                  r.residual_likelihood, r.residual_impact].map(esc).join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Risks-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });

  app.get('/workspaces/:wsId/export/assets.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('asset.view'), async (req, res) => {
    const rows = await db.prepare('SELECT * FROM assets WHERE workspace_id = ? ORDER BY name').all(req.workspace.id);
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['Name,Type,Classification,Owner,C,I,A,Description'];
    rows.forEach(r => lines.push([r.name, r.type, r.classification, r.owner_name,
      r.cia_c, r.cia_i, r.cia_a, r.description].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Assets-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });


  function markdownToDocxParagraphs(md) {
    const lines = md.split('\n');
    const parts = [];
    let i = 0;
    const inline = (text) => {
      const runs = [];
      let cur = '';
      let bold = false, italic = false;
      let j = 0;
      while (j < text.length) {
        if (text.substr(j, 2) === '**') {
          if (cur) { runs.push(new TextRun({ text: cur, bold, italics: italic })); cur = ''; }
          bold = !bold; j += 2;
        } else if (text[j] === '*') {
          if (cur) { runs.push(new TextRun({ text: cur, bold, italics: italic })); cur = ''; }
          italic = !italic; j += 1;
        } else if (text[j] === '`') {
          const end = text.indexOf('`', j + 1);
          if (end > 0) {
            if (cur) { runs.push(new TextRun({ text: cur, bold, italics: italic })); cur = ''; }
            runs.push(new TextRun({ text: text.substring(j + 1, end), font: 'Consolas', shading: { type: 'solid', color: 'F4F4F5' } }));
            j = end + 1;
          } else { cur += text[j++]; }
        } else { cur += text[j++]; }
      }
      if (cur) runs.push(new TextRun({ text: cur, bold, italics: italic }));
      return runs.length ? runs : [new TextRun({ text: '' })];
    };

    while (i < lines.length) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.+)$/))) {
        const lvl = m[1].length;
        const headingMap = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        parts.push(new Paragraph({ heading: headingMap[lvl - 1], children: inline(m[2]), spacing: { before: 240, after: 120 } }));
        i++; continue;
      }
      if (/^\|/.test(l) && i + 1 < lines.length && /^\|[-\s|:]+\|$/.test(lines[i + 1])) {
        const headerCells = lines[i].split('|').slice(1, -1).map(c => c.trim());
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim())); i++;
        }
        const docxRows = [
          new TableRow({ children: headerCells.map(h => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })], shading: { fill: 'F4F4F5' } })) }),
          ...rows.map(r => new TableRow({ children: r.map(c => new TableCell({ children: [new Paragraph({ children: inline(c) })] })) }))
        ];
        parts.push(new Table({ rows: docxRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        parts.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
        continue;
      }
      if (/^[-*]\s/.test(l)) {
        while (i < lines.length && /^[-*]\s/.test(lines[i])) {
          parts.push(new Paragraph({ children: inline(lines[i].replace(/^[-*]\s/, '')), bullet: { level: 0 } }));
          i++;
        }
        continue;
      }
      if (/^>\s?/.test(l)) {
        parts.push(new Paragraph({ children: inline(l.replace(/^>\s?/, '')), indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: '4F46E5', space: 12 } } }));
        i++; continue;
      }
      if (/^---+$/.test(l)) {
        parts.push(new Paragraph({ children: [new TextRun({ text: '' })], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D6D6DB' } } }));
        i++; continue;
      }
      if (l.trim() === '') { parts.push(new Paragraph({ children: [new TextRun({ text: '' })] })); i++; continue; }
      parts.push(new Paragraph({ children: inline(l), spacing: { after: 120 } }));
      i++;
    }
    return parts;
  }

  const generateDocxBuffer = require('../lib/workers').generateDocx;

  app.get('/workspaces/:wsId/documents/:id/docx', requireAuth, requireWorkspace, requirePermission('document.view'), async (req, res) => {
    const docRaw = await db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
    if (!docRaw) return res.status(404).send('Not found');
    const doc = { ...docRaw, content: enc.decryptIfNeeded(docRaw.content, req.workspace.id) };
    try {
      const buf = await generateDocxBuffer(doc, req.workspace);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w\- ]+/g,'_')}.docx"`);
      res.send(buf);
    } catch (e) { console.error(e); res.status(500).send('Failed to generate .docx: ' + e.message); }
  });

  app.get('/workspaces/:wsId/audit-pack/zip', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('evidence.download'), requirePermission('workspace.export'),
    requirePermission('control.view'), requirePermission('risk.view'),
    requirePermission('asset.view'), requirePermission('document.view'),
    requirePermission('audit.manage'), requirePermission('nc.manage'),
    requirePermission('mrm.manage'),
    requirePermission('audit_log.view'), requirePermission('audit_log.export'),
    requireReadinessService, async (req, res) => {
    const ws = req.workspace;
    const safeName = ws.client_name.replace(/[^\w]+/g, '_');
    const today = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="audit-pack-${safeName}-${today}.zip"`);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', err => { console.error(err); res.status(500).end(); });
    zip.pipe(res);

    const manifest = ['ISO/IEC 27001:2022 Audit Pack', '='.repeat(40), `Client: ${ws.client_name}`, `Generated: ${new Date().toISOString()}`, `Stage: ${ws.stage}`, ws.target_cert_date ? `Target cert: ${ws.target_cert_date}` : '', '', 'Contents:', ''];

    const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const soaRows = await db.prepare(`SELECT i.id, i.title, i.category,
      COALESCE(cs.applicability,'undecided') AS applicability,
      COALESCE(cs.status,'Not Assessed') AS status,
      cs.inclusion_justification, cs.exclusion_justification
      FROM iso_items i
      LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control' ORDER BY i.sort_order`).all(ws.id);
    let soaCsv = 'Control ID,Title,Category,Applicability,Status,Inclusion Justification,Exclusion Justification\n';
    soaRows.forEach(r => { soaCsv += [r.id.replace('annex-','').toUpperCase(), r.title, r.category, r.applicability, r.status, r.inclusion_justification, r.exclusion_justification].map(esc).join(',') + '\n'; });
    zip.append(soaCsv, { name: '01_Statement_of_Applicability.csv' });
    manifest.push(`  01_Statement_of_Applicability.csv (${soaRows.length} controls)`);

    const riskRows = await db.prepare(`SELECT r.*, a.name AS asset_name FROM risks r LEFT JOIN assets a ON a.id=r.asset_id
      WHERE r.workspace_id=? AND ${require('../lib/risk-owner').ownedSql('r', 'iso27001')} ORDER BY (r.likelihood*r.impact) DESC NULLS LAST`).all(ws.id);
    let riskCsv = 'ID,Title,Asset,Threat,Vulnerability,L,I,Score,Treatment,Owner,Status,Residual L,Residual I\n';
    riskRows.forEach(r => { riskCsv += ['R-' + String(r.id).padStart(3,'0'), r.title, r.asset_name, r.threat, r.vulnerability, r.likelihood, r.impact, r.likelihood*r.impact, r.treatment, r.owner_name, r.status, r.residual_likelihood, r.residual_impact].map(esc).join(',') + '\n'; });
    zip.append(riskCsv, { name: '02_Risk_Register.csv' });
    manifest.push(`  02_Risk_Register.csv (${riskRows.length} risks)`);

    const assetRows = await db.prepare(`SELECT * FROM assets WHERE workspace_id=? ORDER BY name`).all(ws.id);
    let assetCsv = 'Name,Type,Classification,Owner,C,I,A,Description\n';
    assetRows.forEach(r => { assetCsv += [r.name, r.type, r.classification, r.owner_name, r.cia_c, r.cia_i, r.cia_a, r.description].map(esc).join(',') + '\n'; });
    zip.append(assetCsv, { name: '03_Asset_Inventory.csv' });
    manifest.push(`  03_Asset_Inventory.csv (${assetRows.length} assets)`);

    const docs = await db.prepare(`SELECT * FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') ORDER BY name`).all(ws.id);
    for (const dRaw of docs) {
      try {
        const d = { ...dRaw, content: enc.decryptIfNeeded(dRaw.content, ws.id) };
        const buf = await generateDocxBuffer(d, ws);
        zip.append(buf, { name: `04_Documents/${d.name.replace(/[^\w\- ]+/g,'_')}.docx` });
        manifest.push(`  04_Documents/${d.name}.docx`);
        if (d.current_version_id) {
          const v = await db.prepare('SELECT * FROM doc_versions WHERE id=?').get(d.current_version_id);
          const sigs = await listSignatures(d.id, d.current_version_id);
          if (v && sigs.length) {
            let sigTxt = `SIGNATURES - ${d.name}\n${'='.repeat(40)}\n\nVersion: ${v.version}\nContent SHA-256: ${v.content_hash}\n\n`;
            sigs.forEach(s => {
              const ok = enc.verifyHmac(`${s.document_id}|${s.version_id}|${s.user_id}|${s.content_hash}|${s.intent}|${s.signed_at}`, ws.id, s.signature);
              sigTxt += `Signer: ${s.user_name} (${s.signature_role || 'unspecified'})\nIntent: ${s.intent}\nSigned: ${s.signed_at}\nIP: ${s.ip_address || '-'}\nUA: ${(s.user_agent || '').slice(0, 80)}\nHMAC: ${s.signature}\nVerification: ${ok ? 'OK' : 'FAILED'}\n\n`;
            });
            zip.append(sigTxt, { name: `04_Documents/${d.name.replace(/[^\w\- ]+/g,'_')}__signatures.txt` });
          }
        }
      } catch (e) { console.error('docx gen failed', dRaw.id, e.message); }
    }
    if (docs.length === 0) manifest.push(`  04_Documents/ (no approved documents yet)`);

    const audits = await db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC NULLS LAST`).all(ws.id);
    for (const a of audits) {
      const findings = await db.prepare(`SELECT f.*, i.title AS iso_title FROM audit_findings f LEFT JOIN iso_items i ON i.id=f.iso_item_id WHERE f.audit_id=?`).all(a.id);
      let txt = `INTERNAL AUDIT REPORT\n${'='.repeat(40)}\n\nTitle: ${a.title}\nDate: ${a.audit_date || '-'}\nAuditor: ${a.auditor_name || '-'}\nStatus: ${a.status}\nScope: ${a.scope || '-'}\n\nSUMMARY\n${a.summary || '(none)'}\n\nFINDINGS (${findings.length})\n${'='.repeat(40)}\n`;
      findings.forEach(f => { txt += `\n[${f.finding_type.toUpperCase()}] severity=${f.severity}${f.iso_title ? '\nRelated: ' + f.iso_title : ''}\n${f.description}\n`; });
      zip.append(txt, { name: `05_Internal_Audits/${a.audit_date || 'undated'}_${a.title.replace(/[^\w]+/g,'_')}.txt` });
    }
    manifest.push(`  05_Internal_Audits/ (${audits.length} audits)`);

    const mrms = await db.prepare(`SELECT * FROM mrms WHERE workspace_id=? ORDER BY meeting_date DESC NULLS LAST`).all(ws.id);
    for (const m of mrms) {
      let txt = `MANAGEMENT REVIEW\n${'='.repeat(40)}\n\nDate: ${m.meeting_date || '-'}\nAttendees: ${m.attendees || '-'}\nStatus: ${m.status}\n\nINPUTS (Clause 9.3.2)\n${'-'.repeat(40)}\n`;
      txt += `\nPrior actions: ${m.prior_actions_status || '(none)'}\nContext changes: ${m.context_changes || '(none)'}\nInterested-party changes: ${m.interested_party_changes || '(none)'}\nPerformance review: ${m.performance_review || '(none)'}\nFeedback from interested parties: ${m.feedback_interested_parties || '(none)'}\nRisk treatment status: ${m.risk_treatment_status || '(none)'}\nImprovement opportunities: ${m.improvement_opportunities || '(none)'}\n\nOUTPUTS (Clause 9.3.3)\n${'-'.repeat(40)}\n\nDecisions: ${m.decisions || '(none)'}\nAction items: ${m.action_items || '(none)'}\n`;
      zip.append(txt, { name: `06_Management_Reviews/${m.meeting_date || 'undated'}_MRM.txt` });
    }
    manifest.push(`  06_Management_Reviews/ (${mrms.length} reviews)`);

    const ncs = await db.prepare(`SELECT * FROM nonconformities WHERE workspace_id=? ORDER BY id`).all(ws.id);
    let ncCsv = 'ID,Title,Source,Severity,Status,Root cause,Corrective action,Responsible,Due date,Effectiveness check,Closed at\n';
    ncs.forEach(n => { ncCsv += ['NC-' + String(n.id).padStart(3,'0'), n.title, n.source, n.severity, n.status, n.root_cause, n.corrective_action, n.responsible, n.due_date, n.effectiveness_check, n.closed_at].map(esc).join(',') + '\n'; });
    zip.append(ncCsv, { name: '07_Nonconformities.csv' });
    manifest.push(`  07_Nonconformities.csv (${ncs.length} NCs)`);

    const evidence = await db.prepare(`SELECT * FROM evidence WHERE workspace_id=?`).all(ws.id);
    let evIdx = 'EVIDENCE INDEX\n' + '='.repeat(40) + '\n\n';
    for (const e of evidence) {
      const fp = resolveUploadPath(e.stored_path, ws.firm_id);
      if (fp && fs.existsSync(fp)) {
        zip.file(fp, { name: `08_Evidence/${e.id}_${e.filename}` });
        evIdx += `${e.id}_${e.filename}\n  Linked to: ${e.iso_item_id || '(general)'}\n  Uploaded: ${e.uploaded_at}\n  SHA-256: ${e.sha256}\n  Size: ${e.size_bytes} bytes\n  Description: ${e.description || '(none)'}\n\n`;
      }
    }
    zip.append(evIdx, { name: '08_Evidence/INDEX.txt' });
    manifest.push(`  08_Evidence/ (${evidence.length} files, integrity hashes in INDEX.txt)`);

    const log = await db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at`).all(ws.id);
    let logCsv = 'When,Who,Action,Entity Type,Entity ID,Details\n';
    log.forEach(l => { logCsv += [l.created_at, l.user_name, l.action, l.entity_type, l.entity_id, l.details].map(esc).join(',') + '\n'; });
    zip.append(logCsv, { name: '09_Activity_Log.csv' });
    manifest.push(`  09_Activity_Log.csv (${log.length} entries)`);

    zip.append(manifest.join('\n'), { name: '00_MANIFEST.txt' });
    await zip.finalize();
    await logAction(req.user.id, ws.id, 'export_audit_pack', 'workspace', ws.id, null);
  });


  const AUDIT_PACK_SECTIONS = ['cover','summary','soa','risks','evidence','audits','ncs','mrms','improvements','audit_trail'];

  function parseSectionsFromBody(body) {
    let raw = body && body.sections;
    if (!raw) return {};
    if (!Array.isArray(raw)) raw = [raw];
    const out = {};
    AUDIT_PACK_SECTIONS.forEach(k => { out[k] = raw.includes(k); });
    return out;
  }

  function buildAuditPackOpts(body) {
    const opts = {
      sections: Object.keys(body || {}).some(k => k === 'sections')
        ? parseSectionsFromBody(body)
        : undefined,
      snapshotId: body && body.snapshotId ? parseInt(body.snapshotId, 10) || null : null,
      preparedFor: body && body.preparedFor ? String(body.preparedFor).trim() : null,
      preparedBy: body && body.preparedBy ? String(body.preparedBy).trim() : null,
      brand: {
        displayName: body && body.brandDisplayName ? String(body.brandDisplayName).trim() : null,
        primaryColor: body && body.brandPrimaryColor ? String(body.brandPrimaryColor).trim() : null,
        confidentialityLabel: body && body.confidentialityLabel ? String(body.confidentialityLabel).trim() : null
      }
    };
    Object.keys(opts.brand).forEach(k => { if (!opts.brand[k]) delete opts.brand[k]; });
    return opts;
  }

  async function renderAuditPackHTML(app, wsId, opts) {
    const data = await auditPack.gatherAuditPackData({ db, enc, methodologyBand, getActiveMethodology }, wsId, opts);
    return new Promise((resolve, reject) => {
      app.render('audit_pack', data, (err, html) => err ? reject(err) : resolve(html));
    });
  }

  app.get('/workspaces/:wsId/audit-pack', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('workspace.export'),
    requirePermission('control.view'), requirePermission('risk.view'),
    requirePermission('asset.view'), requirePermission('audit_log.view'),
    requirePermission('audit_log.export'),
    requirePermission('audit.manage'), requirePermission('nc.manage'),
    requirePermission('mrm.manage'),
    requireReadinessService, async (req, res) => {
    const snapshots = await db.prepare(`SELECT id, label, created_at, included_count FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC NULLS LAST, id DESC`).all(req.workspace.id);
    const firm = (await db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id)) || {};
    const riskCount = (await db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(req.workspace.id)).c;
    const evidenceCount = (await db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(req.workspace.id)).c;
    const auditCount = (await db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`).get(req.workspace.id)).c;
    const ncCount = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?`).get(req.workspace.id)).c;
    const mrmCount = (await db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?`).get(req.workspace.id)).c;
    const improvementCount = (await db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=?`).get(req.workspace.id)).c;
    res.render('audit_pack_config', {
      user: req.user, ws: req.workspace,
      snapshots, firmName: firm.name || '',
      riskCount, evidenceCount, auditCount, ncCount, mrmCount, improvementCount
    });
  });

  app.get('/workspaces/:wsId/audit-pack/preview', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('workspace.export'),
    requirePermission('control.view'), requirePermission('risk.view'),
    requirePermission('asset.view'), requirePermission('audit_log.view'),
    requirePermission('audit_log.export'),
    requirePermission('audit.manage'), requirePermission('nc.manage'),
    requirePermission('mrm.manage'),
    requireReadinessService, async (req, res) => {
    try {
      const opts = buildAuditPackOpts(req.query);
      const html = await renderAuditPackHTML(app, req.workspace.id, opts);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      res.status(500).render('error', { user: req.user, message: 'Could not generate audit pack preview: ' + e.message });
    }
  });

  app.post('/workspaces/:wsId/audit-pack/pdf', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('workspace.export'),
    requirePermission('control.view'), requirePermission('risk.view'),
    requirePermission('asset.view'), requirePermission('audit_log.view'),
    requirePermission('audit_log.export'),
    requirePermission('audit.manage'), requirePermission('nc.manage'),
    requirePermission('mrm.manage'),
    requireReadinessService, async (req, res) => {
    try {
      const opts = buildAuditPackOpts(req.body);
      const html = await renderAuditPackHTML(app, req.workspace.id, opts);
      const headerLeft = opts.brand && opts.brand.displayName ? opts.brand.displayName : ((await db.prepare('SELECT name FROM firms WHERE id=?').get(req.workspace.firm_id)) || {}).name || '';
      const headerRight = `${req.workspace.client_name} · ISMS Audit Pack`;
      const footerLeft = (opts.brand && opts.brand.confidentialityLabel) || 'Confidential · For audit and management review purposes only';
      const pdfRaw = await auditPack.renderPDF(html, { headerLeft, headerRight, footerLeft });
      const pdf = Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw);
      await logAction(req.user.id, req.workspace.id, 'generate_audit_pack', 'audit_pack', null, { bytes: pdf.length }, auditCtx(req));
      const fname = `audit-pack-${req.workspace.client_name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0,10)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(pdf);
    } catch (e) {
      console.error('audit-pack generate error:', e);
      res.status(500).render('error', { user: req.user, message: 'Could not generate audit pack PDF: ' + e.message + '. The pack data is fine - this is a rendering glitch. Try again, or use Preview HTML to see the content.' });
    }
  });

}

module.exports = { register };
