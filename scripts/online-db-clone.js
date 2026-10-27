'use strict';

process.umask(0o077);

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || sourceArgument === '--help' || sourceArgument === '-h') {
  console.log('Usage: node scripts/online-db-clone.js <source-database-url> <new-database-name | new-database-url>');
  process.exit(sourceArgument ? 0 : 1);
}

const { pgTools } = require('../lib/backup');
require('../lib/pg');
const { Client } = require('pg');

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

async function tableCounts(client) {
  const tables = (await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows;
  const counts = {};
  for (const { table_name: table } of tables) {
    counts[table] = (await client.query(`SELECT count(*)::bigint AS count FROM ${ident(table)}`)).rows[0].count;
  }
  return counts;
}

(async () => {
  let source;
  let destinationUrl;
  try {
    source = pgTools.parseDatabaseUrl(sourceArgument);
    destinationUrl = /^postgres(ql)?:\/\//.test(destinationArgument)
      ? destinationArgument
      : pgTools.databaseUrlFor(sourceArgument, destinationArgument);
    if (pgTools.sameDatabase(sourceArgument, destinationUrl)) throw new Error('source and destination must differ');
  } catch (error) {
    console.error(`[online-db-clone] ${error.message}`);
    process.exit(1);
  }
  const destination = pgTools.parseDatabaseUrl(destinationUrl);
  const sameServer = destination.host === source.host && destination.port === source.port;
  const adminUrl = process.env.ISMS_RESTORE_ADMIN_URL
    || (sameServer ? sourceArgument : pgTools.databaseUrlFor(destinationUrl, 'postgres'));

  let created = false;
  const snapshot = new Client({ connectionString: sourceArgument, application_name: 'iso27001-tool:clone' });
  try {
    try {
      await pgTools.createDatabase(adminUrl, destination.database);
    } catch (error) {
      if (error.code === '42P04') throw new Error(`destination already exists: ${destination.database}`);
      throw error;
    }
    created = true;
    await snapshot.connect();
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshotId = (await snapshot.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const sourceCounts = await tableCounts(snapshot);
    await pgTools.copyDatabase(sourceArgument, destinationUrl, { snapshot: snapshotId });
    await snapshot.query('COMMIT');

    const clone = new Client({ connectionString: destinationUrl, application_name: 'iso27001-tool:clone' });
    await clone.connect();
    let cloneCounts;
    try { cloneCounts = await tableCounts(clone); } finally { await clone.end().catch(() => {}); }
    const tables = Object.keys(sourceCounts);
    const differ = [...new Set([...tables, ...Object.keys(cloneCounts)])]
      .filter((table) => sourceCounts[table] !== cloneCounts[table]);
    if (differ.length) {
      throw new Error(`clone row counts differ from the source snapshot: ${differ.slice(0, 5).join(', ')}`);
    }
    const rows = tables.reduce((sum, table) => sum + sourceCounts[table], 0);
    console.log(JSON.stringify({ ok: true, source: source.database, destination: destination.database, tables: tables.length, rows }));
  } catch (error) {
    if (created) await pgTools.dropDatabase(adminUrl, destination.database).catch(() => {});
    console.error(`[online-db-clone] failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await snapshot.end().catch(() => {});
  }
})();
