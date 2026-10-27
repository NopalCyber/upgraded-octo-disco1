'use strict';

process.umask(0o077);

const path = require('path');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: DATABASE_URL=postgres://... node scripts/backup.js [--standalone-no-migrations] [destination-directory]');
  process.exit(0);
}
const unknown = args.filter(arg => arg.startsWith('-') && arg !== '--standalone-no-migrations');
if (unknown.length) {
  console.error(`[backup] unknown option: ${unknown[0]}`);
  process.exit(1);
}
const positional = args.filter(arg => !arg.startsWith('-'));
if (positional.length > 1) {
  console.error('[backup] only one destination directory may be supplied');
  process.exit(1);
}
const destination = positional[0];
if (destination) process.env.ISMS_BACKUP_DIR = path.resolve(destination);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[backup] DATABASE_URL is not set: name the PostgreSQL database to back up');
  process.exit(1);
}

const { runBackup } = require('../lib/backup');
const { createDatabase } = require('../lib/pg');
const database = createDatabase(databaseUrl, { max: 2, applicationName: 'iso27001-tool:backup' });

runBackup({ db: database, databaseUrl }).then(result => {
  if (!result.ok) {
    console.error(`[backup] failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[backup] recovery generation: ${result.generationId}`);
  console.log(`[backup] encrypted database: ${result.database}`);
  console.log(`[backup] encrypted uploads: ${result.uploads}`);
  console.log(`[backup] uploads captured: ${result.uploadCount} files (${result.uploadBytes} bytes)`);
  console.log(`[backup] manifest: ${result.manifest}`);
  console.log(`[backup] database sha256: ${result.sha256}`);
  console.log(`[backup] uploads sha256: ${result.uploadsSha256}`);
  console.log(`[backup] signed manifest: HMAC-SHA-256 ${result.manifestHmac}`);
  console.log('[backup] encryption key included: no (verify separate escrow before relying on this generation)');
  if (result.mirrored && result.mirrored.length) {
    console.log(`[backup] mirrored: ${result.mirrored.join(', ')}`);
  }
}).catch(error => {
  console.error(`[backup] failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => database.close().catch(() => {}));
