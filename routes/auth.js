'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rbac = require('../lib/rbac');
const frameworks = require('../lib/frameworks');
const { auditCtx, withToast, escapeHtml } = require('../lib/http-helpers');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function register(app, deps) {
  const { db, requireAuth, logAction } = deps;

  const SESSION_DEFAULT_MAX_AGE  = 1000 * 60 * 60 * 8;
  const SESSION_REMEMBER_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

  const LOGIN_BAD_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_BAD_LIMIT = 8;
  const loginKey = (email) => String(email || '').toLowerCase().slice(0, 320);
  async function recordBadLogin(email) {
    const row = await db.prepare(`INSERT INTO login_failures AS f (email, failures, window_ends_at)
        VALUES (?, 1, now() + ?::integer * interval '1 millisecond')
      ON CONFLICT (email) DO UPDATE SET
        failures = CASE WHEN f.window_ends_at < now() THEN 1 ELSE f.failures + 1 END,
        window_ends_at = CASE WHEN f.window_ends_at < now() THEN EXCLUDED.window_ends_at ELSE f.window_ends_at END
      RETURNING failures`).get(loginKey(email), LOGIN_BAD_WINDOW_MS);
    return row.failures;
  }
  async function isLockedOut(email) {
    const row = await db.prepare(`SELECT failures FROM login_failures WHERE email = ? AND window_ends_at >= now()`)
      .get(loginKey(email));
    return !!row && row.failures >= LOGIN_BAD_LIMIT;
  }
  async function clearBadLogin(email) {
    await db.prepare(`DELETE FROM login_failures WHERE email = ?`).run(loginKey(email));
  }

  function validPublicEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    if (/@(?:example\.(?:com|org|net)|isms\.local)$/i.test(email)) return null;
    return email;
  }

  async function publicContactDetails() {
    let contactEmail = validPublicEmail(process.env.EVALUATION_CONTACT_EMAIL);
    if (!contactEmail) {
      try {
        const configured = await db.prepare(`SELECT COALESCE(reply_to,from_email) email
          FROM firm_email_settings
          WHERE enabled=1 AND COALESCE(reply_to,from_email) IS NOT NULL
          ORDER BY firm_id LIMIT 1`).get();
        contactEmail = validPublicEmail(configured && configured.email);
      } catch (_) {}
    }
    const securityEmail = validPublicEmail(process.env.SECURITY_CONTACT_EMAIL) || contactEmail;
    const configuredUrl = String(process.env.EVALUATION_REQUEST_URL || '').trim();
    const evaluationUrl = /^https:\/\/[^\s]+$/i.test(configuredUrl) ? configuredUrl : '/contact';
    return { contactEmail, securityEmail, evaluationUrl };
  }

  async function renderPublic(req, res, page, extra = {}) {
    const pages = {
      home: ['Your compliance programme, in one place', 'The platform our consultants deliver ISO 27001 and third-party risk engagements on, with a portal for your team.'],
      access: ['Request access', 'Access is invite-only so every account starts in an explicitly assigned firm or client workspace.'],
      security: ['Security', 'How the product protects access, governed records, uploads, and external sharing.'],
      privacy: ['Privacy', 'What this site processes and which responsibilities belong to the organization operating it.'],
      terms: ['Terms of use', 'Plain-language conditions for evaluating and using this software.'],
      contact: ['Talk to us', 'Tell us about your compliance programme.']
    };
    const [title, description] = pages[page] || pages.home;
    return res.render('auth/public', {
      page, title, description, ...(await publicContactDetails()),
      topic: ['evaluation','security','privacy'].includes(String(req.query.topic || '')) ? String(req.query.topic) : 'evaluation',
      ...extra
    });
  }

  const PROGRAMME_UNITS = Object.freeze({
    iso27001: 'requirements',
  });

  const PROGRAMME_OUTPUTS = Object.freeze({
    iso27001: 'Gap report, Statement of Applicability, policy set, internal audit, management review, readiness pack',
  });

  function programmeRegister() {
    return frameworks.FRAMEWORK_LIST.map((f) => ({
      code: f.tagLabel,
      formalName: f.formalName,
      descriptor: f.descriptor,
      count: frameworks.catalogueSize(f.code),
      unit: PROGRAMME_UNITS[f.code] || 'requirements',
      outputs: PROGRAMME_OUTPUTS[f.code] || '',
    })).filter((p) => p.count > 0);
  }

  async function homeFacts(programmes) {
    let templates = 0;
    try { templates = (await db.prepare('SELECT COUNT(*) c FROM doc_templates WHERE is_system=1').get()).c; } catch (_) {}
    return {
      requirements: programmes.reduce((n, p) => n + p.count, 0),
      templates,
    };
  }

  app.get('/', async (req, res) => {
    if (req.session && req.session.userId) return res.redirect('/dashboard');
    const programmes = programmeRegister();
    return await renderPublic(req, res, 'home', { programmes, facts: await homeFacts(programmes) });
  });

  app.get('/security', async (req, res) => await renderPublic(req, res, 'security'));
  app.get('/privacy', async (req, res) => await renderPublic(req, res, 'privacy'));
  app.get('/terms', async (req, res) => await renderPublic(req, res, 'terms'));
  app.get('/contact', async (req, res) => await renderPublic(req, res, 'contact'));
  app.get('/.well-known/security.txt', async (req, res) => {
    const { securityEmail } = await publicContactDetails();
    const configuredBase = /^https:\/\/[^\s]+$/i.test(String(process.env.APP_BASE_URL || ''))
      ? String(process.env.APP_BASE_URL).replace(/\/+$/, '')
      : `${req.protocol}://${String(req.get('host') || 'localhost').replace(/[^a-z0-9.:[\]-]/gi, '')}`;
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const contacts = [securityEmail ? `Contact: mailto:${securityEmail}` : null, `Contact: ${configuredBase}/contact?topic=security`]
      .filter(Boolean).join('\n');
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(
      `${contacts}\nExpires: ${expires}\nPolicy: ${configuredBase}/security\nPreferred-Languages: en\n`);
  });

  const localPath = value => (typeof value === 'string' && /^\/(?![\/\\])/.test(value) ? value : '');

  app.get('/login', (req, res) => {
    if (req.session && req.session.userId) return res.redirect(localPath(req.query.next) || '/dashboard');
    res.render('auth/login', {
      error: null,
      notice: req.query.signed_out ? 'You have been signed out.' : (req.query.reset_ok ? 'Password updated. Sign in to continue.' : null),
      next_url: localPath(req.query.next),
      prefillEmail: '',
      csrfToken: res.locals.csrfToken
    });
  });

  app.post('/login', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const remember = !!(req.body && req.body.remember);
    const nextUrl = localPath(req.body.next) || '/dashboard';

    const renderFail = (msg) => res.status(401).render('auth/login', {
      error: msg, notice: null, next_url: nextUrl === '/dashboard' ? '' : nextUrl,
      prefillEmail: email, csrfToken: res.locals.csrfToken
    });

    const recordFailedLogin = async (userId, reason) => await logAction(userId || null, null, 'login_failed', 'user', userId || null,
      { email: email.slice(0, 254), reason }, { ...auditCtx(req), touchActivity: false });

    if (!email || !password) return renderFail('Email and password are required.');
    if (await isLockedOut(email)) {
      const known = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
      await recordFailedLogin(known && known.id, 'locked_out');
      return renderFail('Too many failed attempts. Wait 15 minutes and try again, or reset your password.');
    }

    const user = await db.prepare(`SELECT id, email, password_hash, active, auth_epoch FROM users WHERE email = ?`).get(email);
    const hashToCheck = (user && user.password_hash && user.password_hash !== '!noauth')
      ? user.password_hash
      : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid.'; // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
    const ok = bcrypt.compareSync(password, hashToCheck);

    if (!user || !user.active || user.password_hash === '!noauth' || !ok) {
      await recordBadLogin(email);
      await recordFailedLogin(user && user.id, !user ? 'unknown_account'
        : !user.active ? 'inactive_account'
          : user.password_hash === '!noauth' ? 'password_sign_in_disabled' : 'wrong_password');
      return renderFail('Email or password is incorrect.');
    }

    await clearBadLogin(email);
    req.session.regenerate(async err => {
      if (err) return renderFail('Could not start a session. Please try again.');
      req.session.cookie.maxAge = remember ? SESSION_REMEMBER_MAX_AGE : SESSION_DEFAULT_MAX_AGE;
      try { await db.prepare(`UPDATE users SET last_active_at = utc_now_text() WHERE id = ?`).run(user.id); } catch (_) {}
      req.session.userId = user.id;
      req.session.authEpoch = Number(user.auth_epoch || 0);
      await logAction(user.id, null, 'login_succeeded', 'user', user.id, { remember }, auditCtx(req));
      res.redirect(nextUrl);
    });
  });

  async function signOut(req, res) {
    const userId = req.session && req.session.userId;
    if (userId) await logAction(userId, null, 'logout', 'user', userId, null, auditCtx(req));
    req.session.destroy(() => {
      res.clearCookie('compliance_sphere.sid');
      res.redirect('/login?signed_out=1');
    });
  }

  app.post('/logout', signOut);

  app.get('/logout', signOut);

  app.get('/register', async (req, res) => await renderPublic(req, res, 'access'));
  app.post('/register', async (req, res) => {
    return await renderPublic(req, res.status(405), 'access', {
      accessNotice: 'Self-signup is disabled. Use the single-use invitation sent by your engagement team, or talk to us to get started.'
    });
  });

  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function isFirmOwnerLocal(u) {
    return u && u.user_type === 'firm' && rbac.isManager(u.firm_role);
  }

  app.get('/admin/users', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'Only Managers can manage users.' });
    }
    const firmUsers = await db.prepare(`
      SELECT id, name, email, firm_role, active, last_active_at, created_at
        FROM users WHERE firm_id = ? AND user_type = 'firm' ORDER BY active DESC NULLS LAST, name`).all(req.user.firm_id);
    const clientUsers = await db.prepare(`
      SELECT u.id, u.name, u.email, u.active, u.last_active_at, u.created_at,
             string_agg(w.client_name || ' (' || wm.role || ')', ' · ') AS workspaces
        FROM users u
        INNER JOIN workspace_members wm ON wm.user_id = u.id
        INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE u.user_type = 'client' AND w.firm_id = ?
       GROUP BY u.id ORDER BY u.active DESC NULLS LAST, u.name`).all(req.user.firm_id);
    const outstanding = await db.prepare(`
      SELECT inv.id, inv.email, inv.name, inv.user_type, inv.firm_role, inv.workspace_role,
             inv.expires_at, inv.created_at, w.client_name AS workspace_name, u.name AS invited_by_name
        FROM user_invitations inv
        LEFT JOIN workspaces w ON w.id = inv.workspace_id
        LEFT JOIN users u ON u.id = inv.invited_by
       WHERE inv.firm_id = ? AND inv.accepted_at IS NULL AND inv.revoked_at IS NULL AND inv.expires_at > utc_now_text()
       ORDER BY inv.created_at DESC NULLS LAST`).all(req.user.firm_id);
    const workspaces = await db.prepare(`SELECT id, client_name FROM workspaces WHERE firm_id = ? ORDER BY client_name`).all(req.user.firm_id);
    const manualShareLink = req.session.manualShareLink || null;
    if (manualShareLink) { delete req.session.manualShareLink; res.set('Cache-Control', 'no-store'); }
    res.render('admin_users', {
      manualShareLink,
      user: req.user, ws: null, active: 'admin-users',
      firmUsers, clientUsers, outstanding, workspaces,
      notice: req.query.notice || null,
      error: req.query.error || null,
      errorAction: req.query.error_action || null,
      errorEmail: req.query.error_email || null,
      errorUserId: req.query.error_user_id || null
    });
  });

  app.post('/admin/users/invite', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim() || null;
    const userType = b.user_type === 'client' ? 'client' : 'firm';
    const firmRole = userType === 'firm'
      ? (rbac.FIRM_ROLES.includes(b.firm_role) ? b.firm_role : 'consultant')
      : null;
    const workspaceId = userType === 'client' ? parseInt(b.workspace_id, 10) || null : null;
    const workspaceRole = userType === 'client'
      ? (rbac.CLIENT_ROLES.includes(b.workspace_role) ? b.workspace_role : 'contributor')
      : null;

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('A valid email is required.'));
    }

    const existing = await db.prepare(`SELECT id, email, active, name FROM users WHERE email = ?`).get(email);
    if (existing) {
      if (existing.active) {
        return res.redirect('/admin/users?'
          + 'error=' + encodeURIComponent(`An active account already exists for ${email}.`)
          + '&error_action=offer_reset'
          + '&error_email=' + encodeURIComponent(email));
      } else {
        return res.redirect('/admin/users?'
          + 'error=' + encodeURIComponent(`${email} previously had an account that was deactivated.`)
          + '&error_action=offer_reactivate'
          + '&error_user_id=' + existing.id
          + '&error_email=' + encodeURIComponent(email));
      }
    }

    if (userType === 'client') {
      if (!workspaceId) return res.redirect('/admin/users?error=' + encodeURIComponent('Pick a client workspace for the client-side user.'));
      const ws = await db.prepare(`SELECT id FROM workspaces WHERE id = ? AND firm_id = ?`).get(workspaceId, req.user.firm_id);
      if (!ws) return res.redirect('/admin/users?error=' + encodeURIComponent('That workspace doesn\'t belong to this firm.'));
      if (!rbac.CLIENT_ROLES.includes(workspaceRole)) {
        return res.redirect('/admin/users?error=' + encodeURIComponent('Invalid workspace role.'));
      }
    }

    const pendingCount = (await db.prepare(`UPDATE user_invitations
         SET revoked_at = utc_now_text()
       WHERE firm_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > utc_now_text()`).run(req.user.firm_id, email)).changes;

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const invitationId = (await db.prepare(`INSERT INTO user_invitations
        (email, name, firm_id, user_type, firm_role, workspace_id, workspace_role,
         token_hash, expires_at, invited_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(email, name, req.user.firm_id, userType, firmRole, workspaceId, workspaceRole,
           tokenHash, expiresAt, req.user.id)).lastInsertRowid;
    await logAction(req.user.id, workspaceId, 'invite_user', 'user_invitation', invitationId, {
      email, user_type: userType, firm_role: firmRole, workspace_role: workspaceRole,
      replaced_pending: pendingCount, expires_at: expiresAt,
    }, auditCtx(req));

    const firmRow = await db.prepare(`SELECT name FROM firms WHERE id = ?`).get(req.user.firm_id);
    const roleLabel = userType === 'firm'
      ? (rbac.ROLE_LABELS[firmRole] || 'Consultant')
      : `Client-side - ${rbac.ROLE_LABELS[workspaceRole] || workspaceRole}`;

    let sendError = null;
    try {
      const emailLib = require('../lib/email');
      const r = await emailLib.sendInviteEmail({
        toEmail: email, toName: name, inviterName: req.user.name,
        firmName: firmRow && firmRow.name, role: roleLabel,
        token: raw, expiresAt, firmId: req.user.firm_id
      });
      if (!r.ok) sendError = r.error || 'Email delivery failed';
    } catch (e) { sendError = e && e.message; }

    if (sendError) {
      req.session.manualShareLink = `/invite/${raw}`;
      return res.redirect('/admin/users?error=' + encodeURIComponent(`Invitation created but email failed (${sendError}). Copy the link below and share it with them directly.`));
    }
    const replacedNote = pendingCount > 0 ? ' (replaced an earlier pending invitation)' : '';
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Invitation sent to ${email}. Link expires in 7 days.${replacedNote}`));
  });

  app.post('/admin/users/create', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim();
    const password = String(b.password || '');
    const firmRole = rbac.FIRM_ROLES.includes(b.firm_role) ? b.firm_role : 'consultant';

    if (!email || !name) return res.redirect('/admin/users?error=' + encodeURIComponent('Name and email are required.'));
    if (password.length < 8) return res.redirect('/admin/users?error=' + encodeURIComponent('Temp password must be at least 8 characters.'));
    if (await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('A user with that email already exists.'));
    }
    const hash = bcrypt.hashSync(password, 12);
    const id = (await db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role)
                           VALUES (?, ?, ?, 'firm', ?, ?)`)
      .run(email, hash, name, req.user.firm_id, firmRole)).lastInsertRowid;
    try { await logAction(req.user.id, null, 'create_consultant', 'user', id, { email, role: firmRole }); } catch (_) {}
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Created ${email}. Share the temp password with them - they should change it on first sign-in.`));
  });

  app.post('/admin/users/:id/deactivate', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const target = await db.prepare(`SELECT id, firm_id, user_type, email FROM users WHERE id = ?`).get(req.params.id);
    if (!target) return res.redirect('/admin/users');
    if (target.id === req.user.id) return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot deactivate your own account.'));
    let ok = false;
    if (target.user_type === 'firm') {
      ok = target.firm_id === req.user.firm_id;
    } else {
      ok = !!(await db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                         WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id));
    }
    if (!ok) return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
    await db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(target.id);
    try { await deps.revokeUserSessions(target.id); } catch (_) {}
    await logAction(req.user.id, null, 'deactivate_user', 'user', target.id,
      { email: target.email, user_type: target.user_type }, auditCtx(req));
    res.redirect('/admin/users?notice=' + encodeURIComponent('User deactivated.'));
  });

  app.post('/admin/users/send-reset', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.redirect('/admin/users?error=' + encodeURIComponent('Missing email.'));

    const target = await db.prepare(`SELECT id, email, name, active, user_type, firm_id FROM users WHERE email = ?`).get(email);
    if (!target) {
      return res.redirect('/admin/users?notice=' + encodeURIComponent(`If an account exists for ${email}, a reset link is on its way.`));
    }
    let allowed = false;
    if (target.user_type === 'firm') allowed = target.firm_id === req.user.firm_id;
    else allowed = !!(await db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                                  WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id));
    if (!allowed || !target.active) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot reset that account from here.'));
    }

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    let sendError = null;
    let issued = false;
    try {
      await db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)`)
        .run(target.id, tokenHash, expiresAt, req.ip || null);
      issued = true;
      const emailLib = require('../lib/email');
      const r = await emailLib.sendPasswordResetEmail({
        toEmail: target.email, toName: target.name, token: raw, expiresAt, firmId: req.user.firm_id
      });
      if (!r.ok) sendError = r.error || 'Email delivery failed';
    } catch (e) { sendError = e && e.message; }
    if (issued) {
      await logAction(req.user.id, null, 'send_password_reset', 'user', target.id,
        { email: target.email, email_sent: !sendError, expires_at: expiresAt }, auditCtx(req));
    }

    if (sendError) {
      req.session.manualShareLink = `/reset/${raw}`;
      return res.redirect('/admin/users?error=' + encodeURIComponent(`Reset token created but email failed (${sendError}). Copy the link below and share it with them directly.`));
    }
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Password-reset link sent to ${email}. Expires in 1 hour.`));
  });

  app.post('/admin/users/:id/reactivate', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const target = await db.prepare(`SELECT id, firm_id, user_type, email, active FROM users WHERE id = ?`).get(req.params.id);
    if (!target) return res.redirect('/admin/users');
    if (target.active) return res.redirect('/admin/users?error=' + encodeURIComponent('That account is already active.'));
    let ok = false;
    if (target.user_type === 'firm') ok = target.firm_id === req.user.firm_id;
    else ok = !!(await db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                            WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id));
    if (!ok) return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
    await db.prepare(`UPDATE users SET active = 1 WHERE id = ?`).run(target.id);
    await logAction(req.user.id, null, 'reactivate_user', 'user', target.id,
      { email: target.email, user_type: target.user_type }, auditCtx(req));
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Reactivated ${target.email}. They can now sign in with their existing password (or use Forgot password if they don't remember it).`));
  });

  app.post('/admin/invitations/:id/revoke', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const inv = await db.prepare(`SELECT id, firm_id, email, workspace_id FROM user_invitations WHERE id = ?`).get(req.params.id);
    if (!inv || inv.firm_id !== req.user.firm_id) return res.redirect('/admin/users');
    await db.prepare(`UPDATE user_invitations SET revoked_at = utc_now_text() WHERE id = ?`).run(inv.id);
    await logAction(req.user.id, inv.workspace_id || null, 'revoke_invitation', 'user_invitation', inv.id,
      { email: inv.email }, auditCtx(req));
    res.redirect('/admin/users?notice=' + encodeURIComponent('Invitation revoked.'));
  });

  app.post('/admin/users/:id/firm-role', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const newRole = String((req.body && req.body.firm_role) || '').trim();
    if (!rbac.FIRM_ROLES.includes(newRole)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Invalid role.'));
    }
    const target = await db.prepare(`SELECT id, firm_id, user_type, firm_role, email, name FROM users WHERE id = ?`)
      .get(req.params.id);
    if (!target) return res.redirect('/admin/users?error=' + encodeURIComponent('User not found.'));
    if (target.user_type !== 'firm' || target.firm_id !== req.user.firm_id) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
    }
    if (target.id === req.user.id) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot change your own role from here. Ask another manager.'));
    }
    const currentNormalised = rbac.normalizeRole(target.firm_role);
    if (currentNormalised === 'manager' && newRole !== 'manager') {
      const otherManagers = await db.prepare(`
        SELECT COUNT(*) AS n FROM users
          WHERE firm_id = ? AND user_type = 'firm' AND active = 1 AND id != ?
            AND (firm_role = 'manager' OR firm_role = 'firm_owner')`).get(target.firm_id, target.id);
      if (!otherManagers.n) {
        return res.redirect('/admin/users?error=' + encodeURIComponent(
          'Cannot demote the last active manager. Promote another firm user to manager first.'));
      }
    }
    if (currentNormalised === newRole) {
      return res.redirect('/admin/users?notice=' + encodeURIComponent('Role unchanged.'));
    }
    await db.prepare(`UPDATE users SET firm_role = ? WHERE id = ?`).run(newRole, target.id);
    await logAction(req.user.id, null, 'change_firm_role', 'user', target.id,
      { old_role: target.firm_role, new_role: newRole }, auditCtx(req));
    res.redirect('/admin/users?notice=' + encodeURIComponent(
      `Updated ${target.email} to ${rbac.ROLE_LABELS[newRole] || newRole}.`));
  });

  async function lookupInvitation(rawToken) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) return null;
    const tokenHash = hashToken(rawToken);
    const row = await db.prepare(`
      SELECT inv.*, f.name AS firm_name, w.client_name AS workspace_name
        FROM user_invitations inv
        LEFT JOIN firms f ON f.id = inv.firm_id
        LEFT JOIN workspaces w ON w.id = inv.workspace_id
       WHERE inv.token_hash = ?`).get(tokenHash);
    if (!row) return null;
    if (row.accepted_at || row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    if (await db.prepare(`SELECT id FROM users WHERE email = ?`).get(row.email)) return null;
    return row;
  }

  app.get('/invite/:token', async (req, res) => {
    const inv = await lookupInvitation(req.params.token);
    if (!inv) {
      return res.status(400).render('auth/login', {
        error: 'That invitation link is invalid, has expired, or has already been used. Ask the person who invited you for a new one.',
        notice: null, next_url: '', prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    res.render('auth/accept_invite', {
      token: req.params.token, invitation: inv, error: null,
      csrfToken: res.locals.csrfToken
    });
  });

  app.post('/invite/:token', async (req, res) => {
    const inv = await lookupInvitation(req.params.token);
    if (!inv) {
      return res.status(400).render('auth/login', {
        error: 'That invitation link is invalid, has expired, or has already been used.',
        notice: null, next_url: '', prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    const b = req.body || {};
    const name = (b.name || inv.name || '').trim();
    const pw  = String(b.password  || '');
    const pw2 = String(b.password2 || '');
    const renderFail = (msg) => res.status(400).render('auth/accept_invite', {
      token: req.params.token, invitation: inv, error: msg, csrfToken: res.locals.csrfToken
    });
    if (!name) return renderFail('Your name is required.');
    if (pw.length < 8) return renderFail('Password must be at least 8 characters.');
    if (pw !== pw2)    return renderFail('Passwords do not match.');

    const hash = bcrypt.hashSync(pw, 12);
    let newUserId = null;
    const tx = db.transaction(async () => {
      const insertCols = inv.user_type === 'firm'
        ? `email, password_hash, name, user_type, firm_id, firm_role`
        : `email, password_hash, name, user_type, firm_id`;
      const insertVals = inv.user_type === 'firm'
        ? [inv.email, hash, name, 'firm', inv.firm_id, inv.firm_role || 'consultant']
        : [inv.email, hash, name, 'client', inv.firm_id];
      newUserId = (await db.prepare(`INSERT INTO users (${insertCols}) VALUES (${insertVals.map(() => '?').join(',')})`)
        .run(...insertVals)).lastInsertRowid;
      if (inv.workspace_id && inv.workspace_role) {
        await db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`)
          .run(inv.workspace_id, newUserId, inv.workspace_role);
      }
      await db.prepare(`UPDATE user_invitations SET accepted_at = utc_now_text(), accepted_user_id = ? WHERE id = ?`)
        .run(newUserId, inv.id);
    });
    await tx();
    await logAction(newUserId, inv.workspace_id || null, 'invitation_accepted', 'user_invitation', inv.id, {
      email: inv.email, user_type: inv.user_type, firm_role: inv.user_type === 'firm' ? (inv.firm_role || 'consultant') : null,
      workspace_role: inv.workspace_role || null, invited_by: inv.invited_by,
    }, auditCtx(req));

    req.session.regenerate(async err => {
      if (err) return res.redirect('/login?invited=1');
      req.session.userId = newUserId;
      req.session.authEpoch = Number(
        (await db.prepare('SELECT auth_epoch FROM users WHERE id = ?').get(newUserId))?.auth_epoch || 0);
      req.session.cookie.maxAge = SESSION_DEFAULT_MAX_AGE;
      const nextUrl = inv.workspace_id ? `/workspaces/${inv.workspace_id}/client-portal` : '/dashboard';
      res.redirect(nextUrl);
    });
  });

  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
  const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

  app.get('/forgot', (req, res) => {
    res.render('auth/forgot', {
      error: null, notice: null, submitted: false,
      prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  });

  app.post('/forgot', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const genericNotice = 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.';
    if (!email) {
      return res.status(400).render('auth/forgot', {
        error: 'Email is required.', notice: null, submitted: false,
        prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    const user = await db.prepare(`SELECT id, email, name, active FROM users WHERE email = ?`).get(email);
    let issued = false;
    if (user && user.active) {
      const raw = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(raw);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      try {
        await db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)`)
          .run(user.id, tokenHash, expiresAt, req.ip || null);
        issued = true;
        const emailLib = require('../lib/email');
        await emailLib.sendPasswordResetEmail({
          toEmail: user.email, toName: user.name, token: raw, expiresAt
        });
      } catch (e) {
        console.error('[auth] password reset issue', e && e.message);
      }
    }
    await logAction(user ? user.id : null, null, 'password_reset_requested', 'user', user ? user.id : null,
      { email: email.slice(0, 254), link_issued: issued }, { ...auditCtx(req), touchActivity: false });
    res.render('auth/forgot', {
      error: null, notice: genericNotice, submitted: true,
      prefillEmail: email, csrfToken: res.locals.csrfToken
    });
  });

  async function lookupResetToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) return null;
    const tokenHash = hashToken(rawToken);
    const row = await db.prepare(`
      SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.name, u.active
        FROM password_reset_tokens t
        INNER JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`).get(tokenHash);
    if (!row) return null;
    if (row.used_at) return null;
    if (!row.active) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    return row;
  }

  app.get('/reset/:token', async (req, res) => {
    const row = await lookupResetToken(req.params.token);
    if (!row) {
      return res.status(400).render('auth/forgot', {
        error: 'That reset link is invalid or has expired. Request a new one below.',
        notice: null, submitted: false, prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    res.render('auth/reset', { token: req.params.token, error: null, csrfToken: res.locals.csrfToken });
  });

  app.post('/reset/:token', async (req, res) => {
    const row = await lookupResetToken(req.params.token);
    if (!row) {
      return res.status(400).render('auth/forgot', {
        error: 'That reset link is invalid or has expired. Request a new one below.',
        notice: null, submitted: false, prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    const pw  = String((req.body && req.body.password)  || '');
    const pw2 = String((req.body && req.body.password2) || '');
    const renderFail = (msg) => res.status(400).render('auth/reset', {
      token: req.params.token, error: msg, csrfToken: res.locals.csrfToken
    });
    if (pw.length < 8) return renderFail('Password must be at least 8 characters.');
    if (pw !== pw2)    return renderFail('Passwords do not match.');

    const hash = bcrypt.hashSync(pw, 12);
    let newEpoch = 0;
    const tx = db.transaction(async () => {
      await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.user_id);
      await db.prepare(`UPDATE password_reset_tokens SET used_at = utc_now_text() WHERE id = ?`).run(row.id);
      await db.prepare(`UPDATE password_reset_tokens SET used_at = utc_now_text() WHERE user_id = ? AND used_at IS NULL`).run(row.user_id);
      newEpoch = await deps.revokeUserSessions(row.user_id);
    });
    await tx();
    await clearBadLogin(row.email);
    await logAction(row.user_id, null, 'password_reset_completed', 'user', row.user_id,
      { email: row.email, sessions_revoked: true }, auditCtx(req));

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?reset_ok=1');
      req.session.userId = row.user_id;
      req.session.authEpoch = newEpoch;
      req.session.cookie.maxAge = SESSION_DEFAULT_MAX_AGE;
      res.redirect('/dashboard');
    });
  });

}

module.exports = { register, hashToken, INVITE_TTL_MS };
