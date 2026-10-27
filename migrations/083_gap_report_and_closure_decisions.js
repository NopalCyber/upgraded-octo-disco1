'use strict';

const PHASES = ['mobilisation', 'fieldwork', 'validation', 'report', 'post_report', 'closure'];

async function up(db) {
  const table = await db.prepare(`SELECT to_regclass('gap_assessment_phase_decisions') IS NOT NULL AS present`).get();
  if (!table.present) return;
  const checks = await db.prepare(`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
     WHERE c.conrelid = 'gap_assessment_phase_decisions'::regclass AND c.contype = 'c'
     ORDER BY c.conname`).all();
  const phase = checks.find((check) => /\bphase\b/.test(check.definition));
  if (phase && phase.definition.includes("'closure'")) return;
  const allowed = PHASES.map((p) => `'${p}'`).join(',');
  const name = phase ? phase.conname : 'gap_assessment_phase_decisions_phase_check';
  const quoted = '"' + name.replace(/"/g, '""') + '"';
  await db.exec(`ALTER TABLE gap_assessment_phase_decisions
    ${phase ? `DROP CONSTRAINT ${quoted},` : ''}
    ADD CONSTRAINT ${quoted} CHECK (phase IN (${allowed}))`);
}

module.exports = { up };
