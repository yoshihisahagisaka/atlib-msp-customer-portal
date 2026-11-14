import { Client } from 'pg';

const TARGET_CONFIRMATION =
  'msp-zabbix:asia-northeast1:secumie-sg-shared-staging-db/secure_guard_staging';
const TARGET_DATABASE = 'secure_guard_staging';
const INSIGHT_DATABASE = 'secumie_insight_staging';
const LOCK_KEY = 7_161_113;

const roles = {
  runtime: { name: 'secure_guard_runtime_staging', limit: 2, passwordEnv: 'SG_RUNTIME_DB_PASSWORD' },
  overage: { name: 'secure_guard_overage_staging', limit: 2, passwordEnv: 'SG_OVERAGE_DB_PASSWORD' },
  migration: { name: 'secure_guard_migration_staging', limit: 1, passwordEnv: 'SG_MIGRATION_DB_PASSWORD' },
} as const;

const insightRoles = [
  'secumie_otp_staging',
  'secumie_pira_staging',
  'secumie_admin_staging',
  'secumie_migration_staging',
  'secumie_maintenance_staging',
] as const;

type RoleKey = keyof typeof roles;

async function shutdownCloudSqlProxy(): Promise<void> {
  const url = process.env.CLOUD_SQL_PROXY_ADMIN_URL;
  if (!url) return;
  if (url !== 'http://127.0.0.1:9091/quitquitquit') throw new Error('PROXY_ADMIN_URL_INVALID');
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('PROXY_SHUTDOWN_FAILED');
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function adminSettings(database: string) {
  return {
    host: required('DB_BOOTSTRAP_HOST'),
    port: Number(required('DB_BOOTSTRAP_PORT')),
    database,
    user: required('DB_BOOTSTRAP_USER'),
    password: required('DB_BOOTSTRAP_PASSWORD'),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'secure-guard-staging-bootstrap-once',
  };
}

async function formatted(client: Client, template: string, ...values: string[]): Promise<string> {
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  const result = await client.query<{ sql: string }>(
    `SELECT format($fmt$${template}$fmt$, ${placeholders}) AS sql`,
    values,
  );
  const sql = result.rows[0]?.sql;
  if (!sql) throw new Error('FORMAT_FAILED');
  return sql;
}

async function connectAs(role: RoleKey, database: string): Promise<Client> {
  const spec = roles[role];
  const client = new Client({
    ...adminSettings(database),
    user: spec.name,
    password: required(spec.passwordEnv),
    application_name: `secure-guard-${role}-staging-verify`,
  });
  await client.connect();
  return client;
}

async function expectConnectionDenied(role: RoleKey, database: string): Promise<void> {
  const spec = roles[role];
  const client = new Client({
    ...adminSettings(database),
    user: spec.name,
    password: required(spec.passwordEnv),
    application_name: `secure-guard-${role}-cross-db-negative`,
  });
  try {
    await client.connect();
    throw new Error('CROSS_DATABASE_CONNECT_UNEXPECTEDLY_ALLOWED');
  } catch (error) {
    if ((error as { code?: string }).code !== '42501') throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (required('SG_BOOTSTRAP_TARGET_CONFIRMATION') !== TARGET_CONFIRMATION) {
    throw new Error('TARGET_CONFIRMATION_MISMATCH');
  }
  for (const role of Object.values(roles)) required(role.passwordEnv);

  let stage = 'PREFLIGHT';
  const admin = new Client(adminSettings('postgres'));
  await admin.connect();
  let lockHeld = false;
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    lockHeld = true;
    const identity = await admin.query<{
      database: string;
      version_num: string;
      max_connections: string;
      used_connections: string;
    }>(`SELECT current_database() AS database,
               current_setting('server_version_num') AS version_num,
               current_setting('max_connections') AS max_connections,
               (SELECT count(*)::text FROM pg_stat_activity) AS used_connections`);
    const fact = identity.rows[0];
    if (!fact || fact.database !== 'postgres' || !fact.version_num.startsWith('16')) {
      throw new Error('POSTGRES_TARGET_MISMATCH');
    }
    const available = Number(fact.max_connections) - Math.max(10, Math.ceil(Number(fact.max_connections) * 0.2));
    if (!Number.isInteger(available) || available < 78 || Number(fact.used_connections) > 18) {
      throw new Error('CONNECTION_BUDGET_STOP');
    }

    const databases = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname',
      [[TARGET_DATABASE, INSIGHT_DATABASE]],
    );
    if (databases.rows.some((row) => row.datname === TARGET_DATABASE)
      || !databases.rows.some((row) => row.datname === INSIGHT_DATABASE)) {
      throw new Error('DATABASE_EXISTENCE_STOP');
    }
    const allRoleNames = [...Object.values(roles).map((role) => role.name), ...insightRoles];
    const existingRoles = await admin.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
      [allRoleNames],
    );
    if (Object.values(roles).some((role) => existingRoles.rows.some((row) => row.rolname === role.name))
      || insightRoles.some((name) => !existingRoles.rows.some((row) => row.rolname === name))) {
      throw new Error('ROLE_EXISTENCE_STOP');
    }

    stage = 'CREATE_ROLES';
    await admin.query('BEGIN');
    try {
      for (const spec of Object.values(roles)) {
        const sql = await formatted(
          admin,
          'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s PASSWORD %L',
          spec.name,
          String(spec.limit),
          required(spec.passwordEnv),
        );
        await admin.query(sql);
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    stage = 'CREATE_DATABASE';
    const createDatabase = await formatted(
      admin,
      'CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L LC_COLLATE %L LC_CTYPE %L',
      TARGET_DATABASE,
      roles.migration.name,
      'UTF8',
      'en_US.UTF8',
      'en_US.UTF8',
    );
    await admin.query(createDatabase);

    stage = 'CONFIGURE_DATABASE';
    const target = new Client(adminSettings(TARGET_DATABASE));
    await target.connect();
    try {
      await target.query('BEGIN');
      try {
        await target.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${TARGET_DATABASE} FROM PUBLIC`);
        await target.query(`GRANT CONNECT ON DATABASE ${TARGET_DATABASE} TO ${roles.runtime.name}, ${roles.overage.name}, ${roles.migration.name}`);
        await target.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await target.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${roles.migration.name}`);
        await target.query('COMMIT');
      } catch (error) {
        await target.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      await target.end();
    }

    stage = 'VERIFY';
    const roleFacts = await admin.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
    }>(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
               rolinherit, rolreplication, rolbypassrls, rolconnlimit
          FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [Object.values(roles).map((role) => role.name)]);
    if (roleFacts.rowCount !== 3 || roleFacts.rows.some((role) => !role.rolcanlogin
      || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolinherit
      || role.rolreplication || role.rolbypassrls
      || role.rolconnlimit !== Object.values(roles).find((spec) => spec.name === role.rolname)?.limit)) {
      throw new Error('ROLE_ATTRIBUTE_VERIFY_FAILED');
    }
    const memberships = await admin.query<{ count: string }>(
      `SELECT count(*)::text FROM pg_auth_members
        WHERE roleid = ANY(SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[]))
           OR member = ANY(SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[]))`,
      [Object.values(roles).map((role) => role.name)],
    );
    if (memberships.rows[0]?.count !== '0') throw new Error('ROLE_MEMBERSHIP_VERIFY_FAILED');

    for (const role of Object.keys(roles) as RoleKey[]) {
      const client = await connectAs(role, TARGET_DATABASE);
      try {
        const check = await client.query<{ user_name: string; database_name: string; user_tables: string; ledger: string | null }>(
          `SELECT current_user AS user_name, current_database() AS database_name,
                  (SELECT count(*)::text FROM pg_tables WHERE schemaname = 'public') AS user_tables,
                  to_regclass('public.secure_guard_schema_migrations')::text AS ledger`,
        );
        const row = check.rows[0];
        if (!row || row.user_name !== roles[role].name || row.database_name !== TARGET_DATABASE
          || row.user_tables !== '0' || row.ledger !== null) throw new Error('ROLE_LOGIN_VERIFY_FAILED');
        const schema = await client.query<{ usage: boolean; create_privilege: boolean }>(
          `SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usage,
                  has_schema_privilege(current_user, 'public', 'CREATE') AS create_privilege`,
        );
        const expected = role === 'migration';
        if (schema.rows[0]?.usage !== expected || schema.rows[0]?.create_privilege !== expected) {
          throw new Error('SCHEMA_PRIVILEGE_VERIFY_FAILED');
        }
      } finally {
        await client.end();
      }
      await expectConnectionDenied(role, INSIGHT_DATABASE);
    }

    const crossAccess = await admin.query<{ role_name: string; can_connect: boolean }>(
      `SELECT role_name,
              has_database_privilege(role_name, $1, 'CONNECT') AS can_connect
         FROM unnest($2::text[]) AS role_name ORDER BY role_name`,
      [TARGET_DATABASE, insightRoles],
    );
    if (crossAccess.rows.some((row) => row.can_connect)) throw new Error('SECU_CROSS_DATABASE_ACCESS_FAILED');

    process.stdout.write(`${JSON.stringify({
      event: 'secure_guard_staging_bootstrap_completed',
      database: TARGET_DATABASE,
      roles: Object.values(roles).map(({ name, limit }) => ({ name, connectionLimit: limit })),
      empty: true,
      crossDatabaseIsolation: true,
      migrationsApplied: 0,
    })}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ event: 'secure_guard_staging_bootstrap_failed', stage })}\n`);
    process.exitCode = 1;
  } finally {
    if (lockHeld) await admin.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

void main()
  .catch(() => {
    process.stderr.write(`${JSON.stringify({ event: 'secure_guard_staging_bootstrap_failed', stage: 'STARTUP' })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await shutdownCloudSqlProxy();
    } catch {
      process.stderr.write(`${JSON.stringify({ event: 'secure_guard_staging_proxy_shutdown_failed' })}\n`);
      process.exitCode = 1;
    }
  });
