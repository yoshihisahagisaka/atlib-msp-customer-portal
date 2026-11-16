const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

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
      SECURE_GUARD_MIGRATIONS_DIR: path.join(__dirname, '../../migrations/secure_guard'),
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
