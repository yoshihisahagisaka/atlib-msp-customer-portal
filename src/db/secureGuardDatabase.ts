import { Pool } from 'pg';

/**
 * Secure Guard uses a different database from the legacy customer portal.
 * Legacy mode is retained only for the existing, uncut-over deployment.
 * The migration runner MUST use a distinct DDL principal.
 */
export interface SecureGuardDatabaseSettings {
  name: string;
  user: string;
  password: string;
  host: string;
  port: number;
  socketPath?: string;
  maxConnections: number;
}

type DatabasePrincipal = 'runtime' | 'overage' | 'migration';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing Secure Guard database setting: ${key}`);
  return value;
}

/**
 * Unset/legacy retains current Portal behaviour; migration mode is opt-in.
 * When the cutover guard is set, omission of the new DB settings is fatal.
 * A selected dedicated mode NEVER falls back to the Portal DB.
 */
export function readSecureGuardDatabaseSettings(
  env: NodeJS.ProcessEnv = process.env,
  principal: DatabasePrincipal = 'runtime',
): SecureGuardDatabaseSettings | null {
  const mode = env.SECURE_GUARD_DB_MODE || 'legacy';
  if (mode !== 'legacy' && mode !== 'dedicated') {
    throw new Error('Invalid SECURE_GUARD_DB_MODE');
  }
  if (mode === 'legacy') {
    if (principal !== 'runtime' || env.SECURE_GUARD_DB_REQUIRE_DEDICATED === 'true') {
      throw new Error('Secure Guard dedicated database required');
    }
    return null;
  }

  const name = required(env, 'SECURE_GUARD_DB_NAME');
  if (env.DB_NAME && name === env.DB_NAME) {
    throw new Error('Secure Guard database must differ from the legacy Portal database');
  }
  const socketPath = env.SECURE_GUARD_DB_SOCKET_PATH?.trim() || undefined;
  const tcpHost = env.SECURE_GUARD_DB_HOST?.trim() || undefined;
  if (socketPath && tcpHost) throw new Error('Set either SG socket path or TCP host, not both');
  if (!socketPath && !tcpHost) throw new Error('Missing Secure Guard database endpoint');

  const rawPort = env.SECURE_GUARD_DB_PORT ?? '5432';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid SECURE_GUARD_DB_PORT');
  }

  const migration = principal === 'migration';
  const overage = principal === 'overage';
  const userKey = migration ? 'SECURE_GUARD_MIGRATION_DB_USER'
    : overage ? 'SECURE_GUARD_OVERAGE_DB_USER' : 'SECURE_GUARD_DB_USER';
  const passwordKey = migration ? 'SECURE_GUARD_MIGRATION_DB_PASSWORD'
    : overage ? 'SECURE_GUARD_OVERAGE_DB_PASSWORD' : 'SECURE_GUARD_DB_PASSWORD';
  return {
    name,
    user: required(env, userKey),
    password: required(env, passwordKey),
    host: tcpHost ?? '',
    port,
    socketPath,
    // Hard application budget; additional revisions/Job are counted by the platform owner.
    maxConnections: migration ? 1 : 2,
  };
}

export function createSecureGuardDatabasePool(settings: SecureGuardDatabaseSettings): Pool {
  return new Pool({
    host: settings.socketPath ?? settings.host,
    ...(settings.socketPath ? {} : { port: settings.port }),
    database: settings.name,
    user: settings.user,
    password: settings.password,
    max: settings.maxConnections,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}
