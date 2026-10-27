const { db } = require('./../db');
const enc = require('./encryption');
const ctlReads = require('./control-reads');

async function lockWorkspaceIndex(workspaceId) {
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`search_index:${workspaceId}`);
}

async function writeEntity({ workspaceId, entityType, entityId, title, body }) {
  const t = enc.decryptIfNeeded(title || '', workspaceId);
  const b = enc.decryptIfNeeded(body || '', workspaceId);
  await db.prepare(`DELETE FROM search_index WHERE workspace_id=? AND entity_type=? AND entity_id=?`)
    .run(workspaceId, entityType, String(entityId));
  await db.prepare(`INSERT INTO search_index (workspace_id, entity_type, entity_id, title, body) VALUES (?, ?, ?, ?, ?)`)
    .run(workspaceId, entityType, String(entityId), String(t || ''), String(b || ''));
}

async function indexEntity(entity) {
  await db.transaction(async () => { await writeEntity(entity); })();
}

async function removeEntity({ workspaceId, entityType, entityId }) {
  await db.prepare(`DELETE FROM search_index WHERE workspace_id=? AND entity_type=? AND entity_id=?`).run(workspaceId, entityType, String(entityId));
}

function searchTerms(query) {
  return String(query)
    .split(/\s+/)
    .map(term => term.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
    .filter(parts => parts.length)
    .map(parts => '(' + parts.map((part, i) => (i === parts.length - 1 ? `${part}:*` : part)).join(' <-> ') + ')');
}

async function search(workspaceId, query, limit = 50) {
  if (!query || !query.trim()) return [];
  try {
    const indexCount = (await db.prepare(`SELECT COUNT(*) AS n FROM search_index WHERE workspace_id=?`).get(workspaceId)).n;
    const src = (await db.prepare(`SELECT
      (SELECT COUNT(*) FROM risks WHERE workspace_id=?)
      + (SELECT COUNT(*) FROM assets WHERE workspace_id=?)
      + (SELECT COUNT(*) FROM ${ctlReads.tables(db, workspaceId).cs} WHERE workspace_id=?)
      + (SELECT COUNT(*) FROM generated_docs WHERE workspace_id=?)
      + (SELECT COUNT(*) FROM suppliers WHERE workspace_id=?)
      + (SELECT COUNT(*) FROM nonconformities WHERE workspace_id=?)
      + (SELECT COUNT(*) FROM incidents WHERE workspace_id=?) AS n`)
      .get(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId)).n;
    if (indexCount !== src) {
      await rebuildAll(workspaceId);
    }
  } catch (_) { }
  const terms = searchTerms(query);
  if (!terms.length) return [];
  try {
    const rows = await db.prepare(`SELECT entity_type, entity_id, title, excerpt, score,
        pos > 0 AND substr(body, 1, pos - 1) ~ '[[:alnum:]]|[^\\x01-\\x7F]' AS cut_start,
        pos > 0 AND substr(body, pos + length(plain)) ~ '[[:alnum:]]|[^\\x01-\\x7F]' AS cut_end
      FROM (
        SELECT entity_type, entity_id, title, body,
          ts_headline('simple', body, marks, 'StartSel=<<, StopSel=>>, MaxWords=12, MinWords=4, MaxFragments=1') AS excerpt,
          ts_rank(search_vector, matches) AS score
        FROM search_index, to_tsquery('simple', ?) AS matches, to_tsquery('simple', ?) AS marks
        WHERE workspace_id=? AND search_vector @@ matches
        ORDER BY score DESC
        LIMIT ?
      ) hits
      CROSS JOIN LATERAL (SELECT replace(replace(hits.excerpt, '<<', ''), '>>', '') AS plain) stripped
      CROSS JOIN LATERAL (SELECT strpos(hits.body, stripped.plain) AS pos) located
      ORDER BY score DESC`).all(terms.join(' & '), terms.join(' | '), workspaceId, limit);
    return rows.map(row => ({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      title: row.title,
      excerpt: `${row.cut_start ? '…' : ''}${row.excerpt == null ? '' : row.excerpt}${row.cut_end ? '…' : ''}`,
      score: row.score,
    }));
  } catch (e) {
    return [];
  }
}

async function refresh(workspaceId, entityType, entityId) {
  if (!workspaceId || !entityType || entityId == null) return;
  try {
    await db.transaction(async () => {
      let row;
      switch (entityType) {
        case 'risk':
          row = await db.prepare(`SELECT title, description FROM risks WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.title, body: row.description });
          break;
        case 'asset':
          row = await db.prepare(`SELECT name, description FROM assets WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.name, body: row.description });
          break;
        case 'control':
          row = await db.prepare(`SELECT i.title, cs.notes FROM iso_items i
            LEFT JOIN ${ctlReads.tables(db, workspaceId).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
            WHERE i.id=?`).get(workspaceId, entityId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.title, body: row.notes });
          break;
        case 'document':
          row = await db.prepare(`SELECT name, content FROM generated_docs WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.name, body: row.content });
          break;
        case 'supplier':
          row = await db.prepare(`SELECT name, service_provided, notes FROM suppliers WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.name,
            body: (row.service_provided || '') + '\n' + (row.notes || '') });
          break;
        case 'nc':
          row = await db.prepare(`SELECT title, description FROM nonconformities WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.title, body: row.description });
          break;
        case 'incident':
          row = await db.prepare(`SELECT title, description FROM incidents WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
          if (row) await writeEntity({ workspaceId, entityType, entityId, title: row.title, body: row.description });
          break;
      }
    })();
  } catch (e) {
    if (process.env.DEBUG_FTS === '1') console.warn('[fts] refresh failed:', e.message);
  }
}

async function rebuildAll(workspaceId) {
  return await db.transaction(async () => {
    await lockWorkspaceIndex(workspaceId);
    let n = 0;
    await db.prepare(`DELETE FROM search_index WHERE workspace_id=?`).run(workspaceId);
    for (const r of await db.prepare(`SELECT id, title, description FROM risks WHERE workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'risk', entityId: r.id, title: r.title, body: r.description });
      n++;
    }
    for (const a of await db.prepare(`SELECT id, name, description FROM assets WHERE workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'asset', entityId: a.id, title: a.name, body: a.description });
      n++;
    }
    for (const c of await db.prepare(`SELECT cs.iso_item_id, i.title, cs.notes FROM ${ctlReads.tables(db, workspaceId).cs} cs INNER JOIN iso_items i ON i.id=cs.iso_item_id WHERE cs.workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'control', entityId: c.iso_item_id, title: c.title, body: c.notes });
      n++;
    }
    for (const d of await db.prepare(`SELECT id, name, content FROM generated_docs WHERE workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'document', entityId: d.id, title: d.name, body: d.content });
      n++;
    }
    for (const s of await db.prepare(`SELECT id, name, service_provided, notes FROM suppliers WHERE workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'supplier', entityId: s.id, title: s.name, body: (s.service_provided || '') + '\n' + (s.notes || '') });
      n++;
    }
    for (const nc of await db.prepare(`SELECT id, title, description FROM nonconformities WHERE workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'nc', entityId: nc.id, title: nc.title, body: nc.description });
      n++;
    }
    for (const i of await db.prepare(`SELECT id, title, description FROM incidents WHERE workspace_id=?`).all(workspaceId)) {
      await writeEntity({ workspaceId, entityType: 'incident', entityId: i.id, title: i.title, body: i.description });
      n++;
    }
    return n;
  })();
}

module.exports = { indexEntity, removeEntity, refresh, search, rebuildAll };
