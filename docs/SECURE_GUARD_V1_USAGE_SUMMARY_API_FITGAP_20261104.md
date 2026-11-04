# Secure Guard v1 | DNSFilter公式集計 API の Fit/Gap（2026-11-04）

対象: Draft PR #4（PR #3をbaseとする差分）。基準: `4d6ff027bba559d43e5db95298a396cc11733937`。
区分: 公開API仕様の確認＋既存PoC照合。**利用台数の実API結果は未取得。超過判定・通知は未有効。**

## 目的
DNSFilter公式管理画面を正本とする。Secure GuardはAPIに存在する数字・状態をそのまま表示/比較し、登録レコード数から別の「保護中台数」「課金対象台数」を生成しない。提供方式はRoaming Clientエージェントに限定。割当ライセンス数は公式GUIからMSP管理者が契約・変更時だけ手動転記する（PR #4の実装）。

## 現行PoC/実機で確定していること
- `GET /v1/user_agents?organization_ids=10220954` は Test02/Coreで**データ2レコード**、次ページなし。これは「一覧2件」の事実であり、Protected台数・課金対象台数・契約利用数の意味付けはしない。
- `GET /v1/metrics/organization_usage_detailed/{id}` は既存Test02/Core、Test03/PlusでHTTP200。しかし Test02 `user_count=1`、GUIの`Roaming Clients in Use=2`と異なる。`roaming_client_count`は出力空欄。**このメトリクスを利用台数として採用しない**。
- `GET /v1/organizations`・個別GETで`Allocated RC Licenses`は読み取れない。割当は公式GUIに従う、手動転記済みの参照値とする。
- 既存`src/services/dnsFilterInventoryClient.ts`にはAgent/Site一覧取得・MSP/Tenant整合が実装されている。新たなAgent台数の独自管理を行わない。

## 新たに見つかった公開公式API仕様（実環境未検証）
DNSFilter公開仕様を再配布する2026-07-13版OpenAPIの記述：
- `GET /v1/traffic_reports/total_roaming_clients?organization_id={id}`: Roaming Clients集計、レスポンススキーマ名`TrafficReportsTotalRoamingClients`。
- `GET /v1/traffic_reports/total_client_stats?organization_id={id}`: `total_roaming_clients`, `active_roaming_clients`等の集計値を返す。**公式の時間区間ベースのactive数と、GUIのProtected数／BillingのCurrent License Usageは同義と確定していない**。

参考:
- 公開API: https://api.dnsfilter.com/docs
- API仕様OpenAPI複製: https://apis.apievangelist.com/store/dnsfilter-traffic-reports-api/
- フィールド・Request: https://www.withone.ai/knowledge/dns-filter/conn_mod_def%3A%3AGKHfZ-_nCEk%3A%3A3tpKCDTcRzqYY8qzWY2khg
- DNSFilter公式Dashboard: https://help.dnsfilter.com/hc/en-us/articles/1500008108482-Customizable-Dashboard-widgets
- DNSFilter公式Agent画面: https://help.dnsfilter.com/hc/en-us/articles/1500008108422-Manage-Roaming-Client-settings

## 専用の一度きりの確認手順
- `scripts/secure-guard-usage-summary-readonly.ps1` は既存テストOrg `10220954` と `10222523` について上記2つのGETを実行するだけ。
- 表示はHTTP状態と集計項目のキーおよびスカラー数値のみ。Secret、Agent ID、端末名、API本文は出力しない。POST/PATCH/DELETEなし、データベース・設定・課金を変更しない。
- Test02のDNSFilter GUIで同時点に表示されるProtected数、Roaming Clients in Use、Current License Usageと、APIが返した**項目の意味を区別して照合**。APIが空/null/異なる集計定義なら、UNKNOWNとして超過通知を停止。
- 既存の`$spec = Invoke-RestMethod https://api.dnsfilter.com/docs/api.json`がある場合は当該pathsのGETレスポンスschemaをRead-onlyで照合してよいが、ベンダーAPIの変更があるため実応答が優先。

## Gate / 次の実装
- APIの確実な利用台数フィールドと対象Organizationスコープを確定できて初めて、PR #4の`compareConfirmedLicenseUsage`へ**そのAPI値だけ**を渡す。数値を推定・再集計して補わない。
- 過剰申告・通知漏れを防ぐため、`UNKNOWN`、0、未入力参照値は別扱い。
- 通知はMSP管理画面＋ユーザー指定のSecure Guard専用Slack Webhook（未指定、送信なし）。同じ超過の再通知・Job並行実行の多重送信防止は永続化し、独自課金エンジンは作らない。
- **本PRはGETとAPI形状確認に限定。** 新たな台数自動補正、Roaming Clientsの状態の独自判定、課金PATCH、本番ジョブ・Slack実送信は許可しない。

## 検証結果
- GitHub Actions Offline `npm test`: 51 PASS / 0 FAIL / 0 SKIP（Run 41784468379）。
- DNSFilter上の新規GETは未実行。APIアクセス権・具体的な数値・管理画面との一致は未確認。
