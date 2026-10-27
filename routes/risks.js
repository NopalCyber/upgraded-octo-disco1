'use strict';

const crypto = require('crypto');
const fts = require('../lib/fts');
const csvImport = require('../lib/csv-import');
const riskLinks = require('../lib/risk-control-links');
const riskOwner = require('../lib/risk-owner');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          activeEntityFilter, getActiveMethodology, methodologyBand,
          seedFirmRiskLibraryIfEmpty, csvUpload } = deps;

  const REVIEW_MONTHS = 12;
  const sealOf = (payload) => crypto.createHash('sha256').update(payload).digest('hex');
  function isoDate(value) {
    const v = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
  }

  async function snapshotRows(workspace) {
    const risks = await db.prepare(`SELECT r.* FROM risks r
      WHERE r.workspace_id=? AND ${riskOwner.ownedSql('r', riskOwner.primary(workspace))}
      ORDER BY (r.likelihood * r.impact) DESC NULLS LAST, r.id`).all(workspace.id);
    const controls = db.prepare(`SELECT i.title FROM risk_controls rc JOIN iso_items i ON i.id = rc.iso_item_id WHERE rc.risk_id=? ORDER BY i.sort_order`);
    return await Promise.all(risks.map(async r => ({
      id: r.id,
      title: r.title,
      description: r.description || null,
      likelihood: r.likelihood,
      impact: r.impact,
      treatment: r.treatment,
      owner: r.owner_name,
      status: r.status,
      residual_likelihood: r.residual_likelihood,
      residual_impact: r.residual_impact,
      controls: (await controls.all(r.id)).map((c) => c.title)
    })));
  }

  async function recordAssessment(workspace, actorId, input, { methodologyName, aboveAppetite }) {
    const performedOn = isoDate(input.performed_on) || new Date().toISOString().slice(0, 10);
    const rows = await snapshotRows(workspace);
    const payload = JSON.stringify(rows);
    const label = String(input.label || '').trim().slice(0, 200) || `Risk assessment ${performedOn}`;
    const above = rows.filter((r) => aboveAppetite(r)).length;
    return Number((await db.prepare(`INSERT INTO risk_assessment_records
        (workspace_id, label, performed_on, methodology_name, notes, risk_count, above_appetite, payload, payload_hash, recorded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(workspace.id, label, performedOn, methodologyName || null, String(input.notes || '').trim().slice(0, 4000) || null,
        rows.length, above, payload, sealOf(payload), actorId)).lastInsertRowid);
  }

  async function assessmentRecords(workspace) {
    return await db.prepare(`SELECT r.id, r.label, r.performed_on, r.methodology_name, r.risk_count, r.above_appetite, r.created_at, u.name AS recorded_by_name
      FROM risk_assessment_records r LEFT JOIN users u ON u.id = r.recorded_by
      WHERE r.workspace_id=? ORDER BY r.performed_on DESC, r.id DESC`).all(workspace.id);
  }

  async function loadAssessmentRecord(workspace, id) {
    const row = await db.prepare(`SELECT r.*, u.name AS recorded_by_name FROM risk_assessment_records r LEFT JOIN users u ON u.id = r.recorded_by
      WHERE r.id=? AND r.workspace_id=?`).get(id, workspace.id);
    if (!row) return null;
    return { ...row, rows: JSON.parse(row.payload), intact: sealOf(row.payload) === row.payload_hash };
  }

  async function nextAssessmentDue(workspace) {
    const last = (await db.prepare('SELECT MAX(performed_on) d FROM risk_assessment_records WHERE workspace_id=?').get(workspace.id)).d;
    if (!last) return { last: null, due: null };
    const due = new Date(`${last}T00:00:00Z`);
    due.setUTCMonth(due.getUTCMonth() + REVIEW_MONTHS);
    return { last, due: due.toISOString().slice(0, 10) };
  }

  app.post('/workspaces/:wsId/risks/assessments', requireAuth, requireWorkspace, requirePermission('risk.update'), async (req, res) => {
    const methodology = await getActiveMethodology(req.workspace.id, riskOwner.primary(req.workspace));
    const appetite = (r) => ['high', 'critical', 'very high', 'extreme'].includes(String(methodologyBand(methodology, r.likelihood, r.impact) || '').toLowerCase());
    const id = await recordAssessment(req.workspace, req.user.id, req.body, { methodologyName: methodology.name, aboveAppetite: appetite });
    await logAction(req.user.id, req.workspace.id, 'record_risk_assessment', 'risk_assessment_record', id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/assessments/${id}`, 'Risk assessment recorded'));
  });

  app.get('/workspaces/:wsId/risks/assessments/:recordId', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const record = await loadAssessmentRecord(req.workspace, Number(req.params.recordId));
    if (!record) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'That risk assessment record was not found.' });
    res.render('risk_assessment_record', { user: req.user, ws: req.workspace, record });
  });

  app.get('/workspaces/:wsId/risks', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const ef = activeEntityFilter(req, 'r');
    const system = riskOwner.primary(req.workspace);
    const owned = ` AND ${riskOwner.ownedSql('r', system)}`;
    const heatRisks = await db.prepare(`SELECT likelihood, impact FROM risks r
      WHERE r.workspace_id = ?${owned}${ef.sql}`).all(req.workspace.id, ...ef.params);
    const pgRisks = await paginate(db, req, {
      count: `SELECT COUNT(*) c FROM risks r WHERE r.workspace_id = ?${owned}${ef.sql}`,
      rows: `SELECT r.*, a.name AS asset_name, e.name AS entity_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN entities e ON e.id = r.entity_id
      WHERE r.workspace_id = ?${owned}${ef.sql} ORDER BY (r.likelihood * r.impact) DESC NULLS LAST`,
      params: [req.workspace.id, ...ef.params], perPage: 100,
    });
    const assets = await db.prepare('SELECT id, name FROM assets WHERE workspace_id = ? ORDER BY name').all(req.workspace.id);
    const methodology = await getActiveMethodology(req.workspace.id);
    const enriched = pgRisks.rows.map(r => ({ ...r, band: methodologyBand(methodology, r.likelihood, r.impact) }));
    res.render('risks', { user: req.user, ws: req.workspace, risks: enriched, heatRisks, assets, methodology,
      pg: pgRisks, pagerHref: p => pageHref(req, p),
      assessmentRecords: (await assessmentRecords(req.workspace)).slice(0, 5), assessmentDue: await nextAssessmentDue(req.workspace) });
  });

  app.post('/workspaces/:wsId/risks', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    const { title, description, asset_id, threat, vulnerability, likelihood, impact, treatment, owner_name, entity_id } = req.body;
    if (!title) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO risks (workspace_id, entity_id, title, description, asset_id, threat, vulnerability,
                           likelihood, impact, treatment, owner_name)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, entity_id || req.entityScopeId || null, title.trim(), description || null, asset_id || null,
           threat || null, vulnerability || null,
           parseInt(likelihood) || 3, parseInt(impact) || 3,
           treatment || 'modify', owner_name || null)).lastInsertRowid;
    await riskOwner.assign(db, req.workspace, id, req.body);
    await fts.refresh(req.workspace.id, 'risk', id);
    await logAction(req.user.id, req.workspace.id, 'create_risk', 'risk', id, { title }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks/' + id, 'Risk created'));
  });

  const RISK_LIBRARY = require('../data/risk-library');

  app.get('/workspaces/:wsId/risks/library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res, nextMw) => {
    const byDomain = {};
    RISK_LIBRARY.forEach((r, idx) => { (byDomain[r.domain] = byDomain[r.domain] || []).push({ ...r, idx }); });
    res.render('risks_library', { user: req.user, ws: req.workspace, byDomain });
  });

  app.post('/workspaces/:wsId/risks/library', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    const picked = parseFormArray(req.body.pick);
    if (!picked.length) return redirectBack(req, res, 'Select at least one risk before adding to the register.', 'error');
    const ins = db.prepare(`INSERT INTO risks (workspace_id, entity_id, title, description, threat, vulnerability,
                           likelihood, impact, treatment, status)
                           VALUES (?, ?, ?, ?, ?, ?, 3, 3, 'modify', 'open')`);
    let added = 0;
    const insertedIds = [];
    const tx = db.transaction(async () => {
      for (const __item of picked) await (async idxStr => {
        const r = RISK_LIBRARY[parseInt(idxStr)];
        if (!r) return;
        const rid = (await ins.run(req.workspace.id, req.entityScopeId || null, r.title, r.description, r.threat || null, r.vulnerability || null)).lastInsertRowid;
        await riskOwner.assign(db, req.workspace, rid);

        for (const c of (r.suggested_controls || [])) {
          await riskLinks.link(db, req.workspace, rid, c);
        }

        insertedIds.push(rid);
        added++;
      })(__item);
    });
    await tx();

    for (const id of insertedIds) {
      await fts.refresh(req.workspace.id, 'risk', id);
    }

    await logAction(req.user.id, req.workspace.id, 'add_risks_from_library', 'risk', null, { count: added }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks', `Added ${added} risk${added === 1 ? '' : 's'} from library - review and adjust scoring`));
  });

  const ai = require('../lib/ai');
  const INTAKE = require('../data/intake-questions');

  async function buildClientContext(ws) {
    const parts = [];
    if (ws.client_name) parts.push(`Client: ${ws.client_name}`);
    const sector = ws.sector || ws.industry;
    if (sector) parts.push(`Sector / industry: ${sector}`);
    if (ws.scope) parts.push(`ISMS scope: ${ws.scope}`);
    const answers = await db.prepare(
      `SELECT question_id, answer FROM engagement_intake
       WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`
    ).all(ws.id);
    if (answers.length) {
      const byId = new Map(answers.map(a => [a.question_id, a.answer]));
      const lines = [];
      INTAKE.flatten().forEach(q => {
        if (byId.has(q.id)) lines.push(`- ${q.text}: ${String(byId.get(q.id)).trim()}`);
      });
      const answerObject = Object.fromEntries(answers.map(row => [row.question_id, row.answer]));
      INTAKE.crownJewelAnswers(answerObject).filter(item => item.number > 3).forEach(item => {
        lines.push(`- Crown jewel #${item.number}: ${item.name}`);
      });
      if (lines.length) parts.push('From the engagement intake:\n' + lines.join('\n'));
    }
    return parts.join('\n');
  }

  async function annexAControls(workspace) {
    const groups = await riskLinks.pickerGroups(db, workspace);
    return [].concat(...groups.map(g => g.items.map(it => ({ id: it.id, title: it.title }))));
  }

  app.get('/workspaces/:wsId/risks/guided', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    res.render('risk_guided', {
      user: req.user, ws: req.workspace,
      methodology: await getActiveMethodology(req.workspace.id),
      controls: await annexAControls(req.workspace),
      prefillContext: await buildClientContext(req.workspace),
      aiConfigured: ai.isConfigured(),
      aiConfigurationMessage: ai.configurationError(),
      aiProvider: ai.providerLabel(),
      aiModel: ai.model(),
      aiModels: ai.availableModels()
    });
  });

  app.post('/workspaces/:wsId/risks/guided/suggest', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    if (!ai.isConfigured()) {
      return res.status(503).json({ ok: false, error: `${ai.configurationError()} Add risks manually or update .env and restart.` });
    }
    const methodology = await getActiveMethodology(req.workspace.id);
    const controls = await annexAControls(req.workspace);
    const controlIds = new Set(controls.map(c => c.id));
    const lMax = methodology.likelihood_scale.length;
    const iMax = methodology.impact_scale.length;
    const context = String(req.body.context || '').slice(0, 8000);
    const selectedModel = ai.resolveModel(req.body.model);
    let count = parseInt(req.body.count, 10) || 12;
    count = Math.max(3, Math.min(20, count));
    const existingTitles = (await db.prepare(`SELECT title FROM risks WHERE workspace_id=?`).all(req.workspace.id)).map(r => r.title);

    try {
      const raw = await ai.suggestRisks({ context, methodology, controlCatalog: controls, count, existingTitles, model: selectedModel });
      const clamp = (v, max) => Math.max(1, Math.min(max, parseInt(v, 10) || Math.ceil(max / 2)));
      const validTreatments = new Set(['modify', 'retain', 'avoid', 'share']);
      const risks = raw.map(r => {
        const likelihood = clamp(r.likelihood, lMax);
        const impact = clamp(r.impact, iMax);
        const suggested_controls = (Array.isArray(r.suggested_controls) ? r.suggested_controls : [])
          .map(c => String(c).trim().toLowerCase())
          .filter(c => controlIds.has(c));
        return {
          title: String(r.title || '').slice(0, 300),
          threat: String(r.threat || '').slice(0, 500),
          vulnerability: String(r.vulnerability || '').slice(0, 500),
          description: String(r.description || '').slice(0, 1000),
          likelihood, impact,
          band: methodologyBand(methodology, likelihood, impact),
          likelihood_rationale: String(r.likelihood_rationale || '').slice(0, 500),
          impact_rationale: String(r.impact_rationale || '').slice(0, 500),
          why_it_matters: String(r.why_it_matters || '').slice(0, 1000),
          cia: Array.isArray(r.cia) ? r.cia.filter(x => ['Confidentiality', 'Integrity', 'Availability'].includes(x)) : [],
          treatment: validTreatments.has(r.treatment) ? r.treatment : 'modify',
          suggested_controls
        };
      }).filter(r => r.title);
      await logAction(req.user.id, req.workspace.id, 'ai_suggest_risks', 'risk', null, { count: risks.length, model: selectedModel }, auditCtx(req));
      res.json({ ok: true, risks, model: selectedModel });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'AI request failed.' });
    }
  });

  app.post('/workspaces/:wsId/risks/guided/commit', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    let rows = [];
    try { rows = JSON.parse(req.body.payload || '[]'); } catch (_) { rows = []; }
    if (!Array.isArray(rows) || !rows.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/guided`, 'Select at least one risk to add', 'error'));
    }
    const methodology = await getActiveMethodology(req.workspace.id);
    const lMax = methodology.likelihood_scale.length;
    const iMax = methodology.impact_scale.length;
    const controlIds = new Set((await annexAControls(req.workspace)).map(c => c.id));
    const clamp = (v, max) => Math.max(1, Math.min(max, parseInt(v, 10) || Math.ceil(max / 2)));
    const validTreatments = new Set(['modify', 'retain', 'avoid', 'share']);

    const ins = db.prepare(`INSERT INTO risks
      (workspace_id, entity_id, title, description, threat, vulnerability,
       likelihood, impact, treatment, owner_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`);
    const insertedIds = [];
    let added = 0;
    const tx = db.transaction(async () => {
      for (const __item of rows.slice(0, 50)) await (async r => {
        const title = String(r.title || '').trim().slice(0, 300);
        if (!title) return;
        const rid = (await ins.run(
          req.workspace.id, req.entityScopeId || null, title,
          String(r.description || '').slice(0, 2000) || null,
          String(r.threat || '').slice(0, 500) || null,
          String(r.vulnerability || '').slice(0, 500) || null,
          clamp(r.likelihood, lMax), clamp(r.impact, iMax),
          validTreatments.has(r.treatment) ? r.treatment : 'modify',
          String(r.owner_name || '').slice(0, 200) || null
        )).lastInsertRowid;
        await riskOwner.assign(db, req.workspace, rid);

        for (const c of (Array.isArray(r.suggested_controls) ? r.suggested_controls : [])) {
          const cid = String(c).trim().toLowerCase();
          if (controlIds.has(cid)) await riskLinks.link(db, req.workspace, rid, cid);
        }

        insertedIds.push(rid);
        added++;
      })(__item);
    });
    await tx();

    for (const id of insertedIds) {
      await fts.refresh(req.workspace.id, 'risk', id);
    }

    await logAction(req.user.id, req.workspace.id, 'add_risks_guided', 'risk', null, { count: added }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, `Added ${added} risk${added === 1 ? '' : 's'} from the guided assessment`));
  });

  async function riskImportContext(wsId) {
    const methodology = await getActiveMethodology(wsId);
    const assets = await db.prepare('SELECT id, name FROM assets WHERE workspace_id = ?').all(wsId);
    const assetsByName = new Map();
    assets.forEach(a => assetsByName.set(a.name.toLowerCase(), a));
    return { methodology, assetsByName };
  }

  app.get('/workspaces/:wsId/risks/import', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    res.render('import', {
      user: req.user, ws: req.workspace,
      schema: csvImport.RISK_SCHEMA, kind: 'risks',
      mode: 'upload', result: null, csv: '', filename: '',
      methodology: await getActiveMethodology(req.workspace.id),
      backUrl: `/workspaces/${req.workspace.id}/risks`,
      listUrl: `/workspaces/${req.workspace.id}/risks`,
      templateUrl: `/workspaces/${req.workspace.id}/risks/import/template`,
      previewUrl: `/workspaces/${req.workspace.id}/risks/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/risks/import/commit`,
      importUrl: `/workspaces/${req.workspace.id}/risks/import`
    });
  });

  app.get('/workspaces/:wsId/risks/import/template', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="risks_template.csv"');
    res.send(csvImport.buildTemplate(csvImport.RISK_SCHEMA));
  });

  app.post('/workspaces/:wsId/risks/import/preview', requireAuth, requireWorkspace, requirePermission('risk.create'), csvUpload.single('file'), async (req, res) => {
    let csv = '';
    let filename = '';
    if (req.file && req.file.buffer) {
      csv = req.file.buffer.toString('utf8');
      filename = req.file.originalname || 'upload.csv';
    } else if (req.body.csv) {
      csv = String(req.body.csv);
      filename = 'pasted.csv';
    }
    const ctx = await riskImportContext(req.workspace.id);
    const result = csvImport.processFile(csv, csvImport.RISK_SCHEMA, ctx);
    res.render('import', {
      user: req.user, ws: req.workspace,
      schema: csvImport.RISK_SCHEMA, kind: 'risks',
      mode: 'preview', result, csv, filename,
      methodology: ctx.methodology,
      backUrl: `/workspaces/${req.workspace.id}/risks`,
      listUrl: `/workspaces/${req.workspace.id}/risks`,
      templateUrl: `/workspaces/${req.workspace.id}/risks/import/template`,
      previewUrl: `/workspaces/${req.workspace.id}/risks/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/risks/import/commit`,
      importUrl: `/workspaces/${req.workspace.id}/risks/import`
    });
  });

  app.post('/workspaces/:wsId/risks/import/commit', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    const csv = String(req.body.csv || '');
    if (!csv.trim()) return res.redirect(`/workspaces/${req.workspace.id}/risks/import`);
    const ctx = await riskImportContext(req.workspace.id);
    const result = csvImport.processFile(csv, csvImport.RISK_SCHEMA, ctx);
    const valid = result.rows.filter(r => r.valid);
    if (!valid.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/import`, 'Nothing to import - all rows had errors', 'error'));
    }
    const lMid = Math.ceil(ctx.methodology.likelihood_scale.length / 2);
    const iMid = Math.ceil(ctx.methodology.impact_scale.length / 2);
    const ins = db.prepare(`INSERT INTO risks
      (workspace_id, entity_id, title, description, asset_id, threat, vulnerability,
       likelihood, impact, treatment, owner_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const importedIds = [];
    const tx = db.transaction(async () => {
      for (const r of valid) {
        const p = r.parsed;
        const info = await ins.run(
          req.workspace.id,
          req.entityScopeId || null,
          p.title,
          p.description || null,
          p.asset || null,
          p.threat || null,
          p.vulnerability || null,
          p.likelihood == null ? lMid : p.likelihood,
          p.impact == null ? iMid : p.impact,
          p.treatment || 'modify',
          p.owner_name || null
        );
        await riskOwner.assign(db, req.workspace, info.lastInsertRowid, p);
        importedIds.push(info.lastInsertRowid);
      }
    });
    await tx();

    for (const id of importedIds) {
      await fts.refresh(req.workspace.id, 'risk', id);
    }

    await logAction(req.user.id, req.workspace.id, 'import_risks_csv', 'risk', null, { count: valid.length, skipped: result.summary.invalid }, auditCtx(req));
    const msg = result.summary.invalid
      ? `Imported ${valid.length} risk${valid.length === 1 ? '' : 's'} - ${result.summary.invalid} row${result.summary.invalid === 1 ? '' : 's'} skipped`
      : `Imported ${valid.length} risk${valid.length === 1 ? '' : 's'}`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, msg));
  });

  app.get('/workspaces/:wsId/risks/:id', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const risk = await db.prepare(`SELECT r.*, a.name AS asset_name, e.name AS entity_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN entities e ON e.id = r.entity_id
      WHERE r.id = ? AND r.workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Not found');
    const linked = await riskLinks.linked(db, req.workspace, risk.id);
    const controlGroups = await riskLinks.pickerGroups(db, req.workspace, risk.id);
    const assets = await db.prepare('SELECT id, name FROM assets WHERE workspace_id = ?').all(req.workspace.id);
    const methodology = await getActiveMethodology(req.workspace.id, risk.management_system);
    const inherentBand = methodologyBand(methodology, risk.likelihood, risk.impact);
    const residualBand = (risk.residual_likelihood && risk.residual_impact) ? methodologyBand(methodology, risk.residual_likelihood, risk.residual_impact) : null;
    const actions = await db.prepare(`SELECT * FROM risk_treatment_actions
      WHERE risk_id=? AND workspace_id=?
      ORDER BY (CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`).all(risk.id, req.workspace.id);
    const activeAcceptance = await db.prepare(`SELECT * FROM risk_acceptances
      WHERE risk_id=? AND revoked_at IS NULL ORDER BY signed_at DESC NULLS LAST LIMIT 1`).get(risk.id);
    res.render('risk_detail', { user: req.user, ws: req.workspace, risk, linked, controlGroups, assets, methodology, inherentBand, residualBand, actions, activeAcceptance });
  });

  app.post('/workspaces/:wsId/risks/:id/actions', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    const risk = await db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const { title, description, owner_name, due_date } = req.body;
    if (!title || !title.trim()) return redirectBack(req, res);
    await db.prepare(`INSERT INTO risk_treatment_actions
      (workspace_id, risk_id, title, description, owner_name, due_date, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)`).run(
      req.workspace.id, req.params.id, title.trim(), description || null,
      owner_name || null, due_date || null, req.user.id
    );
    await logAction(req.user.id, req.workspace.id, 'add_treatment_action', 'risk', req.params.id, { title }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/risks/:id/actions/:aid', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    const { title, description, owner_name, due_date, status, residual_likelihood, residual_impact } = req.body;
    const closedAt = status === 'done' ? `utc_now_text()` : 'NULL';
    await db.prepare(`UPDATE risk_treatment_actions SET
      title=COALESCE(?, title), description=?, owner_name=?, due_date=?, status=?,
      residual_likelihood=?, residual_impact=?,
      closed_at=CASE WHEN ?='done' AND closed_at IS NULL THEN utc_now_text() ELSE closed_at END
      WHERE id=? AND risk_id=? AND workspace_id=?`).run(
      title || null, description || null, owner_name || null, due_date || null, status || 'planned',
      residual_likelihood ? parseInt(residual_likelihood) : null,
      residual_impact ? parseInt(residual_impact) : null,
      status, req.params.aid, req.params.id, req.workspace.id
    );
    if (status === 'done' && residual_likelihood && residual_impact) {
      await db.prepare(`UPDATE risks SET residual_likelihood=?, residual_impact=? WHERE id=? AND workspace_id=?`)
        .run(parseInt(residual_likelihood), parseInt(residual_impact), req.params.id, req.workspace.id);
    }
    await logAction(req.user.id, req.workspace.id, 'update_treatment_action', 'risk', req.params.id, { action_id: req.params.aid, status }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/risks/:id/actions/:aid/delete', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    await db.prepare(`DELETE FROM risk_treatment_actions WHERE id=? AND risk_id=? AND workspace_id=?`)
      .run(req.params.aid, req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
  });

}

module.exports = { register };
