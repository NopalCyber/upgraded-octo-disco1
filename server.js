process.umask(0o077);

try { process.loadEnvFile(); } catch (_) { }

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = require('docx');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const MarkdownIt = require('markdown-it');
const htmlToDocx = require('html-to-docx');
const mdRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });

function looksLikeMarkdown(s) {
  if (!s) return false;
  return !/<(p|h[1-6]|ul|ol|li|table|tr|td|th|div|span|strong|em|br|hr|img|a)\b/i.test(s);
}

const { workspaceTimeZone } = require('./lib/dates');
const uploadSecurity = require('./lib/upload-security');
const { db, init, logAction, verifyAuditChain, defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand } = require('./db');
const enc = require('./lib/encryption');
const rbac = require('./lib/rbac');
const { paginate, pageHref } = require('./lib/paginate');
const { escapeHtml, jsonForScript, withToast, redirectBack, auditCtx, parseFormArray } = require('./lib/http-helpers');
const { computeReadiness, computeRoadmap } = require('./lib/readiness');
const { buildWorkspaceStatus } = require('./lib/grc-truth');
const { computeNextStep, computeNeedsAttention } = require('./lib/next-steps');
const { seedFirmRiskLibraryIfEmpty } = require('./lib/firm-library');
const workers = require('./lib/workers');
const generateDocxBuffer = workers.generateDocx;
const jobs = require('./lib/jobs');
const fts = require('./lib/fts');
const reports = require('./lib/reports');
const csvImport = require('./lib/csv-import');
const auditPack = require('./lib/audit-pack');
const changesSince = require('./lib/changes-since');
const email = require('./lib/email');
const docApprovals = require('./lib/doc-approvals');
const evReads = require('./lib/evidence-reads');
const ctlReads = require('./lib/control-reads');
const ctlWrites = require('./lib/control-writes');
const docLinks = require('./lib/doc-links');
const evWrites = require('./lib/evidence-writes');
const tprmMonitoringRoutes = require('./routes/tprm-monitoring');
const { resolveRuntimeSecret } = require('./lib/runtime-secret-resolver');

(function hardenRuntimePermissions() {
  const dataDir = path.join(__dirname, 'data');
  const backupDir = path.resolve(process.env.ISMS_BACKUP_DIR || path.join(dataDir, 'backups'));
  const uploadsDir = path.join(__dirname, 'uploads');
  const localSnapshotDir = path.join(__dirname, '.demo-backup');
  const keyFile = path.resolve(process.env.ISMS_KEY_FILE || path.join(dataDir, 'master.key'));
  const directories = [dataDir, backupDir, uploadsDir, localSnapshotDir];
  const files = [path.join(__dirname, '.env'), keyFile];
  try {
    for (const dir of directories) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
    if (fs.existsSync(dataDir)) {
      for (const name of fs.readdirSync(dataDir)) {
        if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/i.test(name)) files.push(path.join(dataDir, name));
      }
    }
    for (const dir of [__dirname, localSnapshotDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/i.test(name)) files.push(path.join(dir, name));
      }
    }
    if (fs.existsSync(backupDir)) {
      for (const name of fs.readdirSync(backupDir)) {
        if (/\.(?:enc|json)$/.test(name) || name === '.backup.lock') files.push(path.join(backupDir, name));
      }
    }
    for (const file of new Set(files)) if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  } catch (error) {
    console.warn('WARNING: could not enforce private runtime file permissions:', error.message);
  }
})();

const bootTasks = [];
function onReady(task) { bootTasks.push(task); }
const ready = init().then(async () => {
  for (const task of bootTasks) await task();
});
ready.catch(() => {});

(function validateSecrets() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowInsecure = process.env.ALLOW_INSECURE_DEFAULTS === '1';

  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-in-production') {
    if (isProd && !allowInsecure) {
      console.error('FATAL: SESSION_SECRET must be set to a strong random value in production.');
      console.error('       Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
      process.exit(1);
    }
    console.warn('WARNING: SESSION_SECRET is not set or is insecure. Set SESSION_SECRET env var before deploying.');
  }

  if (!process.env.ISMS_MASTER_KEY) {
    const keyFile = process.env.ISMS_KEY_FILE || path.join(__dirname, 'data', 'master.key');
    const hasKeyFile = fs.existsSync(keyFile);
    if (isProd && !allowInsecure && !hasKeyFile) {
      console.error('FATAL: ISMS_MASTER_KEY env var is not set and no key file exists at ' + keyFile + '.');
      console.error('       Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      process.exit(1);
    }
    if (!hasKeyFile) {
      console.warn('WARNING: ISMS_MASTER_KEY is not set. A key file will be auto-generated at ' + keyFile + '. Set ISMS_MASTER_KEY env var before deploying.');
    }
  }
})();

enc.masterKey();
let stopNotificationDelivery = () => {};
if (process.env.ISMS_DISABLE_JOBS !== '1') {
  ready.then(() => {
    jobs.start(parseInt(process.env.ISMS_JOB_INTERVAL_MIN || '60', 10));
    stopNotificationDelivery = require('./lib/notification-delivery').start(db);
  }, () => {});
}

const app = express();

const ASYNC_ROUTE_HANDLER = Symbol('asyncRouteHandler');

function rememberRouteParams(req) {
  if (req.params && Object.keys(req.params).length) req.routeParams = { ...req.params };
}

function wrapAsyncRouteHandler(handler) {
  if (Array.isArray(handler)) return handler.map(wrapAsyncRouteHandler);
  if (typeof handler !== 'function' || handler.length === 4 || handler[ASYNC_ROUTE_HANDLER]) return handler;

  const wrapped = function asyncRouteBoundary(req, res, next) {
    rememberRouteParams(req);
    try {
      const result = handler.call(this, req, res, next);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(next);
      return result;
    } catch (error) {
      return next(error);
    }
  };
  Object.defineProperty(wrapped, ASYNC_ROUTE_HANDLER, { value: true });
  return wrapped;
}

function wrapAsyncMiddleware(handler) {
  if (Array.isArray(handler)) return handler.map(wrapAsyncMiddleware);
  if (typeof handler !== 'function' || typeof handler.handle === 'function') return handler;
  return wrapAsyncRouteHandler(handler);
}

function installAsyncRouteSafety(targetApp) {
  for (const method of ['all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
    const register = targetApp[method].bind(targetApp);
    targetApp[method] = function registerSafeRoute(...args) {
      if (method === 'get' && args.length === 1) return register(...args);
      if (args.length < 2) return register(...args);
      return register(args[0], ...args.slice(1).map(wrapAsyncRouteHandler));
    };
  }
  const use = targetApp.use.bind(targetApp);
  targetApp.use = function registerSafeMiddleware(...args) {
    return use(...args.map(wrapAsyncMiddleware));
  };
  return targetApp;
}

function requestIdMiddleware(req, res, next) {
  req.id = crypto.randomBytes(12).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

installAsyncRouteSafety(app);
app.use(function awaitDatabaseReady(_req, _res, next) {
  ready.then(() => next(), next);
});
app.use(requestIdMiddleware);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const { normalizeDisplayPunctuation } = require('./lib/typography');
const renderEjs = app.render.bind(app);
app.render = function renderWithoutEmDashes(view, options, callback) {
  return renderEjs(view, options, (err, html) => {
    callback(err, err ? html : normalizeDisplayPunctuation(html));
  });
};

if (process.env.NODE_ENV === 'production') {
  app.set('view cache', true);
  app.set('trust proxy', 1);
}

const helmet = require('helmet');
const compression = require('compression');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      ...(process.env.NODE_ENV === 'production' ? {} : { upgradeInsecureRequests: null }),
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production' ? undefined : false,
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()');
  next();
});
app.use(compression());

tprmMonitoringRoutes.registerPublic(app, { db, secretResolver: resolveRuntimeSecret });

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.locals.assetVersion = (() => {
  const h = crypto.createHash('md5');
  for (const f of ['public/app.css', 'public/tprm.css', 'public/auditor.css', 'public/public.css', 'public/page-loader.css', 'public/page-loader.js', 'public/site-enhancements.js', 'public/favicon.svg', 'public/fonts/inter.css']) {
    try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (_) {}
  }
  return h.digest('hex').slice(0, 8);
})();

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true,
  setHeaders(res) {
    if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use('/vendor/tinymce', express.static(path.join(__dirname, 'node_modules/tinymce')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/healthz', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await db.prepare('SELECT 1').get();
    res.json({
      ok: true,
      version: process.env.APP_VERSION || app.locals.assetVersion,
      asset_version: app.locals.assetVersion,
      uptime: Math.round(process.uptime())
    });
  } catch (_) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

app.get('/readyz', async (_req, res) => {
  const production = process.env.NODE_ENV === 'production';
  const isolatedPreflight = process.env.ISMS_PREFLIGHT === '1' &&
    process.env.ISMS_DISABLE_JOBS === '1' &&
    process.env.EMAIL_DELIVERY_DISABLED === '1' &&
    !process.env.RESEND_API_KEY && !process.env.BREVO_API_KEY &&
    !process.env.GMAIL_USER && !process.env.GMAIL_APP_PASSWORD;
  const checks = {
    database: true,
    session_secret: !!process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32,
    master_key: !!process.env.ISMS_MASTER_KEY || fs.existsSync(process.env.ISMS_KEY_FILE || path.join(__dirname, 'data', 'master.key')),
    public_https_url: !production || /^https:\/\//i.test(process.env.APP_BASE_URL || ''),
    transactional_email: !production || isolatedPreflight ||
      (process.env.EMAIL_DELIVERY_DISABLED !== '1' &&
        !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD))),
    preflight_isolation: process.env.ISMS_PREFLIGHT !== '1' || isolatedPreflight,
    malware_scanning: !production || ((process.env.UPLOAD_AV_MODE || 'required') === 'required' && require('./lib/upload-security').scannerAvailable())
  };
  try { await db.prepare('SELECT 1').get(); } catch (_) { checks.database = false; }
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({
    ok,
    version: process.env.APP_VERSION || app.locals.assetVersion,
    checks
  });
});

const { PgSessionStore } = require('./lib/pg/session-store');
app.use(session({ // nosemgrep: javascript.express.security.audit.express-cookie-settings.express-cookie-session-no-domain, javascript.express.security.audit.express-cookie-settings.express-cookie-session-no-expires, javascript.express.security.audit.express-cookie-settings.express-cookie-session-no-path, javascript.express.security.audit.express-cookie-settings.express-cookie-session-no-secure
  store: new PgSessionStore({ db }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production-' + crypto.randomBytes(8).toString('hex'),
  name: 'compliance_sphere.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use((_req, res, next) => {
  const origRender = res.render.bind(res);
  res.render = function (...args) {
    res.set('Cache-Control', 'no-store, must-revalidate');
    return origRender(...args);
  };
  next();
});

const { csrfMiddleware, csrfAfterMultipart } = require('./lib/csrf');
if (process.env.DISABLE_CSRF !== '1') {
  app.use(csrfMiddleware);
} else {
  app.use((_req, res, next) => { res.locals.csrfToken = ''; next(); });
}

const GENERAL_UPLOAD_EXTENSIONS = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','md','markdown','rtf',
  'odt','ods','png','jpg','jpeg','gif','webp','zip','json','xml'
]);
const rawUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, _file, cb) {
      const firmId = (req.workspace && req.workspace.firm_id) || (req.user && req.user.firm_id) || 0;
      const dir = path.join(__dirname, 'uploads', `firm_${firmId}`);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      } catch (_) {}
      cb(null, dir);
    },
    filename: function (_req, file, cb) {
      const rand = require('crypto').randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${rand}-${file.originalname.replace(/[^\w.\-]/g, '_')}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function removeStagedFiles(files) {
  (files || []).forEach(file => {
    try { if (file && file.path) fs.unlinkSync(file.path); } catch (_) {}
  });
}

function stagedFiles(req) {
  if (!req) return [];
  const many = Array.isArray(req.files)
    ? req.files
    : (req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : []);
  return [req.file, ...many].filter(Boolean);
}

function inspectedUpload(middleware, allowedExtensions = GENERAL_UPLOAD_EXTENSIONS) {
  return function inspectMultipart(req, res, next) {
    middleware(req, res, err => {
      if (err) return next(err);
      const files = stagedFiles(req);
      for (const file of files) {
        const result = uploadSecurity.validateUpload(file, allowedExtensions);
        if (!result.ok) {
          removeStagedFiles(files);
          req.file = undefined;
          req.files = Array.isArray(req.files) ? [] : {};
          return res.status(400).render('error', {
            user: req.user || null, ws: req.workspace || null,
            message: result.message || 'The uploaded file did not pass security inspection.'
          });
        }
      }
      if (process.env.DISABLE_CSRF === '1') return next();
      csrfAfterMultipart(req, res, next, () => removeStagedFiles(files));
    });
  };
}

const upload = {
  single: field => inspectedUpload(rawUpload.single(field)),
  array: (field, maxCount) => inspectedUpload(rawUpload.array(field, maxCount)),
  fields: fields => inspectedUpload(rawUpload.fields(fields)),
  any: () => inspectedUpload(rawUpload.any())
};

const rawCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});
const CSV_UPLOAD_EXTENSIONS = new Set(['csv']);
const csvUpload = {
  single: field => inspectedUpload(rawCsvUpload.single(field),CSV_UPLOAD_EXTENSIONS)
};

const QFILE_ALLOWED_EXT = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','rtf','odt','ods',
  'png','jpg','jpeg','gif','webp','zip','json','xml'
]);
const questionnaireUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, _file, cb) {
      const firmId = (req.workspace && req.workspace.firm_id) || (req.user && req.user.firm_id) || 0;
      const dir = path.join(__dirname, 'uploads', `firm_${firmId}`);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      } catch (_) {}
      cb(null, dir);
    },
    filename: function (_req, file, cb) {
      const rand = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${rand}-${file.originalname.replace(/[^\w.\-]/g, '_')}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
  fileFilter: function (req, file, cb) {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (QFILE_ALLOWED_EXT.has(ext)) return cb(null, true);
    if (!req._rejectedUploads) req._rejectedUploads = [];
    req._rejectedUploads.push(file.originalname);
    cb(null, false);
  }
});

function qUploadAny(req, res, next) {
  questionnaireUpload.any()(req, res, (err) => {
    if (err) req._uploadError = err;
    if (!err && Array.isArray(req.files)) {
      for (const file of req.files) {
        const result = uploadSecurity.validateUpload(file, QFILE_ALLOWED_EXT);
        if (!result.ok) {
          removeStagedFiles(req.files);
          req.files = [];
          req._uploadError = { code: 'UPLOAD_INSPECTION', message: result.message };
          break;
        }
      }
    }
    if (process.env.DISABLE_CSRF === '1') return next();
    csrfAfterMultipart(req, res, next, () => removeStagedFiles(stagedFiles(req)));
  });
}

async function resolveQuestionnaireFirm(req, res, next) {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const q = await db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description,
      w.firm_id AS ws_firm_id, COALESCE(w.brand_display_name, w.client_name) AS requester_name,
      et.id AS invitation_id, et.expires_at AS token_expires_at, et.completed_at AS token_completed_at
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    LEFT JOIN workspaces w ON w.id=q.workspace_id
    INNER JOIN external_assessment_tokens et ON et.questionnaire_id=q.id
    WHERE et.token_hash=? AND et.revoked_at IS NULL`).get(tokenHash);
  const blank = { sections: {}, respMap: {}, token: req.params.token };
  if (!q) return res.status(404).render('external_questionnaire', { q: null, state: 'invalid', ...blank });
  if (q.external_completed_at || q.token_completed_at) return res.render('external_questionnaire', { q, state: 'done', ...blank });
  if (q.token_expires_at && new Date(q.token_expires_at) < new Date())
    return res.status(410).render('external_questionnaire', { q, state: 'expired', ...blank });
  req._questionnaire = q;
  req.workspace = { id: q.workspace_id, firm_id: q.ws_firm_id || 0 };
  next();
}

async function persistQuestionnaireFiles({ files, questionnaireId, workspaceId, source, uploadedBy }) {
  if (!Array.isArray(files) || !files.length) return 0;
  const ins = db.prepare(`INSERT INTO questionnaire_attachments
    (questionnaire_id, question_id, workspace_id, filename, stored_path, mime, size_bytes, sha256, source, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let saved = 0;
  for (const f of files) {
    try {
      const inspection = uploadSecurity.validateUpload(f, QFILE_ALLOWED_EXT);
      if (!inspection.ok) {
        try { fs.unlinkSync(f.path); } catch (_) {}
        continue;
      }
      const m = /^file_(\d+)$/.exec(f.fieldname || '');
      const questionId = m ? parseInt(m[1], 10) : null;
      let sha = null;
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'); } catch (_) {}
      await ins.run(questionnaireId, questionId, workspaceId, f.originalname, f.filename,
        f.mimetype || null, f.size || null, sha, source || 'vendor', uploadedBy || null);
      saved++;
    } catch (e) {
      console.error('[questionnaire attach] failed to persist', f && f.originalname, e && e.message);
      try { if (f && f.path) fs.unlinkSync(f.path); } catch (_) {}
    }
  }
  return saved;
}

function resolveUploadPath(storedPath, firmId) {
  if (!storedPath) return null;
  if (firmId) {
    const partitioned = path.join(__dirname, 'uploads', `firm_${firmId}`, storedPath);
    if (fs.existsSync(partitioned)) return partitioned;
  }
  const legacy = path.join(__dirname, 'uploads', storedPath);
  return fs.existsSync(legacy) ? legacy : (firmId ? path.join(__dirname, 'uploads', `firm_${firmId}`, storedPath) : legacy);
}

async function getActiveFirmId(req) {
  const user = req.user || (await currentUser(req));
  if (!user) {
    const first = await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    return first ? first.id : null;
  }
  if (user.user_type === 'firm') return user.firm_id;
  const sessId = parseInt((req.session && req.session.active_firm_id) || 0, 10);
  if (sessId) {
    const hasMembership = await db.prepare(
      `SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND w.firm_id = ?`
    ).get(user.id, sessId);
    if (hasMembership) return sessId;
  }
  const fallback = await db.prepare(
    `SELECT w.firm_id FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? LIMIT 1`
  ).get(user.id);
  return fallback ? fallback.firm_id : null;
}

async function currentUser(req) {
  if (req.session && req.session.userId) {
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!u || !u.active) {
      delete req.session.userId;
      delete req.session.authEpoch;
      return null;
    }
    const epoch = Number(u.auth_epoch || 0);
    const claimed = Number(req.session.authEpoch || 0);
    if (claimed !== epoch) {
      delete req.session.userId;
      delete req.session.authEpoch;
      return null;
    }
    return u;
  }
  return null;
}

async function revokeUserSessions(userId) {
  await db.prepare('UPDATE users SET auth_epoch = COALESCE(auth_epoch,0) + 1 WHERE id = ?').run(userId);
  await db.prepare(`DELETE FROM sessions WHERE (sess::jsonb ->> 'userId') ~ '^[0-9]+$'
    AND (sess::jsonb ->> 'userId')::bigint = ?`).run(Number(userId));
  return (await db.prepare('SELECT auth_epoch FROM users WHERE id = ?').get(userId))?.auth_epoch ?? 0;
}

async function listAllFirms() {
  return await db.prepare(`SELECT f.id, f.name, f.created_at,
    (SELECT COUNT(*) FROM workspaces w WHERE w.firm_id=f.id) AS workspace_count
    FROM firms f ORDER BY f.id`).all();
}

async function listUserFirms(user) {
  if (!user) return [];
  if (user.user_type === 'firm') {
    return await db.prepare(`SELECT f.id, f.name, f.created_at,
      (SELECT COUNT(*) FROM workspaces w WHERE w.firm_id=f.id) AS workspace_count
      FROM firms f WHERE f.id = ?`).all(user.firm_id);
  }
  return await db.prepare(`SELECT DISTINCT f.id, f.name, f.created_at,
    (SELECT COUNT(*) FROM workspaces w2 WHERE w2.firm_id=f.id) AS workspace_count
    FROM firms f
    INNER JOIN workspaces w ON w.firm_id = f.id
    INNER JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? ORDER BY f.id`).all(user.id);
}

const PUBLIC_AUTH_PATHS = [
  /^\/login(\?|$|\/)/,
  /^\/logout(\?|$)/,
  /^\/forgot(\?|$|\/)/,
  /^\/reset\//,
  /^\/invite\//,
];

async function requireAuth(req, res, next) {
  req.user = await currentUser(req);
  if (!req.user) {
    const wantsHtml = (req.accepts(['html', 'json']) === 'html');
    if (wantsHtml && req.method === 'GET') {
      const nxt = encodeURIComponent(req.originalUrl || '/dashboard');
      return res.redirect(`/login?next=${nxt}`);
    }
    return res.status(401).json({ error: 'auth_required' });
  }
  res.locals.experienceEnabled = await require('./lib/experience-flags').enabledFor(db,{actor:req.user});
  next();
}

async function getWorkspace(workspaceId, user) {
  const ws = await db.prepare(`SELECT w.*,f.timezone AS firm_timezone
    FROM workspaces w JOIN firms f ON f.id=w.firm_id WHERE w.id=?`).get(workspaceId);
  if (!ws) return null;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    const fr = rbac.normalizeRole(user.firm_role) || 'consultant';
    if (rbac.isManager(fr) || rbac.rolePermissions(fr).includes('firm.cross_view')) {
      return { ...ws, role: 'consultant', _userRole: fr };
    }
    const member = await db.prepare(`SELECT role FROM workspace_members
      WHERE workspace_id=? AND user_id=?`).get(ws.id, user.id);
    if (!member) return null;
    const memberRole = rbac.normalizeRole(member.role);
    const effectiveRole = rbac.FIRM_ROLES.includes(memberRole) ? memberRole : fr;
    return { ...ws, role: 'consultant', _userRole: effectiveRole };
  }
  const m = await db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id);
  if (!m) return null;
  return { ...ws, role: m.role, _userRole: m.role };
}

const { ALLOWED_FRAMEWORKS, FRAMEWORK_LIST, parseWorkspaceFrameworks } = require('./lib/frameworks');

async function requireWorkspace(req, res, next) {
  const ws = await getWorkspace(req.params.wsId, req.user);
  if (!ws) return res.status(403).render('error', { user: req.user, message: 'This workspace doesn\'t exist, or it belongs to a different firm. If you recently switched tenants, the old workspace URL won\'t resolve. Use the Clients dashboard to pick a workspace in the active firm.' });
  ws.frameworks = parseWorkspaceFrameworks(ws.frameworks);
  ws.effective_timezone = workspaceTimeZone(ws);
  try {
    ws.tprm_module = (await db.prepare(`SELECT * FROM tprm_modules
      WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(ws.id)) || null;
  } catch (_) {
    ws.tprm_module = null;
  }
  ws.tprm_enabled = ws.tprm_module ? 1 : 0;
  ws.tprm_active = ws.tprm_module && ws.tprm_module.status === 'active' ? 1 : 0;
  ws.tprm_closed = ws.tprm_module && ws.tprm_module.status === 'closed' ? 1 : 0;
  req.workspace = ws;
  const isScopedClient = req.user.user_type === 'client';
  const portalPrefix = `/workspaces/${ws.id}/client-portal`;
  const policyDecisionPath = new RegExp(`^/workspaces/${ws.id}/documents/\\d+/decide$`);
  if (isScopedClient && req.method === 'GET' && req.path === `/workspaces/${ws.id}`) {
    return res.redirect(portalPrefix);
  }
  const allowedClientPath = req.path === portalPrefix || req.path.startsWith(portalPrefix + '/') ||
    (req.method === 'POST' && policyDecisionPath.test(req.path));
  if (isScopedClient && !allowedClientPath) {
    await logAction(req.user.id, ws.id, 'scoped_route_denied', 'route', req.path,
      { method: req.method, reason: 'contributor_portal_boundary' }, auditCtx(req));
    return res.status(403).render('error', {
      user: req.user,
      ws,
      message: 'Your account is limited to the client portal. Open your engagement to view requests, approvals, reports, policies and evidence shared with you.'
    });
  }
  if (req.session) req.session.last_ws_id = ws.id;
  res.locals.entitySelectorWs = ws;
  res.locals.tprmModule = ws.tprm_module;
  res.locals.workspaceEntities = [];
  res.locals.userPerms = await permissionsFor(req.user, ws);
  res.locals.experienceEnabled = await require('./lib/experience-flags').enabledFor(db,{actor:req.user,workspace:ws});
  try {
    res.locals.unreadNotifications = await require('./lib/notification-delivery').countUnread(db,{workspaceId:ws.id,actor:req.user});
  } catch (_) { res.locals.unreadNotifications = 0; }
  try {
    const T = ctlReads.tables(db, ws.id);
    const a = (await db.prepare(`SELECT COUNT(*) c FROM ${T.cs} WHERE workspace_id=? AND review_status IN ('requested','needs_changes')`).get(ws.id)).c; // nosemgrep: javascript.express.security.injection.tainted-sql-string.tainted-sql-string
    res.locals.openReviewCount = res.locals.experienceEnabled
      ? (await require('./lib/work-projection').listWork({db,workspaces:[ws],actor:req.user,scope:'team',filters:{type:'review'},limit:1})).counts.total
      : a;
  } catch (_) { res.locals.openReviewCount = 0; }
  next();
}

function isFirmUser(user) { return user.user_type === 'firm'; }
function isFirmOwner(user) { return user.user_type === 'firm' && rbac.isManager(user.firm_role); }

async function listWorkspaces(user) {
  if (user.user_type === 'firm') {
    const role = rbac.normalizeRole(user.firm_role) || 'consultant';
    if (!rbac.isManager(role) && !rbac.rolePermissions(role).includes('firm.cross_view')) {
      return await db.prepare(`SELECT w.*,m.role AS my_role,
          (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name
          FROM workspaces w
          INNER JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=?
          WHERE w.firm_id=? ORDER BY w.created_at DESC`).all(user.id,user.firm_id);
    }
    return await db.prepare(`SELECT w.*,
        (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name
        FROM workspaces w WHERE w.firm_id = ? ORDER BY w.created_at DESC`).all(user.firm_id);
  }
  return await db.prepare(`SELECT w.*,
      (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name,
      m.role AS my_role
      FROM workspaces w
      INNER JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? ORDER BY w.created_at DESC`).all(user.id);
}

async function workspaceProgress(wsId) {
  const total = (await db.prepare('SELECT COUNT(*) AS c FROM iso_items').get()).c;
  const assessed = (await db.prepare(`SELECT COUNT(*) AS c FROM ${ctlReads.tables(db, wsId).cs}
    WHERE workspace_id = ? AND status != 'Not Assessed'`).get(wsId)).c;
  return { total, assessed, percent: total ? Math.round((assessed / total) * 100) : 0 };
}

async function computeClientStage(ws) {
  try {
    return (await buildWorkspaceStatus(db, ws)).lifecycle;
  } catch (_) {
    return { key: 'new', label: 'New engagement' };
  }
}

async function getOrCreateState(wsId, isoId) {
  const reqId = await ctlWrites.requirementId(db, 'iso27001', isoId);
  if (reqId) {
    await db.prepare('INSERT INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING')
      .run(wsId, reqId);
  }
  return await db.prepare('SELECT * FROM v_control_states WHERE workspace_id = ? AND iso_item_id = ?').get(wsId, isoId);
}




app.locals.escapeHtml = escapeHtml;
app.locals.jsonForScript = jsonForScript;
app.locals.tierIcon = (tier, size = 12) => {
  const open = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-0.125em;flex-shrink:0;">`;
  if (tier === 'mandatory') return open + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  if (tier === 'expected') return open + '<polygon points="12 2 22 12 12 22 2 12"/></svg>';
  return open + '<circle cx="12" cy="12" r="4"/></svg>';
};
app.locals.rbac = rbac;
app.locals.frameworkList = FRAMEWORK_LIST;

async function permissionsFor(user, ws) {
  if (!user || !ws) return new Set();
  if (user.user_type === 'firm' && rbac.isManager(user.firm_role) && user.firm_id === ws.firm_id) {
    return new Set(Object.keys(rbac.PERMISSIONS).concat(['*']));
  }
  let role;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    role = ws._userRole || 'consultant';
  } else {
    const m = await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(ws.id, user.id);
    role = m?.role || 'contributor';
  }
  const overrides = await activeOverridesFor(db, ws.id, user.id);
  return rbac.effectivePermissions(role, overrides);
}

async function activeOverridesFor(connection, workspaceId, userId) {
  return await rbac.activeOverrides(connection, workspaceId, userId);
}

function requirePermission(perm) {
  return async (req, res, next) => {
    if (!req.workspace) return res.status(500).render('error', { user: req.user, message: 'No workspace context.' });
    const perms = await permissionsFor(req.user, req.workspace);
    if (!rbac.hasPermission(perms, perm)) {
      await logAction(req.user.id, req.workspace.id, 'permission_denied', 'permission', perm,
                { route: req.method + ' ' + req.path }, auditCtx(req));
      return res.status(403).render('error', { user: req.user, message: `You don't have permission to do this (missing: ${perm}). A workspace owner can grant individual permissions in workspace settings → Access & permissions, or assign you a role that includes it.` });
    }
    req.userPerms = perms;
    next();
  };
}

function diffObjects(before, after) {
  const b = {}, a = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const bv = before ? before[k] : undefined;
    const av = after ? after[k] : undefined;
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[k] = bv === undefined ? null : bv;
      a[k] = av === undefined ? null : av;
    }
  }
  return { before: b, after: a };
}

function activeEntityFilter(_req, _sqlAlias) { return { sql: '', params: [] }; }
function requireEntity(_req) { return null; }
function listWorkspaceEntities(_wsId) { return []; }
app.locals.listWorkspaceEntities = listWorkspaceEntities;

app.use(async (req, res, next) => {
  res.locals.activeEntity = null;
  res.locals.entitySelectorWs = null;
  res.locals.unreadNotifications = 0;
  try {
    const firmId = await getActiveFirmId(req);
    res.locals.activeFirm = firmId ? await db.prepare('SELECT id, name FROM firms WHERE id=?').get(firmId) : null;
    const u = req.user || (await currentUser(req));
    res.locals.allFirms = await listUserFirms(u);
  } catch (_) {
    res.locals.activeFirm = null;
    res.locals.allFirms = [];
  }
  res.locals.lastWs = null;
  res.locals.firmWorkspaces = [];
  try {
    const u = await currentUser(req);
    if (u) {
      const firmId = await getActiveFirmId(req);
      if (firmId) {
        res.locals.firmWorkspaces = await listWorkspaces(u);
      }
      const lastId = req.session && req.session.last_ws_id;
      if (lastId) {
        const ws = await getWorkspace(lastId, u);
        if (ws) res.locals.lastWs = ws;
      }
    }
  } catch (_) {}
  next();
});

app.use((req, res, next) => {
  if (req.session && req.session.userId !== undefined) { }
  next();
});

const authRoutes = require('./routes/auth');
authRoutes.register(app, { db, requireAuth, logAction, revokeUserSessions });

require('./routes/tenants').register(app, {
  db, bcrypt,
  requireAuth,
  isFirmUser,
  getActiveFirmId,
  listUserFirms,
  listWorkspaces,
  withToast,
  logAction,
  projectRoot: __dirname,
});

require('./routes/auditor').register(app, {
  db, enc, mdRenderer, logAction,
  getActiveMethodology, methodologyBand,
  auditPack,
  resolveUploadPath,
  fs, path,
  escapeHtml,
  requireAuth, requireWorkspace, requirePermission
});

require('./routes/dashboard').register(app, { db, requireAuth, logAction, isFirmUser, isFirmOwner,
  getActiveFirmId, listWorkspaces, workspaceProgress, computeClientStage });

require('./routes/admin').register(app, { db, requireAuth, logAction, isFirmOwner, getActiveFirmId });

require('./routes/glossary').register(app, { db, requireAuth, isFirmUser, listWorkspaces, onReady });


require('./routes/workspaces').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, isFirmUser, computeReadiness, workspaceProgress, computeNextStep,
  computeRoadmap, computeClientStage, computeNeedsAttention, resolveUploadPath });

require('./routes/form-drafts').register(app, { db, requireAuth, requireWorkspace });
const controlsRoutes = require('./routes/controls');
  controlsRoutes.register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState, resolveUploadPath });
require('./routes/gap-fieldwork').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
});

require('./routes/workspace-ops').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, csvUpload, activeEntityFilter, getOrCreateState, isFirmUser });

require('./routes/evidence').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath });

require('./routes/risks').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, activeEntityFilter, getActiveMethodology, methodologyBand, seedFirmRiskLibraryIfEmpty, csvUpload });

require('./routes/soa').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState });

require('./routes/exports').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, resolveUploadPath });

require('./routes/assurance').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction });

require('./routes/documents').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, isFirmUser, diffObjects });

require('./routes/client-portal').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, permissionsFor });

require('./routes/governance').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, workspaceProgress });

require('./routes/workspace-ops-b').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState, getActiveMethodology,
  defaultMethodology, methodologyBand, ensureWorkspaceMethodology, activeEntityFilter, computeNeedsAttention,
  getWorkspace, listWorkspaces, permissionsFor });

require('./routes/readiness').register(app, { db, requireAuth, requireWorkspace });

require('./routes/registers').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, activeEntityFilter, qUploadAny, persistQuestionnaireFiles });
require('./routes/supplier-programme').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction, qUploadAny,
  resolveUploadPath, questionnaireFileExtensions: QFILE_ALLOWED_EXT
});
require('./routes/tprm').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
});
require('./routes/tprm-relationships').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
});
require('./routes/tprm-governance').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction,
  upload, resolveUploadPath
});
tprmMonitoringRoutes.register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction,
  csvUpload, secretResolver: resolveRuntimeSecret
});

require('./routes/performance').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, upload });

require('./routes/notifications').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction });


require('./routes/engagement-ops').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState, getActiveMethodology,
  methodologyBand, activeEntityFilter, resolveUploadPath, upload, csvUpload, qUploadAny,
  resolveQuestionnaireFirm, computeClientStage, permissionsFor, persistQuestionnaireFiles, verifyAuditChain, listWorkspaces, workspaceProgress });

require('./routes/engagement').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, withToast, logAction, auditCtx,
  upload, resolveUploadPath,
});

app.use(async (req, res) => {
  res.status(404).render('error', { user: await currentUser(req), message: 'Page not found.' });
});

function isNonNumericIdLookup(err, req) {
  if (!err || err.code !== '22P02') return false;
  return Object.values(req.routeParams || req.params || {})
    .some(value => typeof value === 'string' && !/^\d+$/.test(value));
}

async function opaqueErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const requestId = req.id || crypto.randomBytes(12).toString('hex');
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (isNonNumericIdLookup(err, req)) {
    if (req.accepts && req.accepts(['html', 'json']) === 'json') {
      return res.status(404).json({ error: 'not_found', request_id: requestId });
    }
    let user = null;
    try { user = await currentUser(req); } catch (_) { }
    return res.status(404).render('error', { user, message: 'Page not found.' });
  }
  console.error('[request_error]', {
    request_id: requestId,
    method: req.method,
    path: req.path || String(req.url || '').split('?')[0],
    error: err && err.stack ? err.stack : String(err)
  });

  if (req.accepts && req.accepts(['html', 'json']) === 'json') {
    return res.status(500).json({ error: 'internal_server_error', request_id: requestId });
  }

  let user = null;
  try { user = await currentUser(req); } catch (_) { }
  return res.status(500).render('error', {
    user,
    message: `An unexpected error occurred. Reference: ${requestId}.`
  });
}

app.use(opaqueErrorHandler);

function createGracefulShutdown({
  server,
  database = db,
  jobsModule = jobs,
  workersModule = workers,
  timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000),
  logger = console,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 15000;
  let shutdownPromise = null;

  function log(level, message, details) {
    const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
    if (fn) fn(message, details || '');
  }

  function waitFor(operation, remainingMs) {
    if (remainingMs <= 0) return Promise.resolve({ status: 'timeout' });
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimer(() => {
        if (settled) return;
        settled = true;
        resolve({ status: 'timeout' });
      }, remainingMs);
      Promise.resolve(operation).then(
        value => {
          if (settled) return;
          settled = true;
          clearTimer(timeout);
          resolve({ status: 'done', value });
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimer(timeout);
          resolve({ status: 'error', error });
        }
      );
    });
  }

  function stopListener() {
    if (!server || typeof server.close !== 'function' || server.listening === false) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      try {
        server.close(error => error ? reject(error) : resolve());
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch (error) {
        reject(error);
      }
    });
  }

  return function shutdown(reason = 'shutdown') {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const startedAt = now();
      const deadline = startedAt + boundedTimeoutMs;
      let timedOut = false;
      const errors = [];
      log('info', '[shutdown] draining runtime', { reason, timeout_ms: boundedTimeoutMs });

      try {
        if (jobsModule && typeof jobsModule.stop === 'function') jobsModule.stop();
        stopNotificationDelivery();
      } catch (error) {
        errors.push(error);
        log('error', '[shutdown] could not stop scheduled jobs', error);
      }

      const listenerResult = await waitFor(stopListener(), deadline - now());
      if (listenerResult.status === 'timeout') {
        timedOut = true;
        log('error', '[shutdown] HTTP drain timed out; closing active connections');
        try {
          if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch (error) {
          errors.push(error);
        }
      } else if (listenerResult.status === 'error') {
        errors.push(listenerResult.error);
        log('error', '[shutdown] HTTP listener close failed', listenerResult.error);
      }

      const workerBudget = Math.max(0, deadline - now());
      let workerResult = { status: 'done' };
      if (workersModule && typeof workersModule.close === 'function') {
        let workerClose;
        try { workerClose = workersModule.close({ timeoutMs: workerBudget }); }
        catch (error) { workerClose = Promise.reject(error); }
        workerResult = await waitFor(workerClose, workerBudget);
      }
      if (workerResult.status === 'timeout') {
        timedOut = true;
        log('error', '[shutdown] worker drain timed out; terminating worker pool');
        try {
          if (workersModule && typeof workersModule.close === 'function') {
            Promise.resolve(workersModule.close({ timeoutMs: 0, force: true })).catch(() => {});
          }
        } catch (_) { }
      } else if (workerResult.status === 'error') {
        errors.push(workerResult.error);
        log('error', '[shutdown] worker pool close failed', workerResult.error);
      }

      if (database && typeof database.close === 'function') {
        try {
          await database.close();
        } catch (error) {
          errors.push(error);
          log('error', '[shutdown] database close failed', error);
        }
      }

      const result = { reason, timedOut, errors, elapsedMs: now() - startedAt };
      log(timedOut || errors.length ? 'error' : 'info', '[shutdown] runtime stopped', {
        reason,
        timed_out: timedOut,
        errors: errors.length,
        elapsed_ms: result.elapsedMs
      });
      return result;
    })();
    return shutdownPromise;
  };
}

function installShutdownSignals(shutdown, {
  processRef = process,
  exit = code => process.exit(code),
  logger = console
} = {}) {
  let handling = false;
  const handlers = {};
  for (const signal of ['SIGTERM', 'SIGINT']) {
    handlers[signal] = () => {
      if (handling) return exit(1);
      handling = true;
      Promise.resolve(shutdown(signal)).then(
        result => exit(result && (result.timedOut || result.errors?.length) ? 1 : 0),
        error => {
          if (logger && typeof logger.error === 'function') logger.error('[shutdown] fatal failure', error);
          exit(1);
        }
      );
    };
    processRef.once(signal, handlers[signal]);
  }
  return () => {
    for (const signal of Object.keys(handlers)) processRef.off(signal, handlers[signal]);
  };
}

function installUnhandledRejectionShutdown(shutdown, {
  processRef = process,
  exit = code => process.exit(code),
  logger = console,
} = {}) {
  const handlerKey = Symbol.for('complianceSphere.unhandledRejectionHandler');
  const previousHandler = processRef[handlerKey];
  if (typeof previousHandler === 'function') {
    processRef.off('unhandledRejection', previousHandler);
  }

  let handling = false;
  const handler = reason => {
    if (handling) return;
    handling = true;
    if (logger && typeof logger.error === 'function') {
      logger.error('[unhandledRejection] draining runtime before fatal exit',
        reason && reason.stack ? reason.stack : reason);
    }
    let draining;
    try { draining = shutdown('unhandledRejection'); }
    catch (error) {
      if (logger && typeof logger.error === 'function') logger.error('[shutdown] fatal failure', error);
      exit(1);
      return;
    }
    Promise.resolve(draining).then(
      () => exit(1),
      error => {
        if (logger && typeof logger.error === 'function') logger.error('[shutdown] fatal failure', error);
        exit(1);
      },
    );
  };
  processRef.on('unhandledRejection', handler);
  processRef[handlerKey] = handler;
  return () => {
    processRef.off('unhandledRejection', handler);
    if (processRef[handlerKey] === handler) delete processRef[handlerKey];
  };
}

module.exports = { app, db, ready, computeReadiness, getOrCreateState,
  activeOverridesFor,
  installAsyncRouteSafety,
  requestIdMiddleware,
  opaqueErrorHandler,
  createGracefulShutdown,
  installShutdownSignals,
  installUnhandledRejectionShutdown };

if (require.main === module) {
  ready.then(() => {
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
      console.log(`\nCompliance Sphere running at http://localhost:${PORT}`);
      console.log(`Need access? Visit /register for the controlled evaluation path.\n`);
    });
    const shutdown = createGracefulShutdown({ server });
    installShutdownSignals(shutdown);
    installUnhandledRejectionShutdown(shutdown);
  }, (error) => {
    console.error('FATAL: database initialisation failed; not serving.', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
