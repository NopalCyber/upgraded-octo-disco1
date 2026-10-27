'use strict';

const PROGRAMMES = Object.freeze({
  iso27001: { label: 'ISO 27001', wave: 1, endpoint: 'The contracted assessment or certification-support outcome' },
  tprm: { label: 'Third-party risk', wave: 5, endpoint: 'The contracted service period, preserving client decision authority' },
  shared: { label: 'Shared delivery', wave: 1, endpoint: 'The agreed engagement deliverables' }
});

function frameworkCodes(value) {
  if (Array.isArray(value)) return value.filter(code => PROGRAMMES[code]);
  try { return frameworkCodes(JSON.parse(value || '[]')); } catch (_) { return []; }
}

function programmeFor(workspace, explicit) {
  if (PROGRAMMES[explicit]) return explicit;
  const codes = frameworkCodes(workspace.frameworks);
  if (codes.length === 1) return codes[0];
  if (!codes.length && workspace.tprm_enabled) return 'tprm';
  return 'shared';
}

module.exports = { PROGRAMMES, frameworkCodes, programmeFor };
