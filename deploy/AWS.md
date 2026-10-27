# Running the GRC Tool in your own AWS account (ECS Fargate)

This runbook covers the AWS deployment in `infra/terraform/` and the release
workflow `.github/workflows/deploy-aws.yml`. AWS and docker-compose
(`docker-compose.yml`, one machine) are the two supported ways to run the
tool. Both use PostgreSQL 16; nothing runs on SQLite any more.

- **Terraform** builds the platform: network, load balancer, ECS, EFS, RDS
  PostgreSQL, secrets, backups and the GitHub deploy role.
- **The workflow** ships releases: build the image, push it to ECR, snapshot
  the database, register a task definition revision, roll the service, and
  check `/readyz`.
- **Secret values never pass through either.** You put them into Secrets
  Manager yourself. The one exception is the database password, which
  Terraform generates without storing it (see [Secrets](#populating-secrets)).

## Architecture

```
Internet ──443──▶ Application Load Balancer (ACM cert, 80 → 301 to 443, optional WAF)   public subnets
                         │ HTTP 3000, health check /readyz
                         ▼
                  ECS Fargate service <app>-<env>-app, 2+ tasks, rolling deploys        private subnets
                         │                                 ──443──▶ NAT ──▶ email / AI APIs, AWS APIs
                         │ NFS over TLS (2049)            │ PostgreSQL over TLS, server verified (5432)
                         ▼                                ▼
                  EFS  state   → /app/var         RDS PostgreSQL 16                     database subnets
                       uploads → /app/uploads     encrypted, Multi-AZ by default

Secrets Manager ──▶ task environment: SESSION_SECRET, ISMS_MASTER_KEY, DATABASE_URL, email key, ...
CloudWatch Logs ◀── app, ECS Exec and import logs     AWS Backup ◀── daily EFS recovery points
```

Every task is the same. They share the database, the sign-in sessions, the
login lockout counter and the scheduled-job locks through PostgreSQL, and the
uploads through EFS ([Running more than one task](#running-more-than-one-task)).

### Where the app writes inside the container

| Path | Backed by | Why |
|---|---|---|
| `/app/uploads` | EFS access point `uploads` (UID/GID 1000, 0700) | Hard-coded in `server.js` and `routes/` (`uploads/firm_{id}/`), so multer's disk storage needs no change. `ISMS_UPLOADS_DIR` is set to the same path for the backup tooling. Every task must see the same files. |
| `/app/var` | EFS access point `state` (UID/GID 1000, 0700) | `ISMS_BACKUP_DIR=/app/var/backups` for app recovery generations, and the SQLite file staged during a cutover (`/app/var/iso27001.db`). |
| `/app/data` | Ephemeral volume, filled from the image | **Not** on EFS. The image keeps code there (`data/*.js` catalogs that `db.js` loads), so mounting EFS over it would hide them and stop the app from booting. |
| `/tmp` | Container file system | Upload scanning, restore checks and Chromium write here. |

The encryption key comes from the `ISMS_MASTER_KEY` secret, not a key file.
The RDS certificate bundle is part of the image, at
`/etc/ssl/rds/global-bundle.pem`.

## The database

RDS PostgreSQL 16 in the database subnets: gp3, encrypted with the stack's
KMS key, Multi-AZ by default, deletion protection, automated backups with
point-in-time recovery, and a final snapshot on deletion.

### C collation

The app compares and sorts text byte by byte, and `db.js` refuses to boot
unless its database is UTF8 with `LC_COLLATE` and `LC_CTYPE` set to `C`
(libc provider). RDS cannot provide that by itself:

- RDS creates the database named in `CreateDBInstance` (`db_name`) with the
  instance default, `en_US.UTF-8`. Neither the API nor a parameter group sets
  the locale of that database, and a database's collation cannot be changed
  after it is created.
- So the stack does not ask RDS for an application database. RDS creates only
  `postgres`. A one-off task of the app image then creates `db_name`
  (default `isms`) from `template0`:
  ```sql
  CREATE DATABASE isms TEMPLATE template0 ENCODING 'UTF8'
    LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C';
  ```
  It runs once, before the service first starts
  ([setup step 6](#first-time-setup)). Its command is the Terraform output
  `create_database_task_overrides`. The task reads `DATABASE_URL` from its own
  secret, connects to the `postgres` database with the same user and TLS
  settings, creates the database, then connects to it and logs its locale.
- The RDS master user owns the new database, so the app (connecting as that
  user) can create its schema at boot.

### TLS

- The parameter group sets `rds.force_ssl = 1`, so RDS refuses unencrypted
  connections.
- The instance uses the `rds-ca-rsa2048-g1` certificate authority.
- The image contains the Amazon RDS global CA bundle at
  `/etc/ssl/rds/global-bundle.pem`. The Dockerfile downloads it from
  `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` at build
  time and checks it against a pinned SHA-256 (see
  [The RDS CA bundle changed](#the-rds-ca-bundle-changed)).
- `DATABASE_URL` always ends in
  `?sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem`
  (output `database_url_query`). node-postgres reads both parameters from the
  URL: it trusts only that bundle and checks the host name. `pg_dump`,
  `pg_restore` and `psql` (libpq) do the same; `scripts/backup.js` passes the
  parameters on as `PGSSLMODE` and `PGSSLROOTCERT`.
- The bundle is not added to the system trust store, so it vouches for
  database servers only.
- `database_url_options` adds extra parameters after these (for example
  `connect_timeout=10`). It cannot change the TLS settings.

## What gets created

| File | Resources |
|---|---|
| `network.tf` | VPC over 2-3 AZs (public, private and database subnets), IGW, NAT (`nat_gateway_count`), free S3 gateway endpoint, optional interface endpoints, VPC flow logs, and a locked-down default security group. Or use `existing_vpc_id` with your own subnets. |
| `security-groups.tf` | Internet to ALB on 80/443; ALB to task on 3000; task to EFS on 2049 and RDS on 5432; task out on 443 (plus `task_egress_extra_tcp_ports`). |
| `kms.tf` | One customer-managed key (rotation on) for logs, secrets, EFS, RDS, ECR, backups and the import bucket. |
| `ecr.tf` | Repository with immutable tags, scan on push, and a lifecycle that keeps the newest 30 images. |
| `secrets.tf` | One secret per injected variable: `<app>-<env>/<NAME>`. Empty, except `DATABASE_URL`. |
| `efs.tf` | Encrypted file system (Elastic throughput), `state` and `uploads` access points, and a file-system policy (TLS only; app role through the access points only). |
| `rds.tf` | PostgreSQL 16: gp3, encrypted, private, deletion protection, final snapshot, PITR, Performance Insights, Enhanced Monitoring, a TLS-enforcing parameter group, log exports, and the `DATABASE_URL` secret value. |
| `iam.tf` | Execution role (pull this repository, write this log group, read these secrets). Task role (EFS through the access points; ECS Exec channels when enabled). |
| `alb.tf` | ALB (drops invalid headers, 120 s idle timeout), target group (`/readyz`), HTTPS listener (TLS 1.2/1.3 policy), HTTP redirect, and optional WAF association. |
| `ecs.tf` | Cluster (Container Insights, encrypted ECS Exec logging), task definition, and a service with rolling deploys (100 % / 200 %), circuit breaker and rollback. |
| `backup.tf` | AWS Backup vault (KMS), daily plan (35 days), and EFS selection (plus RDS if `backup_include_rds`). |
| `data-import.tf` | Optional cutover kit for an existing SQLite install: private S3 staging bucket and a one-off task that copies the files onto EFS. |
| `outputs.tf` | Besides names and ARNs, the overrides for the one-off app tasks (`create_database_task_overrides`, `sqlite_copy_task_overrides`). |
| `github-oidc.tf` | Optional GitHub OIDC provider and a deploy role scoped to one repository and environment. |
| `tests/stack.tftest.hcl` | Offline `terraform test` cases with mocked AWS: the default stack, TLS and database settings, an existing VPC, and the input guards. |

## Prerequisites

1. **AWS access.** You need administrator-level rights in the target account
   for whoever runs Terraform. Install Terraform 1.11 or later (or run
   `docker run hashicorp/terraform:1.16.5`), AWS CLI v2, `jq`, and the
   [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
   (needed for ECS Exec).
2. **ACM certificate** for the public hostname, issued in the same region:
   ```bash
   aws acm request-certificate --region <region> \
     --domain-name isms.example.com --validation-method DNS
   # Add the CNAME from `aws acm describe-certificate` to DNS, then wait for ISSUED.
   ```
3. **State bucket.** Follow the commands in `infra/terraform/backend.tf`, then
   uncomment its backend block. Use one state key per environment.
4. **GitHub environments.** Create one per target (for example `staging` and
   `production`) under Settings → Environments, with:
   - **Required reviewers** for production.
   - **Deployment branches and tags**: production limited to `main` (and
     release tags if you use them). Optionally also set the environment
     variable `DEPLOY_REQUIRED_REF=refs/heads/main`, which the workflow checks.
   - The variables listed in [step 4](#first-time-setup).
5. **The OIDC deploy role.** Let this stack create it
   (`create_github_deploy_role = true`, `github_repository = "<owner>/<repo>"`),
   or have your platform team create an equivalent. Set
   `create_github_oidc_provider = true` in exactly one stack per AWS account,
   because the GitHub identity provider is account-wide; other stacks look it
   up. The trust policy only accepts `repo:<owner>/<repo>:environment:<env>`.
6. **A transactional email provider key.** In production, `/readyz` fails
   without Resend, Brevo, or Gmail credentials, and the load balancer gates on
   `/readyz`.

## First-time setup

The order matters. A task cannot start while any secret it references is
empty, no image exists until the workflow has run once, and the app cannot
boot until its database exists.

1. **Configure.**
   ```bash
   cd infra/terraform
   cp example.tfvars production.tfvars    # *.tfvars is git-ignored; edit every value
   terraform init                         # with the backend from backend.tf
   ```
   Keep `service_enabled = false` for now. For a fresh install, also add
   `INITIAL_ADMIN_PASSWORD` to `app_secret_names` and `INITIAL_ADMIN_EMAIL` /
   `INITIAL_ADMIN_NAME` to `app_environment`. For a move from Lightsail, read
   [Cutover from Lightsail](#cutover-from-lightsail) first.
2. **Create the platform with the service stopped.**
   ```bash
   terraform plan -var-file=production.tfvars -out=production.tfplan
   terraform apply production.tfplan
   ```
   This creates RDS and writes `DATABASE_URL`. The application database does
   not exist yet.
3. **Populate every secret.** See [Populating secrets](#populating-secrets).
4. **Set the GitHub environment variables.**
   ```bash
   terraform output -json github_environment_variables |
     jq -r 'to_entries[] | select(.value != "") | "\(.key)\t\(.value)"' |
     while IFS=$'\t' read -r k v; do gh variable set "$k" --env production --body "$v"; done
   ```
5. **Run the deploy workflow.** Go to Actions → *Deploy to AWS* → *Run
   workflow* → branch `main`, environment `production`. While the service is at
   0 tasks, the workflow builds and pushes the image, snapshots RDS, registers
   the revision, points the service at it, and finishes with a notice instead
   of waiting. The one-off tasks below run the revision the service points
   at, so they need this run: a revision Terraform registers points at an
   image tag (`bootstrap`) that does not exist.
6. **Create the application database** with the C collation. This is the
   one-off task described under [C collation](#c-collation). Set up the helper
   once per shell; the other one-off tasks in this runbook use it too:
   ```bash
   C=$(terraform output -raw ecs_cluster_name)
   SERVICE=$(terraform output -raw ecs_service_name)
   NET=$(terraform output -raw one_off_app_task_network_configuration)
   one_off() {   # one_off <overrides.json>: runs the service's current revision once, prints its exit code
     td=$(aws ecs describe-services --cluster "$C" --services "$SERVICE" \
       --query 'services[0].taskDefinition' --output text)
     task=$(aws ecs run-task --cluster "$C" --task-definition "$td" \
       --launch-type FARGATE --platform-version LATEST --network-configuration "$NET" \
       --overrides "file://$1" --query 'tasks[0].taskArn' --output text)
     echo "task $task"
     aws ecs wait tasks-stopped --cluster "$C" --tasks "$task"   # gives up after 10 minutes; run it again if so
     aws ecs describe-tasks --cluster "$C" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text
   }

   terraform output -raw create_database_task_overrides > create-database.json
   one_off create-database.json    # 0
   ```
   The app log group (`/ecs/<app>-<env>/app`) shows
   `created isms: LC_COLLATE=C, LC_CTYPE=C, provider=c (c = libc), encoding=UTF8`.
   Run it only once: a second run stops with `database "isms" already exists`.
7. **Load data.** A fresh install needs nothing here: the first boot creates
   the schema and promotes the initial administrator. For a move from
   Lightsail, follow [In the window](#in-the-window) now.
8. **Start the service.** Set `service_enabled = true`, then plan and apply.
   ECS starts the revision the workflow registered.
9. **Verify before touching DNS.**
   ```bash
   ALB=$(terraform output -raw alb_dns_name)
   curl -s --connect-to isms.example.com:443:$ALB:443 https://isms.example.com/readyz | jq
   ```
   Expect `"ok": true` and `"version": "<commit SHA>"`. If `ok` is false, the
   `checks` object names the missing setting. Then log in and open a
   workspace through the same `--connect-to`, or with a temporary
   `/etc/hosts` entry pointing at an ALB IP.
10. **Cut DNS over.** See [DNS cutover](#dns-cutover).

From then on, a release means running the workflow.

The one-off tasks run the app's own task definition, so they get the same
secrets, EFS mounts and network as the service. The container health check
(`/healthz`) fails in them because nothing listens; ECS only acts on health
for tasks that belong to a service, so a one-off task runs to completion
regardless.

## Populating secrets

Secret names come from `terraform output -json secret_names`. Pipe values in
so they never appear in shell history or process listings, and strip the
trailing newline:

```bash
sid() { terraform output -json secret_names | jq -r --arg k "$1" '.[$k]'; }
put() { aws secretsmanager put-secret-value --secret-id "$(sid "$1")" --secret-string file:///dev/stdin >/dev/null; }

openssl rand -hex 48 | tr -d '\n' | put SESSION_SECRET
openssl rand -hex 32 | tr -d '\n' | put ISMS_MASTER_KEY   # new install only; see below for a move

# Provider keys: type at a hidden prompt
read -rs v && printf %s "$v" | put RESEND_API_KEY; unset v
```

Check that every secret has a value before starting the service:

```bash
for s in $(terraform output -json secret_names | jq -r '.[]'); do
  printf '%s ' "$s"
  aws secretsmanager describe-secret --secret-id "$s" --query 'length(keys(VersionIdsToStages || `{}`))' --output text
done   # every line must end in a number of 1 or more
```

**`ISMS_MASTER_KEY` when migrating: copy it, never generate it.** The copy
into PostgreSQL keeps encrypted field values exactly as stored, so they only
decrypt with the key that wrote them. Lightsail setup put it in the `.env`
file in the app's folder on the VM, written `<app-dir>` below. It was made
with `openssl rand -hex 48` (96 hex characters; the app uses the first 64).
Copy the exact value straight from the VM into Secrets Manager:

```bash
ssh ubuntu@<lightsail-ip> "sudo sed -n 's/^ISMS_MASTER_KEY=//p' <app-dir>/.env" | tr -d '\n' | put ISMS_MASTER_KEY
# Compare fingerprints without printing the key:
ssh ubuntu@<lightsail-ip> "sudo sed -n 's/^ISMS_MASTER_KEY=//p' <app-dir>/.env | tr -d '\n' | sha256sum"
aws secretsmanager get-secret-value --secret-id "$(sid ISMS_MASTER_KEY)" --query SecretString --output text | tr -d '\n' | sha256sum
```

- If the `.env` line is quoted, remove the quotes before storing it.
- If `.env` has no `ISMS_MASTER_KEY`, the key lives in
  `<app-dir>/data/master.key` (64 hex characters). Store that file's
  content instead.
- If both exist, the environment value is the one in use
  (`lib/encryption.js`).

A wrong key makes every encrypted field unreadable. Keep the separate offline
escrow copy you already hold. Secrets Manager also keeps a deleted secret
recoverable for 30 days.

`SESSION_SECRET` can be new: sign-in sessions are not copied from SQLite
(`scripts/sqlite-to-postgres.js` skips them), so everyone signs in again after
the move anyway. Copy the email provider key and any
`TPRM_MONITORING_WEBHOOK_SECRET` or AI keys, and list their names in
`app_secret_names`.

**`DATABASE_URL`** is written by Terraform with write-only arguments. The
generated password goes to RDS and into the secret, never into the state file
or plan output. To rotate it, increment `db_password_version`, apply, then run
`aws ecs update-service --cluster <c> --service <s> --force-new-deployment`.
New connections fail until the tasks restart. The URL uses the RDS master
user. To use a least-privilege role instead, create the role in the database,
set `manage_database_url_secret = false`, and `put` your own URL ending in
`?$(terraform output -raw database_url_query)`. The role must own the schema
objects (boot applies migrations), and it needs `CREATEDB` if the restore
drill or `scripts/backup.js` runs (they create scratch databases).

## Cutover from Lightsail

Only an existing SQLite install on Lightsail needs this. The data moves in
two hops: the import task copies the SQLite file and the uploads from S3 onto
EFS, then a one-off app task loads the SQLite file into RDS with
`scripts/sqlite-to-postgres.js`. After that, the only remaining step is DNS.

The commands marked **on the VM** run the SQLite release that is installed
there, not this branch.

### Before the window

- Complete [first-time setup](#first-time-setup) steps 1-6: the platform, the
  secrets (with the **Lightsail** `ISMS_MASTER_KEY`), the GitHub variables,
  one workflow run, and the C-collation database. Leave the service at 0
  tasks.
- Set `enable_data_import = true` and apply. This creates the staging bucket
  (`terraform output data_import_bucket`) and the import task.
- Lower the DNS record's TTL to 60 seconds, at least one old TTL ahead of the
  window.
- Install AWS CLI v2 on the Lightsail VM. Give it **short-lived** credentials
  that can only write to the staging bucket: an assumed role, or
  `aws configure export-credentials --format env` from IAM Identity Center.
  Never leave long-lived keys on the VM.
- **On the VM**, take a backup and run a restore drill
  (`docker compose exec -T isms node scripts/backup.js`, then
  `scripts/restore-check.js`). This is your rollback point.
- Rehearse the whole window once against a staging stack with a copy of the
  data. The SQLite copy is the step most likely to need attention
  ([Troubleshooting](#the-sqlite-copy-cannot-set-session_replication_role)).

### In the window

1. **Stop writes on Lightsail (on the VM).** If the VM's nginx has the
   maintenance rule from its `update.sh`, this marker makes it serve a
   maintenance page; otherwise stop nginx. The next step only needs the
   container. `<site>` is the app's nginx site file.
   ```bash
   if grep -q grc-deploy-maintenance /etc/nginx/sites-available/<site>; then
     sudo install -m 000 /dev/null /run/grc-deploy-maintenance
   else
     sudo systemctl stop nginx
   fi
   ```
2. **Take a final backup and a consistent single-file copy (on the VM)**, then
   stop the app. `online-db-clone.js` here is the SQLite release's version
   (online clone with an integrity check):
   ```bash
   cd <app-dir>
   docker compose exec -T isms node scripts/backup.js
   sudo install -d -m 0700 -o 1000 -g 1000 data/cutover
   docker compose exec -T isms node scripts/online-db-clone.js /app/data/iso27001.db /app/data/cutover/iso27001.db
   docker compose stop isms
   sudo sha256sum data/cutover/iso27001.db
   sudo find uploads -type f | wc -l
   ```
3. **Stage the data in S3 (on the VM).** The files belong to UID 1000, which
   is `ubuntu` on the Lightsail Ubuntu image; otherwise use `sudo -E`.
   ```bash
   B=<data_import_bucket>
   aws s3 cp data/cutover/iso27001.db "s3://$B/cutover/iso27001.db"
   aws s3 sync uploads/ "s3://$B/cutover/uploads/" --only-show-errors
   ```
4. **Copy the files onto EFS.** Confirm the service is at 0, then run the
   import task:
   ```bash
   aws ecs describe-services --cluster "$C" --services "$SERVICE" --query 'services[0].desiredCount'   # 0
   TASK=$(eval "$(terraform output -raw data_import_run_task_command) --query 'tasks[0].taskArn' --output text")
   aws ecs wait tasks-stopped --cluster "$C" --tasks "$TASK"
   aws ecs describe-tasks --cluster "$C" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode'   # 0
   ```
   The log group `/ecs/<app>-<env>/data-import` prints the database SHA-256
   and the number of upload files. Compare both with step 2. Uploads are now
   in place; the SQLite file is at `/app/var/iso27001.db`. The task refuses
   to overwrite an existing file there unless you pass `IMPORT_OVERWRITE=1`
   in a container override.
5. **Load the database into RDS.** With the `one_off` helper from
   [setup step 6](#first-time-setup):
   ```bash
   terraform output -raw sqlite_copy_task_overrides > sqlite-copy.json
   one_off sqlite-copy.json    # 0
   ```
   The task runs
   `node scripts/sqlite-to-postgres.js --sqlite /app/var/iso27001.db --pg "$DATABASE_URL"`.
   In one transaction it applies the schema, copies every table keeping ids,
   moves the id sequences on, re-checks every foreign key, and commits only
   if every row count matches (docs/postgres-port.md, section 7). The app log
   group ends with `Copied <n> rows in <m> tables; row counts match.` Exit 1
   means verification failed and nothing was written; exit 2 is a setup
   problem (connection, permissions, or tables that already hold rows). The
   copy refuses a database the app has already booted against, because boot
   seeds reference data. In that case add `--truncate` to the command in
   `sqlite-copy.json` and run it again.
6. **Start the service.** Set `service_enabled = true` and apply. The first
   boot applies the migrations newer than the SQLite release. Then verify as
   in [setup step 9](#first-time-setup), and do a smoke test: log in (everyone
   signs in again), open a workspace, download an existing evidence file,
   upload a small file (this exercises ClamAV and EFS), and check that an
   emailed link uses the public hostname.
7. **Switch DNS** ([DNS cutover](#dns-cutover)).
8. **Clean up.**
   - Run `aws s3 rm "s3://$B/cutover" --recursive`, set
     `enable_data_import = false`, and apply.
   - Delete `data/cutover/` on the VM and revoke the temporary credentials.
   - Leave the Lightsail instance stopped, with the maintenance marker in
     place, for the agreed rollback period. Then snapshot it and delete it.
   - After the rollback period, delete the staged SQLite file:
     ```bash
     echo '{"containerOverrides":[{"name":"app","command":["rm","-f","/app/var/iso27001.db"]}]}' > remove-sqlite.json
     one_off remove-sqlite.json    # 0
     ```

## DNS cutover

- **Route 53:** create an alias `A` record for the hostname, pointing at
  `alb_dns_name` / `alb_zone_id`.
- **Other DNS providers:** use a `CNAME` to `alb_dns_name`. At a zone apex you
  need ALIAS/ANAME support.
- The hostname must match `app_base_url` and be covered by the certificate.
- Watch the ALB request count rise and the Lightsail nginx log go quiet. The
  app already sends HSTS in production.

## Deploying a release

Go to Actions → **Deploy to AWS** → *Use workflow from* `main` (or a release
tag) → choose the environment, then wait for the environment's reviewers to
approve. The job then:

1. Checks its settings (including `DB_INSTANCE_IDENTIFIER`, unless the
   snapshot is skipped), and that the ref is allowed (`DEPLOY_REQUIRED_REF`).
2. Assumes `AWS_DEPLOY_ROLE_ARN` through GitHub OIDC. No stored AWS keys are
   involved.
3. Builds `linux/amd64` and pushes `<repo>:<commit SHA>`. If that tag already
   exists, it reuses the image. With **rebuild_image**, it builds a fresh image
   of the same commit under `<SHA>-r<run>`, which is how ClamAV signatures and
   Alpine packages get refreshed.
4. Takes an RDS snapshot `<db>-predeploy-<sha12>-<time>` (skip with
   `skip_database_snapshot`).
5. Copies the newest task definition revision (it carries Terraform's current
   configuration), changes only the image and `APP_VERSION`, and registers it.
6. Updates the service, then waits until the **primary** deployment is our
   revision with rollout `COMPLETED`. New tasks start beside the old ones,
   which stop once the new ones are healthy. It fails if the circuit breaker
   rolled back.
7. Calls `/readyz` through the load balancer (by `ALB_DNS_NAME`, using the
   public hostname for TLS) until six consecutive answers report `ok: true`
   and this commit's SHA.

During the roll, old and new tasks serve side by side, and the first new task
to boot applies any migrations while the old tasks are still running. A
release's migrations must therefore not break the code it replaces, or the
old tasks fail requests until they stop.

Configuration you change in Terraform (environment variables, the list of
secrets, CPU and memory) reaches the tasks with the next workflow run. To ship
it without a code change, re-run the workflow for the commit that is already
deployed; it reuses the image. A changed secret *value* needs a restart:
`aws ecs update-service --cluster <c> --service <s> --force-new-deployment`.

## Rollback

- **Automatic.** A revision whose tasks never become healthy is rolled back by
  the ECS deployment circuit breaker, and the workflow fails.
- **Code rollback.** Re-run the workflow from the previous release tag or
  commit; its image is reused, so this is fast. Alternatively, point the
  service at an earlier revision:
  ```bash
  aws ecs list-task-definitions --family-prefix <family> --sort DESC --max-items 5
  aws ecs update-service --cluster <c> --service <s> --task-definition <family>:<revision>
  ```
- **Data rollback.** New tasks migrate the live database, and nothing proves
  beforehand that the previous image can still run on the migrated schema.
  If a release's migration is not backward-compatible, rolling back the code
  also needs a data restore: restore the pre-deploy snapshot or a point in
  time to a **new** instance, set `manage_database_url_secret = false`, `put`
  a URL for the restored endpoint (ending in `database_url_query`), force a
  new deployment, and reconcile Terraform state afterwards. A restored
  instance keeps its databases, so the C-collation database comes back as it
  was. Rehearse this once in staging.
- **Back to Lightsail during the cutover window.** If AWS has not taken writes
  yet, point DNS back, then on the VM run
  `docker compose start isms && sudo rm /run/grc-deploy-maintenance`. Once AWS
  has accepted writes, those writes exist only on AWS; nothing copies them
  back to SQLite. Agree on a point of no return before the window.

## Backups and restore

| What | How | Retention |
|---|---|---|
| Database (primary) | RDS automated backups with point-in-time recovery, a final snapshot on deletion, and pre-deploy manual snapshots from the workflow | `db_backup_retention_days` (14). Manual snapshots stay until you delete them. |
| Uploads (primary) | AWS Backup of EFS, daily at 03:00 UTC into a KMS-encrypted vault | `backup_retention_days` (35) |
| Database, longer or in one console (optional) | `backup_include_rds = true` adds RDS to the same AWS Backup plan | `backup_retention_days` |
| Portable export (optional) | App recovery generation (`scripts/backup.js`, [docs/backup-postgres.md](../docs/backup-postgres.md)): one encrypted, signed bundle of the database and the uploads taken at the same moment, restorable on any PostgreSQL 16 server | `ISMS_BACKUP_RETAIN` generations in `/app/var/backups` (on EFS, so AWS Backup copies them too) |
| Master key | The `ISMS_MASTER_KEY` secret (KMS, 30-day deletion window), plus your offline escrow copy | Keep the escrow apart from the backups. Encrypted fields and app generations cannot be read without the key. |

RDS and AWS Backup copy the database and the uploads separately, minutes
apart. Restoring both from the same night can leave a few uploads without a
database row, or the reverse. The app recovery generation is the one copy
that is consistent across both.

**App recovery generations** are optional on AWS. To keep them, run
`scripts/backup.js` as a one-off task, by hand or on a schedule (for example
an EventBridge Scheduler rule that calls `ecs:RunTask`; this stack does not
create one):

```bash
echo '{"containerOverrides":[{"name":"app","command":["node","scripts/backup.js"]}]}' > app-backup.json
one_off app-backup.json    # 0
```

Each run restores the new generation into a scratch database before it
commits it, so the role in `DATABASE_URL` needs `CREATEDB` (the master user
has it). Two runs cannot overlap: the lock file is on EFS. The app also runs a
**monthly restore drill** of the newest generation. With no generations it
would record a failure every hour, so the stack sets
`ISMS_RESTORE_DRILL_DISABLED=1` unless you set `restore_drill_enabled = true`.
Turn the drill on only once generations are scheduled.

**Restoring the database:** see [Rollback](#rollback). To load an app
generation instead, follow docs/backup-postgres.md ("Restoring") into a new,
empty C-collation database.

**Restoring EFS:** AWS Backup restores a recovery point (item-level or full)
into an `aws-backup-restore_<timestamp>` directory at the root of the file
system, or into a new file system. The app's access points
(`/isms-state`, `/isms-uploads`) cannot see that directory, so moving data
back is an administrator task:

1. Scale the service to 0 (`service_enabled = false`).
2. Launch a temporary EC2 instance in a private subnet with the task security
   group, `amazon-efs-utils`, and an administrator role.
3. Mount the file system root with `-o tls,iam`.
4. Copy the restored `isms-state/` or `isms-uploads/` content over the live
   directories, keeping owner `1000:1000` and private modes.
5. Unmount, terminate the instance, and start the service.

Rehearse this once in staging.

**Clean up pre-deploy snapshots** now and then:
`aws rds describe-db-snapshots --db-instance-identifier <db> --snapshot-type manual`
lists them, and `aws rds delete-db-snapshot` removes them.

## Operations

- **Logs:** CloudWatch Logs `/ecs/<app>-<env>/app`, which also holds the
  output of the one-off tasks. Use Logs Insights, for example
  `fields @timestamp, @message | filter @message like /ERROR|\[shutdown\]/ | sort @timestamp desc`.
  ECS Exec session logging is configured, but the Alpine image has no `script`
  binary, so session transcripts are not captured. CloudTrail still records
  who ran `ExecuteCommand` and when.
- **ECS Exec** is for interactive diagnosis only. Sessions start as root with
  almost every Linux capability removed, so root cannot read the app's private
  files; only `SETUID`/`SETGID` are kept, so that
  `su -s /bin/sh node -c '...'` works. If sessions do not start, check that
  the Session Manager plugin is installed locally and that the task started
  after `enable_execute_command` was turned on. If they still fail, set the
  cluster's exec logging to `DEFAULT` in `ecs.tf` (`logging = "DEFAULT"`, no
  `log_configuration`).
- **ClamAV signatures** are fixed when the image is built (`RUN freshclam` in
  the Dockerfile). A Fargate task cannot refresh them as root. Run the
  workflow with **rebuild_image** at least weekly, or decide on a `clamd` +
  `freshclam` sidecar.
- **Scaling:** change `desired_count` (2 to 20). Autoscaling is not
  configured. Each task opens up to `PG_POOL_MAX` (default 10) database
  connections, plus short-lived ones for the boot and job locks; check the
  total against the instance class's `max_connections` before scaling far.
- **Rotating secrets:**
  - `SESSION_SECRET`: `put` a new value and force a new deployment. Everyone is
    signed out.
  - Provider API keys: `put` the new value and force a new deployment.
  - Database password: increment `db_password_version`, apply, and force a
    new deployment.
  - **Never** `put` a new `ISMS_MASTER_KEY`. Key rotation has to go through
    the application's re-encryption path (`lib/keyrotation.js`).
- **Patching:** Fargate uses the `LATEST` platform version. RDS takes minor
  versions automatically in `db_maintenance_window`. Base image and Alpine
  packages update when you rebuild.
- **Readiness versus liveness:** the load balancer gates on `/readyz`, so
  removing the email provider key or breaking ClamAV takes tasks out of
  service on their next start. `/readyz` checks the scanner at most once a
  minute per task. Set `health_check_path = "/healthz"` if you prefer
  liveness only; the workflow still requires `/readyz` before calling a
  release good. The container health check uses `/healthz`.

## Troubleshooting the first deploy

These parts of the design depend on AWS behaviour that cannot be checked
offline. Each has a quick diagnosis.

- **Task stops at boot, and the app log shows `Cannot find module './data/...'`.**
  ECS should copy the image's `/app/data` into the ephemeral `app-data` bind
  volume (it is a Dockerfile `VOLUME`). If your platform version does not,
  remove the `app-data` volume and its mount point from `ecs.tf`. The image's
  own `/app/data` is then used directly.
- **Task stops at boot with `database "isms" does not exist`.** Run the
  database creation task ([setup step 6](#first-time-setup)).
- **Task stops at boot with `Database "isms" has LC_COLLATE=en_US.UTF-8 ...`.**
  The database was created some other way (for example by RDS, from an older
  version of this stack that set `db_name` on the instance). Its collation
  cannot be changed. If it is empty, drop it as the master user
  (`DROP DATABASE isms;` from a one-off task with `psql`) and run the creation
  task; if it holds data, copy the data into a new C-collation database first.
- **Connections fail with `self-signed certificate in certificate chain` or
  `unable to get local issuer certificate`.** The image does not contain the
  RDS bundle (built from an older Dockerfile), or `DATABASE_URL` lacks
  `sslrootcert` (a hand-written URL; append `database_url_query`). Connections
  fail closed: there is no fallback to unverified TLS.
- **The one-off task fails at once with `CannotPullContainerError`.** The
  service still points at Terraform's revision (`bootstrap` image tag). Run
  the deploy workflow once first.
- **Task stops with `ResourceInitializationError` mentioning secrets.** A
  secret in the task definition has no value yet. Run the check under
  [Populating secrets](#populating-secrets).
- **Task stops with an EFS mount error.** Check that the mount targets exist
  in every private subnet the service uses (at most one subnet per AZ). Also
  check that the file system policy names the task role (`efs.tf`).
- **Targets stay unhealthy while the app log looks fine.** `/readyz` returns
  503 until every production check passes. Run the `curl --connect-to ...`
  check from setup step 9 and read `checks`.
- **RDS rejects the parameter group.** Remove `log_parameter_max_length` and
  `log_parameter_max_length_on_error` from `rds.tf`. TLS enforcement and
  slow-query logging do not depend on them.
- **`docker build` fails with `toomanyrequests`.** The runner pulls
  `node:22-alpine` from Docker Hub anonymously. Re-run the workflow, or see
  [Decisions](#decisions-left-to-you).

### The SQLite copy cannot set `session_replication_role`

`scripts/sqlite-to-postgres.js` loads historical rows with
`session_replication_role = replica`, which turns off the guard triggers and
foreign-key checks for its own transaction (it re-checks every foreign key
afterwards). PostgreSQL allows that only to a superuser. The RDS master user
is not a superuser but holds `rds_superuser`, which RDS lets set this
parameter; this has not been tried on this stack yet, which is why the
rehearsal matters. If the copy exits 2 with `cannot set
session_replication_role`, copy into a PostgreSQL 16 server you control
(for example a local container, database created with the C collation), then
move that database to RDS with `pg_dump --format=custom` and
`pg_restore --no-owner` into the empty C-collation database. pg_restore loads
the data before it creates triggers and foreign keys, so it needs no
superuser.

### The RDS CA bundle changed

AWS adds certificates to the global bundle from time to time. The Dockerfile
pins its SHA-256, so the next image build stops at the `sha256sum -c` line.
Download the bundle from the same URL, check that the change is what AWS
announced (new regions or a new CA generation; compare the certificate
subjects with `openssl x509 -noout -subject`), then update the hash in the
Dockerfile and commit. Images built before the change keep working until the
instance moves to a CA that is only in the new bundle.

## Security notes and scanner results

Checkov 3.3.27 (`--framework terraform`): 303 passed, 0 failed, 16 skipped.
Each skip carries an inline `checkov:skip` reason:

| Check | Where | Why it is accepted |
|---|---|---|
| CKV_AWS_109 / 111 / 356 | KMS key policy | The account-root statement is AWS's default key policy. In a key policy, `"*"` means this key. |
| CKV_AWS_260 | ALB port 80 | Port 80 only returns a 301 to HTTPS. |
| CKV2_AWS_57 | Secrets | No safe automatic rotation exists: the master key must never be replaced, and the others follow the procedures above. |
| CKV2_AWS_76 | ALB WAF (Log4j rule set) | WAF is your choice (`waf_web_acl_arn`), and the app is Node.js. |
| CKV_AWS_394 | AZ data source | Only the first `az_count` sorted names are used; `availability_zones` pins them. |
| CKV2_AWS_5 | Endpoint and import security groups | Attached through `for_each` or at `run-task` time. |
| CKV_AWS_18 / 21 / 144, CKV2_AWS_62 | Import bucket | Short-lived staging bucket; copies must be fully deletable after cutover. |

Checkov `--framework github_actions` on the workflow: 59 passed, 1 failed.
CKV_GHA_7 (SLSA: "workflow_dispatch inputs must be empty") is accepted. The
inputs choose the target environment and whether to snapshot or rebuild. None
of them changes what is built from the commit.

Other trade-offs the scanner does not report:

- **`readonlyRootFilesystem` is off.** The app writes to `os.tmpdir()`, and
  Chromium and ClamAV need writable paths. See
  [Remaining gaps](#remaining-gaps).
- **ALB access logs are off by default.** ALB logs record the full URL
  including query strings (filters, reset links, old CSRF-bearing URLs). If
  you enable `alb_access_logs_bucket`, apply short retention and restricted
  access to that bucket.
- **Task egress on 443 goes to `0.0.0.0/0`.** The email and AI providers have
  no fixed IP ranges. Use AWS Network Firewall or an egress proxy if you need
  a domain allow-list.
- **SETUID/SETGID stay in the capability bounding set** while ECS Exec is
  enabled. They are not effective for the app (UID 1000), and the base image
  has no setuid binaries. Set `enable_execute_command = false` to drop all
  capabilities.
- **The app connects as the RDS master user** by default. See
  [Decisions](#decisions-left-to-you).

## Cost (rough, us-east-1 on-demand list prices, per month)

| Item | Cost |
|---|---|
| Fargate, 2 vCPU / 4 GB per task (x86), 2 tasks | ≈ $144 |
| Application Load Balancer | ≈ $16 + LCUs (≈ $6) |
| NAT gateway (one) | ≈ $33 + $0.045 per GB; each extra NAT adds ≈ $33 |
| RDS db.t4g.small, 20 GB gp3 | Multi-AZ ≈ $52; single-AZ ≈ $26 |
| EFS Elastic | $0.30 per GB-month + $0.03/$0.06 per GB read/written |
| AWS Backup (EFS) | $0.05 per GB-month |
| Secrets Manager, KMS | ≈ $4-5 |
| CloudWatch Logs, Container Insights, flow logs | ≈ $5-15, depending on volume |
| ECR storage | ≈ $0.10 per GB-month (a few dollars at 30 images) |
| Interface endpoints (optional) | ≈ $7.30 each per AZ |
| **Rough total** | **≈ $260-300** (Multi-AZ) |

Ways to lower the bill:

- Compute Savings Plans for Fargate.
- A smaller staging environment: `db_multi_az = false`, smaller tasks, and
  `service_enabled = false` when idle.
- One NAT gateway.
- Fewer retained images.
- ARM64 tasks (cheaper, but they need an ARM image build).

Check your region in the AWS Pricing Calculator.

## Running more than one task

The service runs two or more identical tasks. What used to live in one
process now lives in PostgreSQL or EFS:

| Concern | How it is shared | Where |
|---|---|---|
| Sign-in sessions | `sessions` table; an hourly job deletes expired rows | `lib/pg/session-store.js`, migration 084 |
| Login lockout (8 failures per email in 15 minutes) | `login_failures` table, counted in one `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statement; an hourly job deletes ended windows | `routes/auth.js`, migration 087 |
| Scheduled jobs (5 s after boot, then hourly) | Every task runs the scheduler; each job holds a PostgreSQL advisory lock while it runs, and a task that cannot take it skips that job | `lib/jobs.js` (`runAllJobs`) |
| In-app notifications | `notify()` takes an advisory transaction lock on the notification before its duplicate check; the email mirror claims each (notification, user) pair with `ON CONFLICT DO NOTHING` | `lib/jobs.js` |
| Notification email delivery | Each task polls the outbox and claims a row with a conditional `UPDATE` before sending, so one row is sent by one task | `lib/notification-delivery.js` |
| Schema, migrations and seeds at boot | Run under a session advisory lock, one task at a time | `db.js` `init()`, `migrations/run.js` (`withBootLock`) |
| Uploads and app backups | EFS | `/app/uploads`, `/app/var` |

Other items that used to be on this list are done: `/readyz` reuses the
scanner check for a minute (`lib/upload-security.js`) instead of spawning
`clamscan` on every health check, and the policy acknowledgement records
`req.ip` (`routes/documents.js`) instead of the client-controlled first
`X-Forwarded-For` entry.

No change is needed for `X-Forwarded-Proto`. The app trusts exactly one proxy
in production, which is the ALB, so `req.secure`, secure cookies and `req.ip`
work as they would behind nginx. If you put CloudFront or another proxy in
front of the ALB, the trust proxy count must change.

### Remaining gaps

These need application changes. The infrastructure does not paper over them.

1. **Database creation is a manual step.** The app refuses a database without
   the C collation but cannot create one. Given an administrative URL, boot
   could create it, which would remove setup step 6.
2. **Scheduled app backups:** the app does not schedule `scripts/backup.js`
   itself. It is safe as a one-off task from any task now, but something
   outside the app has to start it ([Backups](#backups-and-restore)).
3. **Read-only root file system:** honour `TMPDIR` and keep Chromium and
   ClamAV writes under one configurable directory. The stack can then mount
   `/tmp` as a volume and turn on `readonlyRootFilesystem`.
4. **ECS Exec transcripts:** add `util-linux-misc` (`script`) to the image if
   you want session transcripts in CloudWatch.
5. **Reads followed by writes outside a transaction.** Within one process,
   every transaction takes one writer lock; across tasks, code that reads and
   then writes without a transaction relies on a unique constraint or a lock
   of its own. docs/postgres-data-layer.md ("Concurrency and more than one
   instance") describes the rule; this runbook does not audit every route.

## Decisions left to you

- Whether the app connects as the RDS master user (the default) or as a
  least-privilege role ([Populating secrets](#populating-secrets)).
- `db_multi_az` (on by default), `nat_gateway_count` (1 by default),
  `desired_count` (2 by default) and task size: resilience against cost.
- Whether to create the GitHub OIDC deploy role here or centrally, the
  reviewers for production, and the allowed deployment branches.
- WAF: whether to attach one (`waf_web_acl_arn`) and which rules to use. The
  login lockout counts per email; a WAF rate rule per IP also slows password
  spraying across many emails. Check the AWS managed common rule set's
  body-size rule against the app's 10 MB uploads before enforcing it.
- ALB access logs (and their retention), given the query-string issue above.
- AWS Backup vault lock (immutability), cross-region or cross-account copies,
  retention periods, and whether RDS joins the plan (`backup_include_rds`).
- Whether to keep app recovery generations as a portable export, how they
  are scheduled, and then `restore_drill_enabled`.
- How ClamAV signatures stay fresh: a weekly rebuild, or a sidecar.
- Alarms and notifications (ALB 5xx, unhealthy hosts, task restarts, RDS
  storage, CPU and connections, backup job failures). None are included.
- Autoscaling.
- How long Lightsail stays available as a rollback after cutover.
- Docker Hub rate limits during builds: add a Docker Hub token to the
  workflow, or mirror `node:22-alpine` in ECR (changes the Dockerfile `FROM`).
- Whether to require a green CI run for the exact commit before deploying.
  Today this relies on branch protection for `main` and on environment
  reviewers.

## Validating changes to this stack offline

```bash
cd infra/terraform
docker run --rm -v "$PWD":/tf -w /tf hashicorp/terraform:1.16.5 fmt -check -recursive
docker run --rm -v "$PWD":/tf -w /tf hashicorp/terraform:1.16.5 init -backend=false
docker run --rm -v "$PWD":/tf -w /tf hashicorp/terraform:1.16.5 validate
docker run --rm -v "$PWD":/tf -w /tf hashicorp/terraform:1.16.5 test
cd ../.. && docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 .github/workflows/deploy-aws.yml
```
