module.exports = {
  'iso-content.js': {
    description: 'Audit-grade content for ISO/IEC 27001:2022 clauses 4-10 + Annex A controls',
    last_reviewed: '2026-05-15',
    reviewed_against: [
      'ISO/IEC 27001:2022',
      'ISO/IEC 27001:2022/Amd 1:2024 (climate change)',
      'ISO/IEC 27002:2022 (implementation guidance)'
    ],
    next_review_due: '2027-05-15',
    notes: 'Climate change amendment (Amd 1:2024) reflected in clauses 4.1 and 4.2. Re-check after any IAF MD update on transitioning organisations or new technical notes from accreditation bodies (UKAS, ANAB, DAkkS).'
  },

  'iso-catalog.js': {
    description: 'ISO 27001:2022 clauses + Annex A control list (the catalog layer feeding controls + SoA + gap wizard)',
    last_reviewed: '2026-05-15',
    reviewed_against: [
      'ISO/IEC 27001:2022 Annex A (93 controls)',
      'ISO/IEC 27001:2022 Clauses 4-10'
    ],
    next_review_due: '2027-05-15',
    notes: 'Structural changes to Annex A are rare. Re-check on next ISO 27001 revision (no scheduled date as of 2026-05).'
  },

  'risk-library.js': {
    description: 'Starter risk catalogue covering ISO 27001 + AI/ML + supply chain + cloud + regulatory change',
    last_reviewed: '2026-05-25',
    reviewed_against: [
      'ISO/IEC 27001:2022 Annex A control mappings',
      'EU AI Act (Reg. (EU) 2024/1689)',
      'DORA (Reg. (EU) 2022/2554)',
      'NIS2 (Dir. (EU) 2022/2555)',
      'India DPDP Act 2023'
    ],
    next_review_due: '2026-11-25',
    notes: 'Regulatory-change domain is the fastest-decaying section. Re-check every 6 months minimum. Add new entries on each new applicable regulation or major incident pattern (e.g., new SolarWinds-class supply-chain event).'
  },

  'policy-templates-organisational.js': {
    description: 'ISO 27001 Annex A.5 organisational control policy templates',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 Annex A.5', 'ISO/IEC 27002:2022 §5'],
    next_review_due: '2027-05-15'
  },
  'policy-templates-people-physical.js': {
    description: 'ISO 27001 Annex A.6 (people) + A.7 (physical) policy templates',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 Annex A.6 and A.7', 'ISO/IEC 27002:2022 §6 and §7'],
    next_review_due: '2027-05-15'
  },
  'policy-templates-technical.js': {
    description: 'ISO 27001 Annex A.8 technological control policy templates',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 Annex A.8', 'ISO/IEC 27002:2022 §8'],
    next_review_due: '2027-05-15',
    notes: 'Technical controls drift fastest with vendor and threat-landscape changes. PAM, endpoint, and crypto templates need re-review when major control updates ship (e.g., new authenticator-assurance levels, post-quantum guidance).'
  },
  'policy-templates-forms-roles.js': {
    description: 'Forms and role-description templates used across the ISMS',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 documented-information requirements'],
    next_review_due: '2027-05-15'
  },
  'policy-templates-bundles.js': {
    description: 'Bundle definitions: which templates ship together as a starter pack',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 mandatory documented information'],
    next_review_due: '2027-05-15'
  }
};
