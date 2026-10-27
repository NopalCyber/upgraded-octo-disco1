const path = require('path');
const fs = require('fs');
const { confirmationMatchesRenderedName } = require('../lib/typography');
const { clientSetup } = require('../lib/client-setup');
const { parseWorkspaceFrameworks } = require('../lib/frameworks');
const rbac = require('../lib/rbac');
const { auditCtx } = require('../lib/http-helpers');
const { deleteFirm } = require('../lib/workspace-deletion');

function buildOnboardingSteps(db) {
  return [
    { num: 1, key: 'first-client', title: 'Create your first client',
      desc: 'Record the client and choose only the assessment programmes and operational services in the engagement.',
      cta: 'Create first client',
      isDone: async firmId => (await db.prepare(`SELECT COUNT(*) c FROM workspaces WHERE firm_id=?`).get(firmId)).c > 0,
      href: '/workspaces/new'
    }
  ];
}

function onboardingManager(user) {
  if (!user || user.user_type !== 'firm') return false;
  return rbac.rolePermissions(rbac.normalizeRole(user.firm_role) || 'consultant').includes('firm.manage');
}

function workspaceCreator(user) {
  if (!user || user.user_type !== 'firm') return false;
  return rbac.rolePermissions(rbac.normalizeRole(user.firm_role) || 'consultant').includes('workspace.create');
}

async function clientSummary(db, workspace) {
  const ws = { ...workspace, frameworks: parseWorkspaceFrameworks(workspace.frameworks) };
  const setup = await clientSetup(db, ws);
  const serviceNames = [...new Set(setup.steps.map(step => step.programme))];
  return {
    workspace: ws,
    setup,
    serviceNames,
    setupHref: setup.total ? `/workspaces/${ws.id}/setup` : `/workspaces/${ws.id}#programme-enable-form`,
  };
}

function register(app, deps) {
  const { db, bcrypt, requireAuth, isFirmUser, getActiveFirmId, listUserFirms, withToast, projectRoot, logAction } = deps;
  const { listWorkspaces } = deps;

  app.get('/tenants', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const firms = await listUserFirms(req.user);
    const activeFirmId = await getActiveFirmId(req);
    res.render('tenants', { user: req.user, firms, activeFirmId });
  });

  app.post('/tenants', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.manage')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Creating a tenant requires a firm manager.' });
    }
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/tenants');

    let fid = null;
    try {
      fid = await db.transaction(async () => {
        const id = (await db.prepare('INSERT INTO firms (name) VALUES (?)').run(name)).lastInsertRowid;
        const placeholderEmail = `owner+firm${id}@local`;
        const placeholderHash = bcrypt.hashSync('disabled-' + Date.now(), 10);
        await db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role, active)
                    VALUES (?, ?, ?, 'firm', ?, 'manager', 1)`).run(placeholderEmail, placeholderHash, `${name} owner`, id);
        await db.prepare(`INSERT INTO tenant_onboarding (firm_id, current_step) VALUES (?, 1)`).run(id);
        return id;
      })();
    } catch (err) {
      return res.status(500).render('error', {
        user: req.user, message: 'Could not create the tenant. No changes were saved.' });
    }

    try { fs.mkdirSync(path.join(projectRoot, 'uploads', `firm_${fid}`), { recursive: true }); }
    catch (err) { console.error('[tenants] upload dir for firm', fid, err.message); }

    if (typeof deps.logAction === 'function') {
      try { await deps.logAction(req.user.id, null, 'create_firm', 'firm', fid, { name }, auditCtx(req)); } catch (_) {}
    }
    req.session.active_firm_id = fid;
    res.redirect('/onboarding');
  });

  app.post('/tenants/:id/switch', requireAuth, async (req, res) => {
    const fid = parseInt(req.params.id, 10);
    if (req.user.user_type === 'firm') {
      if (req.user.firm_id !== fid) return res.status(403).send('Forbidden');
    } else {
      const hasMembership = await db.prepare(
        `SELECT 1 FROM workspace_members wm
         INNER JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = ? AND w.firm_id = ?`
      ).get(req.user.id, fid);
      if (!hasMembership) return res.status(403).send('Forbidden');
    }
    const previousFirmId = req.session.active_firm_id || null;
    req.session.active_firm_id = fid;
    await logAction(req.user.id, null, 'switch_firm', 'firm', fid, { from_firm_id: previousFirmId }, auditCtx(req));
    res.redirect('/dashboard');
  });

  app.post('/tenants/:id/rename', requireAuth, async (req, res) => {
    const fid = parseInt(req.params.id, 10);
    if (req.user.user_type !== 'firm' || req.user.firm_id !== fid) {
      return res.status(403).send('Forbidden');
    }
    if (req.user.firm_role !== 'manager' && req.user.firm_role !== 'owner') {
      return res.status(403).send('Forbidden');
    }
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/tenants');
    const before = await db.prepare('SELECT name FROM firms WHERE id=?').get(fid);
    const renamed = await db.prepare('UPDATE firms SET name=? WHERE id=?').run(name, fid);
    if (before && renamed.changes) {
      await logAction(req.user.id, null, 'rename_firm', 'firm', fid, { old_name: before.name, new_name: name }, auditCtx(req));
    }
    res.redirect('/tenants');
  });

  app.post('/tenants/:id/delete', requireAuth, async (req, res) => {
    const fid = parseInt(req.params.id, 10);
    if (req.user.user_type !== 'firm' || req.user.firm_id !== fid) {
      return res.status(403).send('Forbidden');
    }
    if (req.user.firm_role !== 'manager' && req.user.firm_role !== 'owner') {
      return res.status(403).send('Forbidden');
    }
    const firm = await db.prepare('SELECT id, name FROM firms WHERE id=?').get(fid);
    if (!firm) return res.redirect(withToast('/tenants', 'Tenant not found', 'error'));

    const confirm = (req.body.confirm_name || '').trim();
    if (!confirmationMatchesRenderedName(confirm, firm.name)) {
      return res.redirect(withToast('/tenants', 'Confirmation name did not match - nothing deleted', 'error'));
    }

    const totalFirms = (await db.prepare('SELECT COUNT(*) c FROM firms').get()).c;
    if (totalFirms <= 1) {
      return res.redirect(withToast('/tenants', 'Cannot delete the only remaining tenant', 'error'));
    }

    const wsCount = (await db.prepare('SELECT COUNT(*) c FROM workspaces WHERE firm_id=?').get(fid)).c;
    const tx = db.transaction(async () => {
      await logAction(req.user.id, null, 'delete_firm', 'firm', fid, {
        name: firm.name, workspaces: wsCount, deleted_by_email: req.user.email,
      }, { ...auditCtx(req), strict: true });
      await deleteFirm(db, fid);
    });
    await tx();

    try {
      const tenantDir = path.join(projectRoot, 'uploads', `firm_${fid}`); // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
      if (fs.existsSync(tenantDir)) fs.rmSync(tenantDir, { recursive: true, force: true });
    } catch (_) {}

    if (req.session.active_firm_id === fid) {
      const fallback = await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
      req.session.active_firm_id = fallback ? fallback.id : null;
    }

    res.redirect(withToast('/tenants', `Tenant "${firm.name}" deleted`, 'success'));
  });

  const ONBOARDING_STEPS = buildOnboardingSteps(db);

  app.get('/onboarding', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const onb = (await db.prepare(`SELECT * FROM tenant_onboarding WHERE firm_id=?`).get(firmId)) || {
      firm_id: firmId,
      started_at: null,
      completed_at: null,
      current_step: 1,
      skipped: 0,
    };
    const stepStates = [];
    for (const s of ONBOARDING_STEPS) stepStates.push({ ...s, done: !!(await s.isDone(firmId)) });
    const completedCount = stepStates.filter(s => s.done).length;
    const accessible = (typeof listWorkspaces === 'function' ? await listWorkspaces(req.user) : [])
      .filter(workspace => Number(workspace.firm_id) === Number(firmId));
    const clientSummaries = await Promise.all(
      accessible.slice(0, 6).map(async workspace => await clientSummary(db, workspace))
    );
    const firmUserCount = (await db.prepare(`SELECT COUNT(*) c FROM users
      WHERE firm_id=? AND user_type='firm' AND active=1`).get(firmId)).c;
    const pendingFirmInvites = (await db.prepare(`SELECT COUNT(*) c FROM user_invitations
      WHERE firm_id=? AND user_type='firm' AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at>utc_now_text()`).get(firmId)).c;
    const emailIdentity = (await db.prepare(`SELECT from_name,from_email,reply_to
      FROM firm_email_settings WHERE firm_id=?`).get(firmId)) || null;
    res.render('onboarding', {
      user: req.user, ws: null, steps: stepStates, completedCount,
      totalSteps: ONBOARDING_STEPS.length, onb,
      clientSummaries,
      accessibleClientCount: accessible.length,
      canCreateClients: workspaceCreator(req.user),
      canManageOnboarding: onboardingManager(req.user),
      firmRecommendations: {
        teamReady: Number(firmUserCount) > 1 || Number(pendingFirmInvites) > 0,
        emailReady: !!(emailIdentity && (emailIdentity.from_name || emailIdentity.from_email || emailIdentity.reply_to)),
      },
    });
  });

  app.post('/onboarding/skip', requireAuth, async (req, res) => {
    if (!onboardingManager(req.user)) return res.status(403).send('Forbidden');
    const firmId = await getActiveFirmId(req);
    if (firmId) {
      await db.prepare(`INSERT INTO tenant_onboarding (firm_id,current_step,skipped,completed_at)
        VALUES (?,1,1,NULL)
        ON CONFLICT(firm_id) DO UPDATE SET
          skipped=CASE WHEN tenant_onboarding.completed_at IS NULL THEN 1 ELSE tenant_onboarding.skipped END`).run(firmId);
      await logAction(req.user.id, null, 'skip_onboarding', 'firm', firmId, null, auditCtx(req));
    }
    res.redirect('/dashboard');
  });

  app.post('/onboarding/complete', requireAuth, async (req, res) => {
    if (!onboardingManager(req.user)) return res.status(403).send('Forbidden');
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const hasClient = await db.prepare('SELECT 1 FROM workspaces WHERE firm_id=? LIMIT 1').get(firmId);
    if (!hasClient) {
      return res.redirect(withToast('/onboarding', 'Create the first client before completing firm onboarding.', 'error'));
    }
    await db.prepare(`INSERT INTO tenant_onboarding (firm_id,current_step,skipped,completed_at)
      VALUES (?,1,0,utc_now_text())
      ON CONFLICT(firm_id) DO UPDATE SET
        skipped=0,
        completed_at=COALESCE(tenant_onboarding.completed_at,utc_now_text())`).run(firmId);
    await logAction(req.user.id, null, 'complete_onboarding', 'firm', firmId, null, auditCtx(req));
    res.redirect('/dashboard');
  });
}

async function getOnboardingProgress(db, firmId) {
  if (!firmId) return null;
  const onb = await db.prepare(`SELECT * FROM tenant_onboarding WHERE firm_id=?`).get(firmId);
  const steps = buildOnboardingSteps(db);
  const stepStates = [];
  for (const s of steps) stepStates.push({ num: s.num, title: s.title, done: !!(await s.isDone(firmId)) });
  const done = stepStates.filter(s => s.done).length;
  const total = stepStates.length;
  return {
    done, total,
    pct: total ? Math.round(done / total * 100) : 0,
    skipped: !!(onb && onb.skipped),
    completed: !!(onb && onb.completed_at && done === total),
    nextStep: stepStates.find(s => !s.done) || null,
  };
}

module.exports = { register, getOnboardingProgress };
