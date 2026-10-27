'use strict';

const fieldwork = require('../lib/gap-fieldwork');
const delivery = require('../lib/engagement-delivery');
const { withToast, auditCtx } = require('../lib/http-helpers');
const { isConstraintError } = require('../lib/pg');

const INTERVIEW_STATUSES = new Set(['scheduled', 'completed', 'rescheduled', 'cancelled']);
const BLOCKER_STATUSES = new Set(['open', 'resolved', 'accepted_risk']);
const PHASES = new Set(['mobilisation', 'fieldwork', 'validation', 'report', 'post_report']);

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;
  const base = workspaceId => `/workspaces/${workspaceId}/gap-assessment/fieldwork`;
  const firmOnly = (req, res, next) => req.user.user_type === 'firm'
    ? next() : res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'This fieldwork workspace is restricted to the engagement team.' });
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
  const scheduledAt = value => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(value || '')) ? String(value) : null;
  const visible = value => value === '1' ? 1 : 0;
  const redirectError = (req, res, message) => res.redirect(withToast(base(req.workspace.id), message, 'error'));
  const requireOpenGapEngagement = async (req, res, next) => {
    const context = await fieldwork.assessmentContext(db, req.workspace);
    if (context.gapOnly && context.closure.complete) {
      return redirectError(req, res,
        'This gap-assessment engagement is formally closed. Retained fieldwork cannot be changed; start a new governed engagement and assessment pass for further work.');
    }
    next();
  };

  async function currentPassOrError(req) {
    return await fieldwork.latestPass(db, req.workspace.id);
  }

  async function workspaceUser(req, id) {
    if (!id) return null;
    return await db.prepare(`SELECT u.id FROM users u LEFT JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
      WHERE u.id=? AND u.active=1 AND ((u.user_type='firm' AND u.firm_id=?) OR wm.workspace_id=?)`).get(
      req.workspace.id, Number(id), req.workspace.firm_id, req.workspace.id);
  }

  app.get('/workspaces/:wsId/gap-assessment/fieldwork', requireAuth, requireWorkspace, firmOnly, async (req, res) => {
    const context = await fieldwork.assessmentContext(db, req.workspace);
    const users = await db.prepare(`SELECT DISTINCT u.id,u.name,u.user_type FROM users u
      LEFT JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
      WHERE u.active=1 AND ((u.user_type='firm' AND u.firm_id=?) OR wm.workspace_id=?)
      ORDER BY u.user_type DESC,u.name`).all(req.workspace.id, req.workspace.firm_id, req.workspace.id);
    const requirements = await db.prepare(`SELECT r.id,r.ref,r.title,r.sort_order FROM requirements r
      JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001' ORDER BY r.sort_order,r.id`).all();
    res.render('gap_fieldwork', {
      user: req.user, ws: req.workspace, active: 'gap-assessment', title: 'Gap assessment fieldwork',
      context, users, requirements
    });
  });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/interviews', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('control.update'), async (req, res) => {
      const pass = await currentPassOrError(req);
      if (!pass) return redirectError(req, res, 'Start an assessment pass before scheduling interviews.');
      const title = clean(req.body.title, 220);
      const role = clean(req.body.participant_role, 180);
      const when = scheduledAt(req.body.scheduled_at);
      const duration = req.body.duration_minutes ? Number(req.body.duration_minutes) : null;
      if (!title || !role || !when) return redirectError(req, res, 'Interview title, participant role and scheduled date are required.');
      if (duration != null && (!Number.isInteger(duration) || duration < 5 || duration > 480)) return redirectError(req, res, 'Interview duration must be between 5 and 480 minutes.');
      const owner = await workspaceUser(req, req.body.owner_id);
      const result = await db.prepare(`INSERT INTO gap_fieldwork_interviews
        (workspace_id,assessment_pass_id,title,objective,participant_role,owner_id,scheduled_at,duration_minutes,client_visible,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          req.workspace.id, pass.id, title, clean(req.body.objective, 5000) || null, role,
          owner?.id || null, when, duration, visible(req.body.client_visible), req.user.id, req.user.id);
      await logAction(req.user.id, req.workspace.id, 'schedule_gap_interview', 'gap_fieldwork_interview', result.lastInsertRowid,
        { assessment_pass_id: pass.id, scheduled_at: when }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Interview added to the governed schedule.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/interviews/:id/status', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('control.update'), async (req, res) => {
      const status = String(req.body.status || '');
      const version = Number(req.body.row_version);
      if (!INTERVIEW_STATUSES.has(status)) return redirectError(req, res, 'Choose a valid interview status.');
      const summary = clean(req.body.completion_summary, 5000);
      if (status === 'completed' && !summary) return redirectError(req, res, 'A client-safe completion summary is required when completing an interview.');
      const result = await db.prepare(`UPDATE gap_fieldwork_interviews SET status=?,completion_summary=?,
        completed_at=CASE WHEN ?='completed' THEN utc_now_text() ELSE NULL END,
        updated_by=?,updated_at=utc_now_text(),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND row_version=?`).run(
          status, summary || null, status, req.user.id, Number(req.params.id), req.workspace.id, version);
      if (!result.changes) return redirectError(req, res, 'The interview changed in another session. Reload before updating it.');
      await logAction(req.user.id, req.workspace.id, 'update_gap_interview', 'gap_fieldwork_interview', req.params.id, { status }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Interview status updated.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/blockers', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('control.update'), async (req, res) => {
      const pass = await currentPassOrError(req);
      if (!pass) return redirectError(req, res, 'Start an assessment pass before recording blockers.');
      const title = clean(req.body.title, 220);
      const description = clean(req.body.description, 5000);
      const priority = ['normal', 'high', 'critical'].includes(req.body.priority) ? req.body.priority : 'high';
      if (!title || !description) return redirectError(req, res, 'Blocker title and client-safe impact statement are required.');
      const owner = await workspaceUser(req, req.body.owner_id);
      const result = await db.prepare(`INSERT INTO gap_fieldwork_blockers
        (workspace_id,assessment_pass_id,title,description,owner_id,priority,due_date,client_visible,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          req.workspace.id, pass.id, title, description, owner?.id || null, priority,
          date(req.body.due_date), visible(req.body.client_visible), req.user.id, req.user.id);
      await logAction(req.user.id, req.workspace.id, 'create_gap_blocker', 'gap_fieldwork_blocker', result.lastInsertRowid,
        { priority }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Blocker recorded.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/blockers/:id/status', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('control.update'), async (req, res) => {
      const status = String(req.body.status || '');
      const version = Number(req.body.row_version);
      const note = clean(req.body.resolution_note, 5000);
      if (!BLOCKER_STATUSES.has(status)) return redirectError(req, res, 'Choose a valid blocker status.');
      if (status !== 'open' && !note) return redirectError(req, res, 'A resolution or risk-acceptance rationale is required.');
      const result = await db.prepare(`UPDATE gap_fieldwork_blockers SET status=?,resolution_note=?,
        resolved_at=CASE WHEN ?='open' THEN NULL ELSE utc_now_text() END,
        updated_by=?,updated_at=utc_now_text(),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND row_version=?`).run(
          status, note || null, status, req.user.id, Number(req.params.id), req.workspace.id, version);
      if (!result.changes) return redirectError(req, res, 'The blocker changed in another session. Reload before updating it.');
      await logAction(req.user.id, req.workspace.id, 'update_gap_blocker', 'gap_fieldwork_blocker', req.params.id, { status }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Blocker status updated.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/defaults', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('control.update'), async (req, res) => {
      const pass = await currentPassOrError(req);
      if (!pass) return redirectError(req, res, 'Start an assessment pass before recording declared defaults.');
      const requirement = await db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id
        WHERE r.id=? AND f.code='iso27001'`).get(Number(req.body.requirement_id));
      const declaration = clean(req.body.declaration, 3000);
      const rationale = clean(req.body.rationale, 5000);
      if (!requirement || !declaration || !rationale) return redirectError(req, res, 'Requirement, declaration and rationale are required.');
      try {
        const result = await db.prepare(`INSERT INTO gap_declared_defaults
          (workspace_id,assessment_pass_id,requirement_id,declaration,rationale,client_visible,recorded_by)
          VALUES (?,?,?,?,?,?,?)`).run(req.workspace.id, pass.id, requirement.id, declaration, rationale,
            visible(req.body.client_visible), req.user.id);
        await logAction(req.user.id, req.workspace.id, 'propose_gap_default', 'gap_declared_default', result.lastInsertRowid,
          { requirement_id: requirement.id }, auditCtx(req));
      } catch (error) {
        if (isConstraintError(error)) return redirectError(req, res, 'A declared default already exists for this requirement in the current pass.');
        throw error;
      }
      res.redirect(withToast(base(req.workspace.id), 'Declared default proposed for confirmation.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/defaults/:id/:action(confirm|withdraw)', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('assessment.signoff'), async (req, res) => {
      const action = req.params.action;
      const version = Number(req.body.row_version);
      const result = await db.prepare(`UPDATE gap_declared_defaults SET status=?,confirmed_by=?,
        confirmed_at=CASE WHEN ?='confirmed' THEN utc_now_text() ELSE confirmed_at END,
        updated_at=utc_now_text(),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND row_version=?`).run(
          action === 'confirm' ? 'confirmed' : 'withdrawn', req.user.id,
          action === 'confirm' ? 'confirmed' : 'withdrawn', Number(req.params.id), req.workspace.id, version);
      if (!result.changes) return redirectError(req, res, 'The declared default changed in another session. Reload before deciding.');
      await logAction(req.user.id, req.workspace.id, `${action}_gap_default`, 'gap_declared_default', req.params.id, null, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), `Declared default ${action === 'confirm' ? 'confirmed' : 'withdrawn'}.`));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/snapshots', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('assessment.signoff'), async (req, res) => {
      try {
        const id = await fieldwork.snapshotFieldwork(db, req.workspace, req.user.id, date(req.body.week_ending));
        await logAction(req.user.id, req.workspace.id, 'freeze_gap_weekly_snapshot', 'gap_fieldwork_snapshot', id,
          { week_ending: req.body.week_ending }, auditCtx(req));
        res.redirect(withToast(base(req.workspace.id), 'Immutable weekly fieldwork snapshot created.'));
      } catch (error) {
        return redirectError(req, res, String(error.message).includes('UNIQUE')
          ? 'A snapshot already exists for that assessment pass and week-ending date.' : error.message);
      }
    });

  const recordDecision = db.transaction(async (req, passId, phase, decision, rationale, expectedVersion) => {
    const current = await db.prepare(`SELECT * FROM gap_assessment_phase_decisions
      WHERE workspace_id=? AND assessment_pass_id=? AND phase=?`).get(req.workspace.id, passId, phase);
    if (current && Number(current.row_version) !== expectedVersion) throw new Error('The phase decision changed in another session. Reload before deciding.');
    let id;
    if (current) {
      const result = await db.prepare(`UPDATE gap_assessment_phase_decisions SET decision=?,rationale=?,decided_by=?,
        decided_at=utc_now_text(),row_version=row_version+1 WHERE id=? AND row_version=?`).run(
          decision, rationale, req.user.id, current.id, expectedVersion);
      if (!result.changes) throw new Error('The phase decision changed in another session. Reload before deciding.');
      id = current.id;
    } else {
      if (expectedVersion !== 0) throw new Error('The phase decision changed in another session. Reload before deciding.');
      id = Number((await db.prepare(`INSERT INTO gap_assessment_phase_decisions
        (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by) VALUES (?,?,?,?,?,?)`).run(
          req.workspace.id, passId, phase, decision, rationale, req.user.id)).lastInsertRowid);
    }
    await db.prepare(`INSERT INTO gap_assessment_phase_events
      (phase_decision_id,from_decision,to_decision,rationale,actor_id) VALUES (?,?,?,?,?)`).run(
        id, current?.decision || null, decision, rationale, req.user.id);
    return id;
  });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/phases/:phase', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('assessment.signoff'), async (req, res) => {
      const phase = String(req.params.phase || '');
      const decision = String(req.body.decision || '');
      const rationale = clean(req.body.rationale, 5000);
      const expectedVersion = Number(req.body.row_version || 0);
      if (!PHASES.has(phase) || !['complete', 'not_required', 'reopened'].includes(decision) || !rationale) {
        return redirectError(req, res, 'A valid phase decision and rationale are required.');
      }
      const context = await fieldwork.assessmentContext(db, req.workspace);
      if (!context.pass) return redirectError(req, res, 'Start an assessment pass before recording phase decisions.');
      if (phase === 'report' && decision === 'not_required') {
        return redirectError(req, res, 'The gap assessment report is part of every assessment; record it as issued or reopen it.');
      }
      if (phase === 'post_report' && context.gapOnly) {
        return redirectError(req, res, 'Post-report remediation is outside this gap-assessment-only engagement. Close the engagement at the issued report instead.');
      }
      if (decision !== 'reopened') {
        if (phase === 'validation' && decision === 'not_required') {
          if (!context.completed.fieldwork || context.findings.length) return redirectError(req, res, 'Validation can be marked not required only after fieldwork sign-off when there are no confirmed client findings.');
        } else if (phase === 'post_report' && decision === 'not_required') {
          if (!context.gates.report.complete || context.findings.length) return redirectError(req, res, 'Post-report remediation can be marked not required only after the report is issued and no confirmed client findings exist.');
        } else if (phase === 'validation' && decision === 'complete' && !context.findings.length) {
          return redirectError(req, res, 'There are no confirmed client findings to validate. Record Validation as Not required instead.');
        } else if (!context.gates[phase].ready) {
          const failed = context.gates[phase].checks.filter(check => !check.pass).map(check => check.label).join('; ');
          return redirectError(req, res, `Phase sign-off is blocked: ${failed}.`);
        }
      }
      let id;
      try { id = await recordDecision(req, context.pass.id, phase, decision, rationale, expectedVersion); } catch (error) { return redirectError(req, res, error.message); }
      await logAction(req.user.id, req.workspace.id, 'decide_gap_phase', 'gap_assessment_phase_decision', id,
        { phase, decision, assessment_pass_id: context.pass.id }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), `${phase.replace('_', ' ')} decision recorded.`));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/close', requireAuth, requireWorkspace, firmOnly,
    requireOpenGapEngagement, requirePermission('workspace.update'), async (req, res) => {
      const context = await fieldwork.assessmentContext(db, req.workspace);
      if (!context.gapOnly) return redirectError(req, res, 'Only a gap-assessment-only engagement closes at the report.');
      if (!context.closure.ready) return redirectError(req, res, `Closure is blocked: ${context.closure.blockers.join(' ')}`);
      const note = clean(req.body.completion_note, 4000) || 'Gap-assessment engagement closed at the issued report.';
      let id;
      try { id = await recordDecision(req, context.pass.id, 'closure', 'complete', note, Number(req.body.row_version || 0)); }
      catch (error) { return redirectError(req, res, error.message); }
      if (await db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(req.workspace.id)) {
        await delivery.syncOutcomePlanStatus(db, req.workspace, req.user.id);
      }
      await logAction(req.user.id, req.workspace.id, 'close_gap_engagement', 'gap_assessment_phase_decision', id,
        { assessment_pass_id: context.pass.id }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Gap-assessment engagement closed.'));
    });
}

module.exports = { register };
