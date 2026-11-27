const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const net = require('node:net');
const bcrypt = require('bcrypt');
const { Client } = require('pg');
const { SecureGuardRepo } = require('../../dist/services/secureGuardRepo');

// The test may only operate on the disposable local PostgreSQL 16 service in CI.
// It cannot target GCP, a Cloud SQL proxy, a production database, or a remote address.
const safeTestHost = '127.0.0.1';
const safeTestPort = 55432;
const targetDatabase = 'secure_guard_staging';
const migrationUser = 'secure_guard_migration_staging';
const runtimeUser = 'secure_guard_runtime_staging';
const overageUser = 'secure_guard_overage_staging';
const secuUser = 'secumie_otp_staging';
const fixturePassword = 'local_ci_fixture_password_not_a_secret';
// Keep the existing 001-005 acceptance independent from the MFA-only SQL file.
const approved005Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-migration-005-'));
for (const name of [
  '001_identity_scope_baseline.sql', '002_overage_alerts.sql',
  '003_license_alert_snapshot.sql', '004_agent_uninstall_claims.sql',
  '005_runtime_overage_privileges.sql',
]) {
  fs.copyFileSync(path.join(__dirname, '../../migrations/secure_guard', name),
    path.join(approved005Dir, name));
}
process.once('exit', () => fs.rmSync(approved005Dir, { recursive: true, force: true }));


function client(database, user, password) {
  return new Client({
    host: safeTestHost, port: safeTestPort, database, user, password,
    connectionTimeoutMillis: 3000,
  });
}

function runMigration(overrides = {}) {
  return spawnSync(process.execPath, ['-r', 'ts-node/register', 'migrations/secure_guard_runner.ts'], {
    cwd: path.join(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      SECURE_GUARD_DB_MODE: 'dedicated',
      SECURE_GUARD_DB_HOST: safeTestHost,
      SECURE_GUARD_DB_PORT: String(safeTestPort),
      SECURE_GUARD_DB_NAME: targetDatabase,
      SECURE_GUARD_MIGRATION_DB_USER: migrationUser,
      SECURE_GUARD_MIGRATION_DB_PASSWORD: fixturePassword,
      SECURE_GUARD_MIGRATION_APPROVED: 'true',
      SECURE_GUARD_MIGRATION_TARGET_CONFIRMATION:
        'msp-zabbix:asia-northeast1:secumie-sg-shared-staging-db/secure_guard_staging',
      SECURE_GUARD_MIGRATIONS_DIR: approved005Dir,
      SECURE_GUARD_MIGRATION_MANIFEST:
        path.join(__dirname, '../../migration-manifests/secure-guard-staging-001-005.json'),
      SECURE_GUARD_MIGRATION_VERIFIER:
        path.join(__dirname, '../../scripts/readiness/verifySecureGuardMigrationManifest.cjs'),
      // Never use the legacy DB principal, socket or endpoint.
      SECURE_GUARD_DB_SOCKET_PATH: '',
      DB_NAME: 'legacy_portal_ci',
      ...overrides,
    },
  });
}

const bootstrapTargetDatabase = 'secure_guard_staging';
const bootstrapInsightDatabase = 'secumie_insight_staging';
const bootstrapManager = 'secure_guard_bootstrap_ci';
const bootstrapRoles = [
  ['secure_guard_runtime_staging', 2],
  ['secure_guard_overage_staging', 2],
  ['secure_guard_migration_staging', 1],
];
const bootstrapInsightRoles = [
  'secumie_otp_staging',
  'secumie_pira_staging',
  'secumie_admin_staging',
  'secumie_migration_staging',
  'secumie_maintenance_staging',
];

function runBootstrap(overrides = {}) {
  return spawnSync(process.execPath, ['dist/db/secureGuardStagingBootstrap.js'], {
    cwd: path.join(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      SG_BOOTSTRAP_TARGET_CONFIRMATION:
        'msp-zabbix:asia-northeast1:secumie-sg-shared-staging-db/secure_guard_staging',
      DB_BOOTSTRAP_HOST: safeTestHost,
      DB_BOOTSTRAP_PORT: String(safeTestPort),
      DB_BOOTSTRAP_USER: bootstrapManager,
      DB_BOOTSTRAP_PASSWORD: fixturePassword,
      SG_RUNTIME_DB_PASSWORD: fixturePassword,
      SG_OVERAGE_DB_PASSWORD: fixturePassword,
      SG_MIGRATION_DB_PASSWORD: fixturePassword,
      CLOUD_SQL_PROXY_ADMIN_URL: '',
      ...overrides,
    },
  });
}

async function cleanupBootstrapFixtures(admin) {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`,
    [[bootstrapTargetDatabase, bootstrapInsightDatabase]],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${bootstrapTargetDatabase}`);
  await admin.query(`DROP DATABASE IF EXISTS ${bootstrapInsightDatabase}`);
  for (const [name] of bootstrapRoles) await admin.query(`DROP ROLE IF EXISTS ${name}`);
  for (const name of bootstrapInsightRoles) await admin.query(`DROP ROLE IF EXISTS ${name}`);
  await admin.query(`DROP ROLE IF EXISTS ${bootstrapManager}`);
}

async function setupBootstrapManagerAndInsight(admin) {
  await admin.query(
    `CREATE ROLE ${bootstrapManager} LOGIN CREATEROLE CREATEDB PASSWORD '${fixturePassword}'`,
  );
  for (const name of bootstrapInsightRoles) await admin.query(`CREATE ROLE ${name} NOLOGIN`);
  await admin.query(`CREATE DATABASE ${bootstrapInsightDatabase}`);
  await admin.query(`REVOKE CONNECT ON DATABASE ${bootstrapInsightDatabase} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${bootstrapInsightDatabase} TO ${bootstrapInsightRoles.join(', ')}`,
  );
}

async function createBootstrapRolesAsManager(admin, { removeAutomaticMemberships = true } = {}) {
  const manager = client('postgres', bootstrapManager, fixturePassword);
  await manager.connect();
  try {
    for (const [name, limit] of bootstrapRoles) {
      await manager.query(
        `CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit} PASSWORD '${fixturePassword}'`,
      );
    }
  } finally {
    await manager.end();
  }
  if (removeAutomaticMemberships) {
    for (const [name] of bootstrapRoles) {
      await admin.query(`REVOKE ${name} FROM ${bootstrapManager} GRANTED BY postgres`);
    }
  }
}

async function assertCompletedBootstrap(admin, expectedOwner) {
  const owner = await admin.query(
    'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
    [bootstrapTargetDatabase],
  );
  assert.equal(owner.rows[0]?.owner, expectedOwner);
  const memberships = await admin.query(
    `SELECT target.rolname AS role_name, member.rolname AS member_name,
            grantor.rolname AS grantor_name, membership.admin_option,
            membership.inherit_option, membership.set_option
       FROM pg_auth_members membership
       JOIN pg_roles target ON target.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE target.rolname = ANY($1::text[])
         OR member.rolname = ANY($1::text[])
      ORDER BY target.rolname`,
    [bootstrapRoles.map(([name]) => name)],
  );
  assert.equal(memberships.rowCount, 0);
  const privileges = await admin.query(
    `SELECT rolname,
            has_database_privilege(rolname, $1, 'CONNECT') AS connect,
            has_database_privilege(rolname, $1, 'CREATE') AS create_privilege
       FROM pg_roles WHERE rolname = ANY($2::text[]) ORDER BY rolname`,
    [bootstrapTargetDatabase, bootstrapRoles.map(([name]) => name)],
  );
  assert.deepEqual(privileges.rows, [
    { rolname: 'secure_guard_migration_staging', connect: true, create_privilege: true },
    { rolname: 'secure_guard_overage_staging', connect: true, create_privilege: false },
    { rolname: 'secure_guard_runtime_staging', connect: true, create_privilege: false },
  ]);
}

async function targetMemberships(admin) {
  return admin.query(
    `SELECT target.rolname AS role_name, member.rolname AS member_name,
            grantor.rolname AS grantor_name, membership.admin_option,
            membership.inherit_option, membership.set_option
       FROM pg_auth_members membership
       JOIN pg_roles target ON target.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE target.rolname = ANY($1::text[])
         OR member.rolname = ANY($1::text[])
      ORDER BY target.rolname, grantor.rolname`,
    [bootstrapRoles.map(([name]) => name)],
  );
}

test('PostgreSQL 16: bootstrap format parameters have explicit text types', async () => {
  assert.equal(process.env.CI, 'true', 'CI-only integration test');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true', 'Explicit opt-in required');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, safeTestHost);
  assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(safeTestPort));

  const admin = client('postgres', 'postgres', fixturePassword);
  await admin.connect();
  try {
    const roleName = 'secure guard "format fixture"';
    const password = "local fixture ' password";
    const result = await admin.query(
      `SELECT format(
         $fmt$CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
               NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s PASSWORD %L$fmt$,
         $1::text, $2::text, $3::text
       ) AS sql`,
      [roleName, '2', password],
    );
    const generated = result.rows[0]?.sql.replace(/\s+/g, ' ').trim();
    assert.equal(
      generated,
      `CREATE ROLE "secure guard ""format fixture""" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD 'local fixture '' password'`,
    );
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
    assert.equal(role.rowCount, 0, 'format regression test must not create a role');
  } finally {
    await admin.end();
  }
});

test('PostgreSQL 16: bootstrap new, recovery and interrupted-state contracts',
  { timeout: 90000 }, async () => {
    assert.equal(process.env.CI, 'true', 'CI-only integration test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true', 'Explicit opt-in required');
    const admin = client('postgres', 'postgres', fixturePassword);
    await admin.connect();
    try {
      await cleanupBootstrapFixtures(admin);

      // New installation SQL path. Vanilla PostgreSQL's superuser fixture models
      // Cloud SQL's measured zero-membership result after CREATE ROLE.
      await setupBootstrapManagerAndInsight(admin);
      const fresh = runBootstrap({
        DB_BOOTSTRAP_USER: 'postgres',
        DB_BOOTSTRAP_PASSWORD: fixturePassword,
      });
      assert.equal(fresh.status, 0, `Fresh bootstrap must pass: ${fresh.stderr}`);
      assert.match(fresh.stdout, /secure_guard_staging_bootstrap_completed/);
      await assertCompletedBootstrap(admin, 'postgres');
      await cleanupBootstrapFixtures(admin);

      // Recovery: all three exact roles exist, the database does not, and SG has
      // no related membership rows, matching the measured Cloud SQL state.
      await setupBootstrapManagerAndInsight(admin);
      await createBootstrapRolesAsManager(admin);
      const recovery = runBootstrap();
      assert.equal(recovery.status, 0, `Recovery bootstrap must pass: ${recovery.stderr}`);
      await assertCompletedBootstrap(admin, bootstrapManager);
      await cleanupBootstrapFixtures(admin);

      // An unexpected membership must stop before database creation.
      await setupBootstrapManagerAndInsight(admin);
      await createBootstrapRolesAsManager(admin, { removeAutomaticMemberships: false });
      const membershipFailure = runBootstrap();
      assert.notEqual(membershipFailure.status, 0);
      assert.match(membershipFailure.stderr, /"stage":"PREFLIGHT"/);
      const unexpectedMemberships = await targetMemberships(admin);
      assert.equal(unexpectedMemberships.rowCount, 3);
      const noDatabaseAfterMembershipFailure = await admin.query(
        'SELECT 1 FROM pg_database WHERE datname = $1', [bootstrapTargetDatabase],
      );
      assert.equal(noDatabaseAfterMembershipFailure.rowCount, 0);
      await cleanupBootstrapFixtures(admin);

      // Role attribute drift must stop before database creation.
      await setupBootstrapManagerAndInsight(admin);
      await createBootstrapRolesAsManager(admin);
      await admin.query('ALTER ROLE secure_guard_runtime_staging CONNECTION LIMIT 3');
      const attributeFailure = runBootstrap();
      assert.notEqual(attributeFailure.status, 0);
      assert.match(attributeFailure.stderr, /"stage":"PREFLIGHT"/);
      const noDatabaseAfterAttributeFailure = await admin.query(
        'SELECT 1 FROM pg_database WHERE datname = $1', [bootstrapTargetDatabase],
      );
      assert.equal(noDatabaseAfterAttributeFailure.rowCount, 0);
      await cleanupBootstrapFixtures(admin);

      // Configuration failure after CREATE DATABASE is fail-closed: the empty
      // database remains for review and a second invocation refuses to proceed.
      await setupBootstrapManagerAndInsight(admin);
      await createBootstrapRolesAsManager(admin);
      const configureFailure = runBootstrap({
        SG_BOOTSTRAP_TEST_FAIL_AFTER_DATABASE_CREATE: 'true',
      });
      assert.notEqual(configureFailure.status, 0);
      assert.match(configureFailure.stderr, /"stage":"CONFIGURE_DATABASE"/);
      const retainedDatabase = await admin.query(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [bootstrapTargetDatabase],
      );
      assert.equal(retainedDatabase.rows[0]?.owner, bootstrapManager);
      const refusedRetry = runBootstrap();
      assert.notEqual(refusedRetry.status, 0);
      assert.match(refusedRetry.stderr, /"stage":"PREFLIGHT"/);
      await cleanupBootstrapFixtures(admin);

      // Partial role creation is ambiguous and must stop before database creation.
      await setupBootstrapManagerAndInsight(admin);
      const manager = client('postgres', bootstrapManager, fixturePassword);
      await manager.connect();
      try {
        await manager.query(
          `CREATE ROLE secure_guard_runtime_staging LOGIN NOINHERIT CONNECTION LIMIT 2
           PASSWORD '${fixturePassword}'`,
        );
      } finally {
        await manager.end();
      }
      const partial = runBootstrap();
      assert.notEqual(partial.status, 0);
      assert.match(partial.stderr, /"stage":"PREFLIGHT"/);
      const absent = await admin.query(
        'SELECT 1 FROM pg_database WHERE datname = $1', [bootstrapTargetDatabase],
      );
      assert.equal(absent.rowCount, 0);
    } finally {
      await cleanupBootstrapFixtures(admin);
      await admin.end();
    }
  });

test('PostgreSQL 16: SG baseline, idempotent runner and role/database isolation', { timeout: 90000 }, async () => {
  assert.equal(process.env.CI, 'true', 'CI-only integration test');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true', 'Explicit opt-in required');
  assert.equal(process.env.NODE_ENV, 'test', 'Test environment required');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, safeTestHost);
  assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(safeTestPort));

  const admin = client('postgres', 'postgres', fixturePassword);
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${migrationUser} LOGIN PASSWORD '${fixturePassword}'`);
    await admin.query(`CREATE ROLE ${runtimeUser} LOGIN PASSWORD '${fixturePassword}'`);
    await admin.query(`CREATE ROLE ${overageUser} LOGIN PASSWORD '${fixturePassword}'`);
    await admin.query(`CREATE ROLE ${secuUser} LOGIN PASSWORD '${fixturePassword}'`);
    await admin.query(`CREATE DATABASE ${targetDatabase} OWNER ${migrationUser}`);
    await admin.query('CREATE DATABASE secumie_insight_ci');
    await admin.query('REVOKE CONNECT ON DATABASE secumie_insight_ci FROM PUBLIC');
    await admin.query(`GRANT CONNECT ON DATABASE secumie_insight_ci TO ${secuUser}`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${targetDatabase} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${targetDatabase} TO ${runtimeUser}, ${overageUser}`);

    // A failure in 002 must roll back that file only: 001 and its ledger row stay
    // consistent, while the conflicting fixture remains unchanged for review.
    const faultSetup = client(targetDatabase, migrationUser, fixturePassword);
    await faultSetup.connect();
    try {
      await faultSetup.query('CREATE TABLE secure_guard_overage_alerts (fixture_marker integer)');
    } finally {
      await faultSetup.end();
    }
    const partial = runMigration();
    assert.notEqual(partial.status, 0, '002 conflict must stop without continuing to 003');
    const partialState = client(targetDatabase, migrationUser, fixturePassword);
    await partialState.connect();
    try {
      const ledger = await partialState.query(
        'SELECT filename FROM secure_guard_schema_migrations ORDER BY filename',
      );
      assert.deepEqual(ledger.rows.map((row) => row.filename), ['001_identity_scope_baseline.sql']);
      const marker = await partialState.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'secure_guard_overage_alerts'`);
      assert.deepEqual(marker.rows.map((row) => row.column_name), ['fixture_marker']);
    } finally {
      await partialState.end();
    }
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [targetDatabase],
    );
    await admin.query(`DROP DATABASE ${targetDatabase}`);
    await admin.query(`CREATE DATABASE ${targetDatabase} OWNER ${migrationUser}`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${targetDatabase} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${targetDatabase} TO ${runtimeUser}, ${overageUser}`);

    const first = runMigration();
    assert.equal(first.status, 0, `First SG-only migration must pass: ${first.stderr}`);
    assert.match(first.stdout, /applied: 001_identity_scope_baseline\.sql/);
    assert.match(first.stdout, /applied: 002_overage_alerts\.sql/);
    assert.match(first.stdout, /applied: 003_license_alert_snapshot\.sql/);
    assert.match(first.stdout, /applied: 004_agent_uninstall_claims\.sql/);

    assert.match(first.stdout, /applied: 005_runtime_overage_privileges\.sql/);

    // Reproduce an established 001-004 database: remove only the 005 ledger row
    // and the exact privileges introduced by 005, then prove the runner skips
    // 001-004 and applies only 005.
    const upgradeFixture = client(targetDatabase, migrationUser, fixturePassword);
    await upgradeFixture.connect();
    try {
      await upgradeFixture.query(`REVOKE USAGE ON SCHEMA public
        FROM ${runtimeUser}, ${overageUser}`);
      await upgradeFixture.query(`REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE
        portal_users, customer_organizations, customer_memberships, msp_role_grants,
        dnsfilter_organization_mappings, secure_guard_receipts, secure_guard_audit_events,
        secure_guard_overage_alerts, secure_guard_agent_uninstall_claims
        FROM ${runtimeUser}`);
      await upgradeFixture.query(`REVOKE USAGE, SELECT ON SEQUENCE
        secure_guard_overage_alerts_id_seq FROM ${runtimeUser}`);
      await upgradeFixture.query(`REVOKE SELECT ON TABLE
        customer_organizations, dnsfilter_organization_mappings FROM ${overageUser}`);
      await upgradeFixture.query(`REVOKE SELECT, INSERT, UPDATE ON TABLE
        secure_guard_overage_alerts FROM ${overageUser}`);
      await upgradeFixture.query(`REVOKE USAGE, SELECT ON SEQUENCE
        secure_guard_overage_alerts_id_seq FROM ${overageUser}`);
      await upgradeFixture.query(`DELETE FROM secure_guard_schema_migrations
        WHERE filename = '005_runtime_overage_privileges.sql'`);
    } finally {
      await upgradeFixture.end();
    }

    const upgrade = runMigration();
    assert.equal(upgrade.status, 0, `001-004 upgrade must pass: ${upgrade.stderr}`);
    assert.match(upgrade.stdout, /skip verified: 001_identity_scope_baseline\.sql/);
    assert.match(upgrade.stdout, /skip verified: 004_agent_uninstall_claims\.sql/);
    assert.match(upgrade.stdout, /applied: 005_runtime_overage_privileges\.sql/);

    const replay = runMigration();
    assert.equal(replay.status, 0, `Migration replay must be safe: ${replay.stderr}`);
    assert.match(replay.stdout, /skip verified: 001_identity_scope_baseline\.sql/);
    assert.match(replay.stdout, /skip verified: 002_overage_alerts\.sql/);
    assert.match(replay.stdout, /skip verified: 003_license_alert_snapshot\.sql/);
    assert.match(replay.stdout, /skip verified: 004_agent_uninstall_claims\.sql/);
    assert.match(replay.stdout, /skip verified: 005_runtime_overage_privileges\.sql/);

    const ddl = client(targetDatabase, migrationUser, fixturePassword);
    await ddl.connect();
    try {
      const ledger = await ddl.query('SELECT filename FROM secure_guard_schema_migrations ORDER BY filename');
      assert.deepEqual(ledger.rows.map((row) => row.filename), [
        '001_identity_scope_baseline.sql', '002_overage_alerts.sql',
        '003_license_alert_snapshot.sql', '004_agent_uninstall_claims.sql',
        '005_runtime_overage_privileges.sql',
      ]);
      const tables = await ddl.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `);
      assert.deepEqual(tables.rows.map((row) => row.tablename), [
        'customer_memberships', 'customer_organizations', 'dnsfilter_organization_mappings',
        'msp_role_grants', 'portal_users', 'secure_guard_agent_uninstall_claims', 'secure_guard_audit_events',
        'secure_guard_overage_alerts', 'secure_guard_receipts', 'secure_guard_schema_migrations',
      ]);
      const crossFk = await ddl.query(`
        SELECT count(*)::integer AS count FROM pg_constraint
        WHERE contype = 'f' AND confrelid = to_regclass('public.customers')
      `);
      assert.equal(crossFk.rows[0].count, 0);
      const businessTables = [
        'portal_users', 'customer_organizations', 'customer_memberships', 'msp_role_grants',
        'dnsfilter_organization_mappings', 'secure_guard_receipts', 'secure_guard_audit_events',
        'secure_guard_overage_alerts', 'secure_guard_agent_uninstall_claims',
      ];
      const runtimeChecks = await ddl.query(`
        SELECT table_name, privilege, has_table_privilege($1, format('public.%I', table_name), privilege) AS allowed
        FROM unnest($2::text[]) AS table_name
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']::text[]) AS privilege
        ORDER BY table_name, privilege
      `, [runtimeUser, businessTables]);
      assert.equal(runtimeChecks.rowCount, 36);
      assert.equal(runtimeChecks.rows.filter((row) => row.allowed).length, 36);
      const runtimeBoundary = await ddl.query(`SELECT
        has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
        has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
        has_database_privilege($1, $2, 'CREATE') AS database_create,
        has_sequence_privilege($1, 'public.secure_guard_overage_alerts_id_seq', 'USAGE') AS sequence_usage,
        has_sequence_privilege($1, 'public.secure_guard_overage_alerts_id_seq', 'SELECT') AS sequence_select,
        has_table_privilege($1, 'public.secure_guard_schema_migrations', 'SELECT') AS ledger_select
      `, [runtimeUser, targetDatabase]);
      assert.deepEqual(runtimeBoundary.rows[0], {
        schema_usage: true, schema_create: false, database_create: false,
        sequence_usage: true, sequence_select: true, ledger_select: false,
      });

      const overageBoundary = await ddl.query(`SELECT
        has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
        has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
        has_database_privilege($1, $2, 'CREATE') AS database_create,
        has_table_privilege($1, 'public.customer_organizations', 'SELECT') AS org_select,
        has_table_privilege($1, 'public.dnsfilter_organization_mappings', 'SELECT') AS mapping_select,
        has_table_privilege($1, 'public.secure_guard_overage_alerts', 'SELECT') AS alerts_select,
        has_table_privilege($1, 'public.secure_guard_overage_alerts', 'INSERT') AS alerts_insert,
        has_table_privilege($1, 'public.secure_guard_overage_alerts', 'UPDATE') AS alerts_update,
        has_sequence_privilege($1, 'public.secure_guard_overage_alerts_id_seq', 'USAGE') AS sequence_usage,
        has_sequence_privilege($1, 'public.secure_guard_overage_alerts_id_seq', 'SELECT') AS sequence_select,
        has_table_privilege($1, 'public.customer_organizations', 'UPDATE') AS org_update,
        has_table_privilege($1, 'public.dnsfilter_organization_mappings', 'UPDATE') AS mapping_update,
        has_table_privilege($1, 'public.secure_guard_overage_alerts', 'DELETE') AS alerts_delete,
        has_table_privilege($1, 'public.portal_users', 'SELECT') AS users_select,
        has_table_privilege($1, 'public.customer_memberships', 'SELECT') AS memberships_select,
        has_table_privilege($1, 'public.msp_role_grants', 'SELECT') AS grants_select,
        has_table_privilege($1, 'public.secure_guard_audit_events', 'SELECT') AS audit_select,
        has_table_privilege($1, 'public.secure_guard_schema_migrations', 'SELECT') AS ledger_select
      `, [overageUser, targetDatabase]);
      const overage = overageBoundary.rows[0];
      assert.deepEqual([
        overage.org_select, overage.mapping_select, overage.alerts_select, overage.alerts_insert,
        overage.alerts_update, overage.sequence_usage, overage.sequence_select,
      ], Array(7).fill(true));
      assert.deepEqual([
        overage.org_update, overage.mapping_update, overage.alerts_delete, overage.users_select,
        overage.memberships_select, overage.grants_select, overage.audit_select, overage.ledger_select,
      ], Array(8).fill(false));
      assert.equal(overage.schema_usage, true);
      assert.equal(overage.schema_create, false);
      assert.equal(overage.database_create, false);
    } finally {
      await ddl.end();
    }

    const runtime = client(targetDatabase, runtimeUser, fixturePassword);
    await runtime.connect();
    try {
      const createdUser = await runtime.query(
        `INSERT INTO portal_users(email) VALUES('ci@example.invalid') RETURNING id`,
      );
      const createdOrg = await runtime.query(
        `INSERT INTO customer_organizations(organization_name) VALUES('CI Fixture Organization') RETURNING id`,
      );
      const membership = [createdUser.rows[0].id, createdOrg.rows[0].id];
      await runtime.query(`
        INSERT INTO customer_memberships
          (user_id, customer_organization_id, role, is_initial_admin, status, invite_token_hash, invite_expires_at)
        VALUES ($1, $2, 'org_admin', true, 'pending', 'test-only-hash', now() + interval '1 day')
      `, membership);
      await assert.rejects(runtime.query(`
        INSERT INTO customer_memberships
          (user_id, customer_organization_id, role, is_initial_admin, status, invite_token_hash, invite_expires_at)
        VALUES ($1, $2, 'org_admin', true, 'pending', 'test-only-hash2', now() + interval '1 day')
      `, membership), (error) => error.code === '23505');
      await runtime.query(`
        INSERT INTO secure_guard_overage_alerts
          (customer_organization_id, last_observed_at, allocated_rc_licenses, roaming_clients_in_use, over_by)
        VALUES ($1, now(), 1, 2, 1)
      `, [createdOrg.rows[0].id]);
      const snapshot = await runtime.query(`UPDATE customer_organizations
        SET dnsfilter_allocated_rc_licenses_snapshot = 1,
            license_snapshot_updated_at = now(), license_snapshot_updated_by = $2
        WHERE id = $1 RETURNING dnsfilter_allocated_rc_licenses_snapshot`,
      [createdOrg.rows[0].id, createdUser.rows[0].id]);
      assert.equal(snapshot.rows[0].dnsfilter_allocated_rc_licenses_snapshot, 1);
      const member = await runtime.query(`SELECT id FROM customer_memberships WHERE user_id = $1`,
        [createdUser.rows[0].id]);
      const agentUuid = '22222222-2222-4222-8222-222222222222';
      const claimId = '33333333-3333-4333-8333-333333333333';
      const claimData = [claimId, createdOrg.rows[0].id, '10220954', createdUser.rows[0].id,
        member.rows[0].id, agentUuid, '1001', 'ci-agent'];
      await runtime.query(`INSERT INTO secure_guard_agent_uninstall_claims
        (id, customer_organization_id, dnsfilter_organization_id, actor_user_id,
         membership_id, agent_uuid, site_id, hostname)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, claimData);
      await assert.rejects(runtime.query(`INSERT INTO secure_guard_agent_uninstall_claims
        (id, customer_organization_id, dnsfilter_organization_id, actor_user_id,
         membership_id, agent_uuid, site_id, hostname)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['44444444-4444-4444-8444-444444444444', ...claimData.slice(1)]),
        (error) => error.code === '23505');
      await assert.rejects(runtime.query('CREATE TABLE cross_role_write_denied (id integer)'),
        (error) => error.code === '42501');
      await assert.rejects(runtime.query('SELECT * FROM secure_guard_schema_migrations'),
        (error) => error.code === '42501');

      // The SAME runtime role, tables and repository serve multiple tenants.
      // Verify SQL-level Membership isolation, not only mocked HTTP requests.
      // Roll back only this synthetic transaction; the original fixture stays
      // unchanged for the following overage/permission checks.
      await runtime.query('BEGIN');
      try {
        const tenantUsers = await runtime.query(`INSERT INTO portal_users (email, status)
          VALUES ('tenant-a@fixture.invalid', 'active'), ('tenant-b@fixture.invalid', 'active')
          RETURNING id`);
        const tenantOrgs = await runtime.query(`INSERT INTO customer_organizations
          (organization_name, status)
          VALUES ('CI Tenant A', 'active'), ('CI Tenant B', 'active')
          RETURNING id`);
        const [userA, userB] = tenantUsers.rows.map((row) => row.id);
        const [orgA, orgB] = tenantOrgs.rows.map((row) => row.id);
        const a = await runtime.query(`INSERT INTO customer_memberships
          (user_id, customer_organization_id, role, status, accepted_at)
          VALUES ($1, $2, 'org_admin', 'active', now()) RETURNING id`, [userA, orgA]);
        const b = await runtime.query(`INSERT INTO customer_memberships
          (user_id, customer_organization_id, role, status, accepted_at)
          VALUES ($1, $2, 'viewer', 'active', now()) RETURNING id`, [userB, orgB]);
        await runtime.query(`INSERT INTO dnsfilter_organization_mappings
          (customer_organization_id, dnsfilter_organization_id)
          VALUES ($1, '990001'), ($2, '990002')`, [orgA, orgB]);

        // Reuse the actual repository SQL and a single transactional DB client.
        const tenantRepo = new SecureGuardRepo(runtime);
        assert.equal((await tenantRepo.findActiveScope(userA, a.rows[0].id)).customerOrganizationId, orgA);
        assert.equal((await tenantRepo.findActiveScope(userB, b.rows[0].id)).customerOrganizationId, orgB);
        assert.equal(await tenantRepo.findActiveScope(userA, b.rows[0].id), null);
        assert.equal(await tenantRepo.findActiveScope(userB, a.rows[0].id), null);
        assert.equal((await tenantRepo.listActiveMemberships(userA)).length, 1);
        assert.equal((await tenantRepo.listActiveMemberships(userB)).length, 1);
        assert.equal(await tenantRepo.findActiveDnsFilterOrganization(orgA), '990001');
        assert.equal(await tenantRepo.findActiveDnsFilterOrganization(orgB), '990002');

        // MSP authorization is independent from Customer Membership.
        assert.equal(await tenantRepo.hasActiveMspAdminGrant(userA), false);
        await runtime.query(`INSERT INTO msp_role_grants (user_id, role)
          VALUES ($1, 'msp_admin')`, [userA]);
        assert.equal(await tenantRepo.hasActiveMspAdminGrant(userA), true);
        assert.equal(await tenantRepo.findActiveScope(userA, b.rows[0].id), null);

        // Revoked membership and suspended organization immediately deny scope.
        await runtime.query(`UPDATE customer_memberships
          SET status = 'revoked', revoked_at = now() WHERE id = $1`, [b.rows[0].id]);
        assert.equal(await tenantRepo.findActiveScope(userB, b.rows[0].id), null);
        assert.deepEqual(await tenantRepo.listActiveMemberships(userB), []);
        await runtime.query(`UPDATE customer_organizations
          SET status = 'suspended' WHERE id = $1`, [orgA]);
        assert.equal(await tenantRepo.findActiveScope(userA, a.rows[0].id), null);
        assert.equal(await tenantRepo.findActiveDnsFilterOrganization(orgA), null);
      } finally {
        await runtime.query('ROLLBACK');
      }
    } finally {
      await runtime.end();
    }

    const overage = client(targetDatabase, overageUser, fixturePassword);
    await overage.connect();
    try {
      const orgs = await overage.query(`SELECT o.id, m.dnsfilter_organization_id
        FROM customer_organizations o
        LEFT JOIN dnsfilter_organization_mappings m ON m.customer_organization_id = o.id`);
      assert.equal(orgs.rowCount, 1);
      const observed = await overage.query(`UPDATE secure_guard_overage_alerts
        SET notification_status = 'attempting' WHERE allocated_rc_licenses = 1 RETURNING id`);
      assert.equal(observed.rowCount, 1);
      await assert.rejects(overage.query('SELECT * FROM portal_users'),
        (error) => error.code === '42501');
      await assert.rejects(overage.query(`UPDATE portal_users SET email = 'forbidden@example.invalid'`),
        (error) => error.code === '42501');
      await assert.rejects(overage.query('SELECT * FROM secure_guard_audit_events'),
        (error) => error.code === '42501');
      await assert.rejects(overage.query('DELETE FROM secure_guard_overage_alerts'),
        (error) => error.code === '42501');
      await assert.rejects(overage.query('SELECT * FROM secure_guard_schema_migrations'),
        (error) => error.code === '42501');
      await assert.rejects(overage.query('CREATE TABLE overage_ddl_denied (id integer)'),
        (error) => error.code === '42501');
    } finally {
      await overage.end();
    }

    const otherDb = client('secumie_insight_ci', runtimeUser, fixturePassword);
    await assert.rejects(otherDb.connect(), (error) => error.code === '42501');
    await otherDb.end().catch(() => undefined);

    const overageOtherDb = client('secumie_insight_ci', overageUser, fixturePassword);
    await assert.rejects(overageOtherDb.connect(), (error) => error.code === '42501');
    await overageOtherDb.end().catch(() => undefined);

    const secuOtherDb = client(targetDatabase, secuUser, fixturePassword);
    await assert.rejects(secuOtherDb.connect(), (error) => error.code === '42501');
    await secuOtherDb.end().catch(() => undefined);

    // Offline-only migration 006 is required for MFA HTTP acceptance.
    const mfaMigration = runMigration({
      SECURE_GUARD_MFA_OFFLINE_006: 'true',
      SECURE_GUARD_MIGRATIONS_DIR: path.join(__dirname, '../../migrations/secure_guard'),
      SECURE_GUARD_MIGRATION_MANIFEST: path.join(
        __dirname, '../../migration-manifests/secure-guard-staging-001-006.json'),
    });
    assert.equal(mfaMigration.status, 0, `Offline MFA upgrade must pass: ${mfaMigration.stderr}`);
    assert.match(mfaMigration.stdout, /applied: 006_mfa_identity\.sql/);

    // Real HTTP + PostgreSQL acceptance of the EXISTING shared SG Staging runtime.
    // Only the disposable CI PostgreSQL 16 on fixed loopback port is used.
    // No GCP, real DNSFilter, SMTP, Slack, or Production credentials are inherited.
    const fixtureDb = client(targetDatabase, runtimeUser, fixturePassword);
    await fixtureDb.connect();
    let liveServer;
    let liveLog = '';
    let ids;
    try {
      const password = 'synthetic-ci-only-password-2026!';
      const passwordHash = await bcrypt.hash(password, 4);
      const users = await fixtureDb.query(`INSERT INTO portal_users (email, password_hash, status)
        VALUES ('live-a@ci.invalid', $1, 'active'), ('live-b@ci.invalid', $1, 'active')
        RETURNING id`, [passwordHash]);
      const orgs = await fixtureDb.query(`INSERT INTO customer_organizations (organization_name, status)
        VALUES ('Live Tenant A', 'active'), ('Live Tenant B', 'active') RETURNING id`);
      const [userA, userB] = users.rows.map((row) => row.id);
      const [orgA, orgB] = orgs.rows.map((row) => row.id);
      const memberA = await fixtureDb.query(`INSERT INTO customer_memberships
        (user_id, customer_organization_id, role, status, accepted_at)
        VALUES ($1, $2, 'org_admin', 'active', now()) RETURNING id`, [userA, orgA]);
      const memberB = await fixtureDb.query(`INSERT INTO customer_memberships
        (user_id, customer_organization_id, role, status, accepted_at)
        VALUES ($1, $2, 'viewer', 'active', now()) RETURNING id`, [userB, orgB]);
      ids = { userA, userB, orgA, orgB, memberA: memberA.rows[0].id, memberB: memberB.rows[0].id };
      await fixtureDb.query(`INSERT INTO msp_role_grants (user_id, role) VALUES ($1, 'msp_admin')`, [userA]);
      const fixtureMfaKeys = {
        SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 81).toString('base64'),
        SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 82).toString('base64'),
      };
      const { SecureGuardMfaCrypto, totpAtStep } =
        require('../../dist/services/secureGuardMfa');
      const mfaCrypto = new SecureGuardMfaCrypto(fixtureMfaKeys);
      const totpSecrets = new Map();
      for (const id of [userA, userB]) {
        const secret = mfaCrypto.generateTotpSecret();
        const encrypted = mfaCrypto.encryptTotp(id, secret);
        totpSecrets.set(id, secret);
        await fixtureDb.query(`INSERT INTO secure_guard_mfa_settings
          (user_id, method, state, totp_ciphertext, totp_nonce, totp_tag, key_version)
          VALUES ($1, 'totp', 'active', $2,$3,$4,$5)`,
        [id, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.keyVersion]);
      }


      const portServer = net.createServer();
      await new Promise((resolve) => portServer.listen(0, safeTestHost, resolve));
      const appPort = portServer.address().port;
      await new Promise((resolve) => portServer.close(resolve));
      const base = `http://${safeTestHost}:${appPort}`;
      liveServer = spawn(process.execPath, ['dist/server.js'], {
        cwd: path.join(__dirname, '../..'),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          CI: 'true',
          SECURE_GUARD_MFA_OFFLINE_E2E: 'true',
          SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: fixtureMfaKeys.SECURE_GUARD_MFA_ENCRYPTION_KEY_V1,
          SECURE_GUARD_MFA_OTP_PEPPER: fixtureMfaKeys.SECURE_GUARD_MFA_OTP_PEPPER,
          PORT: String(appPort),
          SECURE_GUARD_STAGING_ISOLATED: 'true',
          SECURE_GUARD_DB_MODE: 'dedicated',
          SECURE_GUARD_DB_REQUIRE_DEDICATED: 'true',
          SECURE_GUARD_DB_HOST: safeTestHost,
          SECURE_GUARD_DB_PORT: String(safeTestPort),
          SECURE_GUARD_DB_NAME: targetDatabase,
          SECURE_GUARD_DB_USER: runtimeUser,
          SECURE_GUARD_DB_PASSWORD: fixturePassword,
          SECURE_GUARD_JWT_SECRET: 'synthetic-live-ci-jwt-secret-longer-than-32',
          SECURE_GUARD_BASE_URL: 'https://secure-guard-ci.invalid/',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [liveServer.stdout, liveServer.stderr]) {
        stream.on('data', (chunk) => { liveLog = (liveLog + String(chunk)).slice(-4096); });
      }
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (liveServer.exitCode !== null) throw new Error('Live server exited: ' + liveLog);
        try {
          const health = await fetch(base + '/healthz', { signal: AbortSignal.timeout(200) });
          if (health.status === 200) { ready = true; break; }
        } catch { /* loopback startup only */ }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      assert.ok(ready, 'Live Secure Guard server must start using only the SG DB');

      const login = async (email, id) => {
        const response = await fetch(base + '/api/secure-guard/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        assert.equal(response.status, 202);
        const initialCookie = response.headers.get('set-cookie') || '';
        assert.doesNotMatch(initialCookie, /secure_guard_session=[^;\s]+/);
        const flow = await response.json();
        assert.equal(flow.flow, 'MFA_REQUIRED');
        assert.equal(flow.method, 'totp');
        assert.match(flow.challengeToken, /^[a-f0-9]{64}$/);
        assert.equal((await fetch(base + '/api/secure-guard/me')).status, 401);
        const step = BigInt(Math.floor(Date.now() / 30000));
        const code = totpAtStep(totpSecrets.get(id), step);
        const verified = await fetch(base + '/api/secure-guard/auth/mfa/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeToken: flow.challengeToken, code }),
        });
        assert.equal(verified.status, 204);
        const setCookie = verified.headers.get('set-cookie');
        assert.match(setCookie, /secure_guard_session=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /Secure/i);
        const replay = await fetch(base + '/api/secure-guard/auth/mfa/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeToken: flow.challengeToken, code }),
        });
        assert.equal(replay.status, 401);
        assert.doesNotMatch(replay.headers.get('set-cookie') || '', /secure_guard_session=[^;\s]+/);
        return setCookie.split(';')[0];
      };
      const cookieA = await login('live-a@ci.invalid', userA);
      const cookieB = await login('live-b@ci.invalid', userB);
      const get = (url, cookie, membershipId) => fetch(base + url, {
        headers: { Cookie: cookie, ...(membershipId ? { 'X-Secure-Guard-Membership': membershipId } : {}) },
      });

      const aMe = await get('/api/secure-guard/me', cookieA);
      assert.equal(aMe.status, 200);
      const aMeBody = await aMe.json();
      assert.equal(aMeBody.mspAdmin, true);
      assert.deepEqual(aMeBody.memberships.map((scope) => scope.customerOrganizationId), [orgA]);
      const bMe = await get('/api/secure-guard/me', cookieB);
      assert.equal(bMe.status, 200);
      const bMeBody = await bMe.json();
      assert.equal(bMeBody.mspAdmin, false);
      assert.deepEqual(bMeBody.memberships.map((scope) => scope.customerOrganizationId), [orgB]);

      assert.equal((await get('/api/secure-guard/memberships', cookieA, ids.memberB)).status, 403);
      assert.equal((await get('/api/secure-guard/memberships', cookieB, ids.memberA)).status, 403);
      const ownA = await get('/api/secure-guard/memberships', cookieA, ids.memberA);
      assert.equal(ownA.status, 200);
      assert.equal((await ownA.json()).memberships.length, 1);
      assert.equal((await get('/secure-guard-admin.html', cookieA)).status, 200);
      assert.equal((await get('/secure-guard-admin.html', cookieB)).status, 403);
      assert.equal((await get('/api/secure-guard/admin/organizations', cookieB)).status, 403);
      assert.equal((await get('/api/secure-guard/admin/organizations', cookieA)).status, 200);
      // No DNSFilter key: even a valid tenant must receive UNKNOWN, not other-tenant inventory.
      assert.equal((await get('/api/secure-guard/overview', cookieA, ids.memberA)).status, 502);
      const forbidden = await fetch(base + '/api/secure-guard/admin/dnsfilter/organizations', {
        method: 'POST', headers: { Cookie: cookieA, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(forbidden.status, 503);

      // Mutate only disposable DB fixture to prove live permission revocation.
      await fixtureDb.query(`UPDATE customer_memberships SET status = 'revoked', revoked_at = now()
        WHERE id = $1`, [ids.memberB]);
      assert.equal((await get('/api/secure-guard/memberships', cookieB, ids.memberB)).status, 403);
      await fixtureDb.query(`UPDATE customer_organizations SET status = 'suspended' WHERE id = $1`, [orgA]);
      assert.equal((await get('/api/secure-guard/memberships', cookieA, ids.memberA)).status, 403);
      await fixtureDb.query(`UPDATE portal_users SET status = 'disabled' WHERE id = $1`, [ids.userB]);
      assert.equal((await get('/api/secure-guard/me', cookieB)).status, 403);
    } finally {
      if (liveServer && liveServer.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { liveServer.kill('SIGKILL'); resolve(); }, 3000);
          liveServer.once('exit', () => { clearTimeout(timer); resolve(); });
          liveServer.kill('SIGTERM');
        });
      }
      if (ids) {
        await fixtureDb.query('DELETE FROM secure_guard_mfa_challenges WHERE user_id = ANY($1::uuid[])', [[ids.userA, ids.userB]]);
        await fixtureDb.query('DELETE FROM secure_guard_mfa_recovery_codes WHERE user_id = ANY($1::uuid[])', [[ids.userA, ids.userB]]);
        await fixtureDb.query('DELETE FROM secure_guard_mfa_settings WHERE user_id = ANY($1::uuid[])', [[ids.userA, ids.userB]]);
        await fixtureDb.query('DELETE FROM secure_guard_audit_events WHERE actor_user_id = ANY($1::uuid[])', [[ids.userA, ids.userB]]);
        await fixtureDb.query('DELETE FROM msp_role_grants WHERE user_id = $1', [ids.userA]);
        await fixtureDb.query('DELETE FROM customer_memberships WHERE id = ANY($1::uuid[])', [[ids.memberA, ids.memberB]]);
        await fixtureDb.query('DELETE FROM customer_organizations WHERE id = ANY($1::uuid[])', [[ids.orgA, ids.orgB]]);
        await fixtureDb.query('DELETE FROM portal_users WHERE id = ANY($1::uuid[])', [[ids.userA, ids.userB]]);
      }
      await fixtureDb.end();
    }

    const driftDdl = client(targetDatabase, migrationUser, fixturePassword);
    await driftDdl.connect();
    try {
      await driftDdl.query(`UPDATE secure_guard_schema_migrations SET sha256 = 'deliberate-ci-drift'
        WHERE filename = '001_identity_scope_baseline.sql'`);
    } finally {
      await driftDdl.end();
    }
    const drift = runMigration();
    assert.notEqual(drift.status, 0, 'Modified checksum must block runner');
  } finally {
    await admin.end();
  }
});


test('PostgreSQL 16: MFA 006 fresh, upgrade, exact ACL and identity-scoped atomic challenge use',
  { timeout: 90000 }, async () => {
    assert.equal(process.env.CI, 'true');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, safeTestHost);
    assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(safeTestPort));

    const { Pool } = require('pg');
    const { SecureGuardMfaCrypto, createMfaChallenge } =
      require('../../dist/services/secureGuardMfa');
    const offline = {
      SECURE_GUARD_MFA_OFFLINE_006: 'true',
      SECURE_GUARD_MIGRATIONS_DIR: path.join(__dirname, '../../migrations/secure_guard'),
      SECURE_GUARD_MIGRATION_MANIFEST: path.join(__dirname,
        '../../migration-manifests/secure-guard-staging-001-006.json'),
    };
    const resetDb = async (admin) => {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [targetDatabase]);
      await admin.query(`DROP DATABASE IF EXISTS ${targetDatabase}`);
      await admin.query(`CREATE DATABASE ${targetDatabase} OWNER ${migrationUser}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${targetDatabase} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${targetDatabase} TO ${runtimeUser}, ${overageUser}`);
    };
    const admin = client('postgres', 'postgres', fixturePassword);
    await admin.connect();
    try {
      await resetDb(admin);
      const full = runMigration(offline);
      assert.equal(full.status, 0, `Offline MFA 001-006 fresh must pass: ${full.stderr}`);
      assert.match(full.stdout, /applied: 006_mfa_identity\.sql/);
      const repeat = runMigration(offline);
      assert.equal(repeat.status, 0, 'MFA 006 replay must skip every verified migration');
      assert.match(repeat.stdout, /skip verified: 006_mfa_identity\.sql/);

      const migration = client(targetDatabase, migrationUser, fixturePassword);
      await migration.connect();
      try {
        const ledger = await migration.query(
          'SELECT filename FROM secure_guard_schema_migrations ORDER BY filename');
        assert.equal(ledger.rowCount, 6);
        assert.equal(ledger.rows[5].filename, '006_mfa_identity.sql');
        const privileges = await migration.query(`SELECT
          has_table_privilege($1, 'public.secure_guard_mfa_settings', 'SELECT') AS runtime_settings,
          has_table_privilege($1, 'public.secure_guard_mfa_challenges', 'UPDATE') AS runtime_challenges,
          has_table_privilege($1, 'public.secure_guard_mfa_recovery_codes', 'DELETE') AS runtime_recovery,
          has_table_privilege($2, 'public.secure_guard_mfa_settings', 'SELECT') AS overage_settings,
          has_table_privilege($2, 'public.secure_guard_mfa_challenges', 'SELECT') AS overage_challenges,
          has_table_privilege($2, 'public.secure_guard_mfa_recovery_codes', 'SELECT') AS overage_recovery
        `, [runtimeUser, overageUser]);
        assert.deepEqual(privileges.rows[0], {
          runtime_settings: true, runtime_challenges: true, runtime_recovery: true,
          overage_settings: false, overage_challenges: false, overage_recovery: false,
        });
      } finally { await migration.end(); }

      const pool = new Pool({
        host: safeTestHost, port: safeTestPort, database: targetDatabase,
        user: runtimeUser, password: fixturePassword, max: 2,
      });
      try {
        const repo = new SecureGuardRepo(pool);
        const actor = await pool.query(
          "INSERT INTO portal_users(email, status) VALUES('mfa-m1@ci.invalid','active') RETURNING id");
        const userId = actor.rows[0].id;
        const keys = {
          SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 42).toString('base64'),
          SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 43).toString('base64'),
        };
        const mfa = new SecureGuardMfaCrypto(keys);
        await repo.mfaPutSetting({ userId, method: 'email', state: 'active' });
        const first = createMfaChallenge('login');
        assert.equal(await repo.mfaIssueChallenge({
          userId, tokenHash: first.tokenHash, purpose: 'login',
          method: 'email', expiresAt: first.expiresAt,
        }), true);
        const otp = mfa.generateEmailOtp();
        const otpHmac = mfa.emailOtpHmac(userId, first.tokenHash, otp);
        assert.equal(await repo.mfaRecordEmailOtp(userId, first.tokenHash, otpHmac), 'recorded');
        assert.equal(await repo.mfaRecordEmailOtp(userId, first.tokenHash, otpHmac), 'rate_limited');
        const wrong = await repo.mfaConsumeChallenge({
          userId, tokenHash: first.tokenHash, purpose: 'login',
          verify: () => ({ valid: false }),
        });
        assert.equal(wrong.status, 'invalid');

        const check = () => repo.mfaConsumeChallenge({
          userId, tokenHash: first.tokenHash, purpose: 'login',
          verify: (_setting, challenge) => ({
            valid: mfa.matchesEmailOtp(userId, challenge.tokenHash, otp, challenge.otpHmac || ''),
          }),
        });
        const concurrent = await Promise.all([check(), check()]);
        assert.deepEqual(concurrent.map((result) => result.status).sort(), ['consumed', 'verified']);

        const next = createMfaChallenge('login');
        assert.equal(await repo.mfaIssueChallenge({
          userId, tokenHash: next.tokenHash, purpose: 'login',
          method: 'email', expiresAt: next.expiresAt,
        }), true);
        const last = createMfaChallenge('login');
        assert.equal(await repo.mfaIssueChallenge({
          userId, tokenHash: last.tokenHash, purpose: 'login',
          method: 'email', expiresAt: last.expiresAt,
        }), true);
        const stale = await repo.mfaConsumeChallenge({
          userId, tokenHash: next.tokenHash, purpose: 'login',
          verify: () => ({ valid: true }),
        });
        assert.equal(stale.status, 'consumed');
        const limitResult = await repo.mfaConsumeChallenge({
          userId, tokenHash: last.tokenHash, purpose: 'login',
          now: new Date(last.expiresAt.getTime() + 1000),
          verify: () => ({ valid: true }),
        });
        assert.equal(limitResult.status, 'expired');

        // Five wrong codes exhaust a challenge permanently.
        const locked = createMfaChallenge('login');
        await repo.mfaIssueChallenge({
          userId, tokenHash: locked.tokenHash, purpose: 'login',
          method: 'email', expiresAt: locked.expiresAt,
        });
        for (let attempt = 0; attempt < 5; attempt++) {
          assert.equal((await repo.mfaConsumeChallenge({
            userId, tokenHash: locked.tokenHash, purpose: 'login',
            verify: () => ({ valid: false }),
          })).status, 'invalid');
        }
        assert.equal((await repo.mfaConsumeChallenge({
          userId, tokenHash: locked.tokenHash, purpose: 'login',
          verify: () => ({ valid: true }),
        })).status, 'attempts_exhausted');

        // Email resends replace the previous HMAC, have a 60s interval,
        // and are limited to three total sends (including the first).
        const sent = createMfaChallenge('login');
        await repo.mfaIssueChallenge({
          userId, tokenHash: sent.tokenHash, purpose: 'login',
          method: 'email', expiresAt: sent.expiresAt,
        });
        const time = new Date();
        for (let index = 0; index < 3; index++) {
          assert.equal(await repo.mfaRecordEmailOtp(userId, sent.tokenHash,
            mfa.emailOtpHmac(userId, sent.tokenHash, mfa.generateEmailOtp()),
            new Date(time.getTime() + index * 61_000)), 'recorded');
          assert.equal(await repo.mfaRecordEmailOtp(userId, sent.tokenHash,
            mfa.emailOtpHmac(userId, sent.tokenHash, mfa.generateEmailOtp()),
            new Date(time.getTime() + index * 61_000 + 1)), 'rate_limited');
        }
        assert.equal(await repo.mfaRecordEmailOtp(userId, sent.tokenHash,
          mfa.emailOtpHmac(userId, sent.tokenHash, mfa.generateEmailOtp()),
          new Date(time.getTime() + 240_000)), 'rate_limited');

        // TOTP replay is rejected against the persisted and locked last step.
        const { totpAtStep, verifyTotp } = require('../../dist/services/secureGuardMfa');
        const secret = mfa.generateTotpSecret();
        const encrypted = mfa.encryptTotp(userId, secret);
        await repo.mfaPutSetting({
          userId, method: 'totp', state: 'active',
          totpCiphertext: encrypted.ciphertext,
          totpNonce: encrypted.nonce, totpTag: encrypted.tag, keyVersion: encrypted.keyVersion,
        });
        const totpLogin = createMfaChallenge('login');
        await repo.mfaIssueChallenge({
          userId, tokenHash: totpLogin.tokenHash, purpose: 'login',
          method: 'totp', expiresAt: totpLogin.expiresAt,
        });
        const at = Date.now();
        const step = BigInt(Math.floor(at / 30_000));
        const code = totpAtStep(secret, step);
        assert.equal((await repo.mfaConsumeChallenge({
          userId, tokenHash: totpLogin.tokenHash, purpose: 'login',
          verify: (setting) => {
            const found = verifyTotp(secret, code, at, setting.lastTotpStep);
            return { valid: found !== null, totpStep: found ?? undefined };
          },
        })).status, 'verified');

        const replayTotp = createMfaChallenge('login');
        await repo.mfaIssueChallenge({
          userId, tokenHash: replayTotp.tokenHash, purpose: 'login',
          method: 'totp', expiresAt: replayTotp.expiresAt,
        });
        assert.equal((await repo.mfaConsumeChallenge({
          userId, tokenHash: replayTotp.tokenHash, purpose: 'login',
          verify: () => ({ valid: true, totpStep: step }),
        })).status, 'invalid');

        const { hashes } = mfa.createRecoveryCodes(userId);

        await repo.mfaReplaceRecoveryHashes(userId, hashes);
        const oneTime = await Promise.all([
          repo.mfaConsumeRecoveryCode(userId, hashes[0]),
          repo.mfaConsumeRecoveryCode(userId, hashes[0]),
        ]);
        assert.deepEqual(oneTime.sort(), [false, true]);
        await repo.mfaPutSetting({ userId, method: 'totp', state: 'reset_required' });
        assert.equal((await repo.mfaGetSetting(userId)).state, 'reset_required');
        // A successful-looking callback cannot override reset_required.
        const resetChallenge = createMfaChallenge('login');
        await repo.mfaIssueChallenge({
          userId, tokenHash: resetChallenge.tokenHash, purpose: 'login',
          method: 'totp', expiresAt: resetChallenge.expiresAt,
        });
        assert.equal((await repo.mfaConsumeChallenge({
          userId, tokenHash: resetChallenge.tokenHash, purpose: 'login',
          verify: () => ({ valid: true }),
        })).status, 'invalid');
        await assert.rejects(repo.mfaPutSetting({ userId, method: 'totp', state: 'active' }),
          (error) => error.code === '23514');

        // M2 enrollment is a single transaction: the factor becomes active
        // only when the enrolled OTP is verified and 10 hashes are persisted.
        const enroll = createMfaChallenge('enroll');
        assert.equal(await repo.mfaIssueChallenge({
          userId, tokenHash: enroll.tokenHash, purpose: 'enroll',
          method: null, expiresAt: enroll.expiresAt,
        }), true);
        assert.equal(await repo.mfaStartEnrollment({
          userId, tokenHash: enroll.tokenHash, method: 'email',
        }), true);
        assert.equal(await repo.mfaStartEnrollment({
          userId, tokenHash: enroll.tokenHash, method: 'email',
        }), false, 'an enrolled method and TOTP secret cannot be fetched twice');
        assert.equal((await repo.mfaGetSetting(userId)).state, 'enrolling');
        const enrollCode = mfa.generateEmailOtp();
        const enrollMac = mfa.emailOtpHmac(userId, enroll.tokenHash, enrollCode);
        assert.equal(await repo.mfaRecordEmailOtp(userId, enroll.tokenHash, enrollMac), 'recorded');
        const enrollment = mfa.createRecoveryCodes(userId);
        const activation = await repo.mfaConsumeChallenge({
          userId, tokenHash: enroll.tokenHash, purpose: 'enroll',
          enrollmentRecoveryHashes: enrollment.hashes,
          verify: (_setting, current) => ({
            valid: mfa.matchesEmailOtp(userId, current.tokenHash, enrollCode, current.otpHmac || ''),
          }),
        });
        assert.equal(activation.status, 'verified');
        assert.equal((await repo.mfaGetSetting(userId)).state, 'active');
        const storedCodes = await pool.query(
          'SELECT code_hmac FROM secure_guard_mfa_recovery_codes WHERE user_id=$1 ORDER BY code_hmac',
          [userId],
        );
        assert.equal(storedCodes.rowCount, 10);
        assert.deepEqual(storedCodes.rows.map((row) => row.code_hmac).sort(), enrollment.hashes.slice().sort());
        const mfaAudit = await pool.query(
          'SELECT action, result FROM secure_guard_audit_events WHERE actor_user_id=$1 ORDER BY created_at',
          [userId],
        );
        assert.ok(mfaAudit.rows.some((row) =>
          row.action === 'mfa.enroll.started' && row.result === 'success'));
        assert.ok(mfaAudit.rows.some((row) =>
          row.action === 'mfa.enroll.verify' && row.result === 'success'));
        assert.ok(mfaAudit.rows.some((row) =>
          row.action === 'mfa.login.verify' && row.result === 'denied'));
        assert.ok(mfaAudit.rows.every((row) => !String(row.action).includes(enrollCode)));
        assert.equal((await repo.mfaConsumeChallenge({
          userId, tokenHash: enroll.tokenHash, purpose: 'enroll',
          enrollmentRecoveryHashes: enrollment.hashes,
          verify: () => ({ valid: true }),
        })).status, 'consumed');
      } finally { await pool.end(); }

      // Old approved 001-005 followed by offline 006, with no re-application of 005.
      await resetDb(admin);
      const old = runMigration();
      assert.equal(old.status, 0, `Approved five-file migration must remain valid: ${old.stderr}`);
      assert.match(old.stdout, /applied: 005_runtime_overage_privileges\.sql/);
      const upgrade = runMigration(offline);
      assert.equal(upgrade.status, 0, `MFA-only upgrade must pass: ${upgrade.stderr}`);
      assert.match(upgrade.stdout, /skip verified: 005_runtime_overage_privileges\.sql/);
      assert.match(upgrade.stdout, /applied: 006_mfa_identity\.sql/);
      const blocked = runMigration({
        SECURE_GUARD_MIGRATION_MANIFEST: offline.SECURE_GUARD_MIGRATION_MANIFEST,
        SECURE_GUARD_MIGRATIONS_DIR: offline.SECURE_GUARD_MIGRATIONS_DIR,
        SECURE_GUARD_MFA_OFFLINE_006: 'false',
      });
      assert.notEqual(blocked.status, 0, '006 must reject deployment without offline guard');
    } finally { await admin.end(); }
  });


test('PostgreSQL 16: M3 recovery, admin MFA reauth, scoped reset and session revocation', { timeout: 90000 }, async () => {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
  assert.equal(process.env.NODE_ENV, 'test');
  const { Pool } = require('pg');
  const { SecureGuardIdentityService } = require('../../dist/services/secureGuardIdentityService');
  const {
    SecureGuardMfaCrypto, totpAtStep, hashMfaChallengeToken, createMfaChallenge,
  } = require('../../dist/services/secureGuardMfa');
  const pool = new Pool({
    host: safeTestHost, port: safeTestPort, database: targetDatabase,
    user: runtimeUser, password: fixturePassword, max: 3,
  });
  const repo = new SecureGuardRepo(pool);
  const keys = {
    SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 31).toString('base64'),
    SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 32).toString('base64'),
  };
  const cryptoMfa = new SecureGuardMfaCrypto(keys);
  const service = new SecureGuardIdentityService(
    repo, 'synthetic-m3-jwt-key-2026-only-test', '1h', undefined, keys,
  );
  let ids = [];
  let organizations = [];
  let memberships = [];
  try {
    const password = 'password-m3-only-synthetic';
    const hash = await bcrypt.hash(password, 4);
    const insertedUsers = await pool.query(
      `INSERT INTO portal_users(email,password_hash,status) VALUES
       ('m3-admin@ci.invalid',$1,'active'),
       ('m3-other-admin@ci.invalid',$1,'active'),
       ('m3-target@ci.invalid',$1,'active'),
       ('m3-multi@ci.invalid',$1,'active'),
       ('m3-msp@ci.invalid',$1,'active'),
       ('m3-foreign@ci.invalid',$1,'active'),
       ('m3-viewer@ci.invalid',$1,'active'),
       ('m3-disabled@ci.invalid',$1,'disabled'),
       ('m3-recovery@ci.invalid',$1,'active') RETURNING id,email`,
      [hash],
    );
    ids = insertedUsers.rows.map((r) => r.id);
    const [admin, otherAdmin, target, multi, msp, foreign, viewer, disabled, recover] = ids;
    const orgs = await pool.query(
      `INSERT INTO customer_organizations(organization_name,status)
       VALUES ('M3 fixture A','active'),('M3 fixture B','active') RETURNING id`,
    );
    organizations = orgs.rows.map((r) => r.id);
    const [orgA, orgB] = organizations;
    const grant = async (userId, orgId, role) => {
      const { rows } = await pool.query(
        `INSERT INTO customer_memberships
         (user_id,customer_organization_id,role,status,accepted_at)
         VALUES($1,$2,$3,'active',now()) RETURNING id`,
        [userId, orgId, role],
      );
      memberships.push(rows[0].id);
      return rows[0].id;
    };
    const adminMembership = await grant(admin, orgA, 'org_admin');
    await grant(otherAdmin, orgA, 'org_admin');
    const targetMembership = await grant(target, orgA, 'viewer');
    const multiMembership = await grant(multi, orgA, 'viewer');
    await grant(multi, orgB, 'viewer');
    const mspMembership = await grant(msp, orgA, 'viewer');
    const foreignMembership = await grant(foreign, orgB, 'viewer');
    const viewerMembership = await grant(viewer, orgA, 'viewer');
    const disabledMembership = await grant(disabled, orgA, 'viewer');
    await pool.query(`INSERT INTO msp_role_grants(user_id,role,status)
      VALUES($1,'msp_admin','active')`, [msp]);

    const secrets = new Map();
    for (const userId of [admin, otherAdmin, target, multi, msp, foreign, viewer, disabled, recover]) {
      const secret = cryptoMfa.generateTotpSecret();
      secrets.set(userId, secret);
      const encrypted = cryptoMfa.encryptTotp(userId, secret);
      await repo.mfaPutSetting({
        userId, method: 'totp', state: 'active',
        totpCiphertext: encrypted.ciphertext, totpNonce: encrypted.nonce,
        totpTag: encrypted.tag, keyVersion: encrypted.keyVersion,
      });
    }
    const attrs = (id, sessionVersion = 1) => ({
      userId: id, sessionVersion, mfaVerified: true, mfaMethod: 'totp',
    });
    assert.ok(await service.verifyActiveSession(attrs(target)));
    assert.equal(await repo.mfaResetByOrgAdmin({
      actorUserId: admin, actorSessionVersion: 1, actorMembershipId: adminMembership,
      targetMembershipId: targetMembership, reauthTokenHash: '0'.repeat(64),
    }), null, 'normal session without fresh MFA proof cannot reset');

    // Recovery is password-verified and MUST consume code + invalidate prior sessions.
    const recoveryCodes = cryptoMfa.createRecoveryCodes(recover);
    await repo.mfaReplaceRecoveryHashes(recover, recoveryCodes.hashes);
    const login = await service.login('m3-recovery@ci.invalid', password);
    assert.equal(login.flow, 'MFA_REQUIRED');
    assert.equal(await service.recoverMfa(login.challengeToken, '0'.repeat(32)), null);
    const simultaneousRecovery = await Promise.all([
      service.recoverMfa(login.challengeToken, recoveryCodes.codes[0]),
      service.recoverMfa(login.challengeToken, recoveryCodes.codes[0]),
    ]);
    assert.equal(simultaneousRecovery.filter(Boolean).length, 1, 'only one recovery may win');
    const recovered = simultaneousRecovery.find(Boolean);
    assert.equal(recovered.flow, 'MFA_ENROLLMENT_REQUIRED');
    assert.match(recovered.challengeToken, /^[a-f0-9]{64}$/);
    assert.equal(await service.verifyActiveSession(attrs(recover)), null);
    const resetFactor = await repo.mfaGetSetting(recover);
    assert.equal(resetFactor.state, 'reset_required');
    assert.equal(resetFactor.totpCiphertext, null);
    assert.equal(await service.recoverMfa(login.challengeToken, recoveryCodes.codes[0]), null);
    assert.equal((await pool.query(
      'SELECT count(*)::integer AS count FROM secure_guard_mfa_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL',
      [recover],
    )).rows[0].count, 0);
    const reEnroll = await repo.mfaFindChallenge(hashMfaChallengeToken(recovered.challengeToken));
    assert.equal(reEnroll.purpose, 'enroll');
    assert.equal(reEnroll.method, null);
    assert.equal(await service.verifyMfa(login.challengeToken, totpAtStep(secrets.get(recover),
      BigInt(Math.floor(Date.now()/30000)))), null);

    // Even a verified-at marker cannot authorize a proof past the 5-minute TTL.
    const expiredReauth = createMfaChallenge('admin_reauth', Date.now() - 10*60*1000);
    await repo.mfaIssueChallenge({
      userId: admin, tokenHash: expiredReauth.tokenHash, purpose: 'admin_reauth',
      method: 'totp', expiresAt: expiredReauth.expiresAt,
    });
    await pool.query(
      "UPDATE secure_guard_mfa_challenges SET verified_at=now()-interval '6 minutes' WHERE token_hash=$1",
      [expiredReauth.tokenHash],
    );
    assert.equal(await repo.mfaResetByOrgAdmin({
      actorUserId: admin, actorSessionVersion: 1, actorMembershipId: adminMembership,
      targetMembershipId: targetMembership, reauthTokenHash: expiredReauth.tokenHash,
    }), null, 'expired reauthentication cannot reset eligible target');
    assert.equal((await repo.mfaGetSetting(target)).state, 'active');
    assert.equal(await service.startAdminReauth(viewer), null, 'viewer cannot initiate admin proof');

    // Prove a fresh MFA code and use the resulting 5-minute proof exactly once.
    const reauth = await service.startAdminReauth(admin);
    assert.equal(reauth.method, 'totp');
    const step = BigInt(Math.floor(Date.now() / 30000));
    const code = totpAtStep(secrets.get(admin), step);
    assert.equal(await service.verifyAdminReauth(admin, reauth.challengeToken, code), true);
    assert.equal(await service.verifyAdminReauth(admin, reauth.challengeToken, code), false);
    const oldBackup = cryptoMfa.createRecoveryCodes(target);
    await repo.mfaReplaceRecoveryHashes(target, oldBackup.hashes);
    const oldChallenge = createMfaChallenge('login');
    assert.equal(await repo.mfaIssueChallenge({
      userId: target, tokenHash: oldChallenge.tokenHash, purpose: 'login',
      method: 'totp', expiresAt: oldChallenge.expiresAt,
    }), true);
    const resetRequests = Array.from({ length: 2 }, () => repo.mfaResetByOrgAdmin({
      actorUserId: admin, actorSessionVersion: 1, actorMembershipId: adminMembership,
      targetMembershipId: targetMembership,
      reauthTokenHash: hashMfaChallengeToken(reauth.challengeToken),
    }));
    const resetResults = await Promise.all(resetRequests);
    assert.equal(resetResults.filter(Boolean).length, 1, 'same proof cannot reset twice concurrently');
    assert.equal(resetResults.find(Boolean).email, 'm3-target@ci.invalid');
    assert.equal(await service.verifyActiveSession(attrs(target)), null);
    assert.equal((await pool.query('SELECT session_version FROM portal_users WHERE id=$1', [target]))
      .rows[0].session_version, 2);
    const targetFactor = await repo.mfaGetSetting(target);
    assert.equal(targetFactor.state, 'reset_required');
    assert.equal(targetFactor.totpCiphertext, null);
    assert.equal(targetFactor.totpTag, null);
    assert.equal((await repo.mfaFindChallenge(oldChallenge.tokenHash)).consumedAt !== null, true);
    assert.equal((await pool.query(
      'SELECT count(*)::integer AS count FROM secure_guard_mfa_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL',
      [target],
    )).rows[0].count, 0);
    assert.equal(await repo.mfaResetByOrgAdmin({
      actorUserId: admin, actorSessionVersion: 1, actorMembershipId: adminMembership,
      targetMembershipId: targetMembership,
      reauthTokenHash: hashMfaChallengeToken(reauth.challengeToken),
    }), null, 'used proof must not reset twice');

    // New proof with another 30-second TOTP step, avoiding replay.
    const freshProof = async () => {
      const fresh = await service.startAdminReauth(admin);
      const last = (await repo.mfaGetSetting(admin)).lastTotpStep;
      const nextStep = (last ?? BigInt(Math.floor(Date.now()/30000))) + 1n;
      // Use the next 30-second step in a synthetic callback with a fixed test clock.
      assert.equal(await repo.mfaVerifyAdminReauth({
        userId: admin, tokenHash: hashMfaChallengeToken(fresh.challengeToken),
        verify: () => ({ valid: true, totpStep: nextStep }),
      }), true);
      return hashMfaChallengeToken(fresh.challengeToken);
    };
    const makeReset = (actorUserId, actorMembershipId, targetMembershipId, hash) =>
      repo.mfaResetByOrgAdmin({
        actorUserId, actorSessionVersion: 1, actorMembershipId,
        targetMembershipId, reauthTokenHash: hash,
      });

    assert.equal(await makeReset(admin, adminMembership, adminMembership, await freshProof()), null,
      'self reset denied');
    assert.equal(await makeReset(admin, adminMembership, foreignMembership, await freshProof()), null,
      'foreign organization denied');
    assert.equal(await makeReset(admin, adminMembership, multiMembership, await freshProof()), null,
      'multi-organization identity denied');
    assert.equal(await makeReset(admin, adminMembership, mspMembership, await freshProof()), null,
      'MSP-granted target denied');
    assert.equal(await makeReset(admin, adminMembership, disabledMembership, await freshProof()), null,
      'disabled target denied');
    assert.equal(await makeReset(viewer, viewerMembership, foreignMembership, await freshProof()), null,
      'viewer denied');
    const audit = await pool.query(
      `SELECT action,result,actor_user_id,membership_id FROM secure_guard_audit_events
       WHERE action IN ('mfa.reset','mfa.recovery') AND actor_user_id=ANY($1::uuid[])`,
      [ids],
    );
    assert.equal(audit.rows.filter(r=>r.action==='mfa.reset' && r.result==='success').length, 1);
    assert.equal(audit.rows.filter(r=>r.action==='mfa.recovery' && r.result==='success').length, 1);
  } finally {
    if (ids.length) {
      await pool.query('DELETE FROM secure_guard_audit_events WHERE actor_user_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM secure_guard_mfa_challenges WHERE user_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM secure_guard_mfa_recovery_codes WHERE user_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM secure_guard_mfa_settings WHERE user_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM msp_role_grants WHERE user_id=ANY($1::uuid[])', [ids]);
      if (memberships.length) await pool.query('DELETE FROM customer_memberships WHERE id=ANY($1::uuid[])', [memberships]);
      if (organizations.length) await pool.query('DELETE FROM customer_organizations WHERE id=ANY($1::uuid[])', [organizations]);
      await pool.query('DELETE FROM portal_users WHERE id=ANY($1::uuid[])', [ids]);
    }
    await pool.end();
  }
});

