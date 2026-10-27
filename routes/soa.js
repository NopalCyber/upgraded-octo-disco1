'use strict';

const ctlReads = require('../lib/control-reads');
const ctlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState } = deps;

  app.get('/workspaces/:wsId/soa', requireAuth, requireWorkspace, async (req, res) => {
    await db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id)
                SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                WHERE f.code='iso27001' AND rq.req_type='control' ON CONFLICT DO NOTHING`).run(req.workspace.id);

    const T = ctlReads.tables(db, req.workspace.id);
    const rows = await db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification,
        cs.last_verified_at,
        (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id = rc.risk_id
         WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risk_count,
        (SELECT COUNT(*) FROM evidence e WHERE e.iso_item_id = i.id AND e.workspace_id = ?) AS evidence_count,
        (SELECT COUNT(*) FROM nonconformities n WHERE n.iso_item_id = i.id AND n.workspace_id = ? AND n.status != 'closed') AS open_nc_count,
        (SELECT COUNT(*) FROM nonconformities n WHERE n.iso_item_id = i.id AND n.workspace_id = ?
          AND n.created_at > utc_text(now() + ('-12 months')::interval)) AS systemic_count
        FROM iso_items i
        LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type = 'control'
        ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id);

    const soaDocLinks = await db.prepare(`
      SELECT dc.iso_item_id, dc.section_ref, d.id AS doc_id, d.name AS doc_name, d.status AS doc_status, d.category
      FROM ${docLinks.docControlsExpr('iso27001')} dc
      INNER JOIN generated_docs d ON d.id = dc.document_id
      WHERE d.workspace_id = ?
      ORDER BY d.name
    `).all(req.workspace.id);
    const docsByControl = {};
    soaDocLinks.forEach(l => { (docsByControl[l.iso_item_id] = docsByControl[l.iso_item_id] || []).push(l); });

    const riskLinks = await db.prepare(`
      SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title, r.likelihood, r.impact, r.status
      FROM risk_controls rc
      INNER JOIN risks r ON r.id = rc.risk_id
      WHERE r.workspace_id = ?
      ORDER BY (r.likelihood * r.impact) DESC NULLS LAST
    `).all(req.workspace.id);
    const risksByControl = {};
    riskLinks.forEach(l => { (risksByControl[l.iso_item_id] = risksByControl[l.iso_item_id] || []).push(l); });

    const customControls = await db.prepare(`SELECT * FROM soa_custom_controls
      WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);

    const latestSnap = await db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, created_at
      FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1`).get(req.workspace.id);

    const soaCounts = {
      included:  rows.filter(r => r.applicability === 'included').length,
      excluded:  rows.filter(r => r.applicability === 'excluded').length,
      undecided: rows.filter(r => !r.applicability || r.applicability === 'undecided').length,
      total:     rows.length
    };

    res.render('soa', {
      user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
      customControls, soaMeta: latestSnap || {}, soaCounts
    });
  });

  app.post('/workspaces/:wsId/soa/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res, nextMw) => {
    if (['snapshot','auto-justify','snapshots','bulk','custom-controls','metadata'].includes(req.params.isoId)) return nextMw();
    await getOrCreateState(req.workspace.id, req.params.isoId);
    const { applicability, inclusion_justification, exclusion_justification, status } = req.body;
    const wcSoa = ctlWrites.converged(db, req.workspace.id);
    const ridSoa = wcSoa ? await ctlWrites.requirementId(db, 'iso27001', req.params.isoId) : null;
    if (wcSoa && ridSoa) {
      await db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification=?, exclusion_justification=?,
                  status = COALESCE(?, status), last_updated = utc_now_text()
                  WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(ctlWrites.normApplic(applicability || 'undecided'),
             inclusion_justification || null, exclusion_justification || null,
             ctlWrites.normStatus(status || null), req.workspace.id, ridSoa);
    } else {
      await db.prepare(`UPDATE control_states SET applicability=?, inclusion_justification=?, exclusion_justification=?,
                  status = COALESCE(?, status), last_updated = utc_now_text()
                  WHERE workspace_id=? AND iso_item_id=?`)
        .run(applicability || 'undecided',
             inclusion_justification || null, exclusion_justification || null,
             status || null, req.workspace.id, req.params.isoId);
    }
    await logAction(req.user.id, req.workspace.id, 'update_soa', 'control', req.params.isoId, null);
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect('/workspaces/' + req.workspace.id + '/soa');
  });

  app.post('/workspaces/:wsId/soa/batch', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    let rows = [];
    try { rows = JSON.parse(req.body.rows || '[]'); } catch (_) { rows = []; }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ ok: false, message: 'No rows to save.' });
    }
    if (rows.length > 250) return res.status(400).json({ ok: false, message: 'Batch too large.' });
    const valid = rows.filter(r => r && typeof r.iso_item_id === 'string' && r.iso_item_id);
    const upsertCi = db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING`);
    const updateCi = db.prepare(`UPDATE control_instances SET
        applicability = ?, inclusion_justification = ?, exclusion_justification = ?,
        status = COALESCE(?, status), last_updated = utc_now_text()
      WHERE workspace_id = ? AND requirement_id = ? AND entity_id IS NULL`);
    const tx = db.transaction(async () => {
      for (const __item of valid) await (async r => {
        const rid = await ctlWrites.requirementId(db, 'iso27001', r.iso_item_id);
        if (!rid) return;
        await upsertCi.run(req.workspace.id, rid);
        await updateCi.run(
          ctlWrites.normApplic(r.applicability || 'undecided'),
          r.inclusion_justification || null,
          r.exclusion_justification || null,
          ctlWrites.normStatus(r.status || null),
          req.workspace.id, rid
        );
      })(__item);
    });
    await tx();
    await logAction(req.user.id, req.workspace.id, 'soa_batch_save', 'soa', null, { count: valid.length }, auditCtx(req));
    res.json({ ok: true, count: valid.length });
  });

  app.post('/workspaces/:wsId/soa/bulk', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), async (req, res) => {
    const { action, justification } = req.body;
    const ids = parseFormArray(req.body.iso_id);
    const wcBulk = ctlWrites.converged(db, req.workspace.id);
    const CTL_REQ = `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.req_type='control'`;
    if (wcBulk) {
      await db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id)
                  SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                  WHERE f.code='iso27001' AND rq.req_type='control' ON CONFLICT DO NOTHING`).run(req.workspace.id);
    } else {
      await db.prepare(`INSERT INTO control_states (workspace_id, iso_item_id)
                  SELECT ?, id FROM iso_items WHERE type='control' ON CONFLICT DO NOTHING`).run(req.workspace.id);
    }
    let affected = 0;
    if (action === 'include_all') {
      affected = wcBulk
        ? (await db.prepare(`UPDATE control_instances SET applicability=?,
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = utc_now_text()
                      WHERE workspace_id=? AND entity_id IS NULL AND requirement_id IN (${CTL_REQ})`)
            .run(ctlWrites.normApplic('included'), justification || null, req.workspace.id)).changes
        : (await db.prepare(`UPDATE control_states SET applicability='included',
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = utc_now_text()
                      WHERE workspace_id=? AND iso_item_id IN (SELECT id FROM iso_items WHERE type='control')`)
            .run(justification || null, req.workspace.id)).changes;
    } else if (action === 'include_undecided') {
      affected = wcBulk
        ? (await db.prepare(`UPDATE control_instances SET applicability=?,
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = utc_now_text()
                      WHERE workspace_id=? AND entity_id IS NULL AND applicability=? AND requirement_id IN (${CTL_REQ})`)
            .run(ctlWrites.normApplic('included'), justification || null, req.workspace.id, ctlWrites.normApplic('undecided'))).changes
        : (await db.prepare(`UPDATE control_states SET applicability='included',
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = utc_now_text()
                      WHERE workspace_id=? AND applicability IN ('undecided','')
                        AND iso_item_id IN (SELECT id FROM iso_items WHERE type='control')`)
            .run(justification || null, req.workspace.id)).changes;
    } else if ((action === 'apply_to_selected' || action === 'exclude_selected') && ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const applicability = action === 'exclude_selected' ? 'excluded' : 'included';
      const justCol = applicability === 'excluded' ? 'exclusion_justification' : 'inclusion_justification';
      affected = wcBulk
        ? (await db.prepare(`UPDATE control_instances SET applicability=?,
                      ${justCol} = COALESCE(?, ${justCol}), last_updated = utc_now_text()
                      WHERE workspace_id=? AND entity_id IS NULL
                        AND requirement_id IN (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                                               WHERE f.code='iso27001' AND rq.ref IN (${placeholders}))`)
            .run(ctlWrites.normApplic(applicability), justification || null, req.workspace.id, ...ids)).changes
        : (await db.prepare(`UPDATE control_states SET applicability=?,
                      ${justCol} = COALESCE(?, ${justCol}), last_updated = utc_now_text()
                      WHERE workspace_id=? AND iso_item_id IN (${placeholders})`)
            .run(applicability, justification || null, req.workspace.id, ...ids)).changes;
    }
    await logAction(req.user.id, req.workspace.id, 'soa_bulk', 'soa', null, { action, affected, count: ids.length }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/soa`, `${affected} control${affected === 1 ? '' : 's'} updated`));
  });

}

module.exports = { register };
