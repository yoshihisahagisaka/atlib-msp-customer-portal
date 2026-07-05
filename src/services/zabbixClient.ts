import { Agent } from 'undici';
import type { Config } from '../config';

/**
 * ZabbixServerの内部IPへ直接接続する場合（DNS名ではなくIPをapiUrlに使う場合）、
 * TLS証明書のホスト名検証は失敗する（証明書はhostHeaderのFQDN用のため）。
 * api-bridge.php（既存のPHP実装）が CURLOPT_SSL_VERIFYPEER=false としているのと
 * 同じ理由で、内部ネットワーク経由の接続に限り検証を無効化する。
 */
const insecureInternalAgent = new Agent({ connect: { rejectUnauthorized: false } });

export interface ZabbixMedia {
  mediatypeid: string;
  sendto: string | string[];
  active: '0' | '1'; // 0=有効, 1=無効 (Zabbix API仕様どおり)
  severity: number; // ビットマスク
  period: string;
}

// 設計書「severity ビットマスク仕様」のとおり
export const SEVERITY_PRESETS = {
  criticalOnly: 48, // High + Disaster
  warningAndAbove: 60, // Warning + Average + High + Disaster
  all: 63, // 全ビット
} as const;

// 設計書「period（通知スケジュール）仕様」のとおり
export const PERIOD_PRESETS = {
  always: '1-7,00:00-24:00',
  businessHours: '1-5,09:00-18:00',
} as const;

interface JsonRpcError {
  code: number;
  message: string;
  data?: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  result?: T;
  error?: JsonRpcError;
  id: number;
}

/**
 * Zabbix API JSON-RPC 2.0 クライアント。
 * 既存の api-bridge.php / zabbixserver/batch/zabbix_client.py と同じエンベロープ形式
 * （{jsonrpc, method, params, id}、idは連番、.error時は例外）を踏襲する。
 *
 * 公開メソッドはあえて狭く保っている: 顧客向けルート（routes/notifications.ts）から
 * 呼ばれるのは getUserMedias/updateUserMedias のみで、任意の groupids/hostids/userid を
 * 呼び出し側から直接渡せる汎用メソッドは公開しない。ホストグループ作成等の広い権限が要る
 * 操作は onboarding スクリプト専用のメソッドとして個別に用意する。
 */
export class ZabbixClient {
  private authToken: string | null = null;
  private loginPromise: Promise<string> | null = null;
  private nextId = 1;

  constructor(private readonly config: Config['zabbix']) {}

  private async call<T>(method: string, params: unknown, requireAuth = true): Promise<T> {
    const auth = requireAuth ? await this.ensureLoggedIn() : undefined;

    const body = {
      jsonrpc: '2.0' as const,
      method,
      params,
      id: this.nextId++,
      ...(auth ? { auth } : {}),
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.hostHeader) {
      headers['Host'] = this.config.hostHeader;
    }

    const res = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: this.config.hostHeader ? insecureInternalAgent : undefined,
    });

    if (!res.ok) {
      throw new Error(`Zabbix API HTTP ${res.status}`);
    }

    const json = (await res.json()) as JsonRpcResponse<T>;

    if (json.error) {
      // 認証切れの場合は一度だけ再ログインしてリトライする
      if (requireAuth && this.isAuthError(json.error) && auth) {
        this.authToken = null;
        const retryAuth = await this.ensureLoggedIn();
        const retryBody = { ...body, auth: retryAuth, id: this.nextId++ };
        const retryRes = await fetch(this.config.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          dispatcher: this.config.hostHeader ? insecureInternalAgent : undefined,
        });
        const retryJson = (await retryRes.json()) as JsonRpcResponse<T>;
        if (retryJson.error) {
          throw new Error(`Zabbix API error: ${retryJson.error.message} (${retryJson.error.data ?? ''})`);
        }
        return retryJson.result as T;
      }
      throw new Error(`Zabbix API error: ${json.error.message} (${json.error.data ?? ''})`);
    }

    return json.result as T;
  }

  private isAuthError(error: JsonRpcError): boolean {
    return error.code === -32602 && /not authoriz/i.test(error.data ?? '');
  }

  private async ensureLoggedIn(): Promise<string> {
    if (this.authToken) return this.authToken;
    if (!this.loginPromise) {
      this.loginPromise = this.login();
    }
    this.authToken = await this.loginPromise;
    this.loginPromise = null;
    return this.authToken;
  }

  private async login(): Promise<string> {
    const token = await this.call<string>(
      'user.login',
      { username: this.config.user, password: this.config.password },
      false,
    );
    return token;
  }

  // ---- Phase 1: 顧客向けルートから呼ばれる公開メソッド ----

  async getUserMedias(zabbixUserId: string): Promise<ZabbixMedia[]> {
    const users = await this.call<Array<{ userid: string; medias: ZabbixMedia[] }>>('user.get', {
      userids: [zabbixUserId],
      selectMedias: 'extend',
    });
    return users[0]?.medias ?? [];
  }

  async updateUserMedias(zabbixUserId: string, medias: ZabbixMedia[]): Promise<void> {
    await this.call('user.update', {
      userid: zabbixUserId,
      medias,
    });
  }

  // ---- onboarding スクリプト専用（信頼されたCLIからのみ呼ばれる） ----

  async createHostGroup(name: string): Promise<string> {
    const result = await this.call<{ groupids: string[] }>('hostgroup.create', { name });
    const groupId = result.groupids[0];
    if (!groupId) throw new Error(`hostgroup.create returned no groupid for "${name}"`);
    return groupId;
  }

  async createNotificationUser(username: string, notificationUserGroupId: string): Promise<string> {
    const result = await this.call<{ userids: string[] }>('user.create', {
      username,
      roleid: this.config.notificationRoleId, // Zabbix 7.0のuser.createで必須
      usrgrps: [{ usrgrpid: notificationUserGroupId }],
      medias: [],
    });
    const userId = result.userids[0];
    if (!userId) throw new Error(`user.create returned no userid for "${username}"`);
    return userId;
  }

  async createAction(name: string, groupIds: string[], notifyUserId: string): Promise<string> {
    const result = await this.call<{ actionids: string[] }>('action.create', {
      name,
      eventsource: 0, // Trigger
      status: 0, // 有効
      filter: {
        evaltype: 2, // OR
        conditions: groupIds.map((groupid) => ({
          conditiontype: 0, // Host group
          operator: 0, // =
          value: groupid,
        })),
      },
      operations: [
        {
          operationtype: 0, // メッセージ送信
          opmessage_usr: [{ userid: notifyUserId }],
          opmessage: {
            default_msg: 1,
            mediatypeid: this.config.mediaTypeEmailId,
          },
        },
      ],
    });
    const actionId = result.actionids[0];
    if (!actionId) throw new Error(`action.create returned no actionid for "${name}"`);
    return actionId;
  }
}
