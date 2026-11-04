# Secure Guard v1 | DNSFilter公式集計 API の Fit/Gap（2026-11-04）

対象: Draft PR #4（PR #3をbaseとする差分）。基準: `4d6ff027bba559d43e5db95298a396cc11733937`。
区分: 公開API仕様の確認＋既存PoC照合。**最新GUI定義に基づく実API再照合は未実施。超過判定・通知は未有効。**

## 目的
DNSFilter公式管理画面を正本とする。Secure GuardはAPIに存在する数字・状態をそのまま表示/比較し、登録レコード数から別の「保護中台数」「課金対象台数」を生成しない。提供方式はRoaming Clientエージェントに限定。割当ライセンス数は公式GUIからMSP管理者が契約・変更時だけ手動転記する（PR #4の実装）。

## 2026-11-04 管理画面説明との対応（ユーザー提示の画面）

- `Roaming Clients in Use = 2`：Roaming Client方式のライセンス使用数。今回のSecure Guard（エージェント方式のみ）の超過監視の対象候補。
- `Network Licenses in Use = 0`：エージェント以外のDNSトラフィックについて、1日10,000クエリを1ライセンスとして換算。今回の超過監視対象外。
- `Current License Usage = 2`：Roaming Clients と Network Licenses の合計。今回の超過判定にはそのまま採用しない。
- DNSFilter公式説明では Roaming Clients In Use に**非アクティブ・古いエージェントが含まれる場合がある**。リアルタイムのProtected数やDNSFilter確定請求数量と混同しない。
  - https://help.dnsfilter.com/hc/en-us/articles/4991568454035-Pricing-license-types
  - https://help.dnsfilter.com/hc/en-us/articles/43809316077715-Sales-managed-MSP-subscription-management

## 現行PoC/実機で確定していること
- `GET /v1/user_agents?organization_ids=10220954` は Test02/Coreで**データ2レコード**、次ページなし。これは「一覧2件」の事実であり、Protected台数・課金対象台数・契約利用数の意味付けはしない。
- 既存Issue #36の2026-10-18実機GETでは、`GET /v1/metrics/organization_usage_detailed/{id}` の **`roaming_clients_in_use=2`、`network_traffic_in_use=0`** が、当時のGUI表示（2、0）と一致した。`allocated_roaming_clients=1`、`user_count=1`は別の意味の値。
- 一方、直近のFit/Gapでは**`roaming_client_count`という別名のフィールド**を参照して空欄と判断していた。`roaming_clients_in_use`と同一フィールドではないため、この空欄だけで既存PoCのPASSを否定できない。
- ただし、`roaming_clients_in_use`が現在も取得でき、GUIと同じ意味・更新タイミングかは改めてRead-onlyで照合する。**この段階では自動監視に採用しない**。
- `GET /v1/organizations`・個別GETで`Allocated RC Licenses`は読み取れない。割当は公式GUIに従う、手動転記済みの参照値とする。
- 既存`src/services/dnsFilterInventoryClient.ts`にはAgent/Site一覧取得・MSP/Tenant整合が実装されている。新たなAgent台数の独自管理を行わない。

## 新たに見つかった公開公式API仕様（実環境未検証）
DNSFilter公開仕様を再配布する2026-07-13版OpenAPIの記述：
- `GET /v1/traffic_reports/total_roaming_clients?organization_id={id}`: OSごとの導入数集計（`values[].os` と `values[].value`）であり、**Protected状態や課金対象数ではないため今回の超過監視には採用しない**。
- `GET /v1/traffic_reports/total_client_stats?organization_id={id}`: `total_roaming_clients`, `active_roaming_clients`等の集計値を返す。**公式の時間区間ベースのactive数と、GUIのProtected数／BillingのCurrent License Usageは同義と確定していない**。

参考:
- 公開API: https://api.dnsfilter.com/docs
- API仕様OpenAPI複製: https://apis.apievangelist.com/store/dnsfilter-traffic-reports-api/
- フィールド・Request: https://www.withone.ai/knowledge/dns-filter/conn_mod_def%3A%3AGKHfZ-_nCEk%3A%3A3tpKCDTcRzqYY8qzWY2khg
- OS別導入数集計（監視対象外）: https://www.withone.ai/knowledge/dns-filter/conn_mod_def%3A%3AGKHfZNJTW4A%3A%3AfPSIu5FOTRWtpB4D2exPLw
- DNSFilter公式Dashboard: https://help.dnsfilter.com/hc/en-us/articles/1500008108482-Customizable-Dashboard-widgets
- DNSFilter公式Agent画面: https://help.dnsfilter.com/hc/en-us/articles/1500008108422-Manage-Roaming-Client-settings

## 専用の一度きりの確認手順
- `scripts/secure-guard-usage-summary-readonly.ps1` は既存テストOrg `10220954` と `10222523` について、**`GET /v1/metrics/organization_usage_detailed/{id}`（UTC直近7日）と `GET /v1/traffic_reports/total_client_stats`** を実行する。OS別導入数を返す `total_roaming_clients` APIは対象外とする。
- 表示はHTTP状態と集計項目のキーおよびスカラー数値のみ。Secret、Agent ID、端末名、API本文は出力しない。POST/PATCH/DELETEなし、データベース・設定・課金を変更しない。
- Test02のDNSFilter GUIで同時点に表示される **Roaming Clients in Use** と、API `roaming_clients_in_use` を優先照合する。別途 `total_roaming_clients`、`active_roaming_clients` が返った場合も項目の意味を区別し、Protected台数として自動採用しない。APIが空/null/異なる集計定義なら、UNKNOWNとして超過通知を停止。
- 既存の`$spec = Invoke-RestMethod https://api.dnsfilter.com/docs/api.json`がある場合は当該pathsのGETレスポンスschemaをRead-onlyで照合してよいが、ベンダーAPIの変更があるため実応答が優先。

## Gate / 次の実装
- 取得フィールド・Organizationスコープ・GUI表示との一致を確認できたら、Roaming Client方式に限定してPR #4の`compareConfirmedLicenseUsage`へ **`roaming_clients_in_use`だけ**を渡す。公式APIが変わった場合は再度Gateを設け、数値を推定・再集計して補わない。
- 過剰申告・通知漏れを防ぐため、`UNKNOWN`、0、未入力参照値は別扱い。
- 通知はMSP管理画面＋ユーザー指定のSecure Guard専用Slack Webhook（未指定、送信なし）。同じ超過の再通知・Job並行実行の多重送信防止は永続化し、独自課金エンジンは作らない。
- **本PRはGETとAPI形状確認に限定。** 新たな台数自動補正、Roaming Clientsの状態の独自判定、課金PATCH、本番ジョブ・Slack実送信は許可しない。

## 検証結果
- GitHub Actions Offline `npm test`: 51 PASS / 0 FAIL / 0 SKIP（Run 41784468379）。
- 2026-10-18のIssue #36に過去GETの実測（`roaming_clients_in_use=2`）あり。今回追加した直近7日GETは未実行。現行レスポンスと管理画面の再一致、APIアクセス権、更新タイミングは未確認。
