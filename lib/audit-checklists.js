'use strict';

const reqOpts = require('./requirement-options');
const docLinks = require('./doc-links');
const evReads = require('./evidence-reads');

const CATALOGUE = Object.freeze({ iso27001: 'iso_items' });
const STATES = Object.freeze({ iso27001: 'v_control_states' });

const SECTIONS = Object.freeze({
  iso27001: [
    ['org', 'A.5 Organisational controls'],
    ['people', 'A.6 People controls'],
    ['physical', 'A.7 Physical controls'],
    ['tech', 'A.8 Technological controls'],
    ['clauses', 'Clauses 4 to 10'],
  ],
});

const SAMPLE_HINTS = Object.freeze({
  'annex-a.5.15': 'Sample 10 users (mix of joiner / mover / leaver).',
  'annex-a.5.16': 'Sample 10 user accounts created in the last 6 months.',
  'annex-a.5.17': 'Sample 5 authentication records (MFA enrolment, password reset).',
  'annex-a.5.18': 'Sample 10 access rights changes; verify approval evidence.',
  'annex-a.8.2': 'Sample 5 privileged-access requests; verify approval + revocation.',
  'annex-a.8.3': 'Sample 5 systems for least-privilege configuration.',
  'annex-a.8.5': 'Sample 5 admin authentications; verify phishing-resistant MFA.',
  'annex-a.8.15': 'Sample 10 consecutive days of logs; verify retention.',
  'annex-a.8.16': 'Sample 3 alert investigations from the last 90 days.',
  'annex-a.8.13': 'Sample 3 restore tests; verify RTO/RPO met.',
  'annex-a.5.29': 'Sample 1 BCP test conducted in the last 12 months.',
  'annex-a.5.30': 'Sample evidence of ICT readiness for BC.',
  'annex-a.5.19': 'Sample 5 active suppliers; verify security clauses + review records.',
  'annex-a.5.20': 'Sample 5 supplier contracts.',
  'annex-a.5.21': 'Sample 5 ICT supply-chain risk assessments.',
  'annex-a.5.22': 'Sample 5 supplier reviews from the last 12 months.',
  'annex-a.5.24': 'Verify incident response procedure exists + has been exercised.',
  'annex-a.5.25': 'Sample 5 incidents from the last 12 months.',
  'annex-a.5.26': 'Sample 5 incident responses; verify lessons-learned captured.',
  'annex-a.5.27': 'Sample 3 post-incident reviews.',
  'annex-a.6.3': 'Sample 5 training completion records.',
  _default: 'Sample 3 to 5 records or 1 process walkthrough.',
});

function sampleHintFor(id) {
  return SAMPLE_HINTS[id] || SAMPLE_HINTS._default;
}

function sources(workspace) {
  return reqOpts.enabledCodes(workspace)
    .filter((code) => CATALOGUE[code])
    .map((code) => ({
      framework: code,
      label: reqOpts.label(code),
      sections: SECTIONS[code].map(([key, name]) => ({ value: `${code}:${key}`, label: name })),
    }));
}

function parseSection(workspace, value) {
  const raw = String(value || '');
  const [framework, category] = raw.includes(':') ? raw.split(':', 2) : ['iso27001', raw];
  if (!sources(workspace).some((s) => s.framework === framework)) return null;
  if (!SECTIONS[framework].some(([key]) => key === category)) return null;
  return { framework, category };
}

async function sectionItems(db, { framework, category }) {
  const table = CATALOGUE[framework];
  return category === 'clauses'
    ? await db.prepare(`SELECT id, title FROM ${table} WHERE type='clause' ORDER BY sort_order`).all()
    : await db.prepare(`SELECT id, title FROM ${table} WHERE type='control' AND category=? ORDER BY sort_order`).all(category);
}

async function includedControls(db, workspace) {
  const rows = [];
  for (const { framework } of sources(workspace)) {
    rows.push(...(await db.prepare(`SELECT i.id, i.title, i.category, cs.status, ? AS framework,
        ${docLinks.docCountSubquery()} AS doc_count,
        ${evReads.checklistEvidenceCountSubquery()} AS evi_count
      FROM ${CATALOGUE[framework]} i
      INNER JOIN ${STATES[framework]} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type='control' AND cs.applicability='included'
      ORDER BY i.sort_order`).all(framework, workspace.id, workspace.id, workspace.id)));
  }
  return rows;
}

function split(row) {
  const code = reqOpts.codeOf(row);
  const title = String(row.title || '').replace(/^(?:Clause\s+)?(?:A\.)?[0-9.]+\s+/, '');
  return { code, title };
}

function soaItemText(workspace, row) {
  const { code, title } = split(row);
  return `${code} - ${title}\n\n`
    + 'Test: (1) Is there a documented procedure? (2) Is it operating in practice - sample evidence below. (3) Has it been reviewed in the last 12 months?\n\n'
    + `Linked policies: ${row.doc_count} - Linked evidence: ${row.evi_count}\n`
    + `Sample size suggestion: ${sampleHintFor(row.id)}\n\n`
    + 'Finding template: [Conformance / Observation / Minor NC / Major NC] - [describe what was tested, what was seen, root cause if NC, evidence references]';
}

function sectionItemText(workspace, framework, row) {
  const { code, title } = split(row);
  return `${code} - ${title}: Is there a documented process? Is it operating in practice (sample evidence)? Has it been reviewed in the last 12 months?`;
}

module.exports = { CATALOGUE, SECTIONS, sources, parseSection, sectionItems, includedControls, soaItemText, sectionItemText, sampleHintFor };
