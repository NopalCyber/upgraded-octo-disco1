# Runtime and deployment safety

This document describes the production safety boundary for runtime failures,
process termination, and releases.

## Releases

There are two supported ways to run the application (`deploy/DEPLOY.md`):

- **AWS**: `.github/workflows/deploy-aws.yml` builds an image addressed by its
  commit, and ECS rolls it out behind the load balancer. Release, rollback and
  the pre-deploy database snapshot are described in `deploy/AWS.md`
  ("Deploying a release", "Rollback").
- **Docker Compose on one server**: take a recovery generation, pull, and
  `docker compose up -d --build`; then require `/readyz` (`deploy/DEPLOY.md`,
  "Updating").

In both, boot applies pending migrations while holding a PostgreSQL advisory
lock (`migrations/run.js`), so two instances starting together never migrate
at the same time. Rolling back changes application code only: if a release
migrated the database, restoring data is a separate, explicit decision (an RDS
snapshot on AWS, a recovery generation with Compose).

Production promotion requires every `/readyz` check to pass. In particular,
configure an HTTPS `APP_BASE_URL`, a transactional email provider, a strong
session secret and master key, and required ClamAV scanning. `/healthz` is the
liveness check: it proves the process and database respond, while `/readyz`
is the stricter gate.

## Offline recovery materialization

Choose a signed generation and materialize it without touching live data:

```bash
node scripts/restore.js --destination <empty-directory> --generation <generation-id>
```

The command fails closed unless the manifest HMAC, RPO age, archive hashes,
signed row counts and every upload path, hash and size verify, and the dump
restores into a scratch database. It writes `restored.pgdump`, `uploads/` and
`recovery-report.json` and never promotes them. `--restore-into <url>` loads
the verified dump into an empty database; the live database is refused. The
procedure for switching over is in `docs/backup-postgres.md`. The separately
escrowed encryption key is never replaced from a generation.
`--allow-stale-generation` is a disaster-salvage override, not a normal
RPO-compliant restore.

## Request failure boundary

All handlers registered through the Express application route methods have a
Promise rejection boundary. A rejected async handler is forwarded to the final
error middleware and cannot leave the request hanging.

Every request receives an `X-Request-Id`. Internal failures are logged on the
server with that identifier, method, and path, but never the query string. The
client receives only an opaque HTTP 500 response and the request ID; exception
messages and stack traces are not returned.

## Graceful process termination

`SIGTERM` and `SIGINT` use one idempotent shutdown controller. The sequence is:

1. Cancel both the scheduled-job startup timeout and recurring interval.
2. Stop the HTTP listener and allow active requests to finish.
3. Drain queued and in-flight document worker jobs, then terminate the pool
   without respawning threads.
4. Close the database connection pool.

The default runtime deadline is 15 seconds and can be set with
`SHUTDOWN_TIMEOUT_MS`. Compose allows 20 seconds before forcing container
termination. On deadline expiry, active HTTP connections are closed and worker
promises are rejected before forced thread termination. A second termination
signal exits immediately.

An unhandled Promise rejection in the main runtime uses the same idempotent
controller and always exits nonzero after draining. Importing `server.js` as a
test or library does not install this process-level handler. The session-store
expiry loop is disabled at its source; the governed jobs module owns the only
session sweep timer and can cancel it during shutdown.

## Verification

Focused repository tests cover async rejection handling, opaque correlated
responses, query-free application error logs, override expiry, idempotent and
bounded shutdown, scheduled-timer cancellation, worker termination without
respawn, and the static deployment invariants. CI also builds the production
Dockerfile, starts the resulting image with production readiness settings,
checks `/readyz`, and verifies a graceful zero-exit container stop.
