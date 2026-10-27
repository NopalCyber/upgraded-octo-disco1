'use strict';

const RETAINED_TABLES = new Set(['audit_log', 'audit_chain']);

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

async function tableColumns(db) {
  const rows = await db.prepare(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position
  `).all();
  const tables = new Map();
  for (const row of rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, new Set());
    tables.get(row.table_name).add(row.column_name);
  }
  return tables;
}

async function foreignKeys(db) {
  return await db.prepare(`
    SELECT con.conname AS name, child.relname AS child, parent.relname AS parent,
           con.confdeltype AS on_delete, con.condeferrable AS deferrable, con.condeferred AS deferred
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype = 'f' AND n.nspname = current_schema()
    ORDER BY child.relname, con.conname
  `).all();
}

async function immutableMutationTriggers(db) {
  return await db.prepare(`
    SELECT c.relname AS table_name, t.tgname AS name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = current_schema()
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
      AND (t.tgtype & 2) = 2
      AND (t.tgtype & 24) <> 0
      AND p.prosrc ~* 'RAISE[[:space:]]+EXCEPTION'
    ORDER BY c.relname, t.tgname
  `).all();
}

async function workspaceScopedTables(db) {
  const tables = await tableColumns(db);
  return [...tables.entries()]
    .filter(([name, columns]) => name !== 'workspaces' && columns.has('workspace_id'))
    .map(([name]) => name)
    .sort();
}

function deletionOrder(targets, fks) {
  const nodes = [...targets].sort();
  const edges = new Map(nodes.map(name => [name, new Set()]));
  const addEdge = (before, after) => {
    if (before !== after && targets.has(before) && targets.has(after)) edges.get(before).add(after);
  };

  const cascadeParents = new Map();
  for (const fk of fks) {
    if (fk.on_delete !== 'c' || fk.child === fk.parent) continue;
    if (!cascadeParents.has(fk.child)) cascadeParents.set(fk.child, new Set());
    cascadeParents.get(fk.child).add(fk.parent);
  }
  const cascadeRoots = (table, seen = new Set()) => {
    const roots = new Set();
    if (seen.has(table)) return roots;
    seen.add(table);
    for (const parent of cascadeParents.get(table) || []) {
      if (targets.has(parent)) roots.add(parent);
      else for (const root of cascadeRoots(parent, seen)) roots.add(root);
    }
    return roots;
  };

  for (const fk of fks) {
    if (targets.has(fk.child)) {
      addEdge(fk.child, fk.parent);
    } else if (targets.has(fk.parent) && (fk.on_delete === 'a' || fk.on_delete === 'r')) {
      for (const root of cascadeRoots(fk.child)) addEdge(root, fk.parent);
    }
  }

  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const component = new Map();
  const components = [];
  const visit = (node) => {
    index.set(node, counter); low.set(node, counter); counter += 1;
    stack.push(node); onStack.add(node);
    for (const next of edges.get(node)) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (low.get(node) === index.get(node)) {
      const members = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); members.push(member); } while (member !== node);
      members.sort();
      for (const name of members) component.set(name, components.length);
      components.push(members);
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);

  const after = components.map(() => new Set());
  const pending = components.map(() => 0);
  for (const [table, later] of edges) {
    for (const next of later) {
      const from = component.get(table);
      const to = component.get(next);
      if (from !== to && !after[from].has(to)) { after[from].add(to); pending[to] += 1; }
    }
  }
  const ready = components.map((_, i) => i).filter(i => pending[i] === 0);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => components[a][0].localeCompare(components[b][0]));
    const next = ready.shift();
    order.push(components[next]);
    for (const to of after[next]) {
      pending[to] -= 1;
      if (pending[to] === 0) ready.push(to);
    }
  }
  if (order.length !== components.length) throw new Error('Could not order the purge by foreign keys.');
  return order;
}

function affectedTables(targets, fks) {
  const affected = new Set(targets);
  let grew = true;
  while (grew) {
    grew = false;
    for (const fk of fks) {
      if (['c', 'n', 'd'].includes(fk.on_delete) && affected.has(fk.parent) && !affected.has(fk.child)) {
        affected.add(fk.child);
        grew = true;
      }
    }
  }
  return affected;
}

async function purge(db, predicates, afterDelete) {
  if (!db.inTransaction) throw new Error('A purge must run inside a transaction');
  const fks = await foreignKeys(db);
  const targets = new Set(predicates.keys());
  const affected = affectedTables(targets, fks);
  const guards = (await immutableMutationTriggers(db)).filter(trigger => affected.has(trigger.table_name));
  const order = deletionOrder(targets, fks);

  const deferrable = [...new Set(fks.filter(fk => fk.deferrable).map(fk => quoteIdentifier(fk.name)))];
  const initiallyDeferred = [...new Set(fks.filter(fk => fk.deferrable && fk.deferred).map(fk => quoteIdentifier(fk.name)))];
  if (deferrable.length) await db.exec(`SET CONSTRAINTS ${deferrable.join(', ')} IMMEDIATE`);

  for (const trigger of guards) {
    await db.exec(`ALTER TABLE ${quoteIdentifier(trigger.table_name)} DISABLE TRIGGER ${quoteIdentifier(trigger.name)}`);
  }

  const counts = {};
  for (const group of order) {
    const statements = group.map(table => {
      const predicate = predicates.get(table);
      return { table, sql: `DELETE FROM ${quoteIdentifier(table)} WHERE ${predicate.sql}`, params: predicate.params };
    });
    if (statements.length === 1) {
      counts[group[0]] = (await db.prepare(statements[0].sql).run(...statements[0].params)).changes;
    } else {
      const sql = `WITH ${statements.map((s, i) => `purge_${i} AS (${s.sql} RETURNING 1)`).join(', ')}
        SELECT ${statements.map((s, i) => `(SELECT COUNT(*) FROM purge_${i}) AS c${i}`).join(', ')}`;
      const row = await db.prepare(sql).get(...statements.flatMap(s => s.params));
      statements.forEach((s, i) => { counts[s.table] = Number(row[`c${i}`]); });
    }
  }

  if (afterDelete) await afterDelete(counts);

  for (const trigger of guards) {
    await db.exec(`ALTER TABLE ${quoteIdentifier(trigger.table_name)} ENABLE TRIGGER ${quoteIdentifier(trigger.name)}`);
  }
  if (initiallyDeferred.length) await db.exec(`SET CONSTRAINTS ${initiallyDeferred.join(', ')} DEFERRED`);
  return { order, counts, suspendedTriggers: guards.length };
}

async function tableExists(db, name) {
  return !!(await db.prepare(`SELECT to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?)) AS reg`).get(name)).reg;
}

async function scopePredicates(db, { workspaceIds = [], firmId = null }) {
  const tables = await tableColumns(db);
  const predicates = new Map();
  const add = (table, sql, params) => {
    const existing = predicates.get(table);
    if (existing) predicates.set(table, { sql: `(${existing.sql}) OR (${sql})`, params: [...existing.params, ...params] });
    else predicates.set(table, { sql, params });
  };
  for (const [table, columns] of tables) {
    if (RETAINED_TABLES.has(table)) continue;
    if (workspaceIds.length) {
      if (table === 'workspaces') add(table, `id IN (${placeholders(workspaceIds)})`, workspaceIds);
      else if (columns.has('workspace_id')) add(table, `workspace_id IN (${placeholders(workspaceIds)})`, workspaceIds);
    }
    if (firmId != null) {
      if (table === 'firms') add(table, 'id = ?', [firmId]);
      else if (columns.has('firm_id')) add(table, 'firm_id = ?', [firmId]);
    }
  }
  if (workspaceIds.length && tables.has('assessment_pass_manifest_items') && !predicates.has('assessment_pass_manifest_items')) {
    add('assessment_pass_manifest_items',
      `manifest_id IN (SELECT id FROM assessment_pass_manifests WHERE workspace_id IN (${placeholders(workspaceIds)}))`,
      workspaceIds);
  }
  return predicates;
}

async function workspaceStoredPaths(db, workspace) {
  const id = Number(workspace && workspace.id);
  if (!Number.isInteger(id) || id < 1) throw new TypeError('A valid workspace is required.');

  const paths = new Set();
  const addRows = async sql => {
    for (const row of await db.prepare(sql).all(id)) {
      const storedPath = String(row.stored_path || '').trim();
      if (storedPath) paths.add(storedPath);
    }
  };

  await addRows('SELECT stored_path FROM evidence WHERE workspace_id=? AND stored_path IS NOT NULL');
  await addRows('SELECT source_stored_path AS stored_path FROM generated_docs WHERE workspace_id=? AND source_stored_path IS NOT NULL');
  await addRows('SELECT stored_path FROM questionnaire_attachments WHERE workspace_id=? AND stored_path IS NOT NULL');
  await addRows('SELECT stored_path FROM supplier_ddq_evidence WHERE workspace_id=? AND stored_path IS NOT NULL');
  await addRows('SELECT stored_path FROM supplier_documents WHERE workspace_id=? AND stored_path IS NOT NULL');

  const logoPath = String(workspace.brand_logo_path || '').trim();
  if (logoPath) paths.add(logoPath);
  return [...paths];
}

async function deleteWorkspace(db, workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id < 1) throw new TypeError('A valid workspace id is required.');

  const run = db.transaction(async () => {
    const workspace = await db.prepare('SELECT firm_id FROM workspaces WHERE id=? FOR UPDATE').get(id);
    if (!workspace) throw new Error('Workspace no longer exists.');
    const predicates = await scopePredicates(db, { workspaceIds: [id] });

    const result = await purge(db, predicates, async (counts) => {
      if (counts.workspaces !== 1) throw new Error('Workspace no longer exists.');
      const hasRemainingClient = await db.prepare('SELECT 1 FROM workspaces WHERE firm_id=? LIMIT 1').get(workspace.firm_id);
      if (!hasRemainingClient && await tableExists(db, 'tenant_onboarding')) {
        await db.prepare('UPDATE tenant_onboarding SET completed_at=NULL WHERE firm_id=?').run(workspace.firm_id);
      }
    });

    return {
      workspaceId: id,
      suspendedTriggers: result.suspendedTriggers,
      clearedTables: predicates.size - 1,
    };
  });

  return await run();
}

async function deleteFirm(db, firmId) {
  const id = Number(firmId);
  if (!Number.isInteger(id) || id < 1) throw new TypeError('A valid firm id is required.');

  const run = db.transaction(async () => {
    const firm = await db.prepare('SELECT id FROM firms WHERE id=? FOR UPDATE').get(id);
    if (!firm) throw new Error('Firm no longer exists.');
    const workspaceIds = (await db.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id').all(id)).map(row => row.id);
    const predicates = await scopePredicates(db, { workspaceIds, firmId: id });
    const result = await purge(db, predicates, async (counts) => {
      if (counts.firms !== 1) throw new Error('Firm no longer exists.');
    });
    return {
      firmId: id,
      workspaces: workspaceIds.length,
      suspendedTriggers: result.suspendedTriggers,
      clearedTables: predicates.size - 1,
    };
  });

  return await run();
}

module.exports = {
  RETAINED_TABLES,
  deleteFirm,
  deleteWorkspace,
  deletionOrder,
  foreignKeys,
  immutableMutationTriggers,
  scopePredicates,
  workspaceScopedTables,
  workspaceStoredPaths,
};
