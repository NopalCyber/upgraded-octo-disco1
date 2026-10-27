'use strict';

const { db } = require('../db');

async function seedFirmRiskLibraryIfEmpty(firmId) {
  const c = (await db.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(firmId)).c;
  if (c > 0) return 0;
  const SHIPPED = require('../data/risk-library');
  const ins = db.prepare(`INSERT INTO firm_risk_library
    (firm_id, title, description, threat, vulnerability, suggested_likelihood, suggested_impact, suggested_controls, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(async () => {
    for (const r of SHIPPED) {
      await ins.run(firmId, r.title, r.description || null, r.threat || null, r.vulnerability || null,
        3, 3, (r.suggested_controls || []).join(','), r.domain || null);
    }
  });
  await tx();
  return SHIPPED.length;
}

module.exports = { seedFirmRiskLibraryIfEmpty };
