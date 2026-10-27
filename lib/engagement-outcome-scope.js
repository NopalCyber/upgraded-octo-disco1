'use strict';

const isoLifecycle = require('./iso-lifecycle');

const MODE = Object.freeze({
  CERTIFICATION: 'certification',
  GAP_ASSESSMENT: 'gap_assessment',
  GENERIC: 'generic',
});
const GAP_PHASE_KEY = 'gap_assessment';

function frameworkCodes(workspace) {
  const value = workspace && workspace.frameworks;
  if (Array.isArray(value)) return value.filter(code => typeof code === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(code => typeof code === 'string') : [];
  } catch (_) {
    return [];
  }
}

function hasIso27001(workspace) {
  return frameworkCodes(workspace).includes('iso27001');
}

const CERTIFIABLE_FRAMEWORKS = Object.freeze(['iso27001']);

function hasCertifiableFramework(workspaceOrCodes) {
  const codes = Array.isArray(workspaceOrCodes) ? workspaceOrCodes : frameworkCodes(workspaceOrCodes);
  return codes.some(code => CERTIFIABLE_FRAMEWORKS.includes(code));
}

function workspaceMode(workspace) {
  if (!isoLifecycle.hasIsoManagementSystem(workspace)) return MODE.GENERIC;
  return isoLifecycle.isGapOnly(workspace && workspace.engagement_outcome)
    ? MODE.GAP_ASSESSMENT
    : MODE.CERTIFICATION;
}

function isGapAssessmentOnly(workspace) {
  return hasCertifiableFramework(workspace) && isoLifecycle.isGapOnly(workspace && workspace.engagement_outcome);
}

function isCertificationSupport(workspace) {
  return workspaceMode(workspace) === MODE.CERTIFICATION;
}

function isPhaseInContract(workspace, phaseKey) {
  return !isGapAssessmentOnly(workspace) || phaseKey === GAP_PHASE_KEY;
}

function phaseSqlForWorkspace(workspace, phaseAlias = 'ph') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(phaseAlias)) {
    throw new Error('Invalid phase alias.');
  }
  return isGapAssessmentOnly(workspace)
    ? `${phaseAlias}.phase_key='${GAP_PHASE_KEY}'`
    : '1=1';
}

const DEFAULT_POST_GAP_MESSAGE = 'This service is outside this gap-assessment-only engagement. Use the gap assessment, evidence, findings and controlled assessment report instead.';

function requirePostGapService(message = DEFAULT_POST_GAP_MESSAGE) {
  return function postGapServiceGuard(req, res, next) {
    if (!isGapAssessmentOnly(req.workspace)) return next();
    const text = String(message || DEFAULT_POST_GAP_MESSAGE);
    const requestPath = String(req.originalUrl || req.path || '');
    if (requestPath.startsWith('/api/')) return res.status(409).json({ error: text });
    return res.status(409).render('error', {
      user: req.user || null,
      ws: req.workspace,
      message: text,
    });
  };
}

module.exports = {
  MODE,
  GAP_PHASE_KEY,
  frameworkCodes,
  hasIso27001,
  CERTIFIABLE_FRAMEWORKS,
  hasCertifiableFramework,
  hasIsoManagementSystem: isoLifecycle.hasIsoManagementSystem,
  workspaceMode,
  isGapAssessmentOnly,
  isCertificationSupport,
  isPhaseInContract,
  phaseSqlForWorkspace,
  requirePostGapService,
};
