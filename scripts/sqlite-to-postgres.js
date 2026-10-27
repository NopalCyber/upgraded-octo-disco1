'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SKIPPED = new Map([
  ['sessions', 'runtime session-store table (better-sqlite3-session-store); users sign in again after the move'],
]);
const FTS5_SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];

function usage(message) {
  if (message) console.error(`sqlite-to-postgres: ${message}`);
  console.error('Usage: node scripts/sqlite-to-postgres.js --sqlite <path> --pg <postgres-url> [--schema <file> | --no-schema] [--truncate] [--skip-table <name>]... [--batch-rows <n>]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    sqlite: null, pg: null,
    schema: path.join(__dirname, '..', 'migrations', 'postgres', 'baseline.sql'),
    applySchema: true, truncate: false, skip: new Set(), batchRows: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) usage(`${a} needs a value`);
      return v;
    };
    if (a === '--sqlite') opts.sqlite = value();
    else if (a === '--pg') opts.pg = value();
    else if (a === '--schema') opts.schema = value();
    else if (a === '--no-schema') opts.applySchema = false;
    else if (a === '--truncate') opts.truncate = true;
    else if (a === '--skip-table') opts.skip.add(value());
    else if (a === '--batch-rows') {
      opts.batchRows = Number(value());
      if (!Number.isInteger(opts.batchRows) || opts.batchRows < 1) usage('--batch-rows must be a positive integer');
    } else if (a === '--help' || a === '-h') usage();
    else usage(`unknown option ${a}`);
  }
  if (!opts.sqlite || !opts.pg) usage('--sqlite and --pg are required');
  if (!fs.existsSync(opts.sqlite)) usage(`no SQLite database at ${opts.sqlite}`);
  if (opts.applySchema && !fs.existsSync(opts.schema)) usage(`no schema file at ${opts.schema}`);
  return opts;
}

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

const INTEGER_TEXT = /^[+-]?[0-9]+$/;
const NUMERIC_TEXT = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function converterFor(pgType, note) {
  switch (pgType) {
    case 'bigint': case 'integer': case 'smallint':
      return (v) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'number') {
          if (Number.isInteger(v)) return String(v);
          throw new Error(`non-integer number ${v} in an integer column`);
        }
        if (typeof v === 'string') {
          if (INTEGER_TEXT.test(v)) { note('integer stored as text'); return v; }
          throw new Error(`text ${JSON.stringify(v.slice(0, 40))} in an integer column`);
        }
        throw new Error('blob in an integer column');
      };
    case 'double precision': case 'real': case 'numeric':
      return (v) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (v > 0 ? 'Infinity' : '-Infinity');
        if (typeof v === 'string') {
          if (NUMERIC_TEXT.test(v.trim())) { note('number stored as text'); return v.trim(); }
          throw new Error(`text ${JSON.stringify(v.slice(0, 40))} in a numeric column`);
        }
        throw new Error('blob in a numeric column');
      };
    case 'text': case 'character varying':
      return (v) => {
        if (typeof v === 'string') {
          if (v.includes('\u0000')) throw new Error('text contains a NUL character, which PostgreSQL text cannot store');
          return v;
        }
        if (typeof v === 'bigint' || typeof v === 'number') { note('number stored in a text column, copied as its decimal text'); return String(v); }
        throw new Error('blob in a text column');
      };
    case 'bytea':
      return (v) => {
        if (Buffer.isBuffer(v)) return v;
        if (typeof v === 'string') { note('text stored in a blob column, copied as UTF-8 bytes'); return Buffer.from(v, 'utf8'); }
        throw new Error('number in a blob column');
      };
    default:
      throw new Error(`no converter for PostgreSQL type ${pgType}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const Database = require('better-sqlite3');
  const { Client } = require('pg');

  const lite = new Database(opts.sqlite, { readonly: true, fileMustExist: true });
  lite.defaultSafeIntegers(true);

  const pg = new Client({ connectionString: opts.pg });
  pg.on('notice', () => {});
  try {
    await pg.connect();
  } catch (e) {
    console.error(`sqlite-to-postgres: cannot connect to PostgreSQL: ${e.message}`);
    process.exit(2);
  }

  const master = lite.prepare("SELECT type, name, sql FROM sqlite_master WHERE type = 'table'").all();
  const virtual = master.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql || '')).map((t) => t.name);
  const shadow = new Set();
  for (const v of virtual) for (const s of FTS5_SHADOW_SUFFIXES) shadow.add(v + s);
  const skipped = [];
  const sourceTables = [];
  for (const t of master) {
    if (t.name.startsWith('sqlite_') || shadow.has(t.name)) continue;
    if (opts.skip.has(t.name)) { skipped.push([t.name, '--skip-table']); continue; }
    if (DEFAULT_SKIPPED.has(t.name)) { skipped.push([t.name, DEFAULT_SKIPPED.get(t.name)]); continue; }
    sourceTables.push(t.name);
  }
  const hasSequenceTable = master.some((t) => t.name === 'sqlite_sequence');
  const sqliteSeq = new Map(hasSequenceTable
    ? lite.prepare('SELECT name, seq FROM sqlite_sequence').all().map((r) => [r.name, BigInt(r.seq)])
    : []);

  let failed = false;
  const fail = (msg) => { failed = true; console.error(`  ERROR ${msg}`); };

  await pg.query('BEGIN');
  try {
    if (opts.applySchema) {
      console.log(`Applying ${path.relative(process.cwd(), opts.schema) || opts.schema}`);
      await pg.query(fs.readFileSync(opts.schema, 'utf8'));
    }

    const colRows = (await pg.query(`
      SELECT c.table_name, c.column_name, c.data_type, c.is_generated, c.is_identity, c.is_nullable, c.column_default
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position`)).rows;
    const target = new Map();
    for (const r of colRows) {
      if (!target.has(r.table_name)) target.set(r.table_name, []);
      target.get(r.table_name).push(r);
    }

    const missing = sourceTables.filter((t) => !target.has(t));
    if (missing.length) {
      throw new SetupError(`source tables with no PostgreSQL table: ${missing.join(', ')} (apply the schema, or pass --skip-table)`);
    }

    const plans = [];
    for (const table of sourceTables) {
      const isVirtual = virtual.includes(table);
      const srcCols = isVirtual
        ? lite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name)
        : lite.prepare(`SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0`).all(table).map((r) => r.name);
      const tgtCols = target.get(table);
      const byName = new Map(tgtCols.map((c) => [c.column_name, c]));
      const absent = srcCols.filter((c) => !byName.has(c));
      if (absent.length) throw new SetupError(`${table}: PostgreSQL table has no column ${absent.join(', ')}`);
      const generated = srcCols.filter((c) => byName.get(c).is_generated === 'ALWAYS');
      if (generated.length) throw new SetupError(`${table}: cannot copy into generated column ${generated.join(', ')}`);
      const notes = new Map();
      const cols = srcCols.map((name) => {
        const pgType = byName.get(name).data_type;
        return { name, pgType, convert: converterFor(pgType, (what) => {
          const k = `${name}: ${what}`;
          notes.set(k, (notes.get(k) || 0) + 1);
        }) };
      });
      const extra = tgtCols.filter((c) => !srcCols.includes(c.column_name) && c.is_generated !== 'ALWAYS');
      for (const c of extra) {
        if (c.is_nullable === 'NO' && c.column_default == null && c.is_identity !== 'YES') {
          throw new SetupError(`${table}.${c.column_name} is NOT NULL without a default and has no SQLite source column`);
        }
      }
      const hasRowid = isVirtual || !/WITHOUT\s+ROWID/i.test(master.find((t) => t.name === table).sql || '');
      plans.push({ table, cols, notes, hasRowid, extra: extra.map((c) => c.column_name) });
    }

    const fks = (await pg.query(`
      SELECT con.conname, child.relname AS child, parent.relname AS parent,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS refcols
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = child.relnamespace
       WHERE con.contype = 'f' AND n.nspname = current_schema()
       ORDER BY child.relname, con.conname`)).rows;

    const order = [];
    const deps = new Map(plans.map((p) => [p.table, new Set()]));
    for (const fk of fks) if (deps.has(fk.child) && deps.has(fk.parent) && fk.child !== fk.parent) deps.get(fk.child).add(fk.parent);
    const state = new Map();
    const visit = (t) => {
      if (state.get(t) === 2 || state.get(t) === 1) return;
      state.set(t, 1);
      for (const p of [...deps.get(t)].sort()) visit(p);
      state.set(t, 2);
      order.push(t);
    };
    for (const t of [...deps.keys()].sort()) visit(t);
    const planBy = new Map(plans.map((p) => [p.table, p]));

    try {
      await pg.query('SAVEPOINT replication_role');
      await pg.query('SET LOCAL session_replication_role = replica');
      await pg.query('RELEASE SAVEPOINT replication_role');
    } catch (e) {
      throw new SetupError(`cannot set session_replication_role (${e.message}). Run as a superuser, or on PostgreSQL 15+: GRANT SET ON PARAMETER session_replication_role TO <role>;`);
    }

    const occupied = [];
    for (const t of order) {
      const { rows } = await pg.query(`SELECT EXISTS (SELECT 1 FROM ${qi(t)}) AS has_rows`);
      if (rows[0].has_rows) occupied.push(t);
    }
    if (occupied.length && !opts.truncate) {
      throw new SetupError(`target tables already hold rows: ${occupied.join(', ')} (pass --truncate to replace them)`);
    }
    if (occupied.length) {
      console.log(`Emptying ${occupied.length} target table(s)`);
      await pg.query(`TRUNCATE ${order.map(qi).join(', ')}`);
    }

    console.log(`Copying ${order.length} tables`);
    const loaded = new Map();
    for (const t of order) {
      const plan = planBy.get(t);
      const n = plan.cols.length;
      const perStatement = Math.max(1, Math.min(opts.batchRows, Math.floor(65535 / n)));
      const colList = plan.cols.map((c) => qi(c.name)).join(', ');
      const select = `SELECT ${plan.cols.map((c) => qi(c.name)).join(', ')} FROM ${qi(t)}${plan.hasRowid ? ' ORDER BY rowid' : ''}`;
      const stmt = lite.prepare(select).raw(true);
      let batch = [];
      let count = 0;
      const flush = async () => {
        if (!batch.length) return;
        const params = [];
        const tuples = batch.map((row) => '(' + row.map((v) => { params.push(v); return '$' + params.length; }).join(', ') + ')');
        await pg.query(`INSERT INTO ${qi(t)} (${colList}) VALUES ${tuples.join(', ')}`, params);
        batch = [];
      };
      let rowNumber = 0;
      let tableErrors = 0;
      for (const row of stmt.iterate()) {
        rowNumber++;
        const out = new Array(n);
        let ok = true;
        for (let i = 0; i < n; i++) {
          const v = row[i];
          if (v === null) { out[i] = null; continue; }
          try {
            out[i] = plan.cols[i].convert(v);
          } catch (e) {
            ok = false;
            if (++tableErrors <= 5) fail(`${t}.${plan.cols[i].name} (row ${rowNumber}): ${e.message}`);
          }
        }
        if (!ok) continue;
        batch.push(out);
        count++;
        if (batch.length >= perStatement) await flush();
      }
      await flush();
      if (tableErrors > 5) fail(`${t}: ${tableErrors - 5} more conversion error(s) not shown`);
      loaded.set(t, count);
      for (const [what, k] of plan.notes) console.log(`  note ${t}.${what} (${k} row${k === 1 ? '' : 's'})`);
    }
    await pg.query('SET LOCAL session_replication_role = origin');

    const identities = (await pg.query(`
      SELECT c.table_name, c.column_name, pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
        FROM information_schema.columns c
       WHERE c.table_schema = current_schema() AND (c.is_identity = 'YES' OR c.column_default LIKE 'nextval(%')`)).rows;
    let sequencesReset = 0;
    for (const id of identities) {
      if (!id.seq) continue;
      const { rows } = await pg.query(`SELECT max(${qi(id.column_name)})::text AS m FROM ${qi(id.table_name)}`);
      let high = rows[0].m == null ? 0n : BigInt(rows[0].m);
      const seq = sqliteSeq.get(id.table_name);
      if (seq != null && seq > high) high = seq;
      if (high > 0n) await pg.query('SELECT setval($1, $2, true)', [id.seq, high.toString()]);
      else await pg.query('SELECT setval($1, 1, false)', [id.seq]);
      sequencesReset++;
    }

    console.log('');
    const width = Math.max(...order.map((t) => t.length), 5);
    console.log(`${'table'.padEnd(width)}  ${'sqlite'.padStart(9)}  ${'postgres'.padStart(9)}`);
    let totalLite = 0, totalPg = 0, mismatches = 0;
    for (const t of [...order].sort()) {
      const liteCount = Number(lite.prepare(`SELECT count(*) FROM ${qi(t)}`).pluck().get());
      const pgCount = Number((await pg.query(`SELECT count(*) AS n FROM ${qi(t)}`)).rows[0].n);
      totalLite += liteCount; totalPg += pgCount;
      const same = liteCount === pgCount;
      if (!same) mismatches++;
      console.log(`${t.padEnd(width)}  ${String(liteCount).padStart(9)}  ${String(pgCount).padStart(9)}${same ? '' : '  MISMATCH'}`);
    }
    console.log(`${'TOTAL'.padEnd(width)}  ${String(totalLite).padStart(9)}  ${String(totalPg).padStart(9)}`);
    if (mismatches) fail(`${mismatches} table(s) have different row counts`);

    let orphanTotal = 0;
    for (const fk of fks) {
      const notNull = fk.cols.map((c) => `c.${qi(c)} IS NOT NULL`).join(' AND ');
      const match = fk.cols.map((c, i) => `p.${qi(fk.refcols[i])} = c.${qi(c)}`).join(' AND ');
      const { rows } = await pg.query(`SELECT count(*) AS n FROM ${qi(fk.child)} c WHERE ${notNull}
        AND NOT EXISTS (SELECT 1 FROM ${qi(fk.parent)} p WHERE ${match})`);
      const n = Number(rows[0].n);
      if (n) { orphanTotal += n; fail(`${fk.child}(${fk.cols.join(', ')}) -> ${fk.parent}: ${n} row(s) reference a missing parent (${fk.conname})`); }
    }

    console.log('');
    for (const [t, why] of skipped) console.log(`Skipped ${t}: ${why}`);
    const untouched = [...target.keys()].filter((t) => !planBy.has(t) && !skipped.some(([s]) => s === t));
    if (untouched.length) console.log(`PostgreSQL tables with no SQLite source (left as they were): ${untouched.join(', ')}`);
    console.log(`Identity sequences reset: ${sequencesReset}`);
    console.log(`Foreign keys checked: ${fks.length}, orphaned rows: ${orphanTotal}`);
    const { rows: [locale] } = await pg.query('SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()');
    if (!['C', 'POSIX'].includes(locale.datcollate) || !['C', 'POSIX'].includes(locale.datctype)) {
      console.log(`Note: this database uses LC_COLLATE ${locale.datcollate} / LC_CTYPE ${locale.datctype}. SQLite sorts and compares text`);
      console.log('      byte by byte and lower()/LIKE fold ASCII only; a database created with LC_COLLATE and LC_CTYPE "C"');
      console.log('      behaves the same way (see docs/postgres-port.md).');
    }

    if (failed) {
      await pg.query('ROLLBACK');
      console.error('\nCopy FAILED; the PostgreSQL transaction was rolled back.');
      process.exitCode = 1;
    } else {
      await pg.query('COMMIT');
      console.log(`\nCopied ${totalPg} rows in ${order.length} tables; row counts match.`);
    }
  } catch (e) {
    await pg.query('ROLLBACK').catch(() => {});
    if (e instanceof SetupError) {
      console.error(`sqlite-to-postgres: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(`sqlite-to-postgres: copy failed and was rolled back: ${e.message}`);
      if (e.detail) console.error(e.detail);
      if (e.where) console.error(e.where);
      process.exitCode = 1;
    }
  } finally {
    await pg.end().catch(() => {});
    lite.close();
  }
}

class SetupError extends Error {}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
