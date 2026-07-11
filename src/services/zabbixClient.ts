import * as crypto from 'crypto';
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
  severity: number | string; // ビットマスク（Zabbix APIからの読み取り時は文字列で返る）
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

export interface ZabbixHost {
  hostid: string;
  name: string;
}

export interface ZabbixHostInterface {
  type: string; // '1'=Agent(ICMP流用), '2'=SNMP
  ip: string;
  port: string;
  details?: { community?: string };
}

export interface ZabbixHostDetail {
  hostid: string;
  host: string;
  name: string;
  status: string; // '0'=有効, '1'=無効
  interfaces?: ZabbixHostInterface[];
}

export interface ZabbixMaintenance {
  maintenanceid: string;
  name: string;
  active_since: string;
  active_till: string;
  maintenance_type: string; // '0' | '1'（Zabbix APIからの読み取り時は文字列）
  hosts?: Array<{ hostid: string; host: string }>;
  groups?: Array<{ groupid: string; name: string }>;
}

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
    // user.get(selectMedias)が返すオブジェクトには mediaid/userdirectory_mediaid など
    // user.update が受け付けない読み取り専用フィールドが含まれるため、書き込み可能な
    // フィールドだけを再構築してから送る。
    const sanitized = medias.map((m) => ({
      mediatypeid: m.mediatypeid,
      sendto: m.sendto,
      active: m.active,
      severity: m.severity,
      period: m.period,
    }));
    await this.call('user.update', {
      userid: zabbixUserId,
      medias: sanitized,
    });
  }

  // ---- onboarding スクリプト専用（信頼されたCLIからのみ呼ばれる） ----

  /** 既に同名のホストグループが存在する場合はそれを再利用する（オンボーディング再実行時の冪等性のため）。 */
  async createHostGroup(name: string): Promise<string> {
    const existing = await this.call<Array<{ groupid: string }>>('hostgroup.get', {
      output: ['groupid'],
      filter: { name: [name] },
    });
    if (existing[0]) {
      return existing[0].groupid;
    }
    const result = await this.call<{ groupids: string[] }>('hostgroup.create', { name });
    const groupId = result.groupids[0];
    if (!groupId) throw new Error(`hostgroup.create returned no groupid for "${name}"`);
    return groupId;
  }

  async createNotificationUser(username: string, notificationUserGroupId: string): Promise<string> {
    // 通知専用アカウントはパスワードでログインすることを想定していないが、
    // 内部認証が有効な環境ではuser.createにpasswdが必須のため、使われないランダム値を割り当てる。
    const dummyPassword = crypto.randomBytes(24).toString('base64');
    const result = await this.call<{ userids: string[] }>('user.create', {
      username,
      passwd: dummyPassword,
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

  // ---- Phase 2: メンテナンス設定（顧客向けルートから呼ばれる公開メソッド） ----

  /** 顧客のホストグループに属する機器一覧（対象機器選択肢用）。groupidsは呼び出し側（customerRepo経由）で解決した値のみ受け付ける。 */
  async getHosts(groupIds: string[]): Promise<ZabbixHost[]> {
    return this.call<ZabbixHost[]>('host.get', {
      groupids: groupIds,
      output: ['hostid', 'name'],
    });
  }

  async getMaintenances(groupIds: string[]): Promise<ZabbixMaintenance[]> {
    return this.call<ZabbixMaintenance[]>('maintenance.get', {
      groupids: groupIds,
      output: 'extend',
      selectHosts: ['hostid', 'host'],
      selectGroups: ['groupid', 'name'],
    });
  }

  async createMaintenance(params: {
    name: string;
    activeSince: number; // UNIXタイムスタンプ（秒）
    activeTill: number;
    maintenanceType: 0 | 1; // 0: 通知停止のみ, 1: 監視停止
    groupIds: string[]; // バックエンドで強制付与された顧客グループのみ
    hostIds?: string[];
  }): Promise<string> {
    const result = await this.call<{ maintenanceids: string[] }>('maintenance.create', {
      name: params.name,
      active_since: params.activeSince,
      active_till: params.activeTill,
      maintenance_type: params.maintenanceType,
      groupids: params.groupIds,
      ...(params.hostIds && params.hostIds.length > 0 ? { hostids: params.hostIds } : {}),
      timeperiods: [
        {
          timeperiod_type: 0, // ワンタイム
          start_date: params.activeSince,
          period: params.activeTill - params.activeSince,
        },
      ],
    });
    const id = result.maintenanceids[0];
    if (!id) throw new Error(`maintenance.create returned no id for "${params.name}"`);
    return id;
  }

  /**
   * 指定されたmaintenanceidが顧客自身のホストグループに属するかを確認する。
   * update/delete前に必ずこれを呼び、falseなら404として扱うこと（他顧客のメンテナンスを操作させないため）。
   */
  async verifyMaintenanceOwnership(maintenanceId: string, groupIds: string[]): Promise<boolean> {
    const result = await this.call<Array<{ maintenanceid: string }>>('maintenance.get', {
      maintenanceids: [maintenanceId],
      groupids: groupIds,
      output: ['maintenanceid'],
    });
    return result.length > 0;
  }

  async updateMaintenance(
    maintenanceId: string,
    params: {
      name?: string;
      activeSince?: number;
      activeTill?: number;
      maintenanceType?: 0 | 1;
      hostIds?: string[];
      groupIds: string[]; // 更新時も常に顧客グループへ強制的に固定し直す
    },
  ): Promise<void> {
    const body: Record<string, unknown> = { maintenanceid: maintenanceId, groupids: params.groupIds };
    if (params.name !== undefined) body.name = params.name;
    if (params.maintenanceType !== undefined) body.maintenance_type = params.maintenanceType;
    if (params.hostIds !== undefined) body.hostids = params.hostIds;
    if (params.activeSince !== undefined) body.active_since = params.activeSince;
    if (params.activeTill !== undefined) body.active_till = params.activeTill;
    if (params.activeSince !== undefined && params.activeTill !== undefined) {
      body.timeperiods = [
        { timeperiod_type: 0, start_date: params.activeSince, period: params.activeTill - params.activeSince },
      ];
    }
    await this.call('maintenance.update', body);
  }

  async deleteMaintenance(maintenanceId: string): Promise<void> {
    await this.call('maintenance.delete', [maintenanceId]);
  }

  // ---- Phase 3: ホスト管理（顧客向けルートから呼ばれる公開メソッド） ----

  async getHostsDetailed(groupIds: string[]): Promise<ZabbixHostDetail[]> {
    return this.call<ZabbixHostDetail[]>('host.get', {
      groupids: groupIds,
      output: ['hostid', 'host', 'name', 'status'],
      selectInterfaces: ['type', 'ip', 'port', 'details'],
    });
  }

  async createHost(params: {
    name: string;
    ip: string;
    monitorType: 'icmp' | 'snmp';
    snmpCommunity?: string;
    groupIds: string[]; // バックエンドで強制付与された顧客グループのみ
    proxyHostId?: string | null; // 顧客環境のProxy ID（未設定ならZabbixサーバーが直接監視）
  }): Promise<string> {
    const isIcmp = params.monitorType === 'icmp';
    // Zabbixの技術名（host）は表示名からスペースをアンダースコアに変換して生成する（設計書どおり）
    // Zabbixの技術名（host）は日本語等のマルチバイト文字を受け付けず、使える文字種も限定される。
    // 表示名（name）には顧客入力の名称をそのまま使い、技術名は衝突しないランダムなASCII識別子にする。
    const technicalName = `host-${crypto.randomBytes(4).toString('hex')}`;

    const body: Record<string, unknown> = {
      host: technicalName,
      name: params.name,
      interfaces: isIcmp
        ? [{ type: 1, main: 1, useip: 1, ip: params.ip, dns: '', port: '10050' }]
        : [
            {
              type: 2,
              main: 1,
              useip: 1,
              ip: params.ip,
              dns: '',
              port: '161',
              details: { version: 2, bulk: 1, community: params.snmpCommunity || 'public' },
            },
          ],
      groups: params.groupIds.map((groupid) => ({ groupid })),
      templates: [{ templateid: isIcmp ? this.config.templateIcmpId : this.config.templateSnmpId }],
      inventory_mode: 1,
      ...(params.proxyHostId ? { proxy_hostid: params.proxyHostId } : {}),
    };

    const result = await this.call<{ hostids: string[] }>('host.create', body);
    const id = result.hostids[0];
    if (!id) throw new Error(`host.create returned no id for "${params.name}"`);
    return id;
  }

  /** update/delete前に必ず呼ぶこと。falseなら404として扱う（他顧客の機器を操作させないため）。 */
  async verifyHostOwnership(hostId: string, groupIds: string[]): Promise<boolean> {
    const result = await this.call<Array<{ hostid: string }>>('host.get', {
      hostids: [hostId],
      groupids: groupIds,
      output: ['hostid'],
    });
    return result.length > 0;
  }

  async setHostStatus(hostId: string, status: 0 | 1): Promise<void> {
    await this.call('host.update', { hostid: hostId, status });
  }

  async deleteHost(hostId: string): Promise<void> {
    await this.call('host.delete', [hostId]);
  }

  // ---- Phase 4: 未知機器検出アラート設定（顧客向けルートから呼ばれる公開メソッド） ----
  //
  // 対象のディスカバリアクション（zabbixserver/batch/setup_discovery.py が命名規約
  // "MSP_新規機器検知通知_{customerCode}" で作成）は、社内ユーザー(atladmin)を常時の
  // 送信先として持つ。顧客ポータルの通知設定トグルは、顧客自身の notify_{customerCode}
  // ユーザーをこの送信先(opmessage_usr)に追加/除外するだけで、status・conditions には
  // 一切触れない（誤って無効化したり検出条件を壊したりしないため）。

  /** 命名規約からディスカバリアクションを解決する。ディスカバリ未設定の顧客ではnullを返す。 */
  async findNewDeviceActionId(customerCode: string): Promise<string | null> {
    const actions = await this.call<Array<{ actionid: string }>>('action.get', {
      output: ['actionid'],
      filter: { name: `MSP_新規機器検知通知_${customerCode}`, eventsource: 1 },
    });
    return actions[0]?.actionid ?? null;
  }

  async isUnknownDeviceAlertEnabled(actionId: string, notifyUserId: string): Promise<boolean> {
    const messageOp = await this.getMessageOperation(actionId);
    return (messageOp?.opmessage_usr ?? []).some((u) => u.userid === notifyUserId);
  }

  async setUnknownDeviceAlertEnabled(actionId: string, notifyUserId: string, enabled: boolean): Promise<void> {
    const messageOp = await this.getMessageOperation(actionId);
    if (!messageOp) {
      throw new Error(`action ${actionId} has no message-send operation`);
    }

    const existingIds = new Set((messageOp.opmessage_usr ?? []).map((u) => u.userid));
    if (enabled) {
      existingIds.add(notifyUserId);
    } else {
      existingIds.delete(notifyUserId);
    }

    // action.update の operations は全件を渡し直す必要があるため、action.get が返す
    // 読み取り専用フィールド（operationid等）は含めず、書き込み可能なフィールドのみで
    // 再構築する（updateUserMedias と同じサニタイズ方針）。
    await this.call('action.update', {
      actionid: actionId,
      operations: [
        {
          operationtype: messageOp.operationtype,
          opmessage_usr: [...existingIds].map((userid) => ({ userid })),
          opmessage: messageOp.opmessage,
        },
      ],
    });
  }

  private async getMessageOperation(actionId: string): Promise<{
    operationtype: string;
    opmessage_usr?: Array<{ userid: string }>;
    opmessage?: { default_msg: string; mediatypeid: string };
  } | null> {
    const actions = await this.call<
      Array<{
        operations: Array<{
          operationtype: string;
          opmessage_usr?: Array<{ userid: string }>;
          opmessage?: { default_msg: string; mediatypeid: string };
        }>;
      }>
    >('action.get', {
      actionids: [actionId],
      output: ['actionid'],
      selectOperations: 'extend',
    });
    const operations = actions[0]?.operations ?? [];
    return operations.find((op) => op.operationtype === '0') ?? null;
  }

  // ---- Phase 5: リアルタイムトポロジー・障害可視化（顧客向けルートから呼ばれる公開メソッド） ----

  /**
   * 顧客のホストグループに属する機器一覧を、障害状態（トリガー）とLLDPネイバー情報つきで取得する。
   * LLDPアイテムのキーは zabbixserver/atlib_monthly_report.html の _buildTopologyData と
   * 同じ規約（key_に"lldp.rem"を含み、sysname/portで対向ホスト名・ポートを表す）を踏襲する。
   */
  async getTopologyData(groupIds: string[]): Promise<ZabbixTopologyHost[]> {
    const [hosts, items] = await Promise.all([
      this.call<
        Array<{
          hostid: string;
          name: string;
          status: string;
          interfaces?: ZabbixHostInterface[];
          triggers?: Array<{ triggerid: string; description: string; priority: string; value: string; status: string }>;
          tags?: Array<{ tag: string; value: string }>;
        }>
      >('host.get', {
        groupids: groupIds,
        output: ['hostid', 'name', 'status'],
        selectInterfaces: ['type', 'ip', 'port'],
        selectTriggers: ['triggerid', 'description', 'priority', 'value', 'status'],
        selectTags: ['tag', 'value'],
      }),
      this.call<Array<{ hostid: string; key_: string; lastvalue: string }>>('item.get', {
        groupids: groupIds,
        output: ['hostid', 'key_', 'lastvalue'],
        search: { key_: 'lldp.rem' },
      }),
    ]);

    return hosts.map((h) => {
      const hostItems = items.filter((i) => i.hostid === h.hostid);
      const lldpSys = hostItems.find((i) => i.key_.includes('sysname'));
      const lldpPort = hostItems.find((i) => i.key_.includes('port'));
      // value: '1'=障害中, '0'=正常。status: '0'=有効, '1'=無効（いずれもZabbix API仕様どおり）。
      // 無効化されたトリガーは、対応するアイテムが無効化された後もvalueがPROBLEMのまま固着することがあるため、
      // 有効なトリガーのみを障害として扱う（zabbixserver/運用手順書_デプロイ.md参照）。
      const activeProblems = (h.triggers ?? [])
        .filter((t) => t.value === '1' && t.status === '0')
        .map((t) => ({ description: t.description, priority: t.priority }));

      // 役割・上位接続先・ケーブル種別は host タグ（tag="role"/"uplink"/"cableType"）に一元化する。
      // atlib_monthly_report.html も同じタグを参照するため、ブラウザのlocalStorageに保存していた頃と
      // 違い、どちらのツールで見ても同じ値になる。
      const tags = h.tags ?? [];
      const roleTag = tags.find((t) => t.tag === 'role');
      const uplinkTag = tags.find((t) => t.tag === 'uplink');
      const cableTypeTag = tags.find((t) => t.tag === 'cableType');

      return {
        hostid: h.hostid,
        name: h.name,
        ip: h.interfaces?.[0]?.ip ?? '',
        enabled: h.status === '0',
        problems: activeProblems,
        lldpNeighbor: lldpSys?.lastvalue ? { name: lldpSys.lastvalue.trim(), port: lldpPort?.lastvalue ?? '' } : null,
        role: roleTag?.value ?? 'other',
        uplinkHostName: uplinkTag?.value || null,
        cableType: (cableTypeTag?.value as 'cat6' | 'cat5e' | 'wifi' | undefined) ?? 'cat6',
      };
    });
  }

  /**
   * 既存のホストタグのうち、指定したタグ名だけを置き換えて保存する（他のタグは温存）。
   * setHostRole / setHostConnection で共通して使う。
   */
  private async patchHostTags(hostId: string, patch: Record<string, string | null>): Promise<void> {
    const hosts = await this.call<Array<{ hostid: string; tags?: Array<{ tag: string; value: string }> }>>(
      'host.get',
      { hostids: [hostId], output: ['hostid'], selectTags: ['tag', 'value'] },
    );
    const patchedNames = new Set(Object.keys(patch));
    const remainingTags = (hosts[0]?.tags ?? []).filter((t) => !patchedNames.has(t.tag));
    const newTags = Object.entries(patch)
      .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '')
      .map(([tag, value]) => ({ tag, value }));
    await this.call('host.update', {
      hostid: hostId,
      tags: [...remainingTags, ...newTags],
    });
  }

  /**
   * 機器の役割（トポロジー図の表示分類）をZabbixホストタグに保存する。
   * atlib_monthly_report.html（月次報告書）も同じ "role" タグを読むため、ここが唯一の書き込み口になる
   * （報告書側は読み取り専用。setup_discovery.py の notify_{code} と同じ単一責任の考え方）。
   * 呼び出し前に verifyHostOwnership で他顧客の機器でないことを確認しておくこと。
   */
  async setHostRole(hostId: string, role: string): Promise<void> {
    await this.patchHostTags(hostId, { role });
  }

  /**
   * LLDP非対応機器向けの手動接続情報（上位接続先ホスト名・ケーブル種別）をZabbixホストタグに保存する。
   * uplinkHostNameにnullを渡すとタグを削除する（LLDP自動検出に戻す）。setHostRoleと同じく、
   * atlib_monthly_report.html側は読み取り専用。呼び出し前にverifyHostOwnershipで所有権確認を行うこと。
   */
  async setHostConnection(
    hostId: string,
    params: { uplinkHostName: string | null; cableType: 'cat6' | 'cat5e' | 'wifi' },
  ): Promise<void> {
    await this.patchHostTags(hostId, { uplink: params.uplinkHostName, cableType: params.cableType });
  }
}

export interface ZabbixTopologyHost {
  hostid: string;
  name: string;
  ip: string;
  enabled: boolean;
  problems: Array<{ description: string; priority: string }>;
  lldpNeighbor: { name: string; port: string } | null;
  role: string;
  uplinkHostName: string | null;
  cableType: 'cat6' | 'cat5e' | 'wifi';
}
