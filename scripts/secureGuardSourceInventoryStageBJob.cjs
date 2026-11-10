'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

const stageBPath = resolve(__dirname, 'secureGuardSourceInventoryRoleStageB.sql');
const expected = Object.freeze({
  database: 'msp_customer_portal',
  user: 'portal_app',
  instance: 'msp-zabbix:asia-northeast1:msp-customer-portal-db',
  secretFile: '/var/run/secrets/portal-db-password/password',
  sqlSha256: '60cc6f2a6ec43affb3a3549c7242fbcea46fd3446e1af53efa6ce780f4e33bad',
});

function normalizedSql(readFile = readFileSync) {
  return readFile(stageBPath, 'utf8').replace(/\r\n/g, '\n');
}

function fixedStop(code, log) {
  log(JSON.stringify({ event: 'SG_SOURCE_INVENTORY_STAGE_B', status: 'STOP', code }));
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireExact(value, expectedValue, code, log) {
  if (value !== expectedValue) throw fixedStop(code, log);
}

async function runStageBJob(options = {}) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readFileSync;
  const ClientClass = options.ClientClass ?? Client;
  const log = options.log ?? console.log;

  requireExact(env.SG_STAGE_B_EXPLICIT_APPROVAL, 'APPROVED_ONCE',
    'CONFIG_EXPLICIT_APPROVAL_REQUIRED', log);
  requireExact(env.DB_NAME, expected.database, 'CONFIG_DB_NAME_INVALID', log);
  requireExact(env.DB_USER, expected.user, 'CONFIG_DB_USER_INVALID', log);
  requireExact(env.CLOUD_SQL_INSTANCE, expected.instance, 'CONFIG_INSTANCE_INVALID', log);
  requireExact(env.DB_PASSWORD_FILE, expected.secretFile, 'CONFIG_SECRET_FILE_INVALID', log);

  let sql;
  try { sql = normalizedSql(readFile); } catch (_error) {
    throw fixedStop('STAGE_B_SQL_UNAVAILABLE', log);
  }
  const hash = createHash('sha256').update(sql, 'utf8').digest('hex');
  requireExact(hash, expected.sqlSha256, 'STAGE_B_SQL_DIGEST_MISMATCH', log);

  let password;
  try { password = readFile(expected.secretFile, 'utf8'); } catch (_error) {
    throw fixedStop('SECRET_FILE_UNAVAILABLE', log);
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw fixedStop('SECRET_FILE_EMPTY', log);
  }

  const client = new ClientClass({
    host: `/cloudsql/${expected.instance}`,
    database: expected.database,
    user: expected.user,
    password,
    application_name: 'secure_guard_source_inventory_stage_b',
    connectionTimeoutMillis: 5000,
  });

  log(JSON.stringify({ event: 'SG_SOURCE_INVENTORY_STAGE_B', status: 'ENTER' }));
  try {
    await client.connect();
    await client.query(sql);
    log(JSON.stringify({ event: 'SG_SOURCE_INVENTORY_STAGE_B', status: 'COMPLETE' }));
  } catch (_error) {
    // The result may be unknown after query dispatch. Never retry and never log
    // the driver error because it can contain connection or server details.
    throw fixedStop('STAGE_B_RESULT_UNKNOWN_OR_FAILED', log);
  } finally {
    try { await client.end(); } catch (_error) { /* fixed outcome already logged */ }
  }
}

if (require.main === module) {
  runStageBJob().catch(() => { process.exitCode = 1; });
}

module.exports = { expected, normalizedSql, runStageBJob };
