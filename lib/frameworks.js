'use strict';
const FRAMEWORK_REGISTRY = Object.freeze({
  iso27001: Object.freeze({
    code: 'iso27001',
    managementSystem: true,
    label: 'ISO/IEC 27001:2022',
    shortLabel: 'ISO 27001',
    tagLabel: 'ISO 27001',
    systemCode: 'ISMS',
    descriptor: 'Information security management system',
    pickerLabel: 'ISO 27001:2022',
    formalName: 'ISO/IEC 27001:2022',
    pickerNote: 'Information security',
    tagRgb: null,
    tagInk: null,
    order: 1,
  }),
});

const ALLOWED_FRAMEWORKS = Object.freeze(Object.keys(FRAMEWORK_REGISTRY));
const LEGACY_DEFAULT_FRAMEWORKS = Object.freeze(['iso27001']);

const FRAMEWORK_LIST = Object.freeze(
  ALLOWED_FRAMEWORKS
    .map(code => FRAMEWORK_REGISTRY[code])
    .sort((a, b) => a.order - b.order)
);

function frameworkMeta(code) {
  return FRAMEWORK_REGISTRY[code] || null;
}

function byFramework(initial = () => []) {
  return Object.fromEntries(ALLOWED_FRAMEWORKS.map(code => [code, initial()]));
}

function parseWorkspaceFrameworks(raw) {
  if (Array.isArray(raw)) return raw.filter(x => ALLOWED_FRAMEWORKS.includes(x));
  if (!raw) return LEGACY_DEFAULT_FRAMEWORKS.slice();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return LEGACY_DEFAULT_FRAMEWORKS.slice();
    return arr.filter(x => ALLOWED_FRAMEWORKS.includes(x));
  } catch (_) { return LEGACY_DEFAULT_FRAMEWORKS.slice(); }
}

function catalogueSize(code) {
  try {
    switch (code) {
      case 'iso27001':
        return Object.keys(require('../data/iso-content.js')).length;
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

module.exports = {
  catalogueSize,
  FRAMEWORK_REGISTRY,
  FRAMEWORK_LIST,
  ALLOWED_FRAMEWORKS,
  LEGACY_DEFAULT_FRAMEWORKS,
  frameworkMeta,
  byFramework,
  parseWorkspaceFrameworks,
};
