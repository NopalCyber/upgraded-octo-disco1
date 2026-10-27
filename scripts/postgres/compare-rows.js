'use strict';
const Database = require('better-sqlite3');
const { Client } = require('pg');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sqlitePath = opt('--sqlite');
const pgUrl = opt('--pg');
if (!sqlitePath || !pgUrl) {
  console.error('Usage: node scripts/postgres/compare-rows.js --sqlite <path> --pg <postgres-url> [--boot-timestamps cols] [--ignore-columns cols] [--sequences]');
  process.exit(2);
}
const bootColumns = (opt('--boot-timestamps') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ignored = (opt('--ignore-columns') || '').split(',').map((s) => s.trim()).filter(Boolean);
const compareSequences = args.includes('--sequences');
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
function canon(type, v) {
  if (v === null || v === undefined) return '\u0001NULL';
  if (type === 'bigint' || type === 'integer' || type === 'smallint') return typeof v === 'bigint' ? v.toString() : String(v);
  if (type === 'double precision' || type === 'real') return String(Number(v));
  if (type === 'bytea') return 'x' + (Buffer.isBuffer(v) ? v : Buffer.from(String(v))).toString('hex');
  return typeof v === 'string' ? v : String(v);
}

(async () => {
  const lite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  lite.defaultSafeIntegers(true);
  const pg = new Client({ connectionString: pgUrl });
  await pg.connect();
  const cols = (await pg.query(`SELECT c.table_name, c.column_name, c.data_type, c.is_generated
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`)).rows;
  const byTable = new Map();
  for (const c of cols) {
    if (c.is_generated === 'ALWAYS' || ignored.includes(`${c.table_name}.${c.column_name}`)) continue;
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
    byTable.get(c.table_name).push(c);
  }
  const masked = new Map();
  let tables = 0, rows = 0, differing = 0;
  for (const [t, cs] of byTable) {
    if (!lite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
    const list = cs.map((c) => qi(c.column_name)).join(', ');
    const boot = cs.map((c) => bootColumns.includes(c.column_name) || bootColumns.includes(`${t}.${c.column_name}`));
    const key = (side) => (r) => JSON.stringify(r.map((v, i) => {
      const value = canon(cs[i].data_type, v);
      if (boot[i] && TIMESTAMP.test(value)) {
        const label = `${t}.${cs[i].column_name}`;
        if (!masked.has(label)) masked.set(label, { sqlite: 0, postgres: 0 });
        masked.get(label)[side] += 1;
        return '<timestamp>';
      }
      return value;
    }));
    const L = lite.prepare(`SELECT ${list} FROM ${qi(t)}`).raw(true).all().map(key('sqlite')).sort();
    const G = (await pg.query({ text: `SELECT ${list} FROM ${qi(t)}`, rowMode: 'array' })).rows.map(key('postgres')).sort();
    tables++;
    rows += L.length;
    if (L.length !== G.length || L.some((x, i) => x !== G[i])) {
      differing++;
      let first = L.findIndex((x, i) => x !== G[i]);
      if (first < 0) first = L.length;
      console.log(`DIFF ${t}: sqlite ${L.length} rows, postgres ${G.length} rows`);
      console.log(`  first differing row, sqlite:   ${L[first] === undefined ? '(none)' : L[first]}`);
      console.log(`  first differing row, postgres: ${G[first] === undefined ? '(none)' : G[first]}`);
    }
  }
  if (bootColumns.length) {
    const list = [...masked].map(([label, n]) => `${label} (${n.sqlite}/${n.postgres})`);
    console.log(`Boot timestamps compared by shape only (sqlite/postgres values): ${list.length ? list.join(', ') : 'none'}`);
  }

  const sqliteOnly = [];
  for (const { name } of lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    if (byTable.has(name)) continue;
    const n = lite.prepare(`SELECT COUNT(*) AS n FROM ${qi(name)}`).get().n;
    sqliteOnly.push(`${name} (${n} row(s))`);
  }
  if (sqliteOnly.length) console.log(`SQLite tables with no PostgreSQL table: ${sqliteOnly.join(', ')}`);

  let sequenceDiffs = 0;
  if (compareSequences) {
    const counters = new Map(lite.prepare('SELECT name, seq FROM sqlite_sequence').all().map((r) => [r.name, BigInt(r.seq)]));
    const identities = (await pg.query(`SELECT c.table_name, c.column_name, pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
        FROM information_schema.columns c
       WHERE c.table_schema = current_schema() AND c.is_identity = 'YES'
       ORDER BY c.table_name`)).rows;
    let checked = 0;
    for (const { table_name: t, column_name: column, seq } of identities) {
      if (!lite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
      const s = (await pg.query(`SELECT last_value::text AS last_value, is_called FROM ${seq}`)).rows[0];
      const pgNext = s.is_called ? BigInt(s.last_value) + 1n : BigInt(s.last_value);
      const maxId = lite.prepare(`SELECT MAX(${qi(column)}) AS m FROM ${qi(t)}`).get().m;
      const base = [counters.get(t) || 0n, maxId == null ? 0n : BigInt(maxId)].reduce((a, b) => (a > b ? a : b));
      const liteNext = base + 1n;
      checked++;
      if (pgNext !== liteNext) {
        sequenceDiffs++;
        console.log(`SEQUENCE ${t}: sqlite next id ${liteNext}, postgres next id ${pgNext}`);
      }
    }
    console.log(`Compared the next id of ${checked} identity column(s); ${sequenceDiffs} differ.`);
  }

  console.log(`Compared ${rows} rows in ${tables} tables; ${differing} table(s) differ.`);
  await pg.end();
  process.exit(differing || sequenceDiffs ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
