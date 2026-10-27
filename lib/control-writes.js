'use strict';

const FLAG_KEY = 'control_writes_converged';

function converged() {
  return true;
}

async function requirementId(db, framework, isoItemId) {
  if (!isoItemId) return null;
  try {
    const r = await db.prepare(
      `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
       WHERE f.code = ? AND rq.ref = ?`
    ).get(framework, isoItemId);
    return r ? r.id : null;
  } catch (_) {
    return null;
  }
}

const STATUS_TO_TOKEN = {
  'Implemented': 'implemented',
  'Partially Implemented': 'partially_implemented',
  'Work In Progress': 'work_in_progress',
  'Not Assessed': 'not_assessed',
  'Not Implemented': 'not_implemented',
  'Not Applicable': 'not_applicable',
};
const APPLIC_TO_TOKEN = { 'included': 'applicable', 'excluded': 'excluded', 'undecided': 'undecided' };

function normStatus(displayValue) {
  if (displayValue == null) return displayValue;
  return Object.prototype.hasOwnProperty.call(STATUS_TO_TOKEN, displayValue) ? STATUS_TO_TOKEN[displayValue] : displayValue;
}
function normApplic(legacyValue) {
  if (legacyValue == null) return legacyValue;
  return Object.prototype.hasOwnProperty.call(APPLIC_TO_TOKEN, legacyValue) ? APPLIC_TO_TOKEN[legacyValue] : legacyValue;
}

function convergeSets(sets, vals) {
  const cSets = [], cVals = [];
  let vi = 0;
  for (const s of sets) {
    const hasVal = s.endsWith('=?');
    const col = s.split('=')[0].trim();
    const v = hasVal ? vals[vi++] : undefined;
    if (col === 'status') { cSets.push('status=?'); cVals.push(normStatus(v)); }
    else if (col === 'applicability') { cSets.push('applicability=?'); cVals.push(normApplic(v)); }
    else { cSets.push(s); if (hasVal) cVals.push(v); }
  }
  return { sets: cSets, vals: cVals };
}

module.exports = { FLAG_KEY, converged, requirementId, normStatus, normApplic, convergeSets };
