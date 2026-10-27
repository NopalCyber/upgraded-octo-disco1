'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const H = (c) => c.repeat(64);
const ING = (c) => c.repeat(32);
const SUP = '(SELECT min(id) FROM suppliers WHERE workspace_id=1)';
const EVI = '(SELECT min(id) FROM evidence WHERE workspace_id=1)';
const CI = '(SELECT min(id) FROM control_instances)';

const scenarios = [
  {
    name: 'immutability: gap_fieldwork_snapshots (no_update / no_delete)',
    steps: [
      [`INSERT INTO gap_fieldwork_snapshots (id, workspace_id, week_ending, requirements_covered, requirements_total, interviews_completed, interviews_planned, requests_received, requests_total, active_blockers, declared_defaults, snapshot_json, snapshot_hash, created_by) VALUES (9001, 1, '2026-10-02', 1, 2, 3, 4, 5, 6, 7, 8, '{"k":1}', '${H('a')}', 1)`, 'ok'],
      ['UPDATE gap_fieldwork_snapshots SET requirements_covered = 2 WHERE id = 9001', 'abort'],
      ['DELETE FROM gap_fieldwork_snapshots WHERE id = 9001', 'abort'],
      ['UPDATE gap_fieldwork_snapshots SET requirements_covered = 2 WHERE id = -1', 'ok'],
      ['SELECT count(*) AS n, max(requirements_covered) AS rc FROM gap_fieldwork_snapshots WHERE id = 9001', 'query'],
    ],
  },
  {
    name: 'immutability + transitions: tprm_modules, tprm_lifecycle_events (hash chain)',
    steps: [
      ["INSERT INTO tprm_modules (id, workspace_id, status, created_by) VALUES (9001, 1, 'needs_classification', 1)", 'ok'],
      ["UPDATE tprm_modules SET status = 'active', service_model = 'assessment_only' WHERE id = 9001", 'ok'],
      ['UPDATE tprm_modules SET workspace_id = 2 WHERE id = 9001', 'abort'],
      ['DELETE FROM tprm_modules WHERE id = 9001', 'abort'],
      [`INSERT INTO tprm_lifecycle_events (id, workspace_id, module_id, event_type, actor_type, actor_name, previous_event_hash, event_hash) VALUES (9001, 1, 9001, 'module_enabled', 'system', 'system', NULL, '${H('a')}')`, 'ok'],
      [`INSERT INTO tprm_lifecycle_events (id, workspace_id, module_id, event_type, actor_type, actor_name, previous_event_hash, event_hash) VALUES (9002, 1, 9001, 'module_classified', 'system', 'system', '${H('b')}', '${H('c')}')`, 'abort'],
      [`INSERT INTO tprm_lifecycle_events (id, workspace_id, module_id, event_type, actor_type, actor_name, previous_event_hash, event_hash) VALUES (9002, 1, 9001, 'module_classified', 'system', 'system', '${H('a')}', '${H('c')}')`, 'ok'],
      [`INSERT INTO tprm_lifecycle_events (id, workspace_id, module_id, event_type, actor_type, actor_name, previous_event_hash, event_hash) VALUES (9003, 1, 9001, 'module_closed', 'system', 'system', '${H('c')}', NULL)`, 'abort'],
      ["UPDATE tprm_lifecycle_events SET reason = 'edit' WHERE id = 9001", 'abort'],
      ['DELETE FROM tprm_lifecycle_events WHERE id = 9002', 'abort'],
      ['SELECT id, previous_event_hash, event_hash FROM tprm_lifecycle_events WHERE module_id = 9001 ORDER BY id', 'query'],
      ["UPDATE tprm_modules SET status = 'closed', effective_to = '2026-12-31 00:00:00' WHERE id = 9001", 'ok'],
      ["UPDATE tprm_modules SET status = 'active', effective_to = NULL WHERE id = 9001", 'abort'],
      ['SELECT status, service_model, effective_to FROM tprm_modules WHERE id = 9001', 'query'],
    ],
  },
  {
    name: 'known difference: one UPDATE violating two triggers on the same event',
    steps: [
      ["INSERT INTO tprm_modules (id, workspace_id, status, created_by) VALUES (9001, 1, 'active', 1)", 'check'],
      ["INSERT INTO tprm_modules (id, workspace_id, status, service_model, created_by) VALUES (9001, 1, 'active', 'assessment_only', 1)", 'ok'],
      ["UPDATE tprm_modules SET status = 'needs_classification', service_model = NULL WHERE id = 9001", 'abort-any'],
    ],
  },
  {
    name: 'calendar dates: trg_supplier_contract_agreement_complete(_insert) + sqlite_date_ymd',
    steps: [
      ...['2024-02-30', '2023-02-29', '2024-13-01', '2024-00-10', '2024-04-31', '2024-1-01', 'abcd-ef-gh'].map((d) =>
        [`INSERT INTO supplier_contract_reviews (workspace_id, supplier_id, methodology_version, status, agreement_reference, agreement_date) VALUES (1, ${SUP}, 'v1', 'complete', 'MSA-1', '${d}')`, 'abort']),
      ...['2024-02-29', '0000-02-29', '2023-12-31'].map((d) =>
        [`INSERT INTO supplier_contract_reviews (workspace_id, supplier_id, methodology_version, status, agreement_reference, agreement_date) VALUES (1, ${SUP}, 'v1', 'complete', 'MSA-1', '${d}')`, 'ok']),
      [`INSERT INTO supplier_contract_reviews (workspace_id, supplier_id, methodology_version, status, agreement_reference, agreement_date) VALUES (1, ${SUP}, 'v1', 'complete', ' MSA-1', '2024-02-29')`, 'abort'],
      [`INSERT INTO supplier_contract_reviews (id, workspace_id, supplier_id, methodology_version, status, agreement_reference, agreement_date) VALUES (9001, 1, ${SUP}, 'v1', 'in_progress', 'MSA-2', '2025-02-29')`, 'ok'],
      ["UPDATE supplier_contract_reviews SET status = 'complete' WHERE id = 9001", 'abort'],
      ["UPDATE supplier_contract_reviews SET status = 'complete', agreement_date = '2025-02-28' WHERE id = 9001", 'ok'],
      ["SELECT agreement_reference, agreement_date, status FROM supplier_contract_reviews WHERE workspace_id = 1 AND methodology_version = 'v1' ORDER BY agreement_date, agreement_reference", 'query'],
    ],
  },
  {
    name: 'json_tree secret scan: trg_tprm_connector_no_secret_config_insert/_update, LIKE->ILIKE check',
    steps: [
      ["INSERT INTO tprm_modules (id, workspace_id, status, service_model, created_by) VALUES (9001, 1, 'active', 'assessment_only', 1)", 'ok'],
      ...[
        ['{"auth":{"api_key":"x"}}', 'abort'],
        ['{"items":[{"Client-Secret":"x"}]}', 'abort'],
        ['{"webhook token":"x"}', 'abort'],
        ['{"deep":{"a":[1,[{"b":{"PRIVATE_KEY":1}}]]}}', 'abort'],
        ['{"auth":{"ref":"vault://x"}}', 'ok'],
      ].map(([cfg, exp], i) => [`INSERT INTO tprm_monitoring_connectors (id, workspace_id, module_id, provider_type, capability_mode, name, ingress_key, adapter_config_json, created_by) VALUES (${9001 + i}, 1, 9001, 'csv_import', 'csv', 'Conn ${i}', '${ING(String(i))}', '${cfg}', 1)`, exp]),
      ["INSERT INTO tprm_monitoring_connectors (id, workspace_id, module_id, provider_type, capability_mode, name, ingress_key, adapter_config_json, created_by) VALUES (9010, 1, 9001, 'csv_import', 'csv', 'Conn T', '" + ING('9') + "', '{\"tokens\":[\"a\"],\"token_count\":2}', 1)", 'ok'],
      ['UPDATE tprm_monitoring_connectors SET adapter_config_json = \'{"password":"x"}\', updated_by = 1, row_version = row_version + 1 WHERE id = 9005', 'abort'],
      ['UPDATE tprm_monitoring_connectors SET adapter_config_json = \'{"region":"eu"}\', updated_by = 1, row_version = row_version + 1 WHERE id = 9005', 'ok'],
      ['UPDATE tprm_monitoring_connectors SET name = \'Conn renamed\', updated_by = 1, row_version = row_version + 1 WHERE id = 9005', 'abort'],
      ["UPDATE tprm_monitoring_connectors SET status = 'paused', updated_by = 1, row_version = row_version + 1 WHERE id = 9005", 'abort'],
      ["INSERT INTO tprm_monitoring_connectors (id, workspace_id, module_id, provider_type, capability_mode, name, ingress_key, secret_reference, created_by) VALUES (9011, 1, 9001, 'generic_webhook', 'webhook', 'Conn W', '" + ING('a') + "', 'VAULT://kv/conn-w', 1)", 'ok'],
      ["INSERT INTO tprm_monitoring_connectors (id, workspace_id, module_id, provider_type, capability_mode, name, ingress_key, secret_reference, created_by) VALUES (9012, 1, 9001, 'generic_webhook', 'webhook', 'Conn X', '" + ING('b') + "', 'https://kv/conn-x', 1)", 'check'],
      ['SELECT id, name, adapter_config_json, row_version, updated_by FROM tprm_monitoring_connectors ORDER BY id', 'query'],
    ],
  },
  {
    name: 'AFTER->BEFORE conversions: control_record_version, client_request_release_*',
    steps: [
      [`SELECT record_version FROM control_instances WHERE id = ${CI}`, 'query'],
      [`UPDATE control_instances SET notes = 'port parity' WHERE id = ${CI}`, 'ok'],
      [`SELECT record_version, notes FROM control_instances WHERE id = ${CI}`, 'query'],
      [`UPDATE control_instances SET notes = 'explicit bump', record_version = record_version + 1 WHERE id = ${CI}`, 'ok'],
      [`SELECT record_version, notes FROM control_instances WHERE id = ${CI}`, 'query'],
      ["INSERT INTO client_requests (id, workspace_id, request_type, title, created_by, assignee_id) VALUES (9001, 1, 'evidence', 'Port parity', 3, 6)", 'ok'],
      ["INSERT INTO client_requests (id, workspace_id, request_type, title, created_by) VALUES (9002, 1, 'evidence', 'Unassigned', 4)", 'ok'],
      ['SELECT id, released_by, released_at IS NOT NULL AS released, length(released_at) AS len FROM client_requests WHERE id IN (9001, 9002) ORDER BY id', 'query'],
      ['UPDATE client_requests SET assignee_id = 7 WHERE id = 9002', 'ok'],
      ['SELECT id, released_by, released_at IS NOT NULL AS released, length(released_at) AS len FROM client_requests WHERE id IN (9001, 9002) ORDER BY id', 'query'],
    ],
  },
  {
    name: 'AFTER trigger with IS DISTINCT FROM: trg_evidence_ai_source_stale',
    steps: [
      [`INSERT INTO evidence_ai_indexes (id, workspace_id, evidence_id, source_sha256, source_size_bytes, extractor_version, chunker_version, embedding_provider, embedding_model_requested, embedding_dimensions, vector_format, pipeline_key, disclosure_version, authorization_scope, authorized_by, authorized_at) VALUES (9001, 1, ${EVI}, '${H('a')}', 10, 'x1', 'c1', 'p', 'm', 2048, 'float32le-v1', '${H('b')}', 'd1', 'manual_index', 1, '2026-10-01 00:00:00')`, 'ok'],
      [`UPDATE evidence SET sha256 = sha256 WHERE id = ${EVI}`, 'ok'],
      ['SELECT status, row_version, last_error_code, stale_at IS NULL AS not_stale FROM evidence_ai_indexes WHERE id = 9001', 'query'],
      [`UPDATE evidence SET sha256 = '${H('f')}' WHERE id = ${EVI}`, 'ok'],
      ['SELECT status, row_version, last_error_code, stale_at IS NULL AS not_stale, length(stale_at) AS len FROM evidence_ai_indexes WHERE id = 9001', 'query'],
      ["UPDATE evidence_ai_indexes SET status = 'ready', row_version = row_version + 1 WHERE id = 9001", 'abort'],
      ["UPDATE evidence_ai_indexes SET extractor_version = 'x2', row_version = row_version + 1 WHERE id = 9001", 'abort'],
      ["UPDATE evidence_ai_indexes SET last_error_code = 'e' WHERE id = 9001", 'abort'],
    ],
  },
];

const norm = (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? String(Number(v)) : String(v));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sqlitePath = opt('--sqlite');
const pgUrl = opt('--pg');
if (!sqlitePath || !pgUrl) {
  console.error('Usage: node scripts/postgres/trigger-parity.js --sqlite <path> --pg <postgres-url>');
  process.exit(2);
}

const FIXTURES = [
  "SELECT count(*) AS n FROM workspaces WHERE id = 1 AND firm_id = 1",
  "SELECT count(*) AS n FROM users WHERE id IN (1, 3, 4) AND user_type = 'firm' AND firm_id = 1 AND active = 1",
  "SELECT count(*) AS n FROM users WHERE id IN (6, 7) AND user_type = 'client'",
  'SELECT count(*) AS n FROM suppliers WHERE workspace_id = 1',
  'SELECT count(*) AS n FROM evidence WHERE workspace_id = 1',
  'SELECT count(*) AS n FROM control_instances',
];
const FIXTURE_MIN = [1, 3, 2, 1, 1, 1];

let tmpDir = null;
(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-parity-'));
  const copyPath = path.join(tmpDir, 'copy.db');
  const source = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  source.prepare('VACUUM INTO ?').run(copyPath);
  source.close();
  const lite = new Database(copyPath);
  lite.pragma('foreign_keys = ON');
  const pg = new Client({ connectionString: pgUrl });
  await pg.connect();
  for (let i = 0; i < FIXTURES.length; i++) {
    const l = Number(lite.prepare(FIXTURES[i]).get().n);
    const g = Number((await pg.query(FIXTURES[i])).rows[0].n);
    if (l < FIXTURE_MIN[i] || g < FIXTURE_MIN[i]) {
      console.error(`Missing fixture data (sqlite ${l}, postgres ${g}, need ${FIXTURE_MIN[i]}): ${FIXTURES[i]}`);
      console.error('Use a database seeded by scripts/seed-realistic-engagements.js and copied with scripts/sqlite-to-postgres.js.');
      await pg.end();
      lite.close();
      return 2;
    }
  }
  let pass = 0, fail = 0;
  const lines = [];
  for (const sc of scenarios) {
    lines.push(`\n# ${sc.name}`);
    lite.exec('BEGIN');
    await pg.query('BEGIN');
    for (const [sql, expect] of sc.steps) {
      let L, G;
      try {
        if (expect === 'query') L = { rows: lite.prepare(sql).all().map((r) => Object.values(r).map(norm)) };
        else { lite.prepare(sql).run(); L = { ok: true }; }
      } catch (e) { L = { err: e.message, code: e.code }; }
      try {
        await pg.query('SAVEPOINT step');
        if (expect === 'query') G = { rows: (await pg.query({ text: sql, rowMode: 'array' })).rows.map((r) => r.map(norm)) };
        else { await pg.query(sql); G = { ok: true }; }
        await pg.query('RELEASE SAVEPOINT step');
      } catch (e) {
        await pg.query('ROLLBACK TO SAVEPOINT step');
        G = { err: e.message, code: e.code };
      }
      let ok;
      if (expect === 'query') ok = !L.err && !G.err && JSON.stringify(L.rows) === JSON.stringify(G.rows);
      else if (expect === 'ok') ok = L.ok && G.ok;
      else if (expect === 'abort') ok = L.err && G.err && L.err === G.err && L.code === 'SQLITE_CONSTRAINT_TRIGGER' && G.code === '23000';
      else if (expect === 'abort-any') ok = L.err && G.err && L.code === 'SQLITE_CONSTRAINT_TRIGGER' && G.code === '23000';
      else if (expect === 'check') ok = L.err && G.err && /^SQLITE_CONSTRAINT/.test(L.code) && /^23/.test(G.code);
      ok ? pass++ : fail++;
      const show = (x) => (x.rows ? JSON.stringify(x.rows) : x.ok ? 'ok' : `${x.code}: ${x.err}`);
      const same = show(L) === show(G) || (L.err && G.err && L.err === G.err);
      lines.push(`${ok ? 'PASS' : 'FAIL'} [${expect}] ${sql.replace(/\s+/g, ' ').slice(0, 150)}`);
      if (same && !L.rows) lines.push(`     both: ${L.ok ? 'ok' : L.err}  (sqlite ${L.code || 'ok'} / pg ${G.code || 'ok'})`);
      else if (same) lines.push(`     both: ${show(L)}`);
      else { lines.push(`     sqlite: ${show(L)}`); lines.push(`     pg:     ${show(G)}`); }
    }
    lite.exec('ROLLBACK');
    await pg.query('ROLLBACK');
  }

  lines.push('\n# helper functions vs SQLite built-ins');
  const dates = [];
  for (const y of ['0000', '1900', '2000', '2023', '2024', '2100', '9999'])
    for (let m = 0; m <= 13; m++) for (let d = 0; d <= 32; d++) dates.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  dates.push('2024-1-011', 'abcd-ef-gh', '2024/02/01', '', ' 2024-01-1', '+024-01-01', '-024-01-01');
  let dateDiff = 0;
  const lq = lite.prepare("SELECT strftime('%Y-%m-%d', ?||' 00:00:00', '+0 days') AS r");
  for (const d of dates) {
    const l = lq.get(d).r;
    const g = (await pg.query('SELECT sqlite_date_ymd($1) AS r', [d])).rows[0].r;
    if (l !== g) { dateDiff++; if (dateDiff < 5) lines.push(`  date ${d}: sqlite ${l} pg ${g}`); }
  }
  lines.push(`${dateDiff ? 'FAIL' : 'PASS'} sqlite_date_ymd vs strftime('%Y-%m-%d', x||' 00:00:00', '+0 days'): ${dates.length} inputs, ${dateDiff} differences`);
  dateDiff ? fail++ : pass++;

  const docs = ['{}', '[]', '1', '"s"', 'null', '{"a":1,"b":{"c":[1,{"d":2}]}}', '[{"x":[{"y":1}]},2,[3,[4]]]', '{"a":{"a":{"a":1}},"a":2}', '{"k-1":{"K 2":[{"z":null}]}}'];
  let treeDiff = 0;
  const lt = lite.prepare('SELECT key FROM json_tree(?)');
  for (const doc of docs) {
    const l = lt.all(doc).map((r) => (r.key == null ? null : String(r.key))).sort();
    const g = (await pg.query('SELECT key FROM sqlite_json_tree_keys($1)', [doc])).rows.map((r) => r.key).sort();
    if (JSON.stringify(l) !== JSON.stringify(g)) { treeDiff++; lines.push(`  json_tree ${doc}: sqlite ${JSON.stringify(l)} pg ${JSON.stringify(g)}`); }
  }
  lines.push(`${treeDiff ? 'FAIL' : 'PASS'} sqlite_json_tree_keys vs json_tree(...).key: ${docs.length} documents, ${treeDiff} differences`);
  treeDiff ? fail++ : pass++;

  const jsons = ['{}', '[]', '[1,2]', ' [1] ', '1', '"x"', 'true', 'null', '', 'x', '{a:1}', "{'a':1}", '[1,]', '{"a":1', '{"a":"\\u0000"}', '1e5', '-0', '01'];
  let jsonDiff = 0;
  for (const j of jsons) {
    const l = lite.prepare('SELECT json_valid(?) AS v, CASE WHEN json_valid(?) THEN json_type(?) END AS t').get(j, j, j);
    const g = (await pg.query("SELECT ($1::text IS JSON) AS v, ($1::text IS JSON ARRAY) AS a", [j])).rows[0];
    if (Boolean(l.v) !== g.v || (l.t === 'array') !== Boolean(g.a)) { jsonDiff++; lines.push(`  json ${JSON.stringify(j)}: sqlite valid=${l.v} type=${l.t} pg valid=${g.v} array=${g.a}`); }
  }
  lines.push(`${jsonDiff ? 'FAIL' : 'PASS'} IS JSON / IS JSON ARRAY vs json_valid / json_type='array': ${jsons.length} inputs, ${jsonDiff} differences`);
  jsonDiff ? fail++ : pass++;

  const ln = lite.prepare("SELECT datetime('now') AS n").get().n;
  const gn = (await pg.query('SELECT utc_now_text() AS n')).rows[0].n;
  const nowOk = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(gn) && Math.abs(Date.parse(ln + 'Z') - Date.parse(gn + 'Z')) < 5000;
  lines.push(`${nowOk ? 'PASS' : 'FAIL'} utc_now_text() ${gn} vs datetime('now') ${ln}`);
  nowOk ? pass++ : fail++;

  console.log(lines.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await pg.end();
  lite.close();
  return fail ? 1 : 0;
})().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; })
  .finally(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });
