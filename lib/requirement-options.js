'use strict';

const frameworks = require('./frameworks');

function enabledCodes(workspace) {
  const codes = frameworks.parseWorkspaceFrameworks(workspace && workspace.frameworks);
  return codes.length ? codes : ['iso27001'];
}

const TYPE_FILTERS = {
  control: ['control'],
  clause: ['clause'],
};

async function list(db, workspace, { types = null } = {}) {
  const codes = enabledCodes(workspace);
  const allowed = types ? [].concat(...[].concat(types).map((t) => TYPE_FILTERS[t] || [t])) : ['clause', 'control'];
  const rows = await db.prepare(`SELECT rq.ref AS id, rq.title, rq.req_type AS type, f.code AS framework
    FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
    WHERE f.code IN (${codes.map(() => '?').join(',')}) AND rq.req_type IN (${allowed.map(() => '?').join(',')})
    ORDER BY rq.sort_order NULLS FIRST, rq.id`).all(...codes, ...allowed);
  const order = (code) => (frameworks.frameworkMeta(code) || { order: 99 }).order;
  return rows
    .map((r) => ({ ...r, code: codeOf(r), frameworkLabel: label(r.framework), label: `${label(r.framework)} ${r.title}` }))
    .sort((a, b) => order(a.framework) - order(b.framework));
}

function codeOf(row) {
  const m = /^((?:A\.)?\d+(?:\.\d+)*)\s/.exec(row.title || '');
  return m ? m[1] : row.id;
}

function displayTitle(workspace, framework, title) {
  if (!title) return title;
  return enabledCodes(workspace).length > 1 && framework ? `${label(framework)} ${title}` : title;
}

function nameRows(workspace, rows) {
  for (const r of rows) r.iso_title = displayTitle(workspace, r.iso_framework, r.iso_title);
  return rows;
}

async function grouped(db, workspace, opts) {
  const groups = [];
  for (const item of await list(db, workspace, opts)) {
    let g = groups.find((x) => x.framework === item.framework);
    if (!g) { g = { framework: item.framework, label: item.frameworkLabel, items: [] }; groups.push(g); }
    g.items.push(item);
  }
  return groups;
}

function label(code) {
  const meta = frameworks.frameworkMeta(code);
  return meta ? meta.shortLabel : code;
}

async function belongs(db, workspace, id) {
  if (!id) return false;
  const codes = enabledCodes(workspace);
  const row = await db.prepare(`SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
    WHERE rq.ref = ? AND f.code IN (${codes.map(() => '?').join(',')})`).get(id, ...codes);
  return !!row;
}

function joinSql(column, alias = 'rq') {
  return `LEFT JOIN requirements ${alias} ON ${alias}.ref = ${column}
    LEFT JOIN frameworks ${alias}_fw ON ${alias}_fw.id = ${alias}.framework_id`;
}

async function frameworkOf(db, id) {
  if (!id) return null;
  const row = await db.prepare(`SELECT f.code FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id WHERE rq.ref = ?`).get(id);
  return row ? row.code : null;
}

module.exports = { enabledCodes, list, grouped, belongs, joinSql, frameworkOf, label, codeOf, displayTitle, nameRows };
