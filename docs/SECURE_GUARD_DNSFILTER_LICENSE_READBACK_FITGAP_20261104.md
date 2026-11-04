# Secure Guard｜DNSFilterライセンス数取得 Read-only Fit/Gap

日付: 2026-11-04
対象: PR #3 `feature/secure-guard-daily-management`
区分: 公開資料調査＋現行コード確認。**API実測・課金更新・実装HAは未実施**。
優先: `DECISION_SECURE_GUARD_DNSFILTER_API_BILLING_UPDATE_20261104.md`, `SECURE_GUARD_V1_ORG_PROVISIONING_SKU_QUANTITY_CONTRACT_20261104.md`

## 確認済みの出所と事実
1. DNSFilter公式「Pricing license types」（2026-08-17更新）: Roaming Client 1端末=1ライセンス。ネットワーク利用は1日10,000クエリ当たり1ライセンスの別計数。利用台数表示は古いエージェントを含み得る。
   https://help.dnsfilter.com/hc/en-us/articles/4991568454035-Pricing-license-types
2. DNSFilter公式「Self-service MSP subscription management」（2026-10-01更新）: Organizationの契約プランと数量はMSPへの請求に反映。変更は即時、日割り精算。
   https://help.dnsfilter.com/hc/en-us/articles/1500008111561-Self-service-MSP-subscription-management
3. DNSFilter公式「Sales-managed MSP subscription management」（2026-10-01更新）にはSelf-serviceと異なる請求取扱いが記載される。**atLIB固有のベンダー回答とSelf-service契約が優先**。Sales-managedの記事を混ぜて請求仕様を確定しない。
   https://help.dnsfilter.com/hc/en-us/articles/43809316077715-Sales-managed-MSP-subscription-management
4. 公開OpenAPIのメトリクス仕様（2026-07-13版、再配布）: `GET /v1/metrics/organization_usage/{id}` は期間指定`from`,`to`必須で`user_count`を返すが`roaming_client_count`は未定義。一方、`GET /v1/metrics/organization_usage_detailed/{id}` は期間指定任意で`roaming_client_count`,`mobile_roaming_client_count`,`user_count`,`wifi_count`,`plan`,`term`を返すschema。**実測で該当Organizationの値を確認するまで利用台数に採用しない**。
   https://apis.io/apis/dnsfilter/dnsfilter-metrics-api/
5. 公開OpenAPI `GET /v1/billing?organization_id={id}` はStripeの支払方法情報(`PaymentMethod`)の取得であり、ライセンス割当数取得の手段ではない。支払方法・個人情報のため本調査では呼ばない。
   https://apis.io/apis/dnsfilter/dnsfilter-billings-api/
6. ユーザー実測: MSP 11473配下のCore Test02=10220954、Plus Test03=10222523。`GET /v1/organizations` と個別GETでは`sku`,`quantity`を取得できず。Distributor専用`GET /v1/distributors/skus_available`はHTTP404。DNSFilterは正式SKU値を後送予定。
7. DNSFilter担当者回答: `POST/PATCH /v1/organizations` でSKU・割当ライセンス数量を更新できる。ただし現在割当数の読取APIは未回答。これは**書き込み可能≠自動整合可能**を意味する。

## 現行コードFit/Gap
- `src/services/dnsFilterInventoryClient.ts` は既にOrganization内の全SiteのAgentをページングGETし、一致検証するfail-closed在庫機能を持つ。しかしAgentの単純行数はDNSFilterの課金カウントと同義とは限らない。オフライン・削除済み・同一端末再インストール等のカウント規則を別途確認。
- `src/services/dnsFilterManagementClient.ts` にはOrg一覧/個別GET/作成があるが、契約上限とSKU/quantity更新・割当数のread-backは未実装。
- 現行Org GETの返却属性が利用者の実環境ではSKU/割当を含まなかった。名前等を使って数量を推定しない。
- Distributor専用`subscribed_quantity`は別の認証方式が必要。MSP APIキーの代理として使う設計にしない。

## 次のRead-only HA（既存テストOrgのみ）
1. `scripts/secure-guard-license-readonly-probe.ps1` はDNSFilterの`GET /v1/metrics/organization_usage_detailed/{id}`を、Test02とTest03のみに各1回実行し、選択した数値・フィールド名だけ出力。Secretの表示・POST/PATCH/DELETEなし。
2. **実測結果**: Test02はHTTP200だが`roaming_client_count`空欄／`user_count=1`でGUIの2台と一致しない。メトリクスを直ちにUとして採用しない。既存Agent Inventoryの組織全件数とGUIの`Roaming Clients in Use=2`を照合する。
3. API失敗時はエラーHTTPコードのみ表示し、別経路・再認証・権限拡大を自動で試行しない。
4. **割当数量Qは依然取得不能**ならVendorへ「Core/Plusにおける各OrgのAllocated RC Licensesのread-only API/公式方法」「PATCH後のread-back手段」「未導入0台時の最低有料割当（GUIには0表示例あり）」を確認。正式手段が得られるまで自動PATCHしない。

## 実機追加結果（2026-11-04、ユーザー実行）
- 対象は既存Test02/Core ID `10220954` とTest03/Plus ID `10222523`。どちらも `GET /v1/metrics/organization_usage_detailed/{id}` はHTTP200。
- Test02: `plan=basic`, `user_count=1`, `wifi_count=0`, `term=not_applicable`。Test03: `plan=plus`, `user_count=1`, `wifi_count=0`, `term=not_applicable`。
- 両方とも `roaming_client_count` と `mobile_roaming_client_count` は**PowerShell出力空欄**。現行診断コードは「属性欠落」と「JSON null」を区別しないため、今の情報ではどちらか未確定。**0台に変換しない**。
- GUI上でTest02のRoaming Clients in Useは2台とユーザーが確認済み。したがって、返された`user_count=1`を実登録端末数として採用することは**否決**。
- プラン名称の読取は`basic=Core`, `plus=Plus`の実測対応を得たが、POST/PATCHに渡す正式`sku`の値と同一とは断定しない。
- **今後のUの第一候補は既存`DnsFilterInventoryClient.getInventory`が組織スコープ・ページング・Site横断一致を検証した`agents`の件数**。DNSFilter公式ドキュメントでは「Roaming Clients in Use」は当該アカウントに関連付けられた全Agentの数。GUIのTest02 2台と当該件数を照合し、stale/offline/queue-uninstallの扱いに注意する。ネットワーク経由の利用分は別途課金基準を確認する。
- **割当ライセンス数Qのread-backは引き続き未確認**。既存Org GETでは返されないため、自動PATCHは未承認・未実装とする。
- 根拠: ユーザー実機出力、DNSFilter公式「Pricing license types」https://help.dnsfilter.com/hc/en-us/articles/4991568454035-Pricing-license-types 。

## 後続実装ゲート
- 実利用Uの意味と現在割当Qの検証手段がそろうまで、自動ライセンス増減を本番ONにしない。
- 顧客の契約上限C以上への自動割当を禁止し、U>Cは顧客へ通知し是正。契約開始時にCを先取り割当しない。
- 端末課金はDNSFilter側の有効な契約要件に従う。日々の手動作業は通常運用としない。
- 変更時の結果不明・重複更新・監査・MSP所属・顧客越境防止を既存契約で検証する。

実行していないこと: DNSFilter書込、APIキー公開、Organization作成・変更、DB migration、デプロイ。
