# Secure Guard 日常管理画面 — PoC Fit/Gap

## Adopted PoC contract

The server uses only these GET collection paths, with the DNSFilter Organization resolved from the authenticated Customer Membership on the server:

- `GET /v1/networks?organization_id={organization}`
- `GET /v1/user_agents?organization_ids={organization}`
- `GET /v1/user_agents?organization_ids={organization}&network_ids={site}`

It does not retrieve or interpret OpenAPI before the inventory request. It requires every Network and Agent record to declare the mapped Organization, reconciles Site-scoped Agents with the Organization-wide collection, rejects duplicate IDs and unsafe or scope-changing pagination, and never issues a non-GET request.

Each DNSFilter GET has an explicit eight-second AbortController timeout. Timeout and transport errors return the same safe unavailable result; the client contains no retry loop. The home calls only `GET /api/secure-guard/overview`, whose single Inventory result contains the summary, Sites, and Agents rendered on that screen.

## Display boundary

The authenticated Organization may view its Network name, Agent hostname and identifier, association, and the API-provided `status` / `agent_state`. The response intentionally contains no API key, authorization header, raw JSON, C2 receipt, GCS content, or inferred policy value. The current verified Network response evidence does not establish a safe policy display field, so Site `policy` is `null` and the UI says that no Policy information was provided by the API.

## Offline result

Synthetic fixtures cover multiple Sites and Agents, pagination acceptance and mixed `total_count` rejection, foreign-Organization rejection, upstream failure, collection reconciliation, Membership scope rejection, missing mapping rejection, and the existing Phase 1 and Zabbix route regression suite.

## Required before a real DNSFilter GET

No live DNSFilter request was made by this change. Before approval for a live GET, an operator must separately verify:

1. an active `dnsfilter_organization_mappings` record exists for the intended Customer Organization;
2. the portal runtime receives `DNSFILTER_API_KEY` only through its server-side secret-injection configuration; the browser must never receive it;
3. the deployed portal service is authorized to use that already-approved secret binding; and
4. the PoC collection shape and endpoint/query contract remain valid for the intended Organization.

This branch performs no migration, deployment, GCP, IAM, Secret, DNSFilter, or C2 operation.

## 2026-10-30 試用期間最終日 — DNSFilter API Fact 確定

### 根拠と分類

この節は、同日の GET 専用確認、既存 PoC／C2 の確定記録、および DNSFilter の公式 API・管理画面ドキュメントを突き合わせたものです。本文、API キー、Authorization、端末名、ID一覧、課金額は記録しない。

| 項目 | 結果 | 根拠の種類 | 結論 |
| --- | --- | --- | --- |
| MSP 所属 | `10222523` は MSP `11473` 配下 | 2026-10-30 API GET 実測 | 取込み候補は、必ず詳細 GET で所属を確認してから扱う。ID入力だけで登録しない。 |
| Subscription relationship | `10222523` は relationship が null、`plan_details` も null | 2026-10-30 API GET 実測 | API上で個別Subscriptionの確定情報は得られない。 |
| Billing | `/v1/billing?organization_id=10222523` は 200、実レコードなし | 2026-10-30 API GET 実測 | APIの「Billing応答が空」であることは、利用可能なCore／Plusプランの確定根拠にはならない。 |
| current_license | 文字列フィールドは返る | 2026-10-30 API GET 実測 | 値を課金契約済みの証拠として解釈しない。契約・課金は公式Billing画面または契約情報で確認する。 |
| Organization作成 | 公開仕様に `POST /v1/organizations` はある。既存PoCは `name` と `managed_by_msp_id` の作成要求を確認済み | 既存PoC／公式API仕様 | SKU・数量・契約期間の確定方法は未確認。管理画面からの本番作成は、課金設定の正規手順を統括が確認するまで停止する。 |
| Site（Network）作成 | 既存PoCでは通常の `POST /v1/networks` に `name`、Organization、Policy、Block Pageを指定し、作成後GETで所属・設定を確認 | 既存PoC実測 | Organization作成だけでは標準Site設定は完了しない。Site作成はPolicyとBlock Pageの確定値・作成後確認を一連で扱う。 |
| Policy／Block Page | Global Policy／Global Block PageをSiteへ明示割当する手順はPoCで確認済み | 既存PoC実測／公式管理画面資料 | 顧客に選択UIは提供しない。標準設定はatLIB運用者が明示して適用する。 |
| Agent照会 | Organization全体、及びSite別のGET・所属／集合照合は既存PoCとC2／Portal実装で確認済み | 既存PoC実測／実装済み試験 | 日常画面はGET専用のInventoryだけを使用する。端末数と課金対象数の同一性は未確認。 |
| Agent削除・解除 | 公開仕様には候補があるが、実運用での成功確認はない | 公式API仕様／未実測 | UIへ実装しない。解除・削除は個別の統括承認と実機検証の対象。 |
| ホワイトリスト | MSPのUniversal Allow／Block Listと、Organization Policyの例外は別の責務 | 公式管理画面資料 | MSP共通制御はDNSFilter公式MSP画面、顧客個別例外は対象OrganizationのPolicy運用で扱う。APIによる登録・解除は未実装・未実測。 |
| 解約・削除 | C2はDryRunの計画・監査保存のみ。Agent解除・Organization削除を実行しない | 既存C2 Canonical | C2を削除・課金終了の手段として扱わない。削除操作は未実装・未実証のまま停止する。 |

`10220954` は既存PoCの検証Organization、`10222523` は今回の新規HA Organizationである。いずれも製品コードの固定値や顧客スコープの根拠にしてはならない。

### API別 Fit/Gap と今回の実装判断

| API・運用領域 | Portalで実装する | 今回実装しない／理由 |
| --- | --- | --- |
| Inventory | Network、Organization全体Agent、Site別AgentのGET。8秒タイムアウト、再試行なし、所属・ページング・重複を検証 | なし。既存実装を維持する。 |
| Organization一覧・既存Organization取込み | MSP所属をサーバー側で確認して扱う | 未確認のIDを直接対応付ける経路。 |
| Organization新規作成 | UI・APIを「課金設定が別途確定済み」の運用候補としてのみ扱う | Core／Plus、SKU、数量、期間を推測したPOST。Subscription APIによるプラン設定。 |
| Site標準設定 | 確定済みのPolicy／Block Pageを運用値として明示した場合の作成後照合 | 顧客選択UI、未確認値の補完、設定未完了を成功扱いする復旧。 |
| Policy・ホワイトリスト | Policy／Global Policyの閲覧 | Allow／Blockの変更、Globalへの影響を伴う操作。 |
| Agent・ホスト | GETによる状態・Site照会 | 削除、解除、移動、再インストールを伴う操作。 |
| 解約 | C2のDryRun／監査を継続 | Organization削除、Agent解除、課金終了の自動化。 |

### 実環境で追加確認が必要な事項

1. DNSFilter公式Billing画面で、`10222523` に適用すべきCore／Plus、数量、契約期間、課金開始条件を確認する。公開MSP APIでのプラン設定は、現在の根拠だけでは採用できない。
2. 標準Site用のPolicyとBlock Pageを、対象Organization向けに明示してから作成する。作成成功後は所属・Policy・Block PageをGETで再確認する。
3. Agent登録数、保護済数、請求対象数の定義と差異をDNSFilterの契約・Billing画面で確認する。
4. 顧客別例外（ホワイトリスト）の責任者、対象Policy、監査・復旧手順を確定する。MSP Global／Universalの変更は顧客個別の例外と混同しない。
5. 解約時のDNSFilter課金停止・Organization削除・Site／Agent解除の正規手順を、C2とは別にDNSFilter側の正式運用として確認する。

### 追加確認用 PowerShell（GET専用、本文非出力）

次の手順は、正規の PowerShell セッションでのみ使用する。Secretはメモリにだけ保持し、応答本文を表示・保存しない。`Invoke-WebRequest` は GET を明示し、8秒で停止する。自動再試行は行わない。

```powershell
$ErrorActionPreference = 'Stop'
$apiKey = $null
try {
  $apiKey = gcloud secrets versions access 1 `
    --secret=secure-guard-dnsfilter-api-key --project=msp-zabbix
  $headers = @{ Authorization = "Bearer $apiKey"; Accept = 'application/json' }

  # Subscription構造: 対象を必要なOrganization IDへ明示して一回だけ確認する。
  $response = Invoke-WebRequest -Method GET `
    -Uri 'https://api.dnsfilter.com/v1/organizations/10222523?include_current_mrr=true' `
    -Headers $headers -TimeoutSec 8 -SkipHttpErrorCheck
  $body = if ($response.StatusCode -eq 200) { $response.Content | ConvertFrom-Json } else { $null }
  [pscustomobject]@{
    HttpStatus = [int]$response.StatusCode
    OrganizationMatches = ($null -ne $body -and [string]$body.data.id -eq '10222523')
    MspMatches = ($null -ne $body -and [string]$body.data.attributes.managed_by_msp_id -eq '11473')
    SubscriptionRelationIsNull = ($null -ne $body -and $null -eq $body.data.relationships.subscription.data)
    PlanDetailsIsNull = ($null -ne $body -and $null -eq $body.data.attributes.plan_details)
  }
} finally {
  Remove-Variable apiKey -ErrorAction SilentlyContinue
  Remove-Variable headers -ErrorAction SilentlyContinue
}
```

Site設定の確認は、Organizationの契約・標準Policy・Block Pageが確定してから、既存PoCと同じ通常GETに限定する。NetworkまたはAgentのID、hostname、Secret Key、レスポンス本文は記録しない。

### 次の一括改修範囲

次の改修は、課金・標準Site設定・例外運用の統括決定後に限定する。

1. Organization作成画面を、Billing確認済みの手動オンボーディング手順と明示的に結合する。
2. 標準PolicyとBlock Pageを、顧客入力ではなく承認済み運用値としてSite作成・read-back確認へ結合する。
3. 読み取り画面では、Agentの観測値と課金対象数を別概念として表示する。
4. 解約、Agent削除、Policy／Allow List変更はこの改修から除外し、個別の実機検証と安全契約を先に確定する。

今回の確認で実行したDNSFilter操作は GET のみであり、DB、IAM、Secret、Cloud Run、Production trafficへの変更はない。

## 2026-10-30 E2E統括 — 解約前ゲートとマルチテナントFit/Gap

### 確認したCanonicalの状態

| 範囲 | 状態 | 根拠・限界 |
| --- | --- | --- |
| Portal PR #3 | HEAD `9ddfd468274a6aec039f581080a07db35d216ee0`。作業ツリーclean | 実装・試験・Runbookの読取。今回、コード変更なし。 |
| 日常Inventory | 実機PASS | `10220954` に対するNetwork／Organization全体Agent／Site別AgentのGET、所属照合、Portal実API GETの過去記録。再実行しない。 |
| PortalのOrganization／Site作成 | モック・自動試験PASS、実機変更は未実施 | DNSFilter Management ClientはPOST候補を持つが、課金・標準設定の未確定により本番POSTは禁止を維持。 |
| Subscription／Billing | API応答構造は実測、Core／Plus設定方法は未確認 | 公開MSP APIで安全にプランを確定・変更する契約は得られていない。 |
| C2解約 | DryRun／監査計画は既存Canonicalに存在。Agent解除・Organization削除は未実装または最終承認待ち | 既存RunbookはUNKNOWN時の自動再送を禁止し、Organization DELETEを別途最終承認とする。今回、C2の再実行なし。 |
| 端末削除・解除 | 未検証・実行禁止 | 公式資料・旧Runbookに候補はあるが、実機での安全な成功・復旧は確定していない。 |

### `10222523`（HA Test Organization 03）の削除前Read-only結果

2026-10-30に本文非出力・8秒タイムアウト・再試行なしで実施したGET、および件数だけを返すPortal本番DBのSELECT結果を記録する。

| 確認項目 | 結果 | 判定 |
| --- | --- | --- |
| DNSFilter Organization | HTTP 200、対象ID・MSP `11473` 所属一致 | PASS |
| Subscription relationship | null | 課金終了や削除可否の根拠には不足 |
| Network（Site） | HTTP 200、0件、ページ終端は明示null | PASS（空であることのみ） |
| Organization全体Agent | HTTP 200、0件、ページ終端は明示null | PASS（空であることのみ） |
| Portal DNSFilter mapping | 1件。対応するCustomer Organizationはactive | **DELETE前に対応付けの扱いを決定する必要あり** |
| Portal Membership | active／pending／revokedとも0件 | 影響を受ける利用者がいないことの補助証拠。DB以外の外部契約・請求の不存在を意味しない。 |

この結果は「DNSFilterのOrganization削除を許可」するものではない。特に、Subscription relationshipがnullであること、Site／Agentが0件であること、Membershipが0件であることは、DNSFilter課金停止・データ消去・Portal側の対応付け解除を自動的に安全にしない。

### 削除E2Eの実行前ゲート

以下を全て満たすまで、DELETE、Site削除、Agent解除、Mapping無効化・削除を送信しない。

1. 対象Organization、MSP所属、全ページのSite／Agent／依存物が直前GETで再確認されている。
2. DNSFilterの正式DELETE契約（path、必須入力、成功・失敗応答、不可逆なデータ損失）を公式仕様または正式サポート回答で確認している。
3. Billing画面または契約担当により、削除と課金終了・クレジット・最低料金・翌月請求の関係が確認されている。
4. Portal mapping 1件の状態遷移、監査記録、失敗時の停止方法を、DNSFilter側の結果確定後に実施する順序として承認している。結果不明時は両側を自動再送・自動削除しない。
5. C2の実行対象、DryRun plan hash、永続監査、UNKNOWN時の人手照合を、実際に配置済みのC2 Source／Image／Runbookと対応付けて確認している。
6. 削除対象・影響範囲・最大送信回数1回・復旧不能性を含む最終パッケージを統括へ提示し、DELETE直前に明示承認を得ている。

現在は1の一部だけが確認済みであり、2〜6が未完了であるため、削除E2Eは **STOP** とする。

### マルチテナントHAの確認結果

| 境界 | 実装・試験状態 |
| --- | --- |
| MSP全体管理者 | 有効な個人Identityと独立した`msp_admin` Grantが必要。Customer Membershipからの暗黙昇格は拒否する。 |
| Customer Role | `org_admin`、`operator`、`viewer`をCustomer Membershipに保持。MSP Grantとは別テーブル・別検証。 |
| 顧客越境拒否 | ブラウザ入力のCustomer／DNSFilter IDを認可根拠にせず、認証Identityと有効Membershipからサーバー側でScopeを解決する。試験あり。 |
| 招待・失効 | 初期管理者の競合防止、最終`org_admin`失効防止、Membership失効拒否、監査記録を実装・自動試験済み。 |
| 監査 | Organization、Membership、provisioning回復操作を`secure_guard_audit_events`へ記録する実装。DNSFilter本文・APIキー・Tokenは記録しない。 |
| API結果不明 | Organization作成結果不明は`DNSFILTER_CREATE_OUTCOME_UNKNOWN`として停止し、勝手な再POSTをしない。C2のUNKNOWNも同じく自動再送しない。 |

### 安全なPowerShell削除前確認（GET専用）

この確認は削除コマンドではない。実行する場合、正規のPowerShellセッションで1回だけ実行し、応答本文・Secret・Site／Agent IDを表示・保存しない。

```powershell
$ErrorActionPreference = 'Stop'
$apiKey = $null
try {
  $apiKey = gcloud secrets versions access 1 `
    --secret=secure-guard-dnsfilter-api-key --project=msp-zabbix
  $headers = @{ Authorization = "Bearer $apiKey"; Accept = 'application/json' }
  $checks = @(
    @{ Name = 'Organization'; Uri = 'https://api.dnsfilter.com/v1/organizations/10222523?include_current_mrr=true' },
    @{ Name = 'Networks'; Uri = 'https://api.dnsfilter.com/v1/networks?organization_id=10222523' },
    @{ Name = 'Agents'; Uri = 'https://api.dnsfilter.com/v1/user_agents?organization_ids=10222523' }
  )
  foreach ($check in $checks) {
    $response = Invoke-WebRequest -Method GET -Uri $check.Uri `
      -Headers $headers -TimeoutSec 8 -SkipHttpErrorCheck
    $body = if ($response.StatusCode -eq 200) { $response.Content | ConvertFrom-Json } else { $null }
    [pscustomobject]@{
      Endpoint = $check.Name
      HttpStatus = [int]$response.StatusCode
      RecordCount = if ($null -eq $body) { $null } elseif ($body.data -is [array]) { @($body.data).Count } else { 1 }
      NextIsNull = ($null -ne $body -and $null -eq $body.links.next)
    }
  }
} finally {
  Remove-Variable apiKey -ErrorAction SilentlyContinue
  Remove-Variable headers -ErrorAction SilentlyContinue
}
```

### 一括改修の対象と除外

次の改修対象は、標準Policy／Block PageをSite作成時に運用固定値として適用し、作成後GETで確認する部分に限定する。顧客向けのPolicy変更画面、Agent削除、Organization削除、Subscription変更、Universal Allow／Block List変更は含めない。これら低頻度・特権操作は、公式DNSFilter画面と承認済み手順を使う。

今回の追加調査で行ったDNSFilter操作は GET 3回、本番DB操作はSELECT 1回のみである。DNSFilter変更、DB変更、IAM・Secret変更、Cloud Run操作、Production traffic変更は0件。


## 2026-10-30｜Windows Agent削除API 実機E2E結果・暫定運用手順

> この節は2026-10-30の**後続実機検証結果**。上記の「端末削除・解除は未検証」という2026-10-30初期Fit/Gapの記述を更新する。Organization削除E2Eは引き続き別扱いであり、完了を意味しない。

### 検証対象と根拠

- MSP: 11473、Test Organization 02: 10220954、Windows端末: atl20260003、Agent UUID: 2a7659c5-68ec-4704-850f-e0f65347b2ee。
- 実行前のAPI GET: 1件、active/protected、nextページなし。WindowsのDNSFilter AgentおよびService ManagerはRunning、Wi-Fi DNSは127.0.0.2。MSI再入手可能。
- DNSFilter公式OpenAPIの \`DELETE /v1/user_agents/{id}\` は「Soft deletes an user agent.」。任意query \`queue_uninstall\` は「Uninstall user agent」、\`clear_registry\` は「Clear registry when uninstalling user agent」。成功応答に204を定義。GUIの「Delete」「Delete & Uninstall」とAPIの厳密な内部呼出対応までは実測していない。

### ケースA：リモートアンインストール＋削除（実機PASS）

- 実行: \`DELETE /v1/user_agents/2a7659c5-68ec-4704-850f-e0f65347b2ee?queue_uninstall=true\`、HTTP 204。
- Windows「プログラムと機能」からDNSFilter Agentが消失。DNSFilter Roaming Clients一覧から対象消失。
- Wi-Fi DNSが127.0.0.2から192.168.0.1へ復帰し、\`Resolve-DnsName www.microsoft.com -DnsOnly\` が成功。
- 本人がアンインストール完了を確認してからMSIで再インストール。再登録GETは同一Agent UUID、active/protected。UUIDが同一となる識別アルゴリズム（MAC等）は未確認であり推測しない。
- 適用範囲: 今回のオンラインWindows端末1台。オフライン端末・他OS・他Agent versionでの同一挙動は未確認。

### ケースB：登録のみSoft Delete（通信障害を実測）

- 再登録後、同一Agent UUIDに対して \`DELETE /v1/user_agents/{id}\`（\`queue_uninstall\` なし）を実施。今回の実行HTTPコードは共有記録にないため記載しない。
- DNSFilter Roaming Clients一覧から対象消失。一方WindowsのDNSFilter Agent／Service ManagerはRunning、Wi-Fi DNSは127.0.0.2のまま。
- 利用者がインターネットサイトへ接続できなくなったと報告。手動アンインストールで復旧した。内部的なDNS障害原因までは未解析。
- **判断:** 通常の顧客向け端末撤去でSoft Deleteを使用しない。既に端末側アンインストールが済んだ残存登録の整理など例外用途は、対象状態と通信影響を確認したうえで別途運用判断する。

### 暫定運用手順（技術 × 運用 × 管理）

1. **技術:** 通常の端末撤去は、対象Organization・Agent UUID・Hostnameの所属を照合し、正式APIの \`queue_uninstall=true\` を1回要求する。HTTP 204は受付であり端末側完了の保証ではない。結果不明時は再送しない。
2. **運用:** 顧客へ事前に撤去手順と通信影響を案内する。解約時は契約期間内に撤去期間（例: 7日、未確定）を設け、未完了端末には手動アンインストールを案内する。単純Soft Deleteは通常の撤去手順として案内しない。
3. **管理:** 対象テナント、実行者、要求時刻、受付結果、端末側完了/未完了、残存端末、顧客への案内を記録する。顧客Role・越境防止・監査・UNKNOWN安全停止は既存Contractを維持する。
4. **通信障害時:** 端末側のDNSFilter Agent残存とDNS設定を確認し、承認済みの手動アンインストール・DNS復元手順で復旧する。今回の手動アンインストールによる復旧は実機PASS。
5. **課金:** Agent登録削除と割当ライセンス減少・課金停止は同義ではない。仕入請求の実績照合は請求開始後に実施する方針。課金停止条件を推測で確定しない。

### 保留・別工程

- Pending Uninstall中にSoft Deleteした場合、キューが維持されるかは**未検証**。必要性を運用上評価してから追加E2Eを判断する。
- Site／Organization削除、依存物の順序、Portal mappingと権限失効、課金停止のE2Eは**未完了**。既存C2/PR #44の安全ゲート・別承認を維持。
- 顧客管理画面の「アンインストール＆削除」実装・HAは未完了。端末登録のみ削除を通常UIに公開しない。
- この記録追加は文書更新のみ。DNSFilter／Cloud Run／DB／IAM／Secret／本番トラフィックの変更を伴わない。
