# Postgres data layer: design

Status: agreed design for the `postgres/port` branch. The schema, the SQLite-to-Postgres copy tool and the inventory of SQLite-specific SQL are in `docs/postgres-port.md`; this document fixes the contract the application code is converted against.

## Goals

- The application runs on PostgreSQL 16 only. SQLite and `better-sqlite3` are removed once everything is green.
- Behaviour is unchanged: every test that passes on SQLite passes on Postgres.
- More than one application instance can run against the same database.
- The SQL in the code is Postgres SQL. Nothing translates dialect at runtime.

## The adapter (`lib/pg/`)

`db.js` keeps exporting `db`; it becomes a thin object over a `pg` pool with the same shape the code already uses, made asynchronous.

| Call | Today (better-sqlite3) | Postgres |
|---|---|---|
| `db.prepare(sql)` | compiles a statement | Compiles text only: no I/O, safe at module load and in loops. Rewrites placeholders and caches the result per SQL string. |
| `stmt.get(...params)` | first row or `undefined` | `await` → first row or `undefined` |
| `stmt.all(...params)` | array of rows | `await` → array of rows |
| `stmt.run(...params)` | `{ changes, lastInsertRowid }` | `await` → `{ changes, lastInsertRowid }` (see below) |
| `stmt.raw()` | rows as arrays | `rowMode: 'array'` (one site) |
| `db.exec(sql)` | runs a script | `await`, simple-query protocol, multiple statements allowed |
| `db.transaction(fn)` | returns a function that runs `fn` in BEGIN/COMMIT; nested calls use savepoints | Returns an `async` function with the same nesting rules (see Transactions) |
| `db.transaction(fn)` / `.immediate(...)` | one writer at a time (better-sqlite3 runs each transaction to completion) | BEGIN plus a global advisory transaction lock (see Concurrency); `.concurrent(...)` opts out |

### Parameters

- `?` positional and `@name` / `:name` / `$name` named parameters (with an object argument) are converted to `$1…$n`.
- The tokenizer skips `'…'` and `"…"` literals and `--` / `/* */` comments, so a `?` inside a LIKE pattern or a quoted identifier never shifts later parameters.
- Values: booleans become 1/0 (the schema keeps integer flags), `undefined` binds as NULL (as better-sqlite3 11 does), Buffers become `bytea`.

### `run()` and new ids

194 call sites read `lastInsertRowid`.

- An INSERT into a table that has an `id` column and no `RETURNING` clause gets `RETURNING id` appended. Which tables have `id` is read from the catalog once at boot.
- `lastInsertRowid` is that id; for a multi-row insert, the last one (as in SQLite).
- With `ON CONFLICT DO NOTHING`, a skipped insert has no returned row and `lastInsertRowid` is `undefined`. It never carries a previous statement's value.
- `changes` is the command's row count.

### Types

- Parsers for `int8` (20) and `numeric` (1700) are set to JavaScript numbers before the pool is created. A value outside the safe integer range throws instead of losing precision. Without this, `COUNT(*)` returns the string `'0'`, which is truthy.
- Dates stay text in `'YYYY-MM-DD HH:MM:SS'` UTC (see `docs/postgres-port.md`); the pool sets `TimeZone=UTC` on every connection.
- The database is created with `LC_COLLATE` and `LC_CTYPE` set to `C`, so ordering, `lower()` and pattern matching behave as in SQLite. Boot refuses to start on another collation.

### Transactions

- The transaction client is bound with `AsyncLocalStorage`. Every query issued inside the callback, however deep, runs on that client; call signatures do not change.
- A nested `db.transaction()` inside a bound transaction becomes `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`.
- After COMMIT or ROLLBACK the binding is marked closed. A query that reaches a closed binding (a timer, job or notification started inside the transaction) throws `TransactionClosedError` instead of silently using a released client.
- Queries started together inside a transaction (`Promise.all` over rows) are queued on its connection in the order they were issued, and nested transactions started together run one after another, so one savepoint's RELEASE or ROLLBACK never lands inside another. better-sqlite3 ran them in that order too.
- `db.afterCommit(work)` queues work that must wait for the commit (sending an email). It starts after COMMIT, outside the transaction, is dropped if the transaction or its savepoint rolls back, and is never awaited, so a slow mail provider never holds the writer lock. Outside a transaction it starts at once.
- Any error inside the callback rolls back. Code that catches a query error and carries on inside a transaction must use a nested `db.transaction()` (a savepoint), because Postgres aborts the whole transaction on any error. These sites are found by the tests and listed in the port log.

## Dialect: rewritten in the code

| SQLite | Postgres | Sites |
|---|---|---|
| `datetime('now')`, `CURRENT_TIMESTAMP` as a value | `utc_now_text()` | about 300 |
| `datetime('now', '-7 days')` and other modifiers | `utc_text(now() - interval '7 days')` | 16 |
| `julianday(a) - julianday(b)` | `days_between(a, b)` (helper in the baseline) | 132, mostly one seeder |
| `strftime`, `date(… modifiers)` | `to_char` / interval arithmetic, by hand | 7 + 102 |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT (…) DO NOTHING` with an explicit target per site | 36 |
| `INSERT OR REPLACE` | `ON CONFLICT (…) DO UPDATE` | 2 |
| `group_concat(x, sep)` | `string_agg(x, sep)` | 6 |
| `json_extract(c, '$.k')`, `json_each` | `(c::jsonb ->> 'k')`, `jsonb_array_elements` | 5 |
| `LIKE` (case-insensitive in SQLite) | `ILIKE` | 34 |
| `GLOB` | `LIKE` or a regular expression | 3 |
| `sqlite_master`, `PRAGMA table_info` | `information_schema` / `pg_catalog` | 24 + 6 |
| FTS5 `MATCH`, `bm25` | `search_vector @@ query`, `ts_rank` (descending) | 3 |
| `access_review_items.current_role` | always quoted: `"current_role"` | all |
| `code.startsWith('SQLITE_CONSTRAINT')` | SQLSTATE class `23` | 5 |

## Asynchronous code

- Every function that queries becomes `async`; every caller awaits it. A codemod adds `await` at the query leaves, marks enclosing functions `async` and propagates through callers, including across modules through their exports; the test suite catches what static analysis misses.
- `array.forEach(async …)` becomes `for … of`; `array.map(x => query)` becomes `await Promise.all(…)` only where order and concurrency do not matter, otherwise `for … of`.
- Views never query the database (verified), so EJS stays synchronous. Helpers on `app.locals` that query are replaced by values computed in the route or middleware.
- Route handlers registered through `app.get/post/…` are already wrapped by `installAsyncRouteSafety`. Middleware registered with `app.use` is not; any `app.use` middleware that becomes `async` is wrapped explicitly so a rejected promise becomes a 500, not a hung request.
- The Word-export worker thread does not touch the database and is unaffected. Scripts open their own pool.

## Concurrency and more than one instance

SQLite let one writer run at a time. With a connection pool, two requests on the same instance can interleave, so:

- Every transaction takes `pg_advisory_xact_lock(<application key>)` at BEGIN. better-sqlite3 ran each transaction to completion before the next began, not only the 60 `.immediate()` ones, and code relies on it (read `MAX(version_number)`, then insert the next number). `.immediate()` is now the same as the default; `.concurrent()` skips the lock for a transaction shown to be safe without it.
- Each transaction sets `lock_timeout` (30 s, `PG_LOCK_TIMEOUT_MS`), so a query that escapes its transaction's context and waits on the writer lock fails with SQLSTATE 55P03 instead of hanging.
- Hash-chained appends (`audit_log`/`audit_chain`, the TPRM lifecycle and connector chains, the received-events chain) take an advisory transaction lock keyed on the chain before reading its head.
- Not covered: a read followed by a write *outside* any transaction (synchronous, hence safe, under better-sqlite3 in one process). These need their own transaction or a unique constraint; they are part of the multi-instance pass below. A transaction that awaits slow non-database work holds the writer lock meanwhile.
- More than one instance: sessions live in PostgreSQL (`lib/pg/session-store.js`); failed sign-ins are counted in `login_failures` (migration 087); each scheduled job takes an advisory lock so one instance runs it (`lib/jobs.js`); a new notification is checked and inserted under a lock on its identity; boot-time migrations hold a session advisory lock (`migrations/run.js`). Still open: read-then-write sequences outside a transaction, such as the evidence duplicate check by SHA-256 in `routes/evidence.js`, which has no unique constraint behind it.

## Things with no runtime translation

- `PRAGMA foreign_keys = OFF` (workspace and firm deletion, some scripts): rewritten as ordered deletes. Firm deletion is changed so it no longer breaks the audit hash chain.
- `db.backup()` and the SQLite-file backup, restore-check and online-clone scripts: replaced by `pg_dump`/`pg_restore`-based scripts and tests; in AWS, RDS snapshots are the production backup.

## Tests

- `tests/helpers.js` builds one template database per run (baseline plus seeds, C locale, `TimeZone=UTC`) and gives every suite its own database with `CREATE DATABASE … TEMPLATE`. The template connection is closed before cloning.
- Tests that open the SQLite file directly (134 places) use a small async test client over the same adapter.
- `PG_TEST_URL` points at the server; CI gets a `services: postgres` block (postgres:16.4) and the CI-parity script starts the same container.

## Order of work and gates

1. Rebase `postgres/schema` onto the handover baseline; branch `postgres/port` from it.
2. Adapter, `db.js` boot on Postgres (baseline, seeds, migrations), `tests/helpers.js`. **Gate A:** a fresh database has exactly the same reference data as SQLite (same diff as the schema work).
3. **Gate B:** `tests/smoke.test.js` passes. It walks the main workflows across most routes, so it proves the async propagation on one file first.
4. Codemod across the code, then the dialect rewrite. Remaining failures are split across the five areas used for the carve-out; those agents never edit the adapter, they report what it lacks.
5. **Gate C:** the full suite passes on Postgres on Mac and on Linux / Node 22, with CI's `services: postgres`.
6. Multi-instance items and backup scripts.
7. Remove `better-sqlite3`, the SQLite session store, `DB_PATH` and the SQLite baseline; `DATABASE_URL` is required. The Dockerfile drops the native build.
