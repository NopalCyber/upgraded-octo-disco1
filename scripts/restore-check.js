process.umask(0o077);

const args = process.argv.slice(2);
const allowStaleGeneration = args.includes('--allow-stale-generation');
const generationIndex = args.indexOf('--generation');
const generationId = generationIndex === -1 ? null : args[generationIndex + 1];
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: DATABASE_URL=postgres://... node scripts/restore-check.js [--generation <id>] [--standalone-no-migrations] [--allow-stale-generation]');
  console.log('Generations written by the SQLite version are reported, not restored (see docs/backup-postgres.md).');
  process.exit(0);
}
if (generationIndex !== -1 && (!generationId || generationId.startsWith('-'))) {
  console.error('restore drill FAILED: --generation requires an id');
  process.exit(1);
}
const allowed = new Set(['--allow-stale-generation', '--standalone-no-migrations']);
const optionValues = new Set(generationIndex === -1 ? [] : [generationId]);
const unknown = args.find(arg => arg !== '--generation' && !allowed.has(arg) && !optionValues.has(arg));
if (unknown) {
  console.error(`restore drill FAILED: unknown option ${unknown}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('restore drill FAILED: DATABASE_URL is not set');
  process.exit(1);
}

const { runDrill } = require('../lib/restore-check');
const { createDatabase } = require('../lib/pg');
const database = createDatabase(process.env.DATABASE_URL, { max: 2, applicationName: 'iso27001-tool:restore-check' });

(async () => {
  let r;
  try {
    r = await runDrill({
      db: database,
      databaseUrl: process.env.DATABASE_URL,
      generationId: generationId || undefined,
      allowStaleGeneration,
    });
  } finally {
    await database.close().catch(() => {});
  }
  if (r.ok) {
    console.log(`restore drill PASSED in ${r.ms}ms`);
    console.log(`  generation: ${r.generationId}`);
    console.log(`  manifest: ${r.manifestIntegrity}`);
    if (r.generationAge) console.log(`  recovery age: ${(r.generationAge.ageMs / 3600000).toFixed(2)}h (maximum ${r.generationAge.maxAgeHours}h)`);
    console.log(`  database: pg_restore into a scratch database (${r.database.tables} tables), archive SHA-256 verified`);
    console.log(`  uploads: ${r.uploads.fileCount} files, ${r.uploads.bytes} bytes, paths/hashes verified`);
    console.log(`  database file references: ${r.databaseUploadReferences.checked} resolved, ${r.databaseUploadReferences.virtual} virtual`);
    for (const [t, c] of Object.entries(r.counts)) console.log(`  ${t}: restored ${c.restored} vs live ${c.live}`);
    process.exit(0);
  }
  console.error(`restore drill FAILED: ${r.error}`);
  process.exit(1);
})().catch(error => {
  console.error(`restore drill FAILED: ${error.message}`);
  process.exit(1);
});
