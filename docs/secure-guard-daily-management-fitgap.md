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
