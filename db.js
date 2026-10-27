'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDatabase } = require('./lib/pg');
const catalog = require('./data/iso-catalog');
const policyTemplates = require('./data/policy-templates');
const questionnaireTemplates = require('./data/questionnaire-templates');

let database = null;
function connection() {
  if (!database) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. Point it at the PostgreSQL 16 database, for example ' +
        'postgres://user:password@host:5432/isms (the database must use the C collation; see docs/postgres-port.md).');
    }
    database = createDatabase(process.env.DATABASE_URL);
  }
  return database;
}

function deferredStatement(sql) {
  let statement = null;
  let rowMode;
  const bound = () => {
    if (!statement) {
      statement = connection().prepare(sql);
      if (rowMode !== undefined) statement.raw(rowMode);
    }
    return statement;
  };
  const deferred = {
    source: sql,
    raw(enabled = true) { rowMode = enabled; if (statement) statement.raw(enabled); return deferred; },
    get: async (...args) => await bound().get(...args),
    all: async (...args) => await bound().all(...args),
    run: async (...args) => await bound().run(...args),
  };
  return deferred;
}

const db = new Proxy({}, {
  get(_target, property) {
    if (property === 'prepare' && !database) return deferredStatement;
    if (property === 'close' && !database) return async () => {};
    const target = connection();
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  },
  has(_target, property) { return property in connection(); },
});

const SCHEMA = fs.readFileSync(path.join(__dirname, 'migrations', 'postgres', 'baseline.sql'), 'utf8');

async function assertDatabaseLocale() {
  const { rows } = await db.pool.query(`SELECT current_database() AS name, datcollate, datctype,
      datlocprovider, pg_encoding_to_char(encoding) AS encoding
    FROM pg_database WHERE datname = current_database()`);
  const info = rows[0];
  const isC = (value) => value === 'C' || value === 'POSIX';
  if (!info || !isC(info.datcollate) || !isC(info.datctype) || info.datlocprovider !== 'c' || info.encoding !== 'UTF8') {
    const found = info
      ? `LC_COLLATE=${info.datcollate}, LC_CTYPE=${info.datctype}, provider=${({ c: 'libc', i: 'icu', b: 'builtin' })[info.datlocprovider] || info.datlocprovider}, encoding=${info.encoding}`
      : 'no pg_database row';
    throw new Error(`Database "${info ? info.name : '?'}" has ${found}. The application needs a UTF8 database with ` +
      `the C collation; create it with: createdb --template=template0 --encoding=UTF8 --locale-provider=libc --lc-collate=C --lc-ctype=C <name>`);
  }
}

async function init() {
  await assertDatabaseLocale();
  const { applyPending, withBootLock } = require('./migrations/run');
  await withBootLock(db, async () => {
    await db.exec(SCHEMA);
    await db.loadCatalog();
    await seedAndSync(applyPending);
  });
}

async function seedAndSync(applyPending) {
  await db.prepare(`UPDATE audits SET status='complete' WHERE lower(trim(status)) IN ('completed','closed','done')`).run();
  await db.prepare(`UPDATE mrms SET status='complete' WHERE lower(trim(status)) IN ('completed','closed','done')`).run();

  await db.prepare(`UPDATE workspaces SET updated_at = COALESCE(updated_at, created_at, utc_now_text()) WHERE updated_at IS NULL`).run();

  const MANDATORY_PATTERNS = [
    'Information Security Policy',
    'Risk Assessment Methodology', 'Risk Methodology', 'Risk Assessment Process', 'Risk Management Process',
    'Risk Treatment Plan',
    'Statement of Applicability',
    'ISMS Scope',
    'Information Security Objectives',
    'Roles and Responsibilities',
    'Internal Audit Programme', 'Internal Audit Plan', 'Internal Audit Procedure',
    'Management Review',
    'Nonconformity', 'Corrective Action',
    'Operations Security Procedure'
  ];
  const EXPECTED_PATTERNS = [
    'Access Control', 'Acceptable Use', 'Asset Management', 'Asset Inventory',
    'Cryptography', 'Cryptographic', 'Backup', 'Business Continuity',
    'Incident Response', 'Incident Management', 'Change Management',
    'Supplier', 'Vendor', 'Secure Development', 'Communication Plan',
    'Physical and Environmental', 'Logging', 'Monitoring',
    'Awareness', 'Competence', 'Legal', 'Regulatory', 'Compliance Register',
    'Data Classification', 'Information Classification',
    'Privileged Access', 'Authentication', 'ISMS Governance'
  ];
  const tagOne = db.prepare(`UPDATE doc_templates SET tier=? WHERE is_system=1 AND name ILIKE ?`);
  await db.prepare(`UPDATE doc_templates SET tier='recommended' WHERE is_system=1`).run();
  for (const p of EXPECTED_PATTERNS) await tagOne.run('expected', `%${p}%`);
  for (const p of MANDATORY_PATTERNS) await tagOne.run('mandatory', `%${p}%`);

  const refsExtractor = require('./lib/template-refs');
  const refsUpd = db.prepare(`UPDATE doc_templates SET controls=?, clauses=? WHERE id=?`);
  await db.transaction(async () => {
    for (const t of await db.prepare(`SELECT id, description FROM doc_templates WHERE is_system=1`).all()) {
      const { controls, clauses } = refsExtractor.extractRefs(t.description || '');
      await refsUpd.run(JSON.stringify(controls), JSON.stringify(clauses), t.id);
    }
  })();

  try {
    const content = require('./data/iso-content');
    const upd = db.prepare(`UPDATE iso_items SET
      purpose=?, what_good_looks_like=?, common_pitfalls=?, evidence_to_look_for=?,
      scoping_notes=?, maturity_ladder=?, related_items=?, minimum_certifiable=? WHERE id=?`);
    let n = 0;
    for (const [id, c] of Object.entries(content)) {
      const r = await upd.run(
        c.purpose || null,
        c.what_good_looks_like || null,
        c.common_pitfalls ? JSON.stringify(c.common_pitfalls) : null,
        c.evidence_to_look_for ? JSON.stringify(c.evidence_to_look_for) : null,
        c.scoping_notes || null,
        c.maturity_ladder ? JSON.stringify(c.maturity_ladder) : null,
        c.related_items ? JSON.stringify(c.related_items) : null,
        c.minimum_certifiable || null,
        id
      );
      if (r.changes > 0) n++;
    }
    if (n > 0) console.log(`[content] synced ${n} ISO item(s) from data/iso-content.js`);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') console.warn('[content] failed to sync:', e.message);
  }

  const count = (await db.prepare('SELECT COUNT(*) as c FROM iso_items').get()).c;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO iso_items
      (id, type, category, title, summary, questions, evidence_needed, documentation_needed, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(async (items) => {
      for (const it of items) {
        await insert.run(
          it.id, it.type, it.category, it.title, it.summary,
          JSON.stringify(it.questions || []),
          JSON.stringify(it.evidence_needed || []),
          JSON.stringify(it.documentation_needed || []),
          it.sort_order
        );
      }
    });
    await tx(catalog);
    console.log(`[db] Seeded ${catalog.length} ISO items`);
  }

  {
    const tIns = db.prepare(`INSERT INTO doc_templates (firm_id, name, category, description, content, is_system)
                             VALUES (NULL, ?, ?, ?, ?, 1)`);
    const tplExistsStmt = db.prepare('SELECT 1 FROM doc_templates WHERE name = ? AND is_system = 1');
    const tTx = db.transaction(async (tpls) => {
      let added = 0;
      for (const t of tpls) {
        if (!(await tplExistsStmt.get(t.name))) { await tIns.run(t.name, t.category, t.description, t.content); added++; }
      }
      return added;
    });
    const peoplePhysical = require('./data/policy-templates-people-physical');
    const technical = require('./data/policy-templates-technical');
    const organisational = require('./data/policy-templates-organisational');
    const formsRoles = require('./data/policy-templates-forms-roles');
    const bundles = require('./data/policy-templates-bundles');
    const allTemplates = [...policyTemplates, ...peoplePhysical, ...technical, ...organisational, ...formsRoles, ...bundles];
    const tplAdded = await tTx(allTemplates);
    if (tplAdded) console.log(`[db] Added ${tplAdded} new system policy templates (catalog now: ${allTemplates.length})`);
  }

  const userCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
  if (userCount === 0) {
    const firmId = (await db.prepare(`INSERT INTO firms (name) VALUES (?)`).run('My firm')).lastInsertRowid;
    await db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role)
                VALUES (?, ?, ?, 'firm', ?, 'manager')`)
      .run('local@local', '!noauth', 'You', firmId);
    console.log('[db] Seeded default firm and placeholder owner (local@local)');
  }

  const placeholderUsers = await db.prepare(`SELECT id, email, name FROM users WHERE password_hash = '!noauth' ORDER BY id`).all();
  if (placeholderUsers.length) {
    const initPw = process.env.INITIAL_ADMIN_PASSWORD;
    if (!initPw || initPw.length < 8) {
      console.warn(`[auth] ${placeholderUsers.length} user(s) still hold the '!noauth' placeholder. ` +
        `Set INITIAL_ADMIN_PASSWORD (>= 8 chars) in your environment and restart to promote them. ` +
        `Until then, login is impossible — only seed/no-auth flows work.`);
    } else {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync(initPw, 12);
      const newEmail = process.env.INITIAL_ADMIN_EMAIL || null;
      const newName  = process.env.INITIAL_ADMIN_NAME  || null;
      await db.transaction(async () => {
        for (const u of placeholderUsers) {
          let renameEmail = null;
          if (newEmail && newEmail !== u.email) {
            const clash = await db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`).get(newEmail, u.id);
            if (!clash) renameEmail = newEmail;
            else console.warn(`[auth] INITIAL_ADMIN_EMAIL=${newEmail} already in use; keeping ${u.email}`);
          }
          await db.prepare(`UPDATE users SET password_hash = ?, email = COALESCE(?, email), name = COALESCE(?, name) WHERE id = ?`)
            .run(hash, renameEmail, newName, u.id);
          console.log(`[auth] Promoted placeholder user → ${renameEmail || u.email}`);
        }
      })();
    }
  }

  const qtCount = (await db.prepare('SELECT COUNT(*) AS c FROM questionnaire_templates WHERE is_system = 1').get()).c;
  if (qtCount === 0) {
    const insTpl = db.prepare(`INSERT INTO questionnaire_templates (firm_id, name, description, is_system, category) VALUES (NULL, ?, ?, 1, ?)`);
    const insQ = db.prepare(`INSERT INTO questionnaire_questions (template_id, question_order, section, question, question_type, weight, expected_answer, iso_control_ref) VALUES (?, ?, ?, ?, 'yes_no', 1, ?, ?)`);
    const tx = db.transaction(async (tpls) => {
      for (const t of tpls) {
        const tid = (await insTpl.run(t.name, t.description, t.category)).lastInsertRowid;
        for (const [i, q] of t.questions.entries()) await insQ.run(tid, i + 1, q.section, q.q, q.expected, q.iso || null);
      }
    });
    await tx(questionnaireTemplates);
    console.log(`[db] Seeded ${questionnaireTemplates.length} questionnaire templates with ${questionnaireTemplates.reduce((s,t)=>s+t.questions.length,0)} questions`);
  }

  const rbCount = (await db.prepare('SELECT COUNT(*) AS c FROM runbooks WHERE is_system=1').get()).c;
  if (rbCount === 0) {
    const runbooks = require('./data/runbooks');
    const ins = db.prepare('INSERT INTO runbooks (firm_id, name, category, trigger_severity, trigger_category, steps, is_system) VALUES (NULL, ?, ?, ?, ?, ?, 1)');
    for (const r of runbooks) await ins.run(r.name, r.category, r.trigger_severity || null, r.trigger_category || null, JSON.stringify(r.steps));
    console.log(`[db] Seeded ${runbooks.length} runbooks`);
  }

  const ttCount = (await db.prepare('SELECT COUNT(*) AS c FROM task_templates WHERE is_system=1').get()).c;
  if (ttCount === 0) {
    const tts = require('./data/task-templates');
    const ins = db.prepare('INSERT INTO task_templates (workspace_id, firm_id, name, description, category, is_system, steps) VALUES (NULL, NULL, ?, ?, ?, 1, ?)');
    for (const t of tts) await ins.run(t.name, t.description, t.category, JSON.stringify(t.steps));
    console.log(`[db] Seeded ${tts.length} task templates`);
  }

  const ptCount = (await db.prepare('SELECT COUNT(*) AS c FROM permission_templates WHERE is_system=1').get()).c;
  if (ptCount === 0) {
    const pts = require('./data/permission-templates');
    const ins = db.prepare('INSERT INTO permission_templates (firm_id, name, description, permissions, is_system) VALUES (NULL, ?, ?, ?, 1)');
    for (const p of pts) await ins.run(p.name, p.description, JSON.stringify(p.permissions));
    console.log(`[db] Seeded ${pts.length} permission templates`);
  }

  const ccmCount = (await db.prepare('SELECT COUNT(*) AS c FROM ccm_rules WHERE is_system=1').get()).c;
  if (ccmCount === 0) {
    const rules = require('./data/ccm-rules');
    const ins = db.prepare('INSERT INTO ccm_rules (workspace_id, firm_id, iso_item_id, name, description, rule_kind, rule_config, frequency, is_active, is_system) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, 1, 1)');
    for (const r of rules) await ins.run(r.iso_item_id || null, r.name, r.description ?? null, r.rule_kind, JSON.stringify(r.rule_config), r.frequency || 'daily');
    console.log(`[db] Seeded ${rules.length} CCM rules`);
  }

  const rtCount = (await db.prepare('SELECT COUNT(*) AS c FROM report_templates WHERE is_system=1').get()).c;
  if (rtCount === 0) {
    const rts = require('./data/report-templates');
    const ins = db.prepare('INSERT INTO report_templates (workspace_id, firm_id, name, description, body, is_system) VALUES (NULL, NULL, ?, ?, ?, 1)');
    for (const r of rts) await ins.run(r.name, r.description, r.body);
    console.log(`[db] Seeded ${rts.length} report templates`);
  }

  const ccCount = (await db.prepare('SELECT COUNT(*) AS c FROM crisis_comms_templates WHERE is_system=1').get()).c;
  if (ccCount === 0) {
    const ccs = require('./data/crisis-comms');
    const ins = db.prepare('INSERT INTO crisis_comms_templates (firm_id, name, audience, channel, body, is_system) VALUES (NULL, ?, ?, ?, ?, 1)');
    for (const c of ccs) await ins.run(c.name, c.audience, c.channel, c.body);
    console.log(`[db] Seeded ${ccs.length} crisis comms templates`);
  }

  await applyPending(db);
  await db.loadCatalog();

  await db.prepare(`INSERT INTO assurance_report_definitions
    (report_key, name, description, audience, default_sections)
    VALUES
    ('executive_posture', 'Executive security posture',
     'Board-ready view of control implementation, priority risk, assurance activity, and management attention.',
     'Board, executive leadership, risk committee',
     '["executive_summary","posture","priority_risks","assurance","management_attention"]'),
    ('audit_readiness', 'Audit-readiness report',
     'Frozen audit preparation record covering scope, SoA quality, controls, evidence, governance, and open nonconformities.',
     'Internal audit, certification body, ISMS leadership',
     '["executive_summary","scope","soa","controls","evidence","governance","nonconformities","source_manifest"]'),
    ('supplier_due_diligence', 'Supplier due-diligence report',
     'Decision-grade third-party risk report with supplier profile, questionnaire, risk calculation, evidence, findings, and approval history.',
     'Procurement, security, privacy, risk committee',
     '["executive_summary","supplier_profile","risk_assessment","questionnaire","evidence","findings","decision","monitoring","source_manifest"]')
    ON CONFLICT (report_key) DO NOTHING`).run();

  const jparse = (v) => { if (v == null || v === '') return null; try { return JSON.parse(v); } catch { return v; } };
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO frameworks (code,name,version,status,is_canonical) VALUES ('iso27001','ISO/IEC 27001','2022','active',1)
      ON CONFLICT (code, version) DO NOTHING`).run();
    const fwId = (await db.prepare(`SELECT id FROM frameworks WHERE code='iso27001' AND version='2022'`).get()).id;
    const insReq = db.prepare(`INSERT INTO requirements
      (framework_id,ref,parent_ref,req_type,title,summary,guidance,sort_order)
      VALUES (@framework_id,@ref,@parent_ref,@req_type,@title,@summary,@guidance,@sort_order)
      ON CONFLICT (framework_id, ref) DO NOTHING`);
    for (const it of await db.prepare('SELECT * FROM iso_items ORDER BY sort_order, id').all()) {
      await insReq.run({
        framework_id: fwId, ref: it.id, parent_ref: null, req_type: it.type,
        title: it.title, summary: it.summary ?? null, sort_order: it.sort_order ?? null,
        guidance: JSON.stringify({
          category: it.category,
          questions: jparse(it.questions),
          evidence_needed: jparse(it.evidence_needed),
          documentation_needed: jparse(it.documentation_needed),
          purpose: it.purpose ?? null,
          what_good_looks_like: it.what_good_looks_like ?? null,
          common_pitfalls: jparse(it.common_pitfalls),
          evidence_to_look_for: jparse(it.evidence_to_look_for),
          scoping_notes: it.scoping_notes ?? null,
          maturity_ladder: jparse(it.maturity_ladder),
          related_items: jparse(it.related_items),
          minimum_certifiable: it.minimum_certifiable ?? null,
        }),
      });
    }
  })();
}

async function externalSignerId() {
  const ext = await db.prepare(`SELECT id FROM users WHERE email='external@isms.local'`).get();
  if (ext) return ext.id;
  return (await db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active) VALUES ('external@isms.local','!external','External signer','client',0)`).run()).lastInsertRowid;
}

async function logAction(userId, workspaceId, action, entityType, entityId, details, ctx = {}) {
  try {
    return await db.transaction(async () => {
      await db.lockChain('audit_log');
      if (!userId || userId === 0) userId = await externalSignerId();
      const info = await db.prepare(`INSERT INTO audit_log (
          workspace_id, entity_scope_id, user_id, action, entity_type, entity_id,
          details, before_state, after_state, ip_address, user_agent, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        workspaceId || null,
        ctx.entityScopeId || null,
        userId, action,
        entityType || null,
        entityId == null ? null : String(entityId),
        details ? JSON.stringify(details) : null,
        ctx.before ? JSON.stringify(ctx.before) : null,
        ctx.after ? JSON.stringify(ctx.after) : null,
        ctx.ip || null,
        ctx.userAgent || null,
        ctx.requestId || null
      );
      await appendChain(info.lastInsertRowid);
      if (userId && ctx.touchActivity !== false) {
        try {
          await db.transaction(async () => {
            await db.prepare('UPDATE users SET last_active_at=utc_now_text() WHERE id=?').run(userId);
          })();
        } catch (_) { }
      }
      return info;
    })();
  } catch (e) {
    console.error('[audit] failed:', e.message);
    if (ctx && ctx.strict) throw e;
    return null;
  }
}

async function appendChain(auditLogId) {
  const row = await db.prepare('SELECT * FROM audit_log WHERE id=?').get(auditLogId);
  if (!row) return;
  const prev = await db.prepare('SELECT entry_hash FROM audit_chain ORDER BY id DESC LIMIT 1').get();
  const prevHash = prev ? prev.entry_hash : '0'.repeat(64);
  const canonical = JSON.stringify({
    i: row.id, w: row.workspace_id, u: row.user_id, a: row.action,
    et: row.entity_type, ei: row.entity_id, d: row.details,
    b: row.before_state, af: row.after_state,
    ip: row.ip_address, ua: row.user_agent, rid: row.request_id,
    t: row.created_at
  });
  const entryHash = crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
  await db.prepare('INSERT INTO audit_chain (audit_log_id, prev_hash, entry_hash) VALUES (?, ?, ?)')
    .run(auditLogId, prevHash, entryHash);
}

async function verifyAuditChain(workspaceId) {
  const rows = await db.prepare(`SELECT a.*, c.prev_hash, c.entry_hash
    FROM audit_log a LEFT JOIN audit_chain c ON c.audit_log_id=a.id
    ORDER BY a.id`).all();
  const issues = [];
  let prevHash = '0'.repeat(64);
  for (const row of rows) {
    if (!row.entry_hash) { issues.push({ id: row.id, kind: 'no_chain', desc: 'Missing chain entry - log row was inserted without going through logAction()' }); continue; }
    const canonical = JSON.stringify({
      i: row.id, w: row.workspace_id, u: row.user_id, a: row.action,
      et: row.entity_type, ei: row.entity_id, d: row.details,
      b: row.before_state, af: row.after_state,
      ip: row.ip_address, ua: row.user_agent, rid: row.request_id,
      t: row.created_at
    });
    const expected = crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
    if (expected !== row.entry_hash) {
      issues.push({ id: row.id, kind: 'mutated', desc: 'Row content does not match recorded chain hash - entry was modified after the fact.' });
    }
    if (row.prev_hash !== prevHash) {
      issues.push({ id: row.id, kind: 'broken_link', desc: 'Recorded prev_hash does not match preceding entry - earlier rows may have been removed.' });
    }
    prevHash = row.entry_hash;
  }
  if (!workspaceId) return issues;
  const wsRowIds = new Set(rows.filter(r => r.workspace_id === workspaceId).map(r => r.id));
  return issues.filter(i => wsRowIds.has(i.id));
}

function defaultMethodology() {
  return {
    name: 'Default 5x5',
    description: '5×5 likelihood × impact matrix with low/medium/high/critical bands.',
    likelihood_scale: [
      { value: 1, label: 'Rare',          description: 'May occur only in exceptional circumstances' },
      { value: 2, label: 'Unlikely',      description: 'Could occur at some time' },
      { value: 3, label: 'Possible',      description: 'Might occur at some time' },
      { value: 4, label: 'Likely',        description: 'Will probably occur in most circumstances' },
      { value: 5, label: 'Almost certain',description: 'Expected to occur in most circumstances' }
    ],
    impact_scale: [
      { value: 1, label: 'Insignificant', description: 'Minor inconvenience, no measurable damage' },
      { value: 2, label: 'Minor',         description: 'Limited internal impact, easily contained' },
      { value: 3, label: 'Moderate',      description: 'Noticeable disruption, recovery within days' },
      { value: 4, label: 'Major',         description: 'Significant business / regulatory impact' },
      { value: 5, label: 'Severe',        description: 'Existential / catastrophic impact' }
    ],
    matrix: [
      ['low','low','low','medium','medium'],
      ['low','low','medium','medium','high'],
      ['low','medium','medium','high','high'],
      ['medium','medium','high','high','critical'],
      ['medium','high','high','critical','critical']
    ],
    thresholds: {
      low:      { color: '#16a34a', action: 'Accept',                 review_months: 24 },
      medium:   { color: '#ca8a04', action: 'Treat or accept',        review_months: 12 },
      high:     { color: '#ea580c', action: 'Treat (mitigate)',       review_months: 6 },
      critical: { color: '#b91c1c', action: 'Treat or transfer ASAP', review_months: 3 }
    }
  };
}

async function methodologySystem(wsId, system) {
  const riskOwner = require('./lib/risk-owner');
  if (riskOwner.SYSTEMS.includes(system)) return system;
  const ws = await db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(wsId);
  return riskOwner.primary(ws || {});
}

async function ensureWorkspaceMethodology(wsId, system) {
  const owner = await methodologySystem(wsId, system);
  const existing = await db.prepare(`SELECT id FROM risk_methodologies WHERE workspace_id=? AND management_system=? AND is_active=1`).get(wsId, owner);
  if (existing) return existing.id;
  const m = defaultMethodology();
  const id = (await db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active, management_system)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
      wsId, m.name, m.description,
      JSON.stringify(m.likelihood_scale),
      JSON.stringify(m.impact_scale),
      JSON.stringify(m.matrix),
      JSON.stringify(m.thresholds),
      owner
    )).lastInsertRowid;
  return id;
}

async function getActiveMethodology(wsId, system) {
  const owner = await methodologySystem(wsId, system);
  const row = await db.prepare(`SELECT * FROM risk_methodologies WHERE workspace_id=? AND management_system=? AND is_active=1 ORDER BY id DESC`).get(wsId, owner);
  if (!row) return { ...defaultMethodology(), id: null, workspace_id: wsId, is_active: 1, built_in: true, management_system: owner };
  return {
    ...row,
    likelihood_scale: JSON.parse(row.likelihood_scale),
    impact_scale: JSON.parse(row.impact_scale),
    matrix: JSON.parse(row.matrix),
    thresholds: JSON.parse(row.thresholds)
  };
}

function methodologyBand(m, likelihood, impact) {
  const l = Math.max(1, Math.min(m.likelihood_scale.length, parseInt(likelihood) || 1));
  const i = Math.max(1, Math.min(m.impact_scale.length, parseInt(impact) || 1));
  return m.matrix[l - 1][i - 1];
}

module.exports = {
  db, init, logAction, verifyAuditChain,
  defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand
};
