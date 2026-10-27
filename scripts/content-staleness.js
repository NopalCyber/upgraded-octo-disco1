const path = require('path');
const meta = require('../data/content-meta');

const TODAY = new Date().toISOString().slice(0, 10);
const SOON_THRESHOLD_DAYS = 60;

function daysBetween(a, b) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function loadEntries(filename) {
  for (const dir of ['data', '.']) {
    try {
      const p = path.resolve(__dirname, '..', dir, filename);
      const mod = require(p);
      if (mod && typeof mod === 'object' && !Array.isArray(mod)) return mod;
    } catch (_) {}
  }
  return null;
}

let overdue = 0, dueSoon = 0;
console.log('Content staleness report');
console.log('========================');
console.log(`Today: ${TODAY}`);
console.log(`Soon threshold: ${SOON_THRESHOLD_DAYS} days\n`);

for (const [filename, m] of Object.entries(meta)) {
  const days = daysBetween(TODAY, m.next_review_due);
  const status = days < 0 ? 'OVERDUE' : days <= SOON_THRESHOLD_DAYS ? 'DUE SOON' : 'current';
  if (days < 0) overdue++;
  else if (days <= SOON_THRESHOLD_DAYS) dueSoon++;

  const flag = days < 0 ? '✗' : days <= SOON_THRESHOLD_DAYS ? '◆' : '✓';
  console.log(`${flag} ${filename}`);
  console.log(`    ${m.description}`);
  console.log(`    last reviewed: ${m.last_reviewed}`);
  console.log(`    next review:   ${m.next_review_due}  (${days >= 0 ? days + ' days remaining' : Math.abs(days) + ' days overdue'}) [${status}]`);
  if (Array.isArray(m.reviewed_against) && m.reviewed_against.length) {
    console.log(`    reviewed against:`);
    m.reviewed_against.forEach(r => console.log(`      - ${r}`));
  }
  if (m.notes) console.log(`    notes: ${m.notes}`);

  const entries = loadEntries(filename);
  if (entries) {
    const overrides = [];
    for (const [id, entry] of Object.entries(entries)) {
      if (entry && typeof entry === 'object' && entry.last_reviewed) {
        const entryDue = entry.next_review_due || m.next_review_due;
        const entryDays = daysBetween(TODAY, entryDue);
        if (entryDays < 0) overrides.push({ id, last: entry.last_reviewed, due: entryDue, days: entryDays });
      }
    }
    if (overrides.length > 0) {
      console.log(`    per-entry overdue overrides:`);
      overrides.forEach(o => console.log(`      - ${o.id}: last=${o.last}, due=${o.due} (${Math.abs(o.days)}d overdue)`));
      overdue += overrides.length;
    }
  }

  console.log('');
}

console.log('Summary');
console.log('-------');
console.log(`${overdue} overdue, ${dueSoon} due soon`);
process.exit(overdue > 0 ? 1 : 0);
