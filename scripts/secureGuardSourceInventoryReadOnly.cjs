'use strict';

const { Client } = require('pg');

const tables = Object.freeze([
  'portal_users', 'customer_organizations', 'customer_memberships',
  'msp_role_grants', 'dnsfilter_organization_mappings',
  'secure_guard_receipts', 'secure_guard_audit_events', 'secure_guard_overage_alerts',
]);

/** One approved, low-privilege connection via a local private-IP Auth Proxy or Unix socket. */
function readSettings(env) {
  if (env.SECURE_GUARD_SOURCE_INVENTORY_APPROVED !== 'true') {
    throw new Error('STOP: source read-only inventory approval is required');
  }
  const required = (key) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`STOP: missing ${key}`);
    return value;
  };
  const database = required('SECURE_GUARD_SOURCE_DB_NAME');
  const expectedDatabase = required('SECURE_GUARD_SOURCE_EXPECTED_DB_NAME');
  if (database !== expectedDatabase) throw new Error('STOP: source database identity mismatch');
  const socket = env.SECURE_GUARD_SOURCE_DB_SOCKET_PATH?.trim();
  const host = env.SECURE_GUARD_SOURCE_DB_HOST?.trim();
  if (!!socket === !!host) throw new Error('STOP: exactly one source endpoint is required');
  if (host && !['127.0.0.1', '::1'].includes(host)) {
    throw new Error('STOP: source TCP access requires a loopback proxy');
  }
  const port = Number(env.SECURE_GUARD_SOURCE_DB_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('STOP: invalid source database port');
  }
  return {
    host: socket ?? host,
    port,
    database,
    user: required('SECURE_GUARD_SOURCE_DB_USER'),
    password: required('SECURE_GUARD_SOURCE_DB_PASSWORD'),
    connectionTimeoutMillis: 3000,
    application_name: 'sg-source-inventory-readonly',
  };
}

function connectionGate(used, max) {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(max) || max < 1) return false;
  // Current legacy instance has M=25 and a 20-connection operational ceiling.
  // Used includes this inspection session; do not consume the reserved headroom.
  return used < Math.min(20, Math.floor(max * 0.8));
}

async function collectInventory(client, expectedDatabase) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
    const identity = (await client.query(`SELECT current_database() AS database_name,
      current_user AS principal, current_setting('transaction_read_only') AS read_only,
      current_setting('max_connections')::integer AS max_connections,
      (SELECT count(*)::integer FROM pg_stat_activity WHERE backend_type = 'client backend') AS used_connections`)).rows[0];
    if (identity.database_name !== expectedDatabase || identity.read_only !== 'on') {
      throw new Error('STOP: source identity or transaction mode mismatch');
    }
    if (!connectionGate(identity.used_connections, identity.max_connections)) {
      throw new Error('STOP: insufficient source connection headroom');
    }
    const role = (await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole
      || role.rolreplication || role.rolbypassrls) {
      throw new Error('STOP: read-only inventory requires a non-privileged principal');
    }
    // A writable application role is not an approved inventory identity, even if
    // BEGIN READ ONLY would block accidental writes in this particular session.
    // Check effective grants (including inherited and PUBLIC permissions) over
    // metadata only; never inspect application rows to determine privileges.
    const writable = (await client.query(`SELECT
      has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
      EXISTS (SELECT 1 FROM pg_namespace n
        WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
          AND has_schema_privilege(current_user, n.oid, 'CREATE')) AS schema_create,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname <> 'information_schema'
          AND n.nspname !~ '^pg_'
          AND (has_table_privilege(current_user, c.oid, 'INSERT')
            OR has_table_privilege(current_user, c.oid, 'UPDATE')
            OR has_table_privilege(current_user, c.oid, 'DELETE')
            OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))) AS table_write`)).rows[0];
    if (!writable || writable.database_create || writable.schema_create || writable.table_write) {
      throw new Error('STOP: source inventory requires a strictly read-only principal');
    }
    const ledgerExists = (await client.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    )).rows[0]?.exists;
    if (!ledgerExists) throw new Error('STOP: legacy migration ledger is absent');
    const migrations = (await client.query(`SELECT filename, applied_at
      FROM public.schema_migrations WHERE filename LIKE '011_%' OR filename LIKE '012_%'
        OR filename LIKE '014_%' OR filename LIKE '015_%' ORDER BY filename`)).rows;
    const relations = (await client.query(`SELECT c.relname AS table_name,
      c.reltuples::bigint AS estimated_rows, pg_total_relation_size(c.oid)::text AS storage_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`, [tables])).rows;
    const foreignKeys = (await client.query(`SELECT c.conrelid::regclass::text AS source_table,
      c.confrelid::regclass::text AS target_table, c.conname AS name
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public' AND t.relname = ANY($1::text[])
      ORDER BY source_table, target_table, name`, [tables])).rows;
    const result = {
      evidence: 'aggregate-metadata-only',
      database: identity.database_name,
      principal: identity.principal,
      readOnly: true,
      observedConnections: identity.used_connections,
      configuredMaxConnections: identity.max_connections,
      migrations: migrations.map((r) => ({ filename: r.filename, appliedAt: r.applied_at })),
      relations: relations.map((r) => ({ name: r.table_name,
        estimatedRows: Number(r.estimated_rows), storageBytes: r.storage_bytes })),
      missingRelations: tables.filter((name) => !relations.some((r) => r.table_name === name)),
      foreignKeys,
    };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const settings = readSettings(process.env);
  const client = new Client(settings);
  try {
    await client.connect();
    const evidence = await collectInventory(client, settings.database);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch(() => {
    // Driver failures may include credentials, query values, or private endpoints.
    console.error('STOP: source inventory failed; inspect restricted operator diagnostics');
    process.exitCode = 1;
  });
}

module.exports = { readSettings, connectionGate, collectInventory };
