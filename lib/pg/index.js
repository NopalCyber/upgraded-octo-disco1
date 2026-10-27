'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const pg = require('pg');
const { compile, bind, insertTarget } = require('./sql');

pg.types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`Integer ${value} is outside JavaScript's safe range`);
  return number;
});
pg.types.setTypeParser(1700, (value) => Number(value));

const WRITER_LOCK_KEY = 727001;
const LOCK_TIMEOUT_MS = 30000;

const noop = () => {};

class TransactionClosedError extends Error {
  constructor() {
    super('A query ran on a transaction that has already finished. Run it inside the transaction or after it, not from a callback the transaction started.');
    this.name = 'TransactionClosedError';
  }
}

function createDatabase(connectionString, options = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: options.max || Number(process.env.PG_POOL_MAX || 10),
    options: '-c TimeZone=UTC',
    application_name: options.applicationName || 'iso27001-tool',
  });
  const lockTimeoutMs = Math.max(1, Math.floor(Number(options.lockTimeoutMs || process.env.PG_LOCK_TIMEOUT_MS || LOCK_TIMEOUT_MS)));
  pool.on('error', (error) => {
    console.error('[db] idle PostgreSQL client error:', error.message);
  });

  const context = new AsyncLocalStorage();
  const compiled = new Map();
  let idTables = null;

  function queued(root, run) {
    const next = root.tail.then(run, run);
    root.tail = next.then(noop, noop);
    return next;
  }

  function executor() {
    const scope = context.getStore();
    if (!scope) return pool;
    const { root } = scope;
    if (root.closed) throw new TransactionClosedError();
    return { query: (...args) => queued(root, () => root.client.query(...args)) };
  }

  async function loadCatalog() {
    const rows = (await pool.query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'id'`)).rows;
    idTables = new Set(rows.map((row) => row.table_name));
  }

  function statement(sql) {
    let entry = compiled.get(sql);
    if (!entry) {
      entry = compile(sql);
      compiled.set(sql, entry);
    }
    return entry;
  }

  async function query(sql, args, rowMode) {
    const entry = statement(sql);
    let text = entry.text;
    if (entry.returningId === undefined) {
      if (!idTables) await loadCatalog();
      const table = insertTarget(entry.text);
      entry.returningId = !!(table && idTables.has(table));
    }
    if (entry.returningId) text += ' RETURNING id';
    const values = bind(entry, args);
    const result = await executor().query(rowMode ? { text, values, rowMode } : { text, values });
    return { result, returningId: entry.returningId };
  }

  function prepare(sql) {
    statement(sql);
    let rowMode = null;
    const stmt = {
      source: sql,
      raw(enabled = true) { rowMode = enabled ? 'array' : null; return stmt; },
      async get(...args) {
        const { result } = await query(sql, args, rowMode);
        return result.rows[0];
      },
      async all(...args) {
        const { result } = await query(sql, args, rowMode);
        return result.rows;
      },
      async run(...args) {
        const { result, returningId } = await query(sql, args, null);
        let lastInsertRowid;
        if (returningId) lastInsertRowid = result.rows.length ? result.rows[result.rows.length - 1].id : undefined;
        else if (result.rows && result.rows.length && result.rows[result.rows.length - 1].id !== undefined) {
          lastInsertRowid = result.rows[result.rows.length - 1].id;
        }
        return { changes: result.rowCount || 0, lastInsertRowid };
      },
    };
    return stmt;
  }

  async function exec(sql) {
    await executor().query(String(sql));
  }

  let savepoints = 0;
  function transaction(fn, mode) {
    const run = async function runInTransaction(...args) {
      const scope = context.getStore();
      if (scope && !scope.root.closed) {
        const { root } = scope;
        const send = (sql) => queued(root, () => root.client.query(sql));
        const turn = scope.nested.then(async () => {
          const name = `sp_${++savepoints}`;
          await send(`SAVEPOINT ${name}`);
          try {
            const own = { root, nested: Promise.resolve(), pending: [] };
            const value = await context.run(own, () => fn.apply(this, args));
            await send(`RELEASE SAVEPOINT ${name}`);
            scope.pending.push(...own.pending);
            return value;
          } catch (error) {
            await send(`ROLLBACK TO SAVEPOINT ${name}`);
            await send(`RELEASE SAVEPOINT ${name}`);
            throw error;
          }
        });
        scope.nested = turn.then(noop, noop);
        return turn;
      }
      const client = await pool.connect();
      const own = { client, closed: false, tail: Promise.resolve(), nested: Promise.resolve(), pending: [] };
      own.root = own;
      const send = (sql, values) => queued(own, () => client.query(sql, values));
      try {
        await send('BEGIN');
        await send(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
        if (mode !== 'concurrent') await send('SELECT pg_advisory_xact_lock($1)', [WRITER_LOCK_KEY]);
        const value = await context.run(own, () => fn.apply(this, args));
        await send('COMMIT');
        own.closed = true;
        for (const work of own.pending) startOutside(work);
        return value;
      } catch (error) {
        try { await send('ROLLBACK'); } catch (_) { }
        throw error;
      } finally {
        own.closed = true;
        client.release();
      }
    };
    run.immediate = run;
    run.deferred = run;
    run.exclusive = run;
    run.concurrent = (...args) => transaction(fn, 'concurrent')(...args);
    return run;
  }

  function startOutside(work) {
    context.exit(() => {
      Promise.resolve().then(work).catch((error) => console.error('[db] after-commit work failed:', error && error.message));
    });
  }

  function afterCommit(work) {
    const scope = context.getStore();
    if (!scope || scope.root.closed) startOutside(work);
    else scope.pending.push(work);
  }

  async function lockChain(name) {
    const scope = context.getStore();
    if (!scope || scope.root.closed) throw new Error('lockChain must run inside a transaction');
    await executor().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chain:${name}`]);
  }

  return {
    prepare,
    exec,
    transaction,
    lockChain,
    afterCommit,
    loadCatalog,
    get inTransaction() {
      const scope = context.getStore();
      return !!(scope && !scope.root.closed);
    },
    pragma() {
      throw new Error('PRAGMA is SQLite-only; use PostgreSQL settings or catalog queries instead');
    },
    async close() { await pool.end(); },
    pool,
  };
}

function isConstraintError(error) {
  return !!(error && typeof error.code === 'string' && error.code.startsWith('23'));
}

function isUniqueViolation(error) {
  return !!(error && error.code === '23505');
}

module.exports = { createDatabase, isConstraintError, isUniqueViolation, TransactionClosedError };
