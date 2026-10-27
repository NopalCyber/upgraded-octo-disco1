'use strict';

const rbac = require('../lib/rbac');
const email = require('../lib/email');
const jobs = require('../lib/jobs');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, logAction, isFirmOwner, getActiveFirmId } = deps;


  app.get('/admin/activity', requireAuth, async (req, res) => {
    if (!rbac.isManager(req.user.firm_role)) {
      return res.status(403).render('error', { user: req.user, message: 'Only Managers can view firm-wide activity.' });
    }
    const wsIds = (await db.prepare(`SELECT id FROM workspaces WHERE firm_id = ?`).all(req.user.firm_id)).map(r => r.id);
    let recentActivity = [];
    let pg = null;
    if (wsIds.length > 0) {
      const placeholders = wsIds.map(() => '?').join(',');
      const whereSql = `FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         INNER JOIN workspaces w ON w.id = a.workspace_id
         WHERE a.workspace_id IN (${placeholders})
           AND a.created_at >= utc_date_text(now() + ('-90 days')::interval)`;
      pg = await paginate(db, req, {
        count: `SELECT COUNT(*) c ${whereSql}`,
        rows: `SELECT a.created_at, a.action, a.entity_type, a.entity_id, a.workspace_id,
                u.name AS user_name, w.client_name ${whereSql} ORDER BY a.created_at DESC NULLS LAST`,
        params: wsIds, perPage: 100,
      });
      recentActivity = pg.rows;
    }
    res.render('admin_activity', { user: req.user, ws: null, active: 'admin-activity', recentActivity, pg, pagerHref: p => pageHref(req, p) });
  });

  app.get('/admin/email', requireAuth, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).render('error', { user: req.user, message: 'Only firm owners can manage email settings.' });
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const settings = await email.getFirmEmailSettings(firmId);
    const outbox = await db.prepare(`SELECT * FROM email_outbox WHERE firm_id=? ORDER BY created_at DESC NULLS LAST LIMIT 50`).all(firmId);
    const counts = {
      sent_7d: (await db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE firm_id=? AND status='sent' AND created_at >= utc_text(now() + ('-7 days')::interval)`).get(firmId)).c,
      failed_7d: (await db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE firm_id=? AND status='failed' AND created_at >= utc_text(now() + ('-7 days')::interval)`).get(firmId)).c
    };
    res.render('admin_email', {
      user: req.user,
      ws: null,
      settings,
      outbox,
      counts,
      provider: email.currentProvider(),
      providerConfigured: email.currentProvider() !== 'devnull',
      envFromDefault: process.env.EMAIL_FROM_DEFAULT || null,
      appBaseUrl: email.appBaseUrl()
    });
  });

  app.post('/admin/email/settings', requireAuth, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    await email.getFirmEmailSettings(firmId);
    const { from_name, from_email, reply_to, enabled } = req.body;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (from_email && !emailRe.test(from_email.trim())) {
      return res.status(400).render('error', { user: req.user, message: '"From email" doesn\'t look like a valid address.' });
    }
    if (reply_to && !emailRe.test(reply_to.trim())) {
      return res.status(400).render('error', { user: req.user, message: '"Reply-to" doesn\'t look like a valid address.' });
    }
    await db.prepare(`UPDATE firm_email_settings SET from_name=?, from_email=?, reply_to=?, enabled=?, updated_at=utc_now_text() WHERE firm_id=?`)
      .run(
        (from_name || '').trim() || null,
        (from_email || '').trim() || null,
        (reply_to || '').trim() || null,
        enabled === '1' || enabled === 'on' ? 1 : 0,
        firmId
      );
    await logAction(req.user.id, null, 'update_email_settings', 'firm', firmId, null);
    res.redirect(withToast('/admin/email', 'Email settings saved'));
  });

  app.post('/admin/email/test', requireAuth, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
    const firmId = await getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const to = (req.body.to || '').trim();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(to)) {
      return res.status(400).render('error', { user: req.user, message: 'Enter a valid email address to send the test to.' });
    }
    const result = await email.sendTestEmail(firmId, to);
    await logAction(req.user.id, null, 'send_test_email', 'firm', firmId,
      { to, ok: !!result.ok, provider: result.provider || null }, auditCtx(req));
    const msg = result.ok
      ? `Test email sent to ${to}` + (result.provider === 'devnull' ? ' (dev fallback - check data/email-dev-outbox.log)' : '')
      : `Send failed: ${result.error}`;
    res.redirect(withToast('/admin/email', msg, result.ok ? 'success' : 'error'));
  });

  app.post('/admin/jobs/run', requireAuth, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
    const out = await jobs.runAllJobs();
    await logAction(req.user.id, null, 'run_jobs', 'job', null, {
      jobs: Object.keys(out),
      failed: Object.keys(out).filter(name => typeof out[name] === 'string' && out[name].startsWith('error:')),
    }, auditCtx(req));
    res.json(out);
  });
}

module.exports = { register };
