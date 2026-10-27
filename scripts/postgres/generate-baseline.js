'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function tokenize(sql) {
  const toks = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { let j = i; while (j < sql.length && /\s/.test(sql[j])) j++; toks.push({ t: 'ws', v: sql.slice(i, j) }); i = j; continue; }
    if (c === '-' && sql[i + 1] === '-') { let j = sql.indexOf('\n', i); if (j < 0) j = sql.length; toks.push({ t: 'comment', v: sql.slice(i, j) }); i = j; continue; }
    if (c === '/' && sql[i + 1] === '*') { let j = sql.indexOf('*/', i + 2); j = j < 0 ? sql.length : j + 2; toks.push({ t: 'comment', v: sql.slice(i, j) }); i = j; continue; }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error('unterminated string');
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      toks.push({ t: 'str', v: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c; const j = sql.indexOf(close, i + 1);
      toks.push({ t: 'id', v: sql.slice(i + 1, j), quoted: true }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1]))) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
      toks.push({ t: 'num', v: m[0] }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
      toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const two = sql.slice(i, i + 2);
    if (['||', '<>', '!=', '<=', '>=', '==', '<<', '>>'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    toks.push({ t: 'op', v: c }); i++;
  }
  return toks;
}
const isSig = (tk) => tk.t !== 'ws' && tk.t !== 'comment';
const U = (tk) => (tk && tk.t === 'id' && !tk.quoted ? tk.v.toUpperCase() : null);
function nextSig(toks, i) { for (let j = i + 1; j < toks.length; j++) if (isSig(toks[j])) return j; return -1; }
function matchParen(toks, i) {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t !== 'op') continue;
    if (toks[j].v === '(') depth++;
    else if (toks[j].v === ')') { depth--; if (depth === 0) return j; }
  }
  throw new Error('unbalanced parens');
}
function splitTop(toks, sep = ',') {
  const parts = []; let cur = []; let depth = 0;
  for (const tk of toks) {
    if (tk.t === 'op' && tk.v === '(') depth++;
    if (tk.t === 'op' && tk.v === ')') depth--;
    if (depth === 0 && tk.t === 'op' && tk.v === sep) { parts.push(cur); cur = []; continue; }
    cur.push(tk);
  }
  parts.push(cur);
  return parts;
}
const trimToks = (toks) => { let a = 0, b = toks.length; while (a < b && !isSig(toks[a])) a++; while (b > a && !isSig(toks[b - 1])) b--; return toks.slice(a, b); };
const sigOnly = (toks) => toks.filter(isSig);

const PG_RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
  'asymmetric', 'authorization', 'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation',
  'column', 'concurrently', 'constraint', 'create', 'cross', 'current_catalog', 'current_date',
  'current_role', 'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default',
  'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
  'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially',
  'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like',
  'limit', 'localtime', 'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on',
  'only', 'or', 'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'returning',
  'right', 'select', 'session_user', 'similar', 'some', 'symmetric', 'system_user', 'table',
  'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic',
  'verbose', 'when', 'where', 'window', 'with']);
let quotedIdents = new Set();
function ident(name) {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name)) return name;
  quotedIdents.add(name);
  return '"' + name.replace(/"/g, '""') + '"';
}
const MAXID = 63;
function checkLen(name, what) { if (Buffer.byteLength(name) > MAXID) throw new Error(`${what} name too long for PostgreSQL (${name.length}): ${name}`); return name; }
function pgName(base) {
  if (base.length <= MAXID) return base;
  const h = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
  return base.slice(0, MAXID - 9) + '_' + h;
}

const TYPE_MAP = { INTEGER: 'bigint', TEXT: 'text', DATETIME: 'text', DATE: 'text', REAL: 'double precision', BLOB: 'bytea' };

function globToRegexLiteral(lit) {
  const p = lit.slice(1, -1).replace(/''/g, "'");
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      let j = i + 1; let cls = '[';
      if (p[j] === '^') { cls += '^'; j++; }
      if (p[j] === ']') { cls += '\\]'; j++; }
      while (j < p.length && p[j] !== ']') { cls += p[j] === '\\' ? '\\\\' : p[j]; j++; }
      if (j >= p.length) throw new Error('unterminated [ in GLOB ' + lit);
      re += cls + ']'; i = j;
    } else re += /[\\^$.|+(){}]/.test(c) ? '\\' + c : c;
  }
  re += '$';
  if (re.startsWith('^.*')) re = re.slice(3);
  if (re.endsWith('.*$') && !re.endsWith('\\.*$')) re = re.slice(0, -3);
  return "'" + re.replace(/'/g, "''") + "'";
}

const raw = (v) => ({ t: 'raw', v });
const emit = (toks) => toks.map((tk) => {
  if (tk.t === 'id') {
    if (tk.keep) return tk.v;
    if (tk.quoted) return ident(tk.v);
    if (tk.v.toLowerCase() === 'current_role') return ident('current_role');
    return tk.v;
  }
  return tk.v;
}).join('');

let usedSqliteFunctions = {};
function note(fn) { usedSqliteFunctions[fn] = (usedSqliteFunctions[fn] || 0) + 1; }

function tx(toks, ctx = {}) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const u = U(tk);
    if (u) {
      const n1 = nextSig(toks, i);
      if (n1 >= 0 && toks[n1].t === 'op' && toks[n1].v === '(') {
        const close = matchParen(toks, n1);
        const inner = toks.slice(n1 + 1, close);
        const args = splitTop(inner).map(trimToks);
        const A = (k) => emit(tx(args[k], ctx));
        let rep = null; let end = close;
        switch (u) {
          case 'DATETIME':
            if (args.length === 1 && emit(args[0]) === "'now'") { rep = 'utc_now_text()'; note('datetime(now)'); }
            else throw new Error('unsupported datetime(): ' + emit(inner));
            break;
          case 'STRFTIME': {
            const a0 = emit(args[0]);
            if (a0 === "'%Y-%m-%d'" && args.length === 3 && emit(args[2]) === "'+0 days'") {
              const s = sigOnly(args[1]);
              const last = s[s.length - 1]; const cat = s[s.length - 2];
              if (!(last && last.t === 'str' && last.v === "' 00:00:00'" && cat && cat.v === '||')) throw new Error('unsupported strftime arg: ' + emit(args[1]));
              const idxCat = args[1].lastIndexOf(cat);
              rep = 'sqlite_date_ymd(' + emit(tx(trimToks(args[1].slice(0, idxCat)), ctx)) + ')';
              note('strftime(%Y-%m-%d,+0 days)');
            } else if (a0 === "'%Y-%m-%dT%H:%M:%fZ'" && args.length === 2 && emit(args[1]) === "'now'") {
              rep = "to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
              note('strftime(iso-ms,now)');
            } else throw new Error('unsupported strftime(): ' + emit(inner));
            break;
          }
          case 'JSON_VALID': rep = '(' + A(0) + ' IS JSON)'; note('json_valid'); break;
          case 'JSON_TYPE': {
            const e1 = nextSig(toks, close); const e2 = nextSig(toks, e1);
            if (toks[e1] && toks[e1].v === '=' && toks[e2] && toks[e2].t === 'str' && ["'array'", "'object'"].includes(toks[e2].v)) {
              rep = '(' + A(0) + ' IS JSON ' + toks[e2].v.slice(1, -1).toUpperCase() + ')'; end = e2; note('json_type');
            } else throw new Error('unsupported json_type use');
            break;
          }
          case 'JSON_EXTRACT': {
            const path = emit(args[1]);
            const m = /^'\$\.([A-Za-z_][A-Za-z0-9_]*)'$/.exec(path);
            if (!m) throw new Error('unsupported json path ' + path);
            rep = '((' + A(0) + ")::json ->> '" + m[1] + "')"; note('json_extract');
            break;
          }
          case 'JSON_TREE': rep = 'sqlite_json_tree_keys(' + A(0) + ')'; note('json_tree'); break;
          case 'INSTR': rep = 'strpos(' + A(0) + ', ' + A(1) + ')'; note('instr'); break;
          case 'CHAR': rep = 'chr(' + A(0) + ')'; note('char'); break;
          case 'TYPEOF': {
            const e1 = nextSig(toks, close); const e2 = nextSig(toks, e1);
            if (toks[e1] && toks[e1].v === '=' && toks[e2] && toks[e2].v === "'blob'" && ctx.blobColumns && ctx.blobColumns.has(emit(args[0]))) {
              rep = '(' + A(0) + ' IS NOT NULL)'; end = e2; note('typeof');
            } else throw new Error('unsupported typeof use');
            break;
          }
          case 'LENGTH':
            if (args.length === 1 && ctx.blobColumns && ctx.blobColumns.has(emit(args[0]))) { rep = 'octet_length(' + A(0) + ')'; note('length(blob)'); }
            break;
          case 'IFNULL': case 'GROUP_CONCAT': case 'JULIANDAY': case 'PRINTF': case 'IIF': case 'JSON_EACH': case 'DATE': case 'TIME': case 'UNIXEPOCH': case 'SUBSTR': case 'JSON_OBJECT': case 'JSON_ARRAY': case 'JSON_GROUP_ARRAY':
            throw new Error('untranslated SQLite function ' + u);
          case 'RAISE': throw new Error('RAISE outside trigger statement');
          default: break;
        }
        if (rep == null) {
          out.push(tk); out.push(...toks.slice(i + 1, n1 + 1)); out.push(...tx(inner, ctx)); out.push(toks[close]);
        } else out.push(raw(rep));
        i = end; continue;
      }
      if (u === 'CURRENT_TIMESTAMP') { out.push(raw('utc_now_text()')); note('CURRENT_TIMESTAMP'); continue; }
      if (u === 'CURRENT_DATE' || u === 'CURRENT_TIME') throw new Error('untranslated ' + u);
      if (u === 'GLOB' || (u === 'NOT' && U(toks[n1]) === 'GLOB')) {
        const g = u === 'GLOB' ? i : n1; const p = nextSig(toks, g);
        if (toks[p].t !== 'str') throw new Error('GLOB with non-literal pattern');
        out.push(raw((u === 'NOT' ? '!~ ' : '~ ') + globToRegexLiteral(toks[p].v))); note('GLOB');
        i = p; continue;
      }
      if (u === 'LIKE') {
        const p = nextSig(toks, i);
        if (toks[p].t !== 'str' || toks[p].v.includes('\\')) throw new Error('LIKE pattern needs review');
        out.push(raw('ILIKE')); note('LIKE->ILIKE'); continue;
      }
      if (u === 'IS') {
        if (U(toks[n1]) === 'NOT') {
          const n2 = nextSig(toks, n1);
          if (U(toks[n2]) === 'NULL') { out.push(tk); continue; }
          out.push(raw('IS DISTINCT FROM')); note('IS NOT'); i = n1; continue;
        }
        if (U(toks[n1]) === 'NULL') { out.push(tk); continue; }
        out.push(raw('IS NOT DISTINCT FROM')); note('IS'); continue;
      }
    }
    if (tk.t === 'op' && tk.v === '==') { out.push(raw('=')); continue; }
    if (tk.t === 'op' && tk.v === '(') {
      const close = matchParen(toks, i);
      let prev = -1; for (let j = i - 1; j >= 0; j--) if (isSig(toks[j])) { prev = j; break; }
      const nx = nextSig(toks, close);
      const arith = (j) => j >= 0 && toks[j].t === 'op' && ['+', '-', '*'].includes(toks[j].v);
      const inner = toks.slice(i + 1, close);
      const topLevelIs = splitTop(inner).length === 1 && (() => { let d = 0; for (const t of inner) { if (t.v === '(') d++; if (t.v === ')') d--; if (d === 0 && U(t) === 'IS') return true; } return false; })();
      if ((arith(prev) || arith(nx)) && topLevelIs) {
        out.push(raw('(' + emit(tx(inner, ctx)) + ')::int')); note('boolean arithmetic'); i = close; continue;
      }
    }
    out.push(tk);
  }
  return out;
}

function generate(sqliteBaselineSql) {
  quotedIdents = new Set();
  usedSqliteFunctions = {};
  const db = new Database(':memory:');
  db.exec(sqliteBaselineSql);

  const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
  const tablesSql = master.filter((r) => r.type === 'table' && !r.name.startsWith('sqlite_') && !/^search_index_/.test(r.name));
  const indexSql = master.filter((r) => r.type === 'index');
  const viewSql = master.filter((r) => r.type === 'view');
  const triggerSql = master.filter((r) => r.type === 'trigger');

  const out = [];
  const P = (s = '') => out.push(s);
  const report = { tables: 0, indexes: 0, views: 0, triggers: 0, fks: 0, triggerFunctions: 0, sharedAbortTriggers: 0, whenMovedIntoBody: 0, afterToBefore: [], quoted: [], multiAbortGroups: [] };

  P();

  P(`
CREATE OR REPLACE FUNCTION utc_now_text() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$ SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $fn$;

CREATE OR REPLACE FUNCTION sqlite_date_ymd(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $fn$
DECLARE
  y int; m int; d int; days_in_month int;
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  y := substr(value, 1, 4)::int;
  m := substr(value, 6, 2)::int;
  d := substr(value, 9, 2)::int;
  IF m < 1 OR m > 12 OR d < 1 OR d > 31 THEN
    RETURN NULL;
  END IF;
  days_in_month := CASE
    WHEN m IN (4, 6, 9, 11) THEN 30
    WHEN m = 2 THEN CASE WHEN (y % 4 = 0 AND y % 100 <> 0) OR y % 400 = 0 THEN 29 ELSE 28 END
    ELSE 31 END;
  IF d > days_in_month THEN
    d := d - days_in_month;
    m := m + 1;
  END IF;
  RETURN lpad(y::text, 4, '0') || '-' || lpad(m::text, 2, '0') || '-' || lpad(d::text, 2, '0');
END;
$fn$;

CREATE OR REPLACE FUNCTION sqlite_json_tree_keys(doc text) RETURNS TABLE (key text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  WITH RECURSIVE node(node_key, node_value) AS (
    SELECT NULL::text, doc::json
    UNION ALL
    SELECT child.child_key, child.child_value
    FROM node
    CROSS JOIN LATERAL (
      SELECT o.key AS child_key, o.value AS child_value
      FROM json_each(CASE WHEN json_typeof(node.node_value) = 'object' THEN node.node_value END) AS o
      UNION ALL
      SELECT (a.ordinality - 1)::text, a.value
      FROM json_array_elements(CASE WHEN json_typeof(node.node_value) = 'array' THEN node.node_value END)
           WITH ORDINALITY AS a(value, ordinality)
    ) AS child
  )
  SELECT node_key FROM node
$fn$;

CREATE OR REPLACE FUNCTION sqlite_raise_abort() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation', MESSAGE = TG_ARGV[0];
END;
$fn$;
`);

  let fkDefs = [];
  const blobColsByTable = {};

  function parseFkTail(toks, j) {
    let k = nextSig(toks, j);
    const refTable = toks[k].v; let refCols = null;
    let k2 = nextSig(toks, k);
    if (k2 >= 0 && toks[k2].v === '(') { const c = matchParen(toks, k2); refCols = sigOnly(toks.slice(k2 + 1, c)).filter((t) => t.v !== ',').map((t) => t.v); k = c; } else k2 = k;
    const tail = [];
    let p = nextSig(toks, k);
    while (p >= 0) {
      const w = U(toks[p]);
      if (w === 'ON') { const a = nextSig(toks, p); const b = nextSig(toks, a); let e = b; let act = U(toks[b]);
        if (act === 'SET' || act === 'NO') { e = nextSig(toks, b); act += ' ' + U(toks[e]); }
        tail.push(`ON ${U(toks[a])} ${act}`); p = nextSig(toks, e); continue; }
      if (w === 'DEFERRABLE' || (w === 'NOT' && U(toks[nextSig(toks, p)]) === 'DEFERRABLE')) {
        let e = p; let s = w; if (w === 'NOT') { e = nextSig(toks, p); s += ' DEFERRABLE'; }
        const n = nextSig(toks, e);
        if (U(toks[n]) === 'INITIALLY') { const m = nextSig(toks, n); s += ' INITIALLY ' + U(toks[m]); e = m; }
        tail.push(s); p = nextSig(toks, e); continue; }
      if (w === 'MATCH') throw new Error('MATCH unsupported');
      break;
    }
    return { refTable, refCols, tail: tail.join(' '), end: p < 0 ? toks.length : p };
  }

  function translateTable(row) {
    const toks = tokenize(row.sql);
    const open = toks.findIndex((t) => t.t === 'op' && t.v === '(');
    const close = matchParen(toks, open);
    const after = sigOnly(toks.slice(close + 1));
    if (after.length) throw new Error('table options unsupported: ' + row.name + ' ' + emit(after));
    const name = row.name;
    const xinfo = db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(name);
    const blobCols = new Set(xinfo.filter((c) => c.type.toUpperCase() === 'BLOB').map((c) => c.name));
    blobColsByTable[name] = blobCols;
    const ctx = { blobColumns: blobCols };
    const body = toks.slice(open + 1, close);
    const items = []; let cur = []; let depth = 0; const comments = [];
    for (let i = 0; i < body.length; i++) {
      const tk = body[i];
      if (tk.t === 'op' && tk.v === '(') depth++;
      if (tk.t === 'op' && tk.v === ')') depth--;
      if (depth === 0 && tk.t === 'op' && tk.v === ',') {
        items.push(cur); cur = [];
        let j = i + 1; let c = null;
        while (j < body.length && body[j].t === 'ws' && !body[j].v.includes('\n')) j++;
        if (j < body.length && body[j].t === 'comment') { c = body[j].v; body[j] = { t: 'ws', v: '' }; }
        comments[items.length - 1] = c;
        continue;
      }
      cur.push(tk);
    }
    items.push(cur);
    const lines = [];
    let fkCount = 0;
    items.forEach((itemRaw, idx) => {
      const leading = itemRaw.filter((t) => t.t === 'comment').map((t) => t.v);
      const item = trimToks(itemRaw.filter((t) => t.t !== 'comment'));
      const s = sigOnly(item);
      const first = U(s[0]);
      let text;
      if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(first)) {
        if (first === 'FOREIGN') {
          const ci = item.findIndex((t) => t.v === '('); const cc = matchParen(item, ci);
          const cols = sigOnly(item.slice(ci + 1, cc)).filter((t) => t.v !== ',').map((t) => t.v);
          const r = item.findIndex((t) => U(t) === 'REFERENCES');
          const fk = parseFkTail(item, r);
          if (fk.end < item.length && sigOnly(item.slice(fk.end)).length) throw new Error('trailing tokens after FK in ' + name);
          fkDefs.push({ table: name, cols, ...fk }); fkCount++;
          text = null;
        } else if (first === 'CONSTRAINT') {
          throw new Error('named table constraint not handled: ' + name);
        } else if (first === 'CHECK') {
          text = emit(tx(item, ctx));
        } else {
          if (s.some((t) => U(t) === 'CONFLICT')) throw new Error('ON CONFLICT clause in ' + name);
          text = emit(item);
        }
      } else {
        const colName = s[0].v;
        let k = 1; const typeWords = [];
        const STOP = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS']);
        while (k < s.length && s[k].t === 'id' && !STOP.has(U(s[k]))) { typeWords.push(s[k].v.toUpperCase()); k++; }
        const sqliteType = typeWords.join(' ');
        const pgType = TYPE_MAP[sqliteType];
        if (!pgType) throw new Error(`unmapped type ${sqliteType} on ${name}.${colName}`);
        let pos = k < s.length ? item.indexOf(s[k]) : item.length;
        const parts = [];
        let identity = false;
        while (pos < item.length) {
          const tk = item[pos]; if (!isSig(tk)) { pos++; continue; }
          const w = U(tk);
          if (w === 'PRIMARY') {
            const kk = nextSig(item, pos); let e = kk; let auto = false;
            let n = nextSig(item, e);
            while (n >= 0 && ['ASC', 'DESC', 'AUTOINCREMENT'].includes(U(item[n]))) { if (U(item[n]) === 'AUTOINCREMENT') auto = true; e = n; n = nextSig(item, e); }
            if (sqliteType === 'INTEGER' && (auto || colName === 'id')) { identity = true; parts.push('GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'); }
            else parts.push('PRIMARY KEY');
            pos = e + 1; continue;
          }
          if (w === 'NOT') { const n = nextSig(item, pos); if (U(item[n]) !== 'NULL') throw new Error('NOT ?'); parts.push('NOT NULL'); pos = n + 1; continue; }
          if (w === 'NULL') { pos++; continue; }
          if (w === 'UNIQUE') { parts.push('UNIQUE'); pos++; continue; }
          if (w === 'CHECK') { const o = nextSig(item, pos); const c = matchParen(item, o); parts.push('CHECK ' + emit(tx(item.slice(o, c + 1), ctx))); pos = c + 1; continue; }
          if (w === 'DEFAULT') {
            const v = nextSig(item, pos); let e = v; let expr;
            if (item[v].t === 'op' && item[v].v === '(') { e = matchParen(item, v); expr = emit(tx(item.slice(v + 1, e), ctx)); if (!/^utc_now_text\(\)$/.test(expr)) expr = '(' + expr + ')'; }
            else if (item[v].t === 'op' && (item[v].v === '-' || item[v].v === '+')) { e = nextSig(item, v); expr = item[v].v + item[e].v; }
            else if (U(item[v]) === 'CURRENT_TIMESTAMP') { expr = 'utc_now_text()'; note('CURRENT_TIMESTAMP'); }
            else if (item[v].t === 'str' || item[v].t === 'num' || U(item[v]) === 'NULL') expr = item[v].v;
            else throw new Error('default ' + item[v].v);
            parts.push('DEFAULT ' + expr); pos = e + 1; continue;
          }
          if (w === 'REFERENCES') {
            const fk = parseFkTail(item, pos);
            fkDefs.push({ table: name, cols: [colName], ...fk }); fkCount++;
            pos = fk.end; continue;
          }
          if (w === 'COLLATE') throw new Error('COLLATE on ' + name + '.' + colName);
          throw new Error(`unhandled column constraint ${tk.v} on ${name}.${colName}`);
        }
        text = `${ident(colName)} ${pgType}${parts.length ? ' ' + parts.join(' ') : ''}`;
        if (ident(colName) !== colName) report.quoted.push(`${name}.${colName}`);
      }
      if (text == null) return;
      const trailing = comments[idx] ? '  ' + comments[idx] : '';
      lines.push({ text, leading, trailing });
    });
    const pragmaFks = new Set(db.prepare('SELECT id FROM pragma_foreign_key_list(?)').all(name).map((r) => r.id)).size;
    if (pragmaFks !== fkCount) throw new Error(`FK count mismatch on ${name}: parsed ${fkCount}, pragma ${pragmaFks}`);
    let sql = `CREATE TABLE IF NOT EXISTS ${ident(name)} (\n`;
    lines.forEach((l, i) => {
      for (const c of l.leading) sql += '  ' + c + '\n';
      sql += '  ' + l.text + (i < lines.length - 1 ? ',' : '') + l.trailing + '\n';
    });
    sql += ');';
    checkLen(name, 'table');
    return sql;
  }

  P();
  for (const row of tablesSql) {
    if (row.name === 'search_index') {
      const s = row.sql.replace(/\s+/g, ' ');
      if (!/USING fts5\( workspace_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED, title, body \)/.test(s)) throw new Error('search_index changed: ' + s);
      P(`CREATE TABLE IF NOT EXISTS search_index (
  workspace_id bigint,
  entity_type text,
  entity_id text,
  title text,
  body text,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      regexp_replace(coalesce(title, '') || ' ' || coalesce(body, ''), '[[:punct:]]', ' ', 'g'))
  ) STORED
);
`);
      report.tables++;
      continue;
    }
    P(translateTable(row));
    P();
    report.tables++;
  }

  P();
  for (const row of indexSql) {
    const toks = tokenize(row.sql);
    const s = sigOnly(toks);
    let k = 1; const unique = U(s[k]) === 'UNIQUE'; if (unique) k++;
    if (U(s[k]) !== 'INDEX') throw new Error('index parse ' + row.sql);
    k++;
    if (U(s[k]) === 'IF') k += 3;
    const name = s[k].v; const on = s[k + 1]; const tbl = s[k + 2];
    if (U(on) !== 'ON') throw new Error('index parse ' + row.sql);
    const openIdx = toks.indexOf(s[k + 3]); const closeIdx = matchParen(toks, openIdx);
    const cols = emit(tx(toks.slice(openIdx + 1, closeIdx), { blobColumns: blobColsByTable[tbl.v] }));
    const rest = trimToks(toks.slice(closeIdx + 1));
    let where = '';
    if (rest.length) {
      if (U(rest[0]) !== 'WHERE') throw new Error('index tail ' + row.sql);
      where = ' WHERE ' + emit(tx(trimToks(rest.slice(1)), {}));
    }
    checkLen(name, 'index');
    P(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ident(name)} ON ${ident(tbl.v)} (${cols.replace(/\s+/g, ' ').trim()})${where.replace(/\s+/g, ' ')};`);
    report.indexes++;
  }
  P(`
CREATE INDEX IF NOT EXISTS search_index_search_vector_idx ON search_index USING gin (search_vector);
CREATE INDEX IF NOT EXISTS search_index_entity_idx ON search_index (workspace_id, entity_type, entity_id);
`);
  report.indexes += 2;

  const OMITTED_FKS = new Set(['audit_log.workspace_id', 'audit_log.user_id']);
  for (const key of OMITTED_FKS) {
    if (!fkDefs.some((fk) => `${fk.table}.${fk.cols.join(',')}` === key)) throw new Error('omitted foreign key not found, review OMITTED_FKS: ' + key);
  }
  fkDefs = fkDefs.filter((fk) => !OMITTED_FKS.has(`${fk.table}.${fk.cols.join(',')}`));
  P();
  const fkNames = new Set();
  const byTable = new Map();
  for (const fk of fkDefs) {
    let base = pgName(`${fk.table}_${fk.cols.join('_')}_fkey`);
    let n = base; let i = 2; while (fkNames.has(n)) n = pgName(`${fk.table}_${fk.cols.join('_')}_fkey${i++}`);
    fkNames.add(n); fk.name = checkLen(n, 'fk');
    if (!byTable.has(fk.table)) byTable.set(fk.table, []);
    byTable.get(fk.table).push(fk);
  }
  for (const [table, fks] of byTable) {
    P('DO $fk$');
    P('BEGIN');
    for (const fk of fks) {
      const ref = `${ident(fk.refTable)}${fk.refCols ? '(' + fk.refCols.map(ident).join(', ') + ')' : ''}`;
      P(`  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '${ident(table)}'::regclass AND conname = '${fk.name}') THEN`);
      P(`    ALTER TABLE ${ident(table)} ADD CONSTRAINT ${fk.name} FOREIGN KEY (${fk.cols.map(ident).join(', ')}) REFERENCES ${ref}${fk.tail ? ' ' + fk.tail : ''};`);
      P('  END IF;');
      report.fks++;
    }
    P('END');
    P('$fk$;');
    P();
  }

  P();
  for (const row of viewSql) {
    const toks = tokenize(row.sql);
    const asIdx = toks.findIndex((t) => U(t) === 'AS');
    const s = sigOnly(toks.slice(0, asIdx));
    const name = s[s.length - 1].v;
    P(`CREATE OR REPLACE VIEW ${ident(name)} AS${emit(tx(toks.slice(asIdx + 1), {}))};`);
    P();
    report.views++;
  }

  P();

  const AFTER_TO_BEFORE = {
    control_record_version: {
      expect: /^CREATE TRIGGER control_record_version AFTER UPDATE ON control_instances WHEN NEW\.record_version = OLD\.record_version BEGIN UPDATE control_instances SET record_version = OLD\.record_version \+ 1 WHERE id = NEW\.id; END$/,
      event: 'BEFORE UPDATE ON control_instances', when: 'NEW.record_version = OLD.record_version',
      body: '  NEW.record_version := OLD.record_version + 1;',
    },
    client_request_release_on_insert: {
      expect: /^CREATE TRIGGER client_request_release_on_insert AFTER INSERT ON client_requests WHEN NEW\.assignee_id IS NOT NULL AND NEW\.released_at IS NULL BEGIN UPDATE client_requests SET released_at=CURRENT_TIMESTAMP,released_by=NEW\.created_by WHERE id=NEW\.id; END$/,
      event: 'BEFORE INSERT ON client_requests', when: 'NEW.assignee_id IS NOT NULL AND NEW.released_at IS NULL',
      body: '  NEW.released_at := utc_now_text();\n  NEW.released_by := NEW.created_by;',
    },
    client_request_release_on_assignment: {
      expect: /^CREATE TRIGGER client_request_release_on_assignment AFTER UPDATE OF assignee_id ON client_requests WHEN NEW\.assignee_id IS NOT NULL AND NEW\.released_at IS NULL BEGIN UPDATE client_requests SET released_at=CURRENT_TIMESTAMP,released_by=NEW\.created_by WHERE id=NEW\.id; END$/,
      event: 'BEFORE UPDATE OF assignee_id ON client_requests', when: 'NEW.assignee_id IS NOT NULL AND NEW.released_at IS NULL',
      body: '  NEW.released_at := utc_now_text();\n  NEW.released_by := NEW.created_by;',
    },
  };

  const groups = new Map();
  const triggerChecks = [];
  for (const row of triggerSql) {
    const flat = row.sql.replace(/\s+/g, ' ').trim();
    const toks = tokenize(row.sql);
    const s = sigOnly(toks);
    let k = 2; if (U(s[k]) === 'IF') k += 3;
    const name = s[k].v; k++;
    const timing = U(s[k]); k++;
    if (!['BEFORE', 'AFTER'].includes(timing)) throw new Error('timing ' + name);
    const eventKw = U(s[k]); k++;
    let ofCols = null;
    if (eventKw === 'UPDATE' && U(s[k]) === 'OF') {
      k++; ofCols = [];
      while (U(s[k]) !== 'ON') { if (s[k].v !== ',') ofCols.push(s[k].v); k++; }
    }
    if (U(s[k]) !== 'ON') throw new Error('ON expected ' + name);
    const table = s[k + 1].v; k += 2;
    if (U(s[k]) === 'FOR') k += 3;
    let whenToks = null;
    const beginIdx = toks.findIndex((t) => U(t) === 'BEGIN');
    if (U(s[k]) === 'WHEN') {
      const wIdx = toks.indexOf(s[k]);
      whenToks = trimToks(toks.slice(wIdx + 1, beginIdx));
    } else if (U(s[k]) !== 'BEGIN') throw new Error('BEGIN expected ' + name);
    let endIdx = toks.length - 1; while (!isSig(toks[endIdx])) endIdx--;
    if (U(toks[endIdx]) !== 'END') throw new Error('END expected ' + name);
    const stmts = splitTop(toks.slice(beginIdx + 1, endIdx), ';').map(trimToks).filter((x) => x.length);
    checkLen(name, 'trigger');
    const event = `${eventKw}${ofCols ? ' OF ' + ofCols.map(ident).join(', ') : ''}`;
    report.triggers++;

    if (AFTER_TO_BEFORE[name]) {
      const o = AFTER_TO_BEFORE[name];
      if (!o.expect.test(flat)) throw new Error('trigger changed, review override: ' + name + '\n' + flat);
      const fn = checkLen(name + '_fn', 'function');
      P(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger\nLANGUAGE plpgsql\nAS $fn$\nBEGIN\n${o.body}\n  RETURN NEW;\nEND;\n$fn$;`);
      P(`CREATE OR REPLACE TRIGGER ${name} ${o.event}\n  FOR EACH ROW WHEN (${o.when})\n  EXECUTE FUNCTION ${fn}();`);
      P();
      report.triggerFunctions++; report.afterToBefore.push(name);
      triggerChecks.push({ name, table, eventKw, exprs: [o.when] });
      continue;
    }

    const hasSub = whenToks && whenToks.some((t) => U(t) === 'SELECT');
    const whenSql = whenToks ? emit(tx(whenToks, {})).trim() : null;
    const isRaise = (st) => { const q = sigOnly(st); return U(q[0]) === 'SELECT' && U(q[1]) === 'RAISE'; };
    const raiseMsg = (st) => {
      const q = sigOnly(st);
      if (U(q[3]) !== 'ABORT' || q[4].v !== ',' || q[5].t !== 'str' || q[6].v !== ')' || q.length !== 7) throw new Error('raise form ' + name);
      return q[5].v;
    };

    if (stmts.length === 1 && isRaise(stmts[0])) {
      const msg = raiseMsg(stmts[0]);
      const gk = `${table}|${timing}|${eventKw}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(name);
      if (!hasSub) {
        P(`CREATE OR REPLACE TRIGGER ${name} ${timing} ${event} ON ${ident(table)}\n  FOR EACH ROW${whenSql ? `\n  WHEN (${whenSql.replace(/\n/g, '\n  ')})` : ''}\n  EXECUTE FUNCTION sqlite_raise_abort(${msg});`);
        P();
        report.sharedAbortTriggers++;
        if (whenSql) triggerChecks.push({ name, table, eventKw, exprs: [whenSql] });
        continue;
      }
      const fn = checkLen(name + '_fn', 'function');
      const ret = eventKw === 'DELETE' ? 'OLD' : 'NEW';
      P(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger\nLANGUAGE plpgsql\nAS $fn$\nBEGIN\n  IF ${whenSql.replace(/\n/g, '\n  ')}\n  THEN\n    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',\n      MESSAGE = ${msg};\n  END IF;\n  RETURN ${ret};\nEND;\n$fn$;`);
      P(`CREATE OR REPLACE TRIGGER ${name} ${timing} ${event} ON ${ident(table)}\n  FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
      P();
      report.triggerFunctions++; report.whenMovedIntoBody++;
      triggerChecks.push({ name, table, eventKw, exprs: [whenSql] });
      continue;
    }

    if (timing !== 'AFTER' || hasSub) throw new Error('unhandled trigger form ' + name);
    const bodySql = stmts.map((st) => {
      if (U(sigOnly(st)[0]) !== 'UPDATE') throw new Error('unhandled statement in ' + name);
      return '  ' + emit(tx(st, {})).replace(/\n/g, '\n  ') + ';';
    }).join('\n');
    const fn = checkLen(name + '_fn', 'function');
    P(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger\nLANGUAGE plpgsql\nAS $fn$\nBEGIN\n${bodySql}\n  RETURN NULL;\nEND;\n$fn$;`);
    P(`CREATE OR REPLACE TRIGGER ${name} ${timing} ${event} ON ${ident(table)}\n  FOR EACH ROW${whenSql ? `\n  WHEN (${whenSql.replace(/\n/g, '\n  ')})` : ''}\n  EXECUTE FUNCTION ${fn}();`);
    P();
    report.triggerFunctions++;
    triggerChecks.push({ name, table, eventKw, exprs: whenSql ? [whenSql] : [], stmts: stmts.map((st) => emit(tx(st, {}))) });
  }
  for (const [k, v] of groups) if (v.length > 1) report.multiAbortGroups.push({ group: k, sqliteOrder: [...v].reverse(), pgOrder: [...v].sort() });


  report.usedSqliteFunctions = usedSqliteFunctions;
  report.quotedIdents = [...quotedIdents];
  report.triggerChecks = triggerChecks;
  db.close();
  return { sql: out.join('\n').replace(/\n{3,}/g, '\n\n'), report };
}

function main(argv) {
  const root = path.join(__dirname, '..', '..');
  const opts = { input: path.join(root, 'migrations', 'baseline.sql'), output: path.join(root, 'migrations', 'postgres', 'baseline.sql'), check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') opts.input = argv[++i];
    else if (argv[i] === '--out') opts.output = argv[++i];
    else if (argv[i] === '--check') opts.check = true;
    else {
      console.error('Usage: node scripts/postgres/generate-baseline.js [--check] [--in <sqlite-baseline.sql>] [--out <postgres-baseline.sql>]');
      return argv[i] === '--help' || argv[i] === '-h' ? 0 : 2;
    }
  }
  const { sql, report } = generate(fs.readFileSync(opts.input, 'utf8'));
  console.log(`tables ${report.tables}, indexes ${report.indexes}, foreign keys ${report.fks}, views ${report.views}, `
    + `triggers ${report.triggers} (${report.sharedAbortTriggers} via sqlite_raise_abort, ${report.whenMovedIntoBody} with the condition in a function, `
    + `${report.afterToBefore.length} AFTER->BEFORE), trigger functions ${report.triggerFunctions}, `
    + `tables with several guards on one event ${report.multiAbortGroups.length}`);
  const rel = path.relative(process.cwd(), opts.output) || opts.output;
  if (opts.check) {
    const current = fs.existsSync(opts.output) ? fs.readFileSync(opts.output, 'utf8') : null;
    if (current === sql) { console.log(`${rel} is up to date`); return 0; }
    console.error(`${rel} is out of date: run node scripts/postgres/generate-baseline.js`);
    return 1;
  }
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, sql);
  console.log(`Wrote ${rel}`);
  return 0;
}

module.exports = { generate };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
