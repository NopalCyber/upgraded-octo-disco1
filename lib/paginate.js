'use strict';

async function paginate(db, req, { count, rows, params = [], perPage = 50 }) {
  const total = (await db.prepare(count).get(...params)).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  let page = parseInt((req.query && req.query.page) || '1', 10);
  if (!Number.isFinite(page)) page = 1;
  page = Math.min(Math.max(1, page), pages);
  const items = await db.prepare(`${rows} LIMIT ? OFFSET ?`).all(...params, perPage, (page - 1) * perPage);
  return { rows: items, page, pages, total, perPage };
}

function paginateArray(req, arr, perPage = 50) {
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  let page = parseInt((req.query && req.query.page) || '1', 10);
  if (!Number.isFinite(page)) page = 1;
  page = Math.min(Math.max(1, page), pages);
  return { rows: arr.slice((page - 1) * perPage, page * perPage), page, pages, total, perPage };
}

function pageHref(req, page) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k === 'page' || v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => q.append(k, x)); else q.append(k, v);
  }
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `?${s}` : '?';
}

module.exports = { paginate, paginateArray, pageHref };
