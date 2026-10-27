'use strict';

const SYSTEMS = Object.freeze(['iso27001']);

const systemsOf = () => SYSTEMS.slice();
const hasBoth = () => false;

const primary = () => 'iso27001';

const ownerFor = () => 'iso27001';

async function assign(db, workspace, riskId) {
  const owner = ownerFor(workspace);
  await db.prepare('UPDATE risks SET management_system=? WHERE id=? AND workspace_id=?').run(owner, riskId, workspace.id);
  return owner;
}

function ownedSql(alias, system) {
  if (!SYSTEMS.includes(system)) throw new Error(`Unknown management system ${system}`);
  return `${alias}.management_system='${system}'`;
}

function requested(workspace, value) {
  return SYSTEMS.includes(value) ? value : primary(workspace);
}

module.exports = { SYSTEMS, systemsOf, hasBoth, primary, ownerFor, assign, ownedSql, requested };
