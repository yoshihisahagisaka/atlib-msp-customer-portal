'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { expected, normalizedSql, runStageBJob } = require('../scripts/secureGuardSourceInventoryStageBJob.cjs');

const realSql = normalizedSql();
const fixtureSecret = 'fixture-password-never-log';
const validEnv = Object.freeze({
  SG_STAGE_B_EXPLICIT_APPROVAL: 'APPROVED_ONCE',
  DB_NAME: expected.database,
  DB_USER: expected.user,
  CLOUD_SQL_INSTANCE: expected.instance,
  DB_PASSWORD_FILE: expected.secretFile,
});

function harness({ queryError, sql = realSql, secret = fixtureSecret } = {}) {
  const calls = { connect: 0, query: [], end: 0, configs: [], reads: [] };
  class FakeClient {
    constructor(config) { calls.configs.push(config); }
    async connect() { calls.connect += 1; }
    async query(value) {
      calls.query.push(value);
      if (queryError) throw queryError;
      return { command: 'COMMIT' };
    }
    async end() { calls.end += 1; }
  }
  const readFile = (path, encoding) => {
    calls.reads.push({ path, encoding });
    return path === expected.secretFile ? secret : sql;
  };
  const logs = [];
  return { calls, FakeClient, readFile, logs, log: (value) => logs.push(value) };
}

test('Stage B job runs the digest-pinned SQL exactly once and never logs the secret', async () => {
  const h = harness();
  await runStageBJob({ env: validEnv, ClientClass: h.FakeClient, readFile: h.readFile, log: h.log });
  assert.equal(h.calls.connect, 1);
  assert.deepEqual(h.calls.query, [realSql]);
  assert.equal(h.calls.end, 1);
  assert.equal(h.calls.configs[0].host, `/cloudsql/${expected.instance}`);
  assert.equal(h.calls.configs[0].user, 'portal_app');
  assert.equal(h.calls.configs[0].password, fixtureSecret);
  assert.deepEqual(h.logs.map(JSON.parse).map(({ status }) => status), ['ENTER', 'COMPLETE']);
  assert.equal(h.logs.join('\n').includes(fixtureSecret), false);
});

test('Stage B job rejects config drift before reading a secret or opening a connection', async () => {
  for (const [name, value, code] of [
    ['SG_STAGE_B_EXPLICIT_APPROVAL', undefined, 'CONFIG_EXPLICIT_APPROVAL_REQUIRED'],
    ['DB_NAME', 'other', 'CONFIG_DB_NAME_INVALID'],
    ['DB_USER', 'postgres', 'CONFIG_DB_USER_INVALID'],
    ['CLOUD_SQL_INSTANCE', 'other:region:instance', 'CONFIG_INSTANCE_INVALID'],
    ['DB_PASSWORD_FILE', '/tmp/password', 'CONFIG_SECRET_FILE_INVALID'],
  ]) {
    const h = harness();
    const env = { ...validEnv, [name]: value };
    await assert.rejects(
      runStageBJob({ env, ClientClass: h.FakeClient, readFile: h.readFile, log: h.log }),
      (error) => error.code === code,
    );
    assert.equal(h.calls.reads.length, 0);
    assert.equal(h.calls.configs.length, 0);
  }
});

test('Stage B job rejects changed SQL and empty secret before query dispatch', async () => {
  for (const fixture of [
    { sql: `${realSql}\nSELECT 1;`, code: 'STAGE_B_SQL_DIGEST_MISMATCH' },
    { secret: '', code: 'SECRET_FILE_EMPTY' },
  ]) {
    const h = harness(fixture);
    await assert.rejects(
      runStageBJob({ env: validEnv, ClientClass: h.FakeClient, readFile: h.readFile, log: h.log }),
      (error) => error.code === fixture.code,
    );
    assert.equal(h.calls.query.length, 0);
  }
});

test('Stage B job classifies unavailable SQL and secret without leaking file errors', async () => {
  for (const [failedPath, code] of [
    ['sql', 'STAGE_B_SQL_UNAVAILABLE'],
    ['secret', 'SECRET_FILE_UNAVAILABLE'],
  ]) {
    const h = harness();
    const readFile = (path, encoding) => {
      if ((failedPath === 'secret') === (path === expected.secretFile)) {
        throw new Error(`sensitive file failure ${fixtureSecret}`);
      }
      return h.readFile(path, encoding);
    };
    await assert.rejects(
      runStageBJob({ env: validEnv, ClientClass: h.FakeClient, readFile, log: h.log }),
      (error) => error.code === code,
    );
    assert.equal(h.calls.query.length, 0);
    assert.equal(h.logs.join('\n').includes(fixtureSecret), false);
  }
});

test('Stage B unknown result is fixed-code, secret-free and never retried', async () => {
  const h = harness({ queryError: new Error(`driver leaked ${fixtureSecret}`) });
  await assert.rejects(
    runStageBJob({ env: validEnv, ClientClass: h.FakeClient, readFile: h.readFile, log: h.log }),
    (error) => error.code === 'STAGE_B_RESULT_UNKNOWN_OR_FAILED',
  );
  assert.equal(h.calls.query.length, 1);
  assert.equal(h.logs.join('\n').includes(fixtureSecret), false);
  assert.equal(h.logs.join('\n').includes('driver leaked'), false);
  assert.deepEqual(h.logs.map(JSON.parse).map(({ status }) => status), ['ENTER', 'STOP']);
});

test('Stage B workload image pins supported Node 24 and contains only the fixed runner contract', () => {
  const dockerfile = readFileSync(resolve(__dirname,
    '../scripts/Dockerfile.secure-guard-source-inventory-stage-b'), 'utf8');
  const deps = JSON.parse(readFileSync(resolve(__dirname,
    '../scripts/secure-guard-stage-b/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(__dirname,
    '../scripts/secure-guard-stage-b/package-lock.json'), 'utf8'));
  const ignore = readFileSync(resolve(__dirname,
    '../scripts/Dockerfile.secure-guard-source-inventory-stage-b.dockerignore'), 'utf8');
  assert.deepEqual(deps.dependencies, { pg: '8.22.0' });
  assert.equal(deps.engines.node, '>=24 <25');
  assert.deepEqual(lock.packages[''].dependencies, deps.dependencies);
  assert.deepEqual(Object.keys(lock.packages).filter((name) => name.startsWith('node_modules/')).sort(),
    ['pg', 'pg-cloudflare', 'pg-connection-string', 'pg-int8', 'pg-pool',
      'pg-protocol', 'pg-types', 'pgpass', 'postgres-array', 'postgres-bytea',
      'postgres-date', 'postgres-interval', 'split2', 'xtend']
      .map((name) => `node_modules/${name}`).sort());
  assert.match(dockerfile, /FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS stage-b-deps/);
  assert.match(dockerfile, /FROM gcr\.io\/distroless\/nodejs24-debian13@sha256:[a-f0-9]{64} AS stage-b-runtime/);
  assert.match(dockerfile, /COPY scripts\/secure-guard-stage-b\/package\.json scripts\/secure-guard-stage-b\/package-lock\.json/);
  assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.match(dockerfile, /COPY --from=stage-b-deps \/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /COPY scripts\/secureGuardSourceInventoryStageBJob\.cjs/);
  assert.match(dockerfile, /COPY scripts\/secureGuardSourceInventoryRoleStageB\.sql/);
  assert.match(dockerfile, /USER nonroot/);
  assert.match(dockerfile, /CMD \["scripts\/secureGuardSourceInventoryStageBJob\.cjs"\]/);
  assert.doesNotMatch(dockerfile, /node:20|COPY src|COPY migrations|CMD \["sh"|COPY package\.json package-lock\.json/);
  assert.deepEqual(ignore.trim().split('\n'), [
    '**',
    '!scripts/',
    '!scripts/secure-guard-stage-b/',
    '!scripts/secure-guard-stage-b/package.json',
    '!scripts/secure-guard-stage-b/package-lock.json',
    '!scripts/secureGuardSourceInventoryStageBJob.cjs',
    '!scripts/secureGuardSourceInventoryRoleStageB.sql',
  ]);
});
