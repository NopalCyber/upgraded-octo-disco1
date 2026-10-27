'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const composePath = path.join(root, 'docker-compose.yml');
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');
const serverPath = path.join(root, 'server.js');
const emailPath = path.join(root, 'lib', 'email.js');

const compose = fs.readFileSync(composePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const emailSource = fs.readFileSync(emailPath, 'utf8');

test('Compose runs the app behind a local-only port on PostgreSQL 16 with the C locale', () => {
  assert.match(compose, /image: "\$\{ISMS_IMAGE:-iso27001-tool:local\}"/);
  assert.match(compose, /APP_VERSION=\$\{APP_VERSION:-development\}/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /healthcheck:[\s\S]*\/healthz/);
  assert.match(compose, /stop_grace_period: 20s/);
  assert.match(compose, /image: postgres:16\.\d+/);
  assert.match(compose, /POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8/);
  assert.match(compose, /POSTGRES_PASSWORD=\$\{POSTGRES_PASSWORD:\?/);
  assert.match(compose, /depends_on:\s*\n\s*db:\s*\n\s*condition: service_healthy/);
  const db = compose.slice(compose.indexOf('\n  db:'));
  assert.doesNotMatch(db.slice(0, db.indexOf('\nvolumes:')), /ports:/, 'the database is not published outside the Compose network');
});

test('a no-send switch keeps preflight and staging boots from delivering email', () => {
  assert.match(serverSource, /EMAIL_DELIVERY_DISABLED !== '1'/);
  assert.match(emailSource, /EMAIL_DELIVERY_DISABLED/);
});

test('CI builds, readiness-checks, and gracefully stops the actual production image', () => {
  assert.match(workflow, /docker build --tag iso27001-tool:ci/);
  assert.match(workflow, /http:\/\/127\.0\.0\.1:3300\/readyz/);
  assert.match(workflow, /docker stop --time 20 nimbus-ci/);
});
