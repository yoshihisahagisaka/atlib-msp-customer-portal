# Secure Guard v1 | DNSFilter公式集計 API の Fit/Gap（2026-11-04）

対象: Draft PR #4（PR #3をbaseとする差分）。基準: `4d6ff027bba559d43e5db95298a396cc11733937`。
区分: 公開API仕様の確認＋既存PoC照合。**最新GUI定義に基づく実API再照合は未実施。超過判定・通知は未有効。**

## 確定スコープ（2026-11-04 最終判断）

**Secure Guard管理システムの目的はライセンス利用監視と超過時の対応管理のみ。** 以前の「割当数からDNSFilter支払額、利用数から顧客請求額を計算する」という検討は本システムの仕様から撤回する。請求書・金額集計・単価・課金履歴・独自請求基盤は実装しない。DNSFilter仕入金額は公式Billing画面で確認する。

- 公式GET `GET /v1/metrics/organization_usage_detailed/{id}` から `allocated_roaming_clients` と `roaming_clients_in_use` のみを使って超過判定する。
- `roaming_clients_in_use > allocated_roaming_clients` のときMSP管理画面にアラートを表示し、Secure Guard専用Slackに通知する。
- atLIBが顧客へ「不要端末を整理する」か「割当ライセンス数を増やす」かを確認する。いずれも自動実行しない。
- 同一超過で毎回Slackを連投しないように最小限の状態・通知結果を記録。対応中・解消を管理する。
- 運用開始前に専用Slack通知先をユーザーから取得する。本番配信・Scheduler・DB migration・DNSFilter変更系APIは別途Go/No-Go。
- 従前の手動割当スナップショットは公式API一致確認により不要となり、Draft PR #4からMigration 014・入力API・画面・テストを撤去した。環境での適用歴はread-onlyで事前確認する。

この項目を本ドキュメントの最新Canonical判断とし、以下にある請求数量計算案の記載より優先する。

## 目的
DNSFilter公式管理画面を正本とする。Secure GuardはAPIに存在する数字・状態をそのまま表示/比較し、登録レコード数から別の「保護中台数」「課金対象台数」を生成しない。提供方式はRoaming Clientエージェントに限定。割当ライセンス数は実機GUIと一致した公式APIの allocated_roaming_clients を採用する。旧手動転記は後述の調査時点の履歴であり現行設計ではない。

## 2026-11-04 管理画面説明との対応（ユーザー提示の画面）

- `Roaming Clients in Use = 2`：Roaming Client方式のライセンス使用数。今回のSecure Guard（エージェント方式のみ）の超過監視の対象候補。
- `Network Licenses in Use = 0`：エージェント以外のDNSトラフィックについて、1日10,000クエリを1ライセンスとして換算。今回の超過監視対象外。
- `Current License Usage = 2`：Roaming Clients と Network Licenses の合計。今回の超過判定にはそのまま採用しない。
- DNSFilter公式説明では Roaming Clients In Use に**非アクティブ・古いエージェントが含まれる場合がある**。リアルタイムのProtected数やDNSFilter確定請求数量と混同しない。
  - https://help.dnsfilter.com/hc/en-us/articles/4991568454035-Pricing-license-types
  - https://help.dnsfilter.com/hc/en-us/articles/43809316077715-Sales-managed-MSP-subscription-management

## 2026-11-04 再実測：GUIとの照合

ユーザーが公式管理画面で確認し、既存Read-onlyスクリプト（UTC 2026-10-28〜11-04）を実行した結果：

| 項目 | Test02 Core (10220954) | Test03 Plus (10222523) |
| --- | ---: | ---: |
| GUI Allocated Licenses 入力値 | **0** | 1 |
| API `allocated_roaming_clients` | **1** | 1 |
| GUI Roaming Clients in Use | 2 | 0 |
| API `roaming_clients_in_use` | 2 | 0 |
| `organization_usage_detailed` HTTP | 200 | 200 |
| `total_client_stats` HTTP | 400 | 400 |

判定：
- **利用数のGUI/API照合はPASS**（2件）。現行Roaming Client方式の監視に利用する候補は `roaming_clients_in_use`。
- **割当数のGUI/API照合はTest02でFAIL**（GUI 0、API 1）。`allocated_roaming_clients` を割当参照値へ自動採用・補正しない。既存のMSP管理者によるGUI値手動転記を維持する。
- 画面の0が保存済みか、保存・再読込後も0かは未確認。DNSFilter公式文書では既存Organizationの初期割当1、過去ベンダー回答（atlib-corporate-site PR #44）では最低1ライセンスの記録があり、この差の原因は未確定。
- この不一致がある間は、API割当数を利用した超過通知・請求・自動補正を禁止。定期実行・Slack実送信は従前どおり無効。
- `total_client_stats` は今回両Orgで400。採用対象外。再試行を繰り返さない。

## 2026-11-04 最終再照合・数量計算の新決定

ユーザーが公式GUIで **Test02の割当を1、Test03の割当を3** に設定した後、同一Read-onlyスクリプトで再実測：

| フィールド | Test02 Core (10220954) | Test03 Plus (10222523) |
| --- | ---: | ---: |
| GUI Allocated RC Licenses | 1 | 3 |
| API `allocated_roaming_clients` | **1** | **3** |
| GUI Roaming Clients in Use | 2 | 0 |
| API `roaming_clients_in_use` | **2** | **0** |
| API `user_count`（監視・数量算定には不使用） | 1 | 3 |

**現在の2 Organizationでは割当・利用の両方ともGUI/API一致。** Test02の以前のGUI「0」表示が未保存か反映差かは未確定だが、現在の同期PASSは実測で確認した。探索中の `total_client_stats` は両Organizationで400のため不採用。

### 当日途中の数量計算検討（最新判断で撤回済み・履歴保存）

- **DNSFilter仕入・支払数量：`allocated_roaming_clients`**。
- **旧検討**：atLIB顧客請求の従量数量への転用案は撤回。請求額・数量の算定は本システムの対象外。
- **超過監視：利用数量 − 割当数量**（正数の場合に超過）。エージェント方式だけを対象にし、Network Licenses・`Current License Usage`・`user_count` は対象外。
- API値は**取得時点の値**。請求確定前に、対象月の数量採用ルール（基準日・変更履歴・増減時日割・休眠Agent整理等）を契約/請求管理レーンで別途確定する。今回のPRは請求書生成・価格計算・請求確定を行わない。
- 旧手動スナップショットはDraftから撤去。監視判定は同一レスポンスの公式2項目のみで行い、API取得失敗時に手動値で成功を偽装しない。

### PR #4の実装境界

- `DnsFilterRoamingUsageClient`：公式 `organization_usage_detailed` の**GETのみ**。Organization ID、応答形状、非負整数の割当/利用数を検証。未知形状・他Organization・非200はfail-closed。
- MSP管理者限定のオンデマンド表示と純粋比較ロジックへの接続。登録Agent一覧からの数え直しなし。
- GitHub ActionsのTypeScriptビルド・55テスト PASS / 0 FAIL（Run 41789507485）。
- **未実施**：本番API接続、DB Migration、定期ジョブ、超過イベント永続化・重複排除、Slack実送信、請求算定。Draft維持。

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
