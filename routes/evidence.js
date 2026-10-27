'use strict';

const fs = require('fs');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');
const fts = require('../lib/fts');
const rbac = require('../lib/rbac');
const evReads = require('../lib/evidence-reads');
const evWrites = require('../lib/evidence-writes');
const evidenceRetrieval = require('../lib/evidence-retrieval');
const { PolicyRetrievalError } = require('../lib/policy-retrieval');
const { paginate, paginateArray, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');
const { requireInternalEvidenceMutation } = require('../lib/evidence-access');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath } = deps;

  function hasPermission(req, permission) {
    return rbac.hasPermission(req.userPerms || new Set(), permission);
  }

  function canUseExternalEvidenceAi(req) {
    return hasPermission(req, 'evidence.view')
      && hasPermission(req, 'evidence.download')
      && hasPermission(req, 'ai.external_process');
  }

  function hasEvidenceAiAcknowledgement(body) {
    return body && body.ai_external_ack === 'accepted'
      && body.ai_data_classification === 'non_confidential_trial';
  }

  async function runEvidenceIndex(req, evidenceId, authorizationScope) {
    if (!canUseExternalEvidenceAi(req)) {
      throw new PolicyRetrievalError(
        'You need evidence.view, evidence.download, and manager-granted ai.external_process permissions before evidence content can leave Nimbus.',
        'external_evidence_processing_forbidden', 403
      );
    }
    if (!hasEvidenceAiAcknowledgement(req.body)) {
      throw new PolicyRetrievalError(
        'Confirm that this file is sanitized, non-confidential trial evidence before sending its text to the logged OpenRouter/NVIDIA free endpoint.',
        'external_evidence_acknowledgement_required', 400
      );
    }
    const startedAt = Date.now();
    let audited = false;
    try {
      const result = await evidenceRetrieval.indexEvidence({
        db,
        workspaceId: req.workspace.id,
        evidenceId: Number(evidenceId),
        actorId: req.user.id,
        authorizationScope,
        resolveUploadPath,
        async beforeEgress(stage, metadata) {
          await logAction(req.user.id, req.workspace.id, 'ai_evidence_index_egress_started', 'evidence', evidenceId, {
            provider: 'OpenRouter',
            stage,
            external_processing: true,
            external_processing_acknowledged: true,
            acknowledgement_version: evidenceRetrieval.DISCLOSURE_VERSION,
            embedding_model: evidenceRetrieval.modelInfo().embedding_model,
            chunk_count: Number(metadata && metadata.chunk_count || 0),
            extracted_character_count: Number(metadata && metadata.extracted_character_count || 0),
            data_categories: ['selected_non_confidential_evidence_plaintext_sent_to_logged_free_embedding_endpoint']
          }, { ...auditCtx(req), strict: true });
          audited = true;
        }
      });
      await logAction(req.user.id, req.workspace.id, 'ai_evidence_index_completed', 'evidence', evidenceId, {
        provider: 'OpenRouter',
        status: result.status,
        reused: !!result.reused,
        chunk_count: Number(result.chunk_count || 0),
        duration_ms: Date.now() - startedAt
      }, auditCtx(req));
      return result;
    } catch (error) {
      await logAction(req.user.id, req.workspace.id, 'ai_evidence_index_failed', 'evidence', evidenceId, {
        provider: 'OpenRouter',
        external_egress_started: audited,
        error_type: String(error && error.name || 'Error').slice(0, 80),
        error_code: String(error && error.code || 'evidence_index_failed').slice(0, 100),
        duration_ms: Date.now() - startedAt
      }, auditCtx(req));
      throw error;
    }
  }

  function evidenceIndexToast(result) {
    if (result.status === 'ready' && result.reused) return 'Evidence already has a current AI index; the existing vectors were reused.';
    if (result.status === 'ready') return `Evidence indexed for control search (${result.chunk_count} chunk${result.chunk_count === 1 ? '' : 's'}).`;
    return result.error || 'The evidence was retained, but no searchable text could be indexed.';
  }

  function publicEvidenceIndexError(error) {
    return error instanceof PolicyRetrievalError
      ? String(error.message || 'Evidence indexing failed.').slice(0, 500)
      : 'Evidence indexing failed because of an internal error. The original file was not changed.';
  }

  app.get('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, requirePermission('evidence.view'), async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const filter = (req.query.filter || 'all').toString();
    const tag = (req.query.tag || '').toString().trim().toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const expSoon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const allEvidence = await db.prepare(`
      SELECT e.*,
             u.name AS uploader,
             ${evReads.linkCountSubquery()} AS link_count,
             sup.filename AS superseded_filename
      FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by
      LEFT JOIN evidence sup ON sup.id = e.supersedes_id
      WHERE e.workspace_id = ? AND e.superseded_at IS NULL
      ORDER BY e.uploaded_at DESC NULLS LAST
    `).all(req.workspace.id);

    let evidenceList = allEvidence;
    if (filter === 'expired') {
      evidenceList = evidenceList.filter(e => e.valid_until && e.valid_until < today);
    } else if (filter === 'expiring') {
      evidenceList = evidenceList.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon);
    } else if (filter === 'unlinked') {
      evidenceList = evidenceList.filter(e => (e.link_count || 0) === 0);
    }
    if (tag) {
      evidenceList = evidenceList.filter(e => (e.tags || '').toLowerCase().split(',').map(t => t.trim()).includes(tag));
    }
    if (q) {
      const lq = q.toLowerCase();
      evidenceList = evidenceList.filter(e =>
        (e.filename || '').toLowerCase().includes(lq) ||
        (e.description || '').toLowerCase().includes(lq) ||
        (e.period_label || '').toLowerCase().includes(lq) ||
        (e.uploader || '').toLowerCase().includes(lq) ||
        (e.tags || '').toLowerCase().includes(lq)
      );
    }

    const pgEv = require('../lib/paginate').paginateArray(req, evidenceList, 50);
    evidenceList = pgEv.rows;

    const { linksByEvidence, crossLinksByEvidence } = await evReads.libraryLinks(
      db, evidenceList.map(e => e.id));

    const counters = {
      total: allEvidence.length,
      expired: allEvidence.filter(e => e.valid_until && e.valid_until < today).length,
      expiring: allEvidence.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon).length,
      unlinked: allEvidence.filter(e => (e.link_count || 0) === 0).length,
      superseded: (await db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND superseded_at IS NOT NULL`).get(req.workspace.id)).c
    };

    const tagCounts = {};
    for (const e of allEvidence) {
      if (!e.tags) continue;
      for (const t of e.tags.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
    const tagList = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const allIsoItems = req.workspace.frameworks.includes('iso27001')
      ? await db.prepare(`SELECT id, type, title FROM iso_items ORDER BY sort_order ASC`).all() : [];

    const canExternalProcess = canUseExternalEvidenceAi(req);
    const evidenceAi = {
      configured: canExternalProcess && evidenceRetrieval.isConfigured(),
      configuration_error: canExternalProcess
        ? evidenceRetrieval.configurationError()
        : 'A manager must grant evidence download and ai.external_process before file content can leave Nimbus.',
      can_external_process: canExternalProcess,
      disclosure: evidenceRetrieval.DATA_DISCLOSURE,
      models: evidenceRetrieval.modelInfo(),
      status_by_id: await evidenceRetrieval.statusByEvidence(db, req.workspace.id)
    };

    res.render('evidence_library', {
      user: req.user, ws: req.workspace,
      title: 'Evidence library',
      active: 'evidence',
      evidenceList, linksByEvidence, counters,
      crossLinksByEvidence,
      allIsoItems,
      q, filter, tag, today, expSoon,
      tagList,
      evidenceAi,
      pg: pgEv, pagerHref: p => pageHref(req, p)
    });
  });

  function normaliseTags(raw) {
    if (!raw) return '';
    return raw.split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i)
      .join(', ');
  }

  async function selectedEvidenceRefs(workspace, body) {
    const enabled = new Set(Array.isArray(workspace.frameworks) ? workspace.frameworks : []);
    const selected = { iso27001: [] };
    const unique = values => [...new Set(parseFormArray(values).map(value => String(value).trim()).filter(Boolean))];

    if (enabled.has('iso27001')) {
      const refs = unique(body.iso_item_id);
      if (refs.length) {
        const placeholders = refs.map(() => '?').join(',');
        const valid = new Set((await db.prepare(`SELECT id FROM iso_items WHERE id IN (${placeholders})`).all(...refs)).map(row => row.id));
        selected.iso27001 = refs.filter(ref => valid.has(ref));
      }
    }
    return selected;
  }

  function selectedEvidenceRefCount(selected) {
    return Object.values(selected).reduce((count, refs) => count + refs.length, 0);
  }

  async function attachSelectedEvidenceRefs(evidenceId, selected, sectionRef) {
    for (const ref of selected.iso27001) await evWrites.attachIsoControl(db, evidenceId, ref, sectionRef || null);
  }

  app.post('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.upload'), upload.single('file'), async (req, res) => {
    if (!req.file) return redirectBack(req, res, 'Pick a file to upload', 'error');
    const selected = await selectedEvidenceRefs(req.workspace, req.body);
    const primaryId = selected.iso27001[0] || null;
    const linkCount = selectedEvidenceRefCount(selected);
    const { description, valid_from, valid_until, period_label, clause_section } = req.body;
    const tags = normaliseTags(req.body.tags);
    const buf = fs.readFileSync(req.file.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

    const existing = await db.prepare(`SELECT id, filename FROM evidence
      WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL
      ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
    if (existing) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      if (linkCount) {
        await db.transaction(async () => await attachSelectedEvidenceRefs(existing.id, selected, clause_section))();
      }
      await logAction(req.user.id, req.workspace.id, 'dedupe_evidence', 'evidence', existing.id, {
        sha, link_count: linkCount,
        framework_counts: Object.fromEntries(Object.entries(selected).map(([framework, refs]) => [framework, refs.length]))
      });
      const back = req.headers.referer || '/workspaces/' + req.workspace.id + '/evidence';
      if (req.body && req.body.ai_index === '1') {
        return runEvidenceIndex(req, existing.id, 'single_upload')
          .then(result => res.redirect(withToast(back, `Same file already exists (${existing.filename}) - linked instead of duplicated. ${evidenceIndexToast(result)}`)))
          .catch(error => res.redirect(withToast(back, `Same file already exists (${existing.filename}) - linked instead of duplicated. AI indexing did not run: ${publicEvidenceIndexError(error)}`, 'error')));
      }
      return res.redirect(withToast(back, `Same file already exists (${existing.filename}) - linked instead of duplicated`));
    }

    const evId = (await db.prepare(`INSERT INTO evidence
      (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
       valid_from, valid_until, period_label, clause_section, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, primaryId, req.file.originalname, req.file.filename,
           sha, req.file.size, req.user.id, description || null,
           valid_from || null, valid_until || null, period_label || null, clause_section || null,
           tags || null)).lastInsertRowid;
    if (linkCount) {
      await db.transaction(async () => await attachSelectedEvidenceRefs(evId, selected, clause_section))();
    }
    await logAction(req.user.id, req.workspace.id, 'upload_evidence', 'evidence', evId, {
      filename: req.file.originalname, link_count: linkCount,
      framework_counts: Object.fromEntries(Object.entries(selected).map(([framework, refs]) => [framework, refs.length]))
    });
    const back = req.headers.referer || '/workspaces/' + req.workspace.id;
    if (req.body && req.body.ai_index === '1') {
      return runEvidenceIndex(req, evId, 'single_upload')
        .then(result => res.redirect(withToast(back, `Evidence uploaded. ${evidenceIndexToast(result)}`)))
        .catch(error => res.redirect(withToast(back, `Evidence uploaded locally, but AI indexing did not complete: ${publicEvidenceIndexError(error)}`, 'error')));
    }
    res.redirect(back);
  });

  app.post('/workspaces/:wsId/evidence/:id/ai-index', requireAuth, requireWorkspace,
    requireInternalEvidenceMutation, requirePermission('evidence.upload'), requirePermission('evidence.view'),
    requirePermission('evidence.download'), requirePermission('ai.external_process'), async (req, res) => {
      const evidence = await db.prepare(`SELECT id FROM evidence
        WHERE workspace_id=? AND id=? AND superseded_at IS NULL`).get(req.workspace.id, req.params.id);
      if (!evidence) return res.status(404).send('Not found');
      const back = req.headers.referer || `/workspaces/${req.workspace.id}/evidence`;
      try {
        const result = await runEvidenceIndex(req, evidence.id, 'manual_index');
        return res.redirect(withToast(back, evidenceIndexToast(result), result.status === 'ready' ? 'success' : 'info'));
      } catch (error) {
        const status = error instanceof PolicyRetrievalError ? Number(error.status) : 500;
        if (status === 404) return res.status(404).send('Not found');
        const message = publicEvidenceIndexError(error);
        return res.redirect(withToast(back, message, 'error'));
      }
    });

  app.post('/workspaces/:wsId/evidence/:id/ai-index/delete', requireAuth, requireWorkspace,
    requireInternalEvidenceMutation, requirePermission('evidence.upload'), requirePermission('evidence.view'),
    requirePermission('evidence.download'), requirePermission('ai.external_process'), async (req, res) => {
      const evidence = await db.prepare(`SELECT id FROM evidence
        WHERE workspace_id=? AND id=?`).get(req.workspace.id, req.params.id);
      if (!evidence) return res.status(404).send('Not found');
      await logAction(req.user.id, req.workspace.id, 'ai_evidence_index_removal_started', 'evidence', evidence.id, {
        derived_vectors_removal_requested: true
      }, { ...auditCtx(req), strict: true });
      const removed = await evidenceRetrieval.purgeEvidenceIndexes(db, req.workspace.id, evidence.id);
      await logAction(req.user.id, req.workspace.id, 'ai_evidence_index_removed', 'evidence', evidence.id, {
        removed_generation_count: removed,
        derived_vectors_removed: true
      }, auditCtx(req));
      const back = req.headers.referer || `/workspaces/${req.workspace.id}/evidence`;
      return res.redirect(withToast(back, removed
        ? 'The evidence AI index and its derived vectors were removed.'
        : 'This evidence did not have an AI index.', 'info'));
    });

  app.post('/workspaces/:wsId/evidence/bulk', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.upload'), upload.array('files', 50), async (req, res) => {
    if (!req.files || !req.files.length) return redirectBack(req, res, 'Pick at least one file', 'error');
    const selected = await selectedEvidenceRefs(req.workspace, req.body);
    const primaryId = selected.iso27001[0] || null;
    const linkCount = selectedEvidenceRefCount(selected);
    const { description, valid_from, valid_until, period_label } = req.body;
    const tags = normaliseTags(req.body.tags);
    let created = 0, deduped = 0;
    for (const f of req.files) {
      const buf = fs.readFileSync(f.path);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const existing = await db.prepare(`SELECT id FROM evidence
        WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
      if (existing) {
        try { fs.unlinkSync(f.path); } catch (_) {}
        if (linkCount) {
          await db.transaction(async () => await attachSelectedEvidenceRefs(existing.id, selected, null))();
        }
        deduped++;
        continue;
      }
      const evId = (await db.prepare(`INSERT INTO evidence
        (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
         valid_from, valid_until, period_label, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.workspace.id, primaryId, f.originalname, f.filename, sha, f.size, req.user.id,
             description || null, valid_from || null, valid_until || null, period_label || null,
             tags || null)).lastInsertRowid;
      if (linkCount) {
        await db.transaction(async () => await attachSelectedEvidenceRefs(evId, selected, null))();
      }
      created++;
    }
    await logAction(req.user.id, req.workspace.id, 'bulk_upload_evidence', 'workspace', req.workspace.id, {
      created, deduped, link_count: linkCount,
      framework_counts: Object.fromEntries(Object.entries(selected).map(([framework, refs]) => [framework, refs.length]))
    });
    const msg = `Uploaded ${created} file${created === 1 ? '' : 's'}` + (deduped ? ` · ${deduped} re-linked (already existed)` : '');
    res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, msg));
  });

  app.post('/workspaces/:wsId/evidence/:id/supersede', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.upload'), upload.single('file'), async (req, res) => {
    const old = await db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!old) return res.status(404).send('Not found');
    if (!req.file) return redirectBack(req, res, 'Pick the new version of the file', 'error');
    const buf = fs.readFileSync(req.file.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha === old.sha256) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, 'New file is identical to the existing version - nothing to supersede', 'info'));
    }
    const { description, valid_from, valid_until, period_label } = req.body;
    const tags = normaliseTags(req.body.tags) || old.tags || null;
    const newId = (await db.prepare(`INSERT INTO evidence
      (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
       valid_from, valid_until, period_label, clause_section, supersedes_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, old.iso_item_id, req.file.originalname, req.file.filename, sha, req.file.size,
           req.user.id, description || old.description || null,
           valid_from || null, valid_until || null, period_label || null, old.clause_section || null,
           old.id, tags)).lastInsertRowid;
    const tx = db.transaction(async () => { await evWrites.copyControlLinks(db, old.id, newId); });
    try { await tx(); } catch (_) {}
    await db.prepare(`UPDATE evidence SET superseded_at=utc_now_text(), superseded_by_id=? WHERE id=?`).run(newId, old.id);
    await evidenceRetrieval.markEvidenceStale(db, req.workspace.id, old.id);
    await logAction(req.user.id, req.workspace.id, 'supersede_evidence', 'evidence', old.id, { new_id: newId, filename: req.file.originalname });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, `Superseded ${old.filename} → ${req.file.originalname}`));
  });

  app.get('/workspaces/:wsId/evidence/pack.zip', requireAuth, requireWorkspace,
    requirePermission('evidence.export'), requirePermission('evidence.view'),
    requirePermission('evidence.download'), requirePermission('workspace.export'), async (req, res) => {
    const dateFrom = (req.query.from || '').toString();
    const dateTo = (req.query.to || '').toString();
    let where = 'e.workspace_id = ? AND e.superseded_at IS NULL';
    const params = [req.workspace.id];
    const calendarDate = value => {
      const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(value.trim());
      return m ? m[1] : value;
    };
    if (dateFrom) { where += ' AND substr(e.uploaded_at, 1, 10) >= sqlite_date_ymd(?)'; params.push(calendarDate(dateFrom)); }
    if (dateTo)   { where += ' AND substr(e.uploaded_at, 1, 10) <= sqlite_date_ymd(?)'; params.push(calendarDate(dateTo)); }
    const items = await db.prepare(`SELECT e.*, u.name AS uploader,
      ${evReads.linkedControlsSubquery()} AS linked_controls
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE ${where} ORDER BY e.uploaded_at ASC NULLS FIRST`).all(...params);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-pack-${req.workspace.id}-${new Date().toISOString().slice(0,10)}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { try { res.status(500).send(String(err)); } catch (_) {} });
    archive.pipe(res);

    const csvLines = [
      'evidence_id,filename,sha256,size_bytes,uploader,uploaded_at,period,valid_from,valid_until,linked_controls,tags,description'
    ];
    function csvEsc(v) {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    for (const e of items) {
      csvLines.push([
        e.id, csvEsc(e.filename), e.sha256, e.size_bytes, csvEsc(e.uploader),
        e.uploaded_at ? e.uploaded_at.slice(0, 19) : '',
        csvEsc(e.period_label), e.valid_from || '', e.valid_until || '',
        csvEsc(e.linked_controls), csvEsc(e.tags), csvEsc(e.description)
      ].join(','));
    }
    archive.append(csvLines.join('\n'), { name: 'MANIFEST.csv' });

    archive.append(
  `Evidence pack - workspace ${req.workspace.client_name || req.workspace.id}
  Generated: ${new Date().toISOString()}
  Files: ${items.length}
  Date range: ${dateFrom || 'all'} → ${dateTo || 'all'}

  MANIFEST.csv lists every file in this pack with its SHA-256, linked controls,
  period, validity, and uploader. The /files/ directory contains the actual
  artefacts. SHA-256 lets you verify nothing was tampered with after export.
  `,
      { name: 'README.txt' }
    );

    for (const e of items) {
      const found = resolveUploadPath(e.stored_path, req.workspace.firm_id);
      if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
        archive.file(found, { name: `files/${e.id}-${e.filename}` });
      }
    }
    archive.finalize();
  });

  app.post('/workspaces/:wsId/evidence/:id/controls', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.upload'), async (req, res) => {
    const ev = await db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const ids = parseFormArray(req.body.iso_item_id);
    if (!ids.length) return redirectBack(req, res);
    const sharedSectionRef = req.body.section_ref || null;
    const tx = db.transaction(async () => {
      for (const id of ids) {
        const perLinkKey = 'section_ref_for_' + id.replace(/[^a-z0-9.-]/gi, '_');
        const ref = (req.body[perLinkKey] || sharedSectionRef || null);
        await evWrites.attachIsoControl(db, ev.id, id, ref);
      }
    });
    try { await tx(); } catch (_) {}
    await logAction(req.user.id, req.workspace.id, 'link_evidence_control', 'evidence', ev.id, { ids, count: ids.length }, auditCtx(req));
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/section', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.upload'), async (req, res) => {
    const ev = await db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const newRef = (req.body.section_ref || '').toString().trim() || null;
    await evWrites.updateSection(db, ev.id, req.params.linkId, newRef);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.delete'), async (req, res) => {
    const ev = await db.prepare(`SELECT id, iso_item_id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const removedIso = await evWrites.unlinkIsoControl(db, ev.id, req.params.linkId);
    if (removedIso) {
      if (ev.iso_item_id === removedIso) {
        await db.prepare(`UPDATE evidence SET iso_item_id=NULL WHERE id=?`).run(ev.id);
      }
    }
    redirectBack(req, res);
  });

  app.get('/workspaces/:wsId/evidence/:id/download', requireAuth, requireWorkspace,
    requirePermission('evidence.download'), async (req, res) => {
    const ev = await db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
    res.download(fp, ev.filename);
  });

  app.post('/workspaces/:wsId/evidence/:id/delete', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.delete'), async (req, res) => {
    const ev = await db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (ev) {
      const retainedCapaLink = await db.prepare(`SELECT 1 FROM nonconformity_evidence_links
        WHERE workspace_id=? AND evidence_id=? LIMIT 1`).get(req.workspace.id, ev.id);
      if (retainedCapaLink) {
        return redirectBack(req, res,
          'This file is retained as CAPA evidence and cannot be hard-deleted. Supersede it with a new evidence version instead.', 'error');
      }
      const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
      await db.prepare('DELETE FROM evidence WHERE id = ?').run(ev.id);
      await logAction(req.user.id, req.workspace.id, 'delete_evidence', 'evidence', ev.id, null);
    }
    redirectBack(req, res);
  });

}

module.exports = { register };
