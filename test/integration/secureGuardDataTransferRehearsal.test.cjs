const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

// Only disposable synthetic fixtures; NEVER point this test at GCP/Production.
const host = '127.0.0.1';
const port = 55432;
const password = 'local_ci_fixture_password_not_a_secret';
const sourceName = 'secure_guard_legacy_fixture_ci';
const targetName = 'secure_guard_transfer_fixture_ci';
const migrationUser = 'secure_guard_transfer_ci_ddl';
const root = path.join(__dirname, '../..');
const tables = [
  'portal_users', 'customer_organizations', 'customer_memberships', 'msp_role_grants',
  'dnsfilter_organization_mappings', 'secure_guard_receipts',
  'secure_guard_audit_events', 'secure_guard_overage_alerts',
];

function connect(database, user = 'postgres') {
  return new Client({ host, port, database, user, password, connectionTimeoutMillis: 3000 });
}

function migrateTargetBaseline() {
  return spawnSync(process.execPath, ['-r', 'ts-node/register', 'migrations/secure_guard_runner.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      SECURE_GUARD_DB_MODE: 'dedicated',
      SECURE_GUARD_DB_HOST: host,
      SECURE_GUARD_DB_PORT: String(port),
      SECURE_GUARD_DB_SOCKET_PATH: '',
      SECURE_GUARD_DB_NAME: targetName,
      SECURE_GUARD_MIGRATION_DB_USER: migrationUser,
      SECURE_GUARD_MIGRATION_DB_PASSWORD: password,
      SECURE_GUARD_MIGRATION_APPROVED: 'true',
      DB_NAME: sourceName,
    },
  });
}

// Rehearsal fixture transfer only. Production transfer mechanism remains No-Go pending
// source schema_migrations ledger, dataset sizing, source write-freeze and rollback approval.
function quote(identifier) { return '"' + identifier.replace(/"/g, '""') + '"'; }
async function copySyntheticFixture(source, target, failAfterTable) {
  await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await target.query('BEGIN');
  try {
    for (const table of tables) {
      const sourceRows = await source.query(`SELECT * FROM ${quote(table)} ORDER BY id`);
      const columns = sourceRows.fields.map((field) => field.name);
      const values = columns.map((_column, index) => `$${index + 1}`).join(', ');
      const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${values})`;
      for (const row of sourceRows.rows) {
        await target.query(sql, columns.map((column) => row[column]));
      }
      if (table === failAfterTable) throw new Error('synthetic failure before commit');
    }
    // BIGSERIAL's sequence is not advanced by explicit historical IDs.
    await target.query(`SELECT setval('secure_guard_overage_alerts_id_seq',
      GREATEST(COALESCE((SELECT max(id) FROM secure_guard_overage_alerts), 1), 1),
      EXISTS (SELECT 1 FROM secure_guard_overage_alerts))`);
    await target.query('COMMIT');
    await source.query('COMMIT');
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    await source.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

test('Synthetic legacy 011/012/015 -> isolated SG database preserves identity and audit atomically',
  { timeout: 90000 }, async () => {
    assert.equal(process.env.CI, 'true');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, host);
    assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(port));

    const admin = connect('postgres');
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${migrationUser} LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE DATABASE ${sourceName}`);
      await admin.query(`CREATE DATABASE ${targetName} OWNER ${migrationUser}`);
    } finally { await admin.end(); }

    const source = connect(sourceName);
    const target = connect(targetName, migrationUser);
    await source.connect();
    await target.connect();
    try {
      await source.query('CREATE TABLE customers(id uuid PRIMARY KEY, company_name varchar(255) NOT NULL)');
      for (const file of [
        '011_secure_guard_identity_scope.sql',
        '012_secure_guard_organization_independence.sql',
        '015_secure_guard_overage_alerts.sql',
      ]) {
        if (file.startsWith('012_')) {
          await source.query(`INSERT INTO customers (id,company_name)
            VALUES ('00000000-0000-0000-0000-000000000099','Synthetic Legacy Organization')`);
          await source.query(`INSERT INTO customer_organizations (id,customer_id)
            VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000099')`);
        }
        await source.query(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
      }

      await source.query(`INSERT INTO customer_organizations (id,customer_id,organization_name)
        VALUES ('00000000-0000-0000-0000-000000000012',NULL,'Synthetic SG-only Organization')`);
      await source.query(`INSERT INTO portal_users
        (id,email,password_hash,status,session_version)
        VALUES ('00000000-0000-0000-0000-000000000021','admin@example.invalid','synthetic-hash','active',7),
               ('00000000-0000-0000-0000-000000000022','pending@example.invalid',NULL,'invited',1)`);
      await source.query(`INSERT INTO customer_memberships
        (id,user_id,customer_organization_id,role,is_initial_admin,status,accepted_at)
        VALUES ('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000021',
                '00000000-0000-0000-0000-000000000011','org_admin',true,'active',now())`);
      await source.query(`INSERT INTO customer_memberships
        (id,user_id,customer_organization_id,role,status,invite_token_hash,invite_expires_at)
        VALUES ('00000000-0000-0000-0000-000000000032','00000000-0000-0000-0000-000000000022',
                '00000000-0000-0000-0000-000000000012','viewer','pending','synthetic-token-hash',now()+interval '1 day')`);
      await source.query(`INSERT INTO msp_role_grants (id,user_id,role)
        VALUES ('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000021','msp_admin')`);
      await source.query(`INSERT INTO dnsfilter_organization_mappings
        (id,customer_organization_id,dnsfilter_organization_id)
        VALUES ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000011','synthetic-dnsfilter-id')`);
      await source.query(`INSERT INTO secure_guard_receipts
        (id,customer_organization_id,status,completed_at,plan_hash)
        VALUES ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000011',
                'verified',now(),'synthetic-plan-hash')`);
      await source.query(`INSERT INTO secure_guard_audit_events
        (id,actor_user_id,customer_organization_id,membership_id,action,result,receipt_id)
        VALUES ('00000000-0000-0000-0000-000000000071','00000000-0000-0000-0000-000000000021',
                '00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000031',
                'synthetic.action','success','00000000-0000-0000-0000-000000000061')`);
      await source.query(`INSERT INTO secure_guard_overage_alerts
        (id,customer_organization_id,last_observed_at,allocated_rc_licenses,
         roaming_clients_in_use,over_by,notification_status,response_updated_by)
        VALUES (100,'00000000-0000-0000-0000-000000000011',now(),1,2,1,
                'needs_review','00000000-0000-0000-0000-000000000021')`);

      const baseline = migrateTargetBaseline();
      assert.equal(baseline.status, 0, `Target SG-only migration: ${baseline.stderr}`);

      await assert.rejects(copySyntheticFixture(source, target, 'customer_memberships'),
        /synthetic failure before commit/);
      for (const table of tables) {
        const count = await target.query(`SELECT count(*)::integer AS n FROM ${quote(table)}`);
        assert.equal(count.rows[0].n, 0, `Failed transfer must not partially persist ${table}`);
      }

      await copySyntheticFixture(source, target);
      for (const table of tables) {
        const original = await source.query(`SELECT * FROM ${quote(table)} ORDER BY id`);
        const transferred = await target.query(`SELECT * FROM ${quote(table)} ORDER BY id`);
        assert.deepEqual(transferred.rows, original.rows, `${table} must preserve every source field`);
      }
      const noLegacyCustomers = await target.query(`SELECT to_regclass('public.customers') AS table_name`);
      assert.equal(noLegacyCustomers.rows[0].table_name, null);

      const nextEpisode = await target.query(`INSERT INTO secure_guard_overage_alerts
        (customer_organization_id,last_observed_at,allocated_rc_licenses,roaming_clients_in_use,over_by)
        VALUES ('00000000-0000-0000-0000-000000000012',now(),2,3,1) RETURNING id`);
      assert.ok(Number(nextEpisode.rows[0].id) > 100, 'Historical BIGSERIAL ID must not be reused');
    } finally {
      await source.end();
      await target.end();
    }
  });
