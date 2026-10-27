'use strict';

const ctlWrites = require('./control-writes');
const reqOpts = require('./requirement-options');

const TABLES = Object.freeze({ iso27001: 'risk_controls' });
const CATALOGUES = Object.freeze({ iso27001: 'iso_items' });

function frameworksFor(workspace) {
  return reqOpts.enabledCodes(workspace).filter((code) => TABLES[code]);
}

async function ownerOf(db, workspace, riskId) {
  const row = await db.prepare('SELECT management_system FROM risks WHERE id=? AND workspace_id=?').get(riskId, workspace.id);
  return row ? row.management_system : null;
}

async function pickerGroups(db, workspace, riskId = null) {
  const owner = riskId ? await ownerOf(db, workspace, riskId) : null;
  const codes = frameworksFor(workspace).filter((code) => !owner || code === owner);
  return (await reqOpts.grouped(db, workspace, { types: 'control' })).filter((g) => codes.includes(g.framework));
}

async function link(db, workspace, riskId, itemId) {
  const framework = await reqOpts.frameworkOf(db, itemId);
  if (!framework || !frameworksFor(workspace).includes(framework)) return null;
  const owner = await ownerOf(db, workspace, riskId);
  if (owner && owner !== framework) return null;
  const isControl = await db.prepare(`SELECT 1 FROM ${CATALOGUES[framework]} WHERE id=? AND type='control'`).get(itemId);
  if (!isControl) return null;
  await db.prepare(`INSERT INTO ${TABLES[framework]} (risk_id, iso_item_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(riskId, itemId);
  const rid = await ctlWrites.requirementId(db, framework, itemId);
  if (rid) {
    await db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING`).run(workspace.id, rid);
    await db.prepare(`UPDATE control_instances SET applicability='applicable'
      WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND applicability='undecided'`).run(workspace.id, rid);
  }
  return framework;
}

async function unlink(db, riskId, itemId) {
  let removed = 0;
  for (const table of Object.values(TABLES)) {
    removed += (await db.prepare(`DELETE FROM ${table} WHERE risk_id=? AND iso_item_id=?`).run(riskId, itemId)).changes;
  }
  return removed;
}

async function linked(db, workspace, riskId) {
  const rows = [];
  for (const [framework, table] of Object.entries(TABLES)) {
    for (const r of await db.prepare(`SELECT i.id, i.title, i.sort_order FROM ${table} rc
        JOIN ${CATALOGUES[framework]} i ON i.id = rc.iso_item_id WHERE rc.risk_id=? ORDER BY i.sort_order`).all(riskId)) {
      rows.push({
        ...r,
        framework,
        frameworkLabel: reqOpts.label(framework),
        href: `/workspaces/${workspace.id}/controls/${r.id}`,
      });
    }
  }
  return rows;
}

module.exports = { TABLES, frameworksFor, ownerOf, pickerGroups, link, unlink, linked };
