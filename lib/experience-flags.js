'use strict';

const { PROGRAMMES, frameworkCodes } = require('./programme-experience');

async function presentationProgramme(db, workspace) {
  if(!workspace)return 'shared';
  const current=await db.prepare(`SELECT w.frameworks,
    (EXISTS(SELECT 1 FROM tprm_modules m WHERE m.workspace_id=w.id AND m.status IN ('active','needs_classification')))::int AS tprm_enabled
    FROM workspaces w WHERE w.id=?`).get(workspace.id);
  if(!current)return 'shared';
  const programmes=new Set(frameworkCodes(current.frameworks));
  if(current.tprm_enabled)programmes.add('tprm');
  return programmes.size===1?[...programmes][0]:'shared';
}

async function experienceFor(db, { actor, workspace = null, programme }) {
  if (!actor) return { enabled: false, wave: 0, cohort: null };
  const firmId=actor.user_type==='client'&&workspace?workspace.firm_id:actor.firm_id;
  if (!firmId) return { enabled: false, wave: 0, cohort: null };
  if (workspace && actor.user_type==='client' && !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id,actor.id))) return { enabled:false,wave:0,cohort:null };
  if (workspace && actor.user_type!=='client' && Number(workspace.firm_id) !== Number(actor.firm_id)) return { enabled: false, wave: 0, cohort: null };
  const rollout = await db.prepare('SELECT enabled,wave,cohort FROM experience_rollouts WHERE firm_id=?').get(firmId);
  const override = workspace ? await db.prepare('SELECT enabled FROM experience_workspace_overrides WHERE workspace_id=?').get(workspace.id) : null;
  const environment = process.env.EXPERIENCE_ENABLED;
  const defaultEnabled = process.env.NODE_ENV !== 'production';
  const enabled = environment === '0' ? false : environment === '1' ? true
    : override ? !!override.enabled : rollout ? !!rollout.enabled : defaultEnabled;
  const wave = rollout?.wave || (defaultEnabled || environment === '1' ? 6 : 1);
  const selectedProgramme=programme===undefined?await presentationProgramme(db,workspace):programme;
  return { enabled: enabled && wave >= (PROGRAMMES[selectedProgramme]?.wave || 1), wave, cohort: rollout?.cohort || (defaultEnabled ? 'development' : null) };
}

async function enabledFor(db, input) { return (await experienceFor(db, input)).enabled; }
module.exports = { experienceFor, enabledFor, presentationProgramme };
