# Backups and restore on PostgreSQL

## What protects the data

| Layer | What it is | Role |
|---|---|---|
| RDS automated backups, point-in-time recovery, pre-deploy snapshots | AWS (`deploy/AWS.md`) | The primary database backup on AWS. |
| AWS Backup of EFS | Daily recovery points of `/app/uploads` | The primary uploads backup on AWS. |
| Recovery generation (`scripts/backup.js`) | One encrypted, signed bundle of the database and the uploads, taken at the same time | Portable export: restores on any PostgreSQL 16 server, outside AWS too. The only backup on a self-hosted install. |

## A recovery generation

`node scripts/backup.js` writes three files to `ISMS_BACKUP_DIR` (`/app/data/backups` in the image):

| File | Contents |
|---|---|
| `isms-<time>.pgdump.enc` | `pg_dump --format=custom` of `DATABASE_URL`, streamed into AES-256-GCM. The plaintext dump never reaches the disk. |
| `isms-<time>.uploads.enc` | Every file under `ISMS_UPLOADS_DIR`, framed and AES-256-GCM encrypted. |
| `isms-<time>.manifest.json` | Format `nimbus-recovery-generation-v3`: size and SHA-256 of both archives, row counts of the core tables, the uploads inventory with a SHA-256 per file, and an HMAC-SHA-256 over all of it. |

- **Key:** both archives and the HMAC use the master key (`ISMS_MASTER_KEY` or `ISMS_KEY_FILE`). The key is never written into a generation or its mirror. Escrow it separately; without it a generation cannot be read.
- **Consistency:** the dump runs from a snapshot exported by a read-only `REPEATABLE READ` transaction, and the signed row counts are read in that same transaction. The application keeps writing during the dump.
- **Proof before commit:** the manifest, which is the commit record, is written only after the encrypted generation has been restored into a scratch database (`pg_restore --single-transaction --exit-on-error`), its row counts match the signed ones, and every file the database references is present in the uploads archive with the recorded size and hash.
- **Files:** directories are `0700` and files `0600`. A lock file stops two backups running at once. `ISMS_BACKUP_RETAIN` (default 14) generations are kept; `BACKUP_MIRROR_DIR` gets a copy of each, manifest last.

## Requirements

- **PostgreSQL 16 client tools** (`pg_dump`, `pg_restore`), no older than the server's major version. The image installs `postgresql16-client`. `PG_DUMP` and `PG_RESTORE` name other binaries.
- **Connection:** `DATABASE_URL`. The tools get it through `PG*` environment variables (the password through `PGPASSWORD`), never on the command line. URL parameters such as `sslmode` and `sslrootcert` are passed on. On AWS the stack's URL already ends in `sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem`, the RDS CA bundle baked into the image.
- **Scratch databases:** each drill creates `isms_restore_<time>_<random>` with the C collation and drops it afterwards. The role needs `CREATEDB` (the RDS master user has it). `ISMS_RESTORE_ADMIN_URL` names a different connection for this if the application's role may not create databases.

## Commands

```sh
node scripts/backup.js                                   # a new generation
node scripts/restore-check.js [--generation <id>]        # restore drill (exit 0 = passed)
node scripts/restore.js --destination /empty/dir --generation <id> \
  [--restore-into postgres://.../new_empty_database]     # materialize, optionally load
node scripts/online-db-clone.js <source-url> <new-database-name>   # consistent copy for preflight
```

The application runs the restore drill itself once a month (`lib/jobs.js`, `restoreDrill`) and records the verdict in `backup_runs`. Set `ISMS_RESTORE_DRILL_DISABLED=1` where no recovery generations are kept (an RDS-only deployment), or the drill records a failure every hour. The AWS stack sets it unless `restore_drill_enabled = true`.

## Restoring

1. `scripts/restore.js --destination <empty folder> --generation <id>` verifies the generation (as the drill does) and writes `restored.pgdump`, `uploads/` and `recovery-report.json`. Nothing live is touched.
2. Add `--restore-into <url>` to load the verified archive into a database. The target must exist, be empty, and use the C collation (`createdb --template=template0 --encoding=UTF8 --lc-collate=C --lc-ctype=C <name>`). The database named by `DATABASE_URL` is refused unless `--into-live-database` is also given, and a database that is not empty is refused in every case.
3. Review the report, stop the application, point `DATABASE_URL` at the restored database, copy `uploads/` into `ISMS_UPLOADS_DIR`, and start the application. Boot applies any newer migrations.

## Generations from the SQLite version

Generations written before the move (`.db.gz.enc`, manifest format v2) are reported by `restore-check` and never fed to `pg_restore`. Rotation leaves them alone; delete them after the rollback period. To recover one: materialize it with `scripts/restore.js` from a SQLite release (tag `handover-baseline`), then load `restored.db` with `node scripts/sqlite-to-postgres.js --sqlite restored.db --pg <url>`.

## Running the tests without a local client

Outside CI, the backup tests skip when `pg_dump`/`pg_restore` are missing. To run them against a PostgreSQL container instead, point `PG_DUMP` and `PG_RESTORE` at wrappers such as:

```sh
#!/usr/bin/env bash
# Run pg_dump inside the container; host and port become the container's own.
exec docker exec -i -e PGHOST=localhost -e PGPORT=5432 -e PGUSER -e PGPASSWORD \
  -e PGDATABASE -e PGSSLMODE -e PGAPPNAME <container> pg_dump "$@"
```
