const SECTIONS = [
  {
    id: 'business-context',
    title: 'Business context',
    blurb: 'Who you are, what you do, why ISO 27001 matters now. Anchors clauses 4.1 and 4.2.',
    questions: [
      { id: 'org-name', text: 'Legal entity name (the certificate will read this exactly)', clause: '4.3', type: 'text', required: true },
      { id: 'trading-name', text: 'Trading or product name(s) - different from legal entity?', clause: '4.3', type: 'text' },
      { id: 'business-summary', text: 'In two sentences, what does your organisation do?', clause: '4.1', type: 'textarea', required: true },
      { id: 'cert-driver', text: 'What\'s driving certification? (customer contract, tender, regulator, internal mandate)', clause: '4.1', type: 'textarea', required: true,
        hint: 'Auditors ask this to gauge management commitment. "A customer required it by Q4" is a real answer.' },
      { id: 'cert-deadline', text: 'Hard deadline (if any) for the certificate?', clause: '4.1', type: 'date' },
    ]
  },
  {
    id: 'scope',
    title: 'ISMS scope',
    blurb: 'Products, services, locations, and systems in scope. This becomes clause 4.3 verbatim.',
    questions: [
      { id: 'products-in-scope', text: 'Which products / services are in scope?', clause: '4.3', type: 'textarea', required: true,
        hint: 'List by product name. Auditors will trace evidence back to these.' },
      { id: 'products-excluded', text: 'Anything explicitly NOT in scope (and why)?', clause: '4.3', type: 'textarea',
        hint: 'Exclusions need justification - "internal HR systems, no customer data" is fine, "we just don\'t want to" is not.' },
      { id: 'infra-model', text: 'Predominant infrastructure model', clause: '4.3', type: 'select', required: true,
        options: ['Cloud-only', 'Cloud-dominant (mostly cloud, some on-prem)', 'Hybrid (balanced cloud + on-prem)', 'On-prem dominant (mostly on-prem, some cloud)', 'On-prem only', 'Air-gapped / isolated'],
        hint: 'Drives which Annex A controls dominate the SoA and the effort estimate. Cloud-heavy engagements lean on A.5 (suppliers, identity); on-prem leans on A.7 (physical) and hardware lifecycle.' },
      { id: 'physical-locations', text: 'Physical locations in scope (offices, data centres, manufacturing, server rooms)', clause: '4.3', type: 'textarea',
        hint: 'One per line. Include addresses if known. List EACH data centre or server room separately - they each need their own A.7 physical controls evidence.' },
      { id: 'onprem-footprint', text: 'On-prem infrastructure summary', clause: '4.3', type: 'textarea',
        showIf: { question: 'infra-model', notOneOf: ['Cloud-only'] },
        hint: 'Number of data centres + server rooms, approximate rack / server count, key on-prem applications, network segments / VLANs.' },
      { id: 'remote-workers', text: 'How many employees work remotely / hybrid?', clause: '4.3', type: 'number',
        hint: 'Affects whether home-office is "in scope" for physical security.' },
      { id: 'cloud-providers', text: 'Cloud providers and services in scope', clause: '4.3', type: 'multiselect',
        options: ['AWS', 'Microsoft Azure', 'Google Cloud', 'Microsoft 365', 'Google Workspace', 'Salesforce'],
        otherLabel: 'Other providers or named services',
        showIf: { question: 'infra-model', notOneOf: ['On-prem only', 'Air-gapped / isolated'] },
        hint: 'Each provider becomes a supplier record and an A.5 control conversation.' },
      { id: 'data-types', text: 'What types of data are processed?', clause: '4.3', type: 'multiselect', required: true,
        options: ['Personal data (PII)', 'Special category / health (PHI)', 'Cardholder data (PCI)',
                  'Intellectual property', 'Internal business data', 'Public data'],
        otherLabel: 'Anything else',
        hint: 'Drives the risk assessment and which regulations apply. Pick every type that is in scope.' },
      { id: 'customer-geography', text: 'Where are your customers based?', clause: '4.3', type: 'multiselect',
        options: ['UK', 'EU / EEA', 'United States', 'Canada', 'LATAM', 'APAC', 'Middle East', 'Africa'],
        otherLabel: 'Other regions',
        hint: 'Drives applicable regulations - UK GDPR, GDPR, CCPA, PIPEDA, etc.' },
    ]
  },
  {
    id: 'organisation',
    title: 'Organisation',
    blurb: 'Headcount, structure, and the people who will own the ISMS.',
    questions: [
      { id: 'headcount-total', text: 'Total employees + contractors (in scope)', clause: '4.3', type: 'number', required: true },
      { id: 'isms-owner', text: 'ISMS owner (top-management sponsor, e.g., CISO, CTO, COO)', clause: '5.1', type: 'text', required: true,
        hint: 'Auditors interview this person. They must be able to talk about the ISMS without notes.' },
      { id: 'isms-coordinator', text: 'Day-to-day ISMS coordinator (the person doing the work)', clause: '5.3', type: 'text', required: true },
      { id: 'isac-frequency', text: 'How often does the ISMS steering / committee meet?', clause: '9.3', type: 'text',
        hint: 'Quarterly is the floor for most certifiers.' },
    ]
  },
  {
    id: 'interested-parties',
    title: 'Interested parties',
    blurb: 'Who can affect or be affected by the ISMS? Feeds clause 4.2 register directly.',
    questions: [
      { id: 'key-customers', text: 'Top 3-5 customers who care about your security posture (and what they ask for)', clause: '4.2', type: 'textarea', required: true,
        hint: 'Their security questionnaires + DPAs become evidence.' },
      { id: 'key-regulators', text: 'Regulators / supervisory authorities relevant to your business', clause: '4.2', type: 'textarea',
        hint: 'ICO (UK), supervisory authorities under GDPR, FCA, FDA, PCI SSC, etc.' },
      { id: 'key-suppliers', text: 'Critical suppliers / processors you depend on', clause: '4.2', type: 'textarea', required: true,
        hint: 'Anyone whose outage breaks your service or whose breach exposes your data.' },
    ]
  },
  {
    id: 'crown-jewels',
    title: 'Crown jewels',
    blurb: 'Start with the 3-5 information assets whose loss or compromise would cause severe business harm. Add more where the scope requires it; every named item is linked to the asset register.',
    questions: [
      { id: 'crown-jewel-1', text: 'Crown jewel #1 - the single most-sensitive information asset', clause: 'A.5.9', type: 'textarea', required: true },
      { id: 'crown-jewel-2', text: 'Crown jewel #2', clause: 'A.5.9', type: 'textarea' },
      { id: 'crown-jewel-3', text: 'Crown jewel #3', clause: 'A.5.9', type: 'textarea' },
    ]
  },
  {
    id: 'existing-posture',
    title: 'Existing posture',
    blurb: 'What\'s already in place. Saves time identifying real gaps vs paper gaps.',
    questions: [
      { id: 'existing-frameworks', text: 'Other frameworks or certifications held or being pursued', clause: '4.1', type: 'multiselect',
        options: ['SOC 2', 'NIST CSF', 'Cyber Essentials', 'Cyber Essentials Plus', 'HIPAA', 'PCI DSS',
                  'ISO 9001', 'ISO 27017 / 27018', 'ISO 42001', 'GDPR programme'],
        otherLabel: 'Anything else',
        hint: 'Existing controls map across - saves remediation effort.' },
      { id: 'existing-policies', text: 'Approximately how many security / privacy policies are already documented and signed off?', clause: '7.5', type: 'number' },
      { id: 'recent-incidents', text: 'Any security incidents or near-misses in the last 24 months we should know about?', clause: 'A.5.24', type: 'textarea',
        hint: 'Withholding hurts you - auditors find them anyway via the breach register.' },
    ]
  },
];

function flatten() {
  const out = [];
  for (const sec of SECTIONS) {
    for (const q of sec.questions) {
      out.push({ ...q, section_id: sec.id });
    }
  }
  return out;
}

const MAX_CROWN_JEWELS = 50;

function crownJewelNumber(id) {
  const match = /^crown-jewel-(\d+)$/.exec(String(id || ''));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 1 && number <= MAX_CROWN_JEWELS ? number : null;
}

function crownJewelQuestion(number) {
  if (!Number.isInteger(number) || number < 1 || number > MAX_CROWN_JEWELS) return null;
  return {
    id: `crown-jewel-${number}`,
    text: number === 1 ? 'Crown jewel #1 - the single most-sensitive information asset' : `Crown jewel #${number}`,
    clause: 'A.5.9',
    type: 'textarea',
    required: number === 1,
    dynamic: number > 3,
  };
}

function crownJewelQuestions(answers = {}) {
  const numbers = new Set([1, 2, 3]);
  for (const [id, answer] of Object.entries(answers)) {
    const number = crownJewelNumber(id);
    if (number && number > 3 && String(answer || '').trim()) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map(crownJewelQuestion);
}

function crownJewelAnswers(answers = {}) {
  return Object.entries(answers)
    .map(([id, answer]) => ({ id, number: crownJewelNumber(id), name: String(answer || '').trim() }))
    .filter(item => item.number && item.name)
    .sort((a, b) => a.number - b.number);
}

function computeEngagementSummary(answers) {
  const a = (id) => (answers[id] || '').trim();
  const lines = (id) => a(id).split('\n').map(s => s.trim()).filter(Boolean);

  const headcount = parseInt(a('headcount-total'), 10) || 0;
  let hcScore = 0;
  if (headcount >= 1000) hcScore = 4;
  else if (headcount >= 200) hcScore = 3;
  else if (headcount >= 50) hcScore = 2;
  else if (headcount > 0) hcScore = 1;

  const cloudCount = lines('cloud-providers').length;
  const cloudScore = cloudCount >= 4 ? 3 : cloudCount >= 2 ? 2 : cloudCount === 1 ? 1 : 0;
  const locCount = lines('physical-locations').length;
  const locScore = locCount >= 6 ? 4 : locCount >= 3 ? 3 : locCount >= 2 ? 2 : locCount === 1 ? 1 : 0;

  const onpremText = a('onprem-footprint');
  const onpremScore = onpremText.length > 200 ? 2.5 : onpremText.length > 20 ? 1.5 : 0;

  const model = a('infra-model').toLowerCase();
  let modelScore = 0;
  if (/air[\s-]?gapped|on-prem only/.test(model))             modelScore = 2;
  else if (/on-prem dominant/.test(model))                     modelScore = 1.5;
  else if (/hybrid/.test(model))                               modelScore = 1;
  else if (/cloud-dominant/.test(model))                       modelScore = 0.5;

  const dataTypes = a('data-types').toLowerCase();
  let regScore = 0;
  if (/\b(pci|payment|cardholder)\b/.test(dataTypes)) regScore += 1;
  if (/\b(phi|health|hipaa|nhs)\b/.test(dataTypes)) regScore += 1;
  if (/\b(pii|gdpr|personal data)\b/.test(dataTypes)) regScore += 0.5;

  const frameworks = a('existing-frameworks').toLowerCase();
  let postureScore = 2;
  if (/\b(soc\s*2|soc2)\b/.test(frameworks)) postureScore -= 1.5;
  if (/cyber essentials/.test(frameworks)) postureScore -= 1;
  if (/nist/.test(frameworks)) postureScore -= 1;
  if (/iso[\s/-]*22301|iso[\s/-]*9001/.test(frameworks)) postureScore -= 0.5;
  postureScore = Math.max(0, postureScore);

  const total = hcScore + cloudScore + locScore + onpremScore + modelScore + regScore + postureScore;
  const tier = total >= 13 ? 'Enterprise' : total >= 8 ? 'Large' : total >= 4.5 ? 'Medium' : 'Small';

  const effortByTier = {
    Small:      { weeks: '8-10',  min: 8,  max: 10 },
    Medium:     { weeks: '12-16', min: 12, max: 16 },
    Large:      { weeks: '18-24', min: 18, max: 24 },
    Enterprise: { weeks: '24-36', min: 24, max: 36 },
  };
  const effort = effortByTier[tier];

  let pressure = null;
  const deadlineStr = a('cert-deadline');
  if (deadlineStr) {
    const deadline = new Date(deadlineStr);
    if (!isNaN(deadline)) {
      const daysLeft = Math.round((deadline - new Date()) / (1000 * 60 * 60 * 24));
      const minDays = effort.min * 7;
      const maxDays = effort.max * 7;
      if (daysLeft >= maxDays * 1.5) pressure = { label: 'Comfortable', tone: 'good', daysLeft, days: `${daysLeft} days vs ${effort.weeks} weeks needed` };
      else if (daysLeft >= maxDays) pressure = { label: 'Achievable', tone: 'good', daysLeft, days: `${daysLeft} days vs ${effort.weeks} weeks needed` };
      else if (daysLeft >= minDays) pressure = { label: 'Tight', tone: 'warn', daysLeft, days: `${daysLeft} days vs ${effort.weeks} weeks needed` };
      else if (daysLeft > 0) pressure = { label: 'At risk', tone: 'bad', daysLeft, days: `${daysLeft} days vs ${effort.weeks} weeks needed` };
      else pressure = { label: 'Past deadline', tone: 'bad', daysLeft, days: `deadline was ${deadlineStr}` };
    }
  }

  const flags = [];
  const recent = a('recent-incidents').toLowerCase();
  if (recent && !/^(none|no|n\/a|nil)\b/.test(recent)) {
    flags.push({ severity: 'high', text: 'Recent incident disclosed - confirm root cause + remediation status before signing' });
  }
  const policies = parseInt(a('existing-policies').replace(/\D/g, ''), 10);
  if (a('existing-policies') && policies === 0) {
    flags.push({ severity: 'medium', text: 'No existing policies documented - expect longer ramp on documentation phase' });
  }
  if (pressure && pressure.tone === 'bad') {
    flags.push({ severity: 'high', text: `Deadline pressure (${pressure.label}) - either reduce scope or push the certification date` });
  }
  if (!a('products-excluded') && headcount >= 200) {
    flags.push({ severity: 'medium', text: 'No exclusions captured - scope may be larger than client thinks; revisit with sponsor' });
  }
  if (!a('isms-owner')) {
    flags.push({ severity: 'medium', text: 'ISMS owner not named - top-management commitment risk (clause 5.1)' });
  }
  if (regScore > 0 && !frameworks) {
    flags.push({ severity: 'medium', text: 'Regulated data in scope with no existing framework - expect heavier control implementation' });
  }

  const readinessMarkers = [
    { key: 'org-name',           label: 'Legal entity named',         got: !!a('org-name') },
    { key: 'products-in-scope',  label: 'Products / services scoped', got: !!a('products-in-scope') },
    { key: 'headcount-total',    label: 'Headcount captured',         got: headcount > 0 },
    { key: 'cloud-providers',    label: 'Cloud surface mapped',       got: !!a('cloud-providers') },
    { key: 'isms-owner',         label: 'Top-management sponsor named', got: !!a('isms-owner') },
    { key: 'cert-driver',        label: 'Certification driver clear', got: !!a('cert-driver') },
  ];

  return {
    tier, effort, pressure, flags, readinessMarkers,
    score: { headcount: hcScore, cloud: cloudScore, locations: locScore, onprem: onpremScore, model: modelScore, regulated: regScore, posture: postureScore, total },
    headcount, cloudCount, locCount, infraModel: a('infra-model') || null,
  };
}

function draftScopeStatement(answers) {
  const a = (id) => (answers[id] || '').trim();
  const placeholder = (id) => a(id) || `[${id} - not answered]`;
  const lines = [];
  lines.push(`The information security management system covers the operations of ${placeholder('org-name')}.`);
  lines.push('');
  lines.push(`In scope: ${placeholder('products-in-scope')}.`);
  if (a('infra-model')) {
    lines.push('');
    lines.push(`Infrastructure model: ${a('infra-model')}.`);
  }
  if (a('physical-locations')) {
    lines.push('');
    lines.push(`Physical locations: ${a('physical-locations')}.`);
  }
  if (a('onprem-footprint')) {
    lines.push('');
    lines.push(`On-prem infrastructure: ${a('onprem-footprint')}.`);
  }
  if (a('cloud-providers')) {
    lines.push('');
    lines.push(`Cloud providers and services in scope: ${a('cloud-providers')}.`);
  }
  if (a('data-types')) {
    lines.push('');
    lines.push(`Data processed: ${a('data-types')}.`);
  }
  if (a('headcount-total')) {
    lines.push('');
    lines.push(`Total in-scope headcount: ${a('headcount-total')}.`);
  }
  if (a('products-excluded')) {
    lines.push('');
    lines.push(`Out of scope: ${a('products-excluded')}.`);
  }
  return lines.join('\n');
}

function parseMultiselect(question, stored) {
  const options = question.options || [];
  const raw = String(stored || '').trim();
  if (!raw) return { selected: [], other: '' };
  const norm = (v) => String(v).trim().toLowerCase();
  const byNorm = new Map(options.map((o) => [norm(o), o]));
  for (const o of options) {
    const abbr = /\(([^)]+)\)/.exec(o);
    if (abbr && !byNorm.has(norm(abbr[1]))) byNorm.set(norm(abbr[1]), o);
  }
  const selected = [];
  const leftovers = [];
  for (const token of raw.split(/[\n,;]+/)) {
    const t = token.trim();
    if (!t) continue;
    const hit = byNorm.get(norm(t));
    if (hit && !selected.includes(hit)) selected.push(hit);
    else if (!hit) leftovers.push(t);
  }
  return { selected, other: leftovers.join(', ') };
}

function serializeMultiselect(question, selected, other) {
  const options = question.options || [];
  const chosen = options.filter((o) => (selected || []).includes(o));
  const extra = String(other || '').trim();
  if (extra) chosen.push(extra);
  return chosen.join('\n');
}

function isVisible(question, answers) {
  const rule = question && question.showIf;
  if (!rule) return true;
  const current = String((answers || {})[rule.question] || '').trim();
  if (!current) return true;
  if (Array.isArray(rule.oneOf)) return rule.oneOf.includes(current);
  if (Array.isArray(rule.notOneOf)) return !rule.notOneOf.includes(current);
  return true;
}

module.exports = {
  parseMultiselect, serializeMultiselect, isVisible,
  SECTIONS,
  MAX_CROWN_JEWELS,
  flatten,
  crownJewelNumber,
  crownJewelQuestion,
  crownJewelQuestions,
  crownJewelAnswers,
  draftScopeStatement,
  computeEngagementSummary,
};
