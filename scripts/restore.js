'use strict';

process.umask(0o077);

const path = require('path');

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/restore.js --destination <empty-directory> [--backup-dir <directory>] [--generation <id>]');
  console.log('         [--allow-stale-generation] [--restore-into <empty-database-url> [--into-live-database]]');
  console.log('Writes restored.pgdump, uploads/, and recovery-report.json; it never writes over live data.');
  console.log('The drill restores into a scratch database: DATABASE_URL or ISMS_RESTORE_ADMIN_URL names its server.');
  process.exit(0);
}

(async () => {
  const destination = optionValue(args, '--destination');
  const backupDir = optionValue(args, '--backup-dir');
  const generationId = optionValue(args, '--generation');
  const restoreInto = optionValue(args, '--restore-into');
  const valued = new Set(['--destination', '--backup-dir', '--generation', '--restore-into']);
  const flags = new Set(['--allow-stale-generation', '--into-live-database']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valued.has(arg)) { index++; continue; }
    if (!flags.has(arg)) throw new Error(`unknown option ${arg}`);
  }
  if (!destination) throw new Error('--destination is required');
  if (args.includes('--into-live-database') && !restoreInto) throw new Error('--into-live-database needs --restore-into');

  const { materializeRecovery } = require('../lib/restore-check');
  const result = await materializeRecovery({
    destination: path.resolve(destination),
    backupDir: backupDir ? path.resolve(backupDir) : undefined,
    generationId: generationId || undefined,
    allowStaleGeneration: args.includes('--allow-stale-generation'),
    restoreInto: restoreInto || undefined,
    intoLiveDatabase: args.includes('--into-live-database'),
  });
  console.log('recovery materialization PASSED');
  console.log(`  generation: ${result.generationId}`);
  console.log(`  database archive: ${result.restoredDatabase}`);
  console.log(`  uploads: ${result.restoredUploads} (${result.uploads.fileCount} files, ${result.uploads.bytes} bytes)`);
  console.log(`  report: ${result.report}`);
  if (result.restoredInto) {
    console.log(`  restored into: database ${result.restoredInto.database} on ${result.restoredInto.host}:${result.restoredInto.port}`);
  }
  console.log('  live data changed: no');
  console.log('  next step: stop the application and explicitly promote the verified data using the runbook in docs/backup-postgres.md');
})().catch(error => {
  console.error(`recovery materialization FAILED: ${error.message}`);
  process.exitCode = 1;
});
