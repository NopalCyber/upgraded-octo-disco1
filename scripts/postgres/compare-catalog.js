'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const { generate } = require('./generate-baseline');

const args = process.argv.slice(2);
const pgUrl = args[args.indexOf('--pg') + 1];
const baselineIdx = args.indexOf('--sqlite-baseline');
const baselinePath = baselineIdx >= 0 ? args[baselineIdx + 1] : path.join(__dirname, '..', '..', 'migrations', 'baseline.sql');
if (args.indexOf('--pg') < 0 || !pgUrl) {
  console.error('Usage: node scripts/postgres/compare-catalog.js --pg <postgres-url> [--sqlite-baseline <migrations/baseline.sql>]');
  process.exit(2);
}
const baselineSql = fs.readFileSync(baselinePath, 'utf8');
const lite = new Database(':memory:');
lite.exec(baselineSql);
const generated = generate(baselineSql);
const problems = [];
const bad = (m) => problems.push(m);

(async () => {
  const pg = new Client({ connectionString: pgUrl });
  await pg.connect();
  const q = async (s, p) => (await pg.query(s, p)).rows;

  const L = {};
  const master = lite.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
  const liteTables = master.filter((r) => r.type === 'table' && !r.name.startsWith('sqlite_') && !/^search_index_/.test(r.name)).map((r) => r.name);
  L.tablesAll = master.filter((r) => r.type === 'table').length;
  L.tables = liteTables.length;
  L.explicitIndexes = master.filter((r) => r.type === 'index' && r.sql).length;
  L.autoIndexes = master.filter((r) => r.type === 'index' && !r.sql).length;
  L.views = master.filter((r) => r.type === 'view').length;
  L.triggers = master.filter((r) => r.type === 'trigger').length;

  const G = {};
  const pgTables = (await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).map((r) => r.tablename);
  G.tables = pgTables.length;
  const pgIdx = await q(`SELECT c.relname AS name, t.relname AS tbl, x.indisunique AS uniq, x.indpred IS NOT NULL AS partial,
      EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = c.oid AND k.conrelid = x.indrelid AND k.contype IN ('p','u','x')) AS backs_constraint
    FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`);
  G.explicitIndexes = pgIdx.filter((r) => !r.backs_constraint).length;
  G.constraintIndexes = pgIdx.filter((r) => r.backs_constraint).length;
  G.views = (await q("SELECT count(*)::int n FROM pg_views WHERE schemaname='public'"))[0].n;
  G.triggers = (await q("SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal"))[0].n;
  G.functions = (await q("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'"))[0].n;
  const cons = await q(`SELECT c.conname, c.contype, t.relname AS tbl, c.condeferrable, c.condeferred, c.confdeltype, c.confupdtype,
      rt.relname AS reftbl,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS cols,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum) AS refcols
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_class rt ON rt.oid=c.confrelid WHERE n.nspname='public'`);
  for (const t of ['p', 'u', 'f', 'c']) G['constraints_' + t] = cons.filter((c) => c.contype === t).length;

  const lt = new Set(liteTables), gt = new Set(pgTables);
  for (const t of lt) if (!gt.has(t)) bad('table missing in PG: ' + t);
  for (const t of gt) if (!lt.has(t)) bad('extra table in PG: ' + t);

  const TYPE = { INTEGER: 'bigint', TEXT: 'text', DATETIME: 'text', DATE: 'text', REAL: 'double precision', BLOB: 'bytea' };
  const pgCols = await q(`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity, ordinal_position
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  const pgColsBy = {}; for (const c of pgCols) (pgColsBy[c.table_name] = pgColsBy[c.table_name] || []).push(c);
  let colCount = 0, identity = 0;
  for (const t of liteTables) {
    if (t === 'search_index') continue;
    const lc = lite.prepare('SELECT * FROM pragma_table_xinfo(?)').all(t);
    const gc = pgColsBy[t] || [];
    if (lc.length !== gc.length) { bad(`column count ${t}: ${lc.length} vs ${gc.length}`); continue; }
    const pkCols = lc.filter((c) => c.pk > 0);
    lc.forEach((c, i) => {
      colCount++;
      const g = gc[i];
      if (c.name !== g.column_name) bad(`column order ${t}: ${c.name} vs ${g.column_name}`);
      if (TYPE[c.type.toUpperCase()] !== g.data_type) bad(`type ${t}.${c.name}: ${c.type} -> ${g.data_type}`);
      const liteNotNull = !!c.notnull;
      const pgNotNull = g.is_nullable === 'NO';
      if (liteNotNull !== pgNotNull && !(c.pk > 0)) bad(`nullability ${t}.${c.name}`);
      const hasDefault = c.dflt_value != null || (c.pk > 0 && pkCols.length === 1 && c.type.toUpperCase() === 'INTEGER');
      const pgHasDefault = g.column_default != null || g.is_identity === 'YES';
      if (g.is_identity === 'YES') identity++;
      if (hasDefault !== pgHasDefault && !(c.pk > 0)) bad(`default ${t}.${c.name}: ${c.dflt_value} vs ${g.column_default}`);
      if (c.dflt_value != null && g.column_default != null) {
        const ld = c.dflt_value.replace(/^\((.*)\)$/s, '$1');
        const isNow = /^(CURRENT_TIMESTAMP|datetime\('now'\))$/i.test(ld);
        if (isNow && g.column_default !== 'utc_now_text()') bad(`now default ${t}.${c.name}: ${g.column_default}`);
        if (!isNow && !/strftime/.test(ld)) {
          const gd = g.column_default.replace(/::[a-z ]+$/, '').replace(/^'(-[0-9.]+)'$/, '$1').replace(/^'(.*)'$/s, "'$1'");
          if (gd !== ld && !(ld === '1.0' && gd === '1.0')) bad(`default value ${t}.${c.name}: ${ld} vs ${g.column_default}`);
        }
      }
    });
    const pk = cons.find((k) => k.tbl === t && k.contype === 'p');
    const lpk = pkCols.sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (lpk.length && (!pk || pk.cols.join(',') !== lpk.join(','))) bad(`pk ${t}: ${lpk} vs ${pk && pk.cols}`);
    if (!lpk.length && pk) bad(`unexpected pk ${t}`);
    const lu = lite.prepare("SELECT name FROM pragma_index_list(?) WHERE origin='u'").all(t)
      .map((i) => lite.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(i.name).map((r) => r.name).join(',')).sort();
    const gu = cons.filter((k) => k.tbl === t && k.contype === 'u').map((k) => k.cols.join(',')).sort();
    if (lu.join('|') !== gu.join('|')) bad(`unique ${t}: [${lu}] vs [${gu}]`);
    const sql = master.find((r) => r.type === 'table' && r.name === t).sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
    const lc2 = (sql.match(/\bCHECK\s*\(/gi) || []).length;
    const gc2 = cons.filter((k) => k.tbl === t && k.contype === 'c').length;
    if (lc2 !== gc2) bad(`check count ${t}: ${lc2} vs ${gc2}`);
    const lf = {};
    for (const f of lite.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(t)) (lf[f.id] = lf[f.id] || []).push(f);
    const ACT = { 'NO ACTION': 'a', RESTRICT: 'r', CASCADE: 'c', 'SET NULL': 'n', 'SET DEFAULT': 'd' };
    const gfs = cons.filter((k) => k.tbl === t && k.contype === 'f');
    const used = new Set();
    for (const g of Object.values(lf)) {
      const cols = g.map((f) => f.from).join(',');
      let refcols = g.map((f) => f.to);
      if (refcols[0] == null) refcols = lite.prepare('SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk').all(g[0].table).map((r) => r.name);
      const m = gfs.find((k) => !used.has(k.conname) && k.cols.join(',') === cols && k.reftbl === g[0].table && k.refcols.join(',') === refcols.join(',')
        && k.confdeltype === ACT[g[0].on_delete] && k.confupdtype === ACT[g[0].on_update]);
      if (!m) bad(`fk ${t}(${cols}) -> ${g[0].table}(${refcols}) on delete ${g[0].on_delete} not found`);
      else used.add(m.conname);
    }
    if (gfs.length !== Object.keys(lf).length) bad(`fk count ${t}: ${Object.keys(lf).length} vs ${gfs.length}`);
    const deferredLite = (master.find((r) => r.type === 'table' && r.name === t).sql.match(/DEFERRABLE INITIALLY DEFERRED/gi) || []).length;
    const deferredPg = gfs.filter((k) => k.condeferrable && k.condeferred).length;
    if (deferredLite !== deferredPg) bad(`deferrable fks ${t}: ${deferredLite} vs ${deferredPg}`);
  }

  const liteIdx = master.filter((r) => r.type === 'index' && r.sql);
  for (const r of liteIdx) {
    const g = pgIdx.find((i) => i.name === r.name);
    if (!g) { bad('index missing ' + r.name); continue; }
    const il = lite.prepare('SELECT * FROM pragma_index_list(?) WHERE name=?').get(r.tbl_name, r.name);
    if (g.tbl !== r.tbl_name || !!il.unique !== g.uniq || !!il.partial !== g.partial) bad('index shape ' + r.name);
    const lcols = lite.prepare('SELECT name, desc FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(r.name).map((c) => c.name + (c.desc ? ' DESC' : '')).join(', ');
    const def = (await q('SELECT pg_get_indexdef($1::regclass) d', [r.name]))[0].d;
    const gcols = /\((.*?)\)(?: WHERE|$)/.exec(def)[1];
    if (lcols !== gcols) bad(`index cols ${r.name}: ${lcols} vs ${gcols}`);
  }

  const gv = new Set((await q("SELECT viewname FROM pg_views WHERE schemaname='public'")).map((r) => r.viewname));
  for (const v of master.filter((r) => r.type === 'view')) if (!gv.has(v.name)) bad('view missing ' + v.name);
  const gtr = await q(`SELECT t.tgname, c.relname, t.tgtype,
      (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=k) AS ofcols
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal`);
  const afterToBefore = new Set(generated.report.afterToBefore);
  for (const r of master.filter((x) => x.type === 'trigger')) {
    const g = gtr.find((x) => x.tgname === r.name);
    if (!g) { bad('trigger missing ' + r.name); continue; }
    const flat = r.sql.replace(/\s+/g, ' ');
    const m = /CREATE TRIGGER \S+ (BEFORE|AFTER) (INSERT|UPDATE|DELETE)(?: OF (.*?))? ON (\S+)/i.exec(flat);
    const before = (g.tgtype & 2) !== 0; const row = (g.tgtype & 1) !== 0;
    const ev = g.tgtype & 4 ? 'INSERT' : g.tgtype & 8 ? 'DELETE' : g.tgtype & 16 ? 'UPDATE' : '?';
    if (!row) bad('trigger not FOR EACH ROW ' + r.name);
    if (g.relname !== m[4] || ev !== m[2].toUpperCase()) bad('trigger event/table ' + r.name);
    if ((m[1].toUpperCase() === 'BEFORE') !== before && !afterToBefore.has(r.name)) bad('trigger timing ' + r.name);
    const lof = m[3] ? m[3].split(',').map((s) => s.trim()).sort().join(',') : '';
    const gof = g.ofcols ? g.ofcols.join(',') : '';
    if (lof !== gof) bad(`trigger OF cols ${r.name}: ${lof} vs ${gof}`);
  }

  let planned = 0;
  for (const t of generated.report.triggerChecks) {
    for (const e of t.exprs) {
      try {
        await pg.query(`EXPLAIN SELECT (${e}) FROM ${t.table} AS new, ${t.table} AS old`);
        planned++;
      } catch (err) {
        bad(`trigger condition ${t.name} does not plan: ${err.message}`);
      }
    }
  }

  console.log('SQLite:', L);
  console.log('Postgres:', G);
  console.log({ columnsCompared: colCount, identityColumns: identity, triggerConditionsPlanned: planned });
  console.log(problems.length ? problems : 'no structural differences');
  await pg.end();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
