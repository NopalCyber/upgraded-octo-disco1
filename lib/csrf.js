const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SKIP_PATHS = [
  /^\/favicon\.ico$/,
  /^\/api\/search/,
  /^\/auditor\//,
  /^\/approve\//,
  /^\/q\//,
  /^\/ack\//,
  /^\/supplier-ddq\//,
  /^\/integrations\/tprm\/monitoring\/[^/]+\/?$/,
];

const MULTIPART_PATHS = [
  /^\/workspaces\/[^/]+\/evidence(?:\/bulk|\/[^/]+\/supersede)?\/?$/,
  /^\/workspaces\/[^/]+\/(?:assets|risks)\/import\/preview\/?$/,
  /^\/workspaces\/[^/]+\/documents\/upload\/?$/,
  /^\/workspaces\/[^/]+\/client-portal\/(?:deliverables|requests)\/[^/]+\/evidence\/?$/,
  /^\/workspaces\/[^/]+\/engagement-plan\/deliverables\/[^/]+\/evidence\/?$/,
  /^\/workspaces\/[^/]+\/vendors\/[^/]+\/documents\/?$/,
  /^\/workspaces\/[^/]+\/tprm\/monitoring\/connectors\/[^/]+\/import\/?$/,
  /^\/workspaces\/[^/]+\/client-portal\/tprm\/[^/]+\/conditions\/[^/]+\/submit\/?$/,
];

function shouldSkip(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  return SKIP_PATHS.some(re => re.test(req.path));
}

function isMultipart(req) {
  return /^multipart\/form-data(?:\s*;|$)/i.test(String(req.headers && req.headers['content-type'] || ''));
}

function canDeferMultipart(req) {
  if (!isMultipart(req)) return false;
  if (SKIP_PATHS.some(re => re.test(req.path))) return true;
  return MULTIPART_PATHS.some(re => re.test(req.path));
}

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function csrfMiddleware(req, res, next) {
  const token = ensureToken(req);
  res.locals.csrfToken = token || '';

  if (SAFE_METHODS.has(req.method)) {
    const cleanUrl = urlWithoutCsrf(req);
    if (cleanUrl) return res.redirect(303, cleanUrl);
    return next();
  }

  if (shouldSkip(req)) return next();

  if (canDeferMultipart(req)) {
    req.csrfDeferred = true;
    return next();
  }

  if (!validRequestToken(req, token)) return rejectCsrf(req, res);
  next();
}

function csrfAfterMultipart(req, res, next, onReject) {
  if (SKIP_PATHS.some(re => re.test(req.path))) return next();
  const token = ensureToken(req);
  res.locals.csrfToken = token || '';
  if (!req.csrfDeferred || !validRequestToken(req, token)) {
    if (typeof onReject === 'function') onReject();
    return rejectCsrf(req, res);
  }
  next();
}

function validRequestToken(req, token = ensureToken(req)) {
  const provided = (req.body && req.body._csrf)
    || (req.headers && req.headers['x-csrf-token'])
    || (req.headers && req.headers['x-xsrf-token']);
  return !!token && !!provided && timingSafeEqualString(provided, token);
}

function rejectCsrf(req, res) {
  return res.status(403).render('error', {
    user: req.user || null,
    ws: req.workspace || null,
    message: 'CSRF token missing or invalid. Reload the page and try again.'
  });
}

function urlWithoutCsrf(req) {
  const original = String(req.originalUrl || req.url || req.path || '');
  const question = original.indexOf('?');
  if (question < 0) return null;
  const pathname = original.slice(0, question);
  const params = new URLSearchParams(original.slice(question + 1));
  if (!params.has('_csrf')) return null;
  params.delete('_csrf');
  const query = params.toString();
  return pathname + (query ? `?${query}` : '');
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = {
  csrfMiddleware,
  csrfAfterMultipart,
  ensureToken,
  validRequestToken,
  canDeferMultipart,
  urlWithoutCsrf,
};
