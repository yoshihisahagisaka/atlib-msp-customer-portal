import { Pool } from 'pg';
import type { Config } from '../config';

/**
 * Cloud Run本番では Cloud SQL Auth Proxy 統合により Unix ソケット経由で接続する
 * （`--add-cloudsql-instances` 指定時、/cloudsql/<INSTANCE_CONNECTION_NAME> にソケットが生成される）。
 * ローカル開発時は host/port のTCP接続にフォールバックする。
 */
export function createPool(config: Config): Pool {
  if (config.db.socketPath) {
    return new Pool({
      host: config.db.socketPath,
      database: config.db.name,
      user: config.db.user,
      password: config.db.password,
      max: 5,
    });
  }
  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    max: 5,
  });
}
