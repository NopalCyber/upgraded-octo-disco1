'use strict';

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsonForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function withToast(url, msg, kind) {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'toast=' + encodeURIComponent(msg)
    + (kind ? '&toastKind=' + encodeURIComponent(kind) : '')
    + fragment;
}

function redirectBack(req, res, toastMsg, toastKind) {
  let target = '/dashboard';
  const raw = req.get('Referer');
  if (raw) {
    try {
      const referer = new URL(raw, `${req.protocol}://${req.get('host')}`);
      if (referer.host === req.get('host')) target = referer.pathname + referer.search + referer.hash;
    } catch (_) { }
  }
  if (toastMsg) target = withToast(target, toastMsg, toastKind);
  return res.redirect(target);
}

function auditCtx(req) {
  return {
    ip: String(req.ip || req.socket?.remoteAddress || ''),
    userAgent: (req.headers['user-agent'] || '').slice(0, 255),
    requestId: req.id || null,
    entityScopeId: req.entityScopeId || null
  };
}

function parseFormArray(raw) {
  const arr = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = (v == null ? '' : String(v)).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function extractMentions(body) {
  const out = new Set();
  const re = /@([a-zA-Z0-9._-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

module.exports = { escapeHtml, jsonForScript, withToast, redirectBack, auditCtx, parseFormArray, extractMentions };
