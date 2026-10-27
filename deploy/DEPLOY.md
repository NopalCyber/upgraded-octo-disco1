# Deploying the GRC Tool

There are two supported ways to run it:

- **AWS** (ECS Fargate, load balancer, RDS PostgreSQL, EFS, Secrets Manager,
  GitHub OIDC deploys): Terraform in `infra/terraform`, guide in
  [AWS.md](AWS.md). Use this for a production service.
- **One server with Docker Compose**: the app and PostgreSQL 16 in two
  containers on one machine. The rest of this page covers it.

The earlier Lightsail scripts (`lightsail-setup.sh`, `update.sh`,
`ssl-setup.sh`) were written for the SQLite version and have been retired. To
move an existing Lightsail install, follow "Cutover from Lightsail" in
[AWS.md](AWS.md), or copy its SQLite file into the Compose database with
`scripts/sqlite-to-postgres.js` ([docs/postgres-port.md](../docs/postgres-port.md) §7).

## Docker Compose on one server

### What you need

- A Linux server with Docker Engine and the Compose plugin.
- A reverse proxy or load balancer in front that terminates HTTPS. The app
  listens on `127.0.0.1:3000` only and expects exactly one proxy in front of it
  (`trust proxy` is 1 in production).

### First start

```bash
git clone https://github.com/Vijayragha1/upgraded-octo-disco.git
cd upgraded-octo-disco
cp .env.example .env
```

Edit `.env`:

| Setting | Value |
|---|---|
| `POSTGRES_PASSWORD` | A long random password. Use letters and digits only, or URL-encode it in `DATABASE_URL`. |
| `DATABASE_URL` | `postgres://isms:<POSTGRES_PASSWORD>@db:5432/isms` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ISMS_MASTER_KEY` | `openssl rand -hex 32`. Escrow it separately: without it the encrypted fields and backups cannot be read. |
| `APP_BASE_URL` | The public HTTPS address, e.g. `https://grc.example.com` |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | The first firm-owner account |
| `RESEND_API_KEY` | Transactional email. Without it, mail is not sent. |

Then:

```bash
install -d -m 0700 data uploads
sudo chown 1000:1000 data uploads
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/readyz
```

The database container creates the `isms` database with the C locale on its
first start; the app creates the schema and seeds the reference content on
its first boot. `/healthz` is the container's liveness check. `/readyz` is
stricter: it fails until the public URL, email provider, secrets and virus
scanning are configured for production.

### Updating

```bash
docker compose exec -T isms node scripts/backup.js
git pull
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/readyz
```

Boot applies new migrations under a database lock. To roll back, check out
the previous commit and run `docker compose up -d --build` again; if the newer
release migrated the database, restore the backup taken before the update.

### Logs and restarts

```bash
docker compose logs -f isms
docker compose restart isms
```

### Backups

```bash
docker compose exec -T isms node scripts/backup.js
docker compose exec -T isms node scripts/restore-check.js
```

`scripts/backup.js` writes one encrypted, signed recovery generation (database
dump and uploads) to `./data/backups` and keeps it only after a test restore
into a scratch database matches it. `restore-check.js` repeats that drill on
the newest generation. Run the backup daily from the host's cron, for example:

```
0 2 * * * cd /opt/upgraded-octo-disco && docker compose exec -T isms node scripts/backup.js
```

Copy `./data/backups` off the server (or set `BACKUP_MIRROR_DIR` to mounted,
separately backed-up storage). How generations are built, checked and
restored is in [docs/backup-postgres.md](../docs/backup-postgres.md).

### Architecture

```
Internet → your HTTPS proxy
         → Docker: GRC Tool (127.0.0.1:3000)
         → Docker: PostgreSQL 16 (Compose network only, volume pgdata)
         → File uploads (./uploads), backups (./data/backups)
```
