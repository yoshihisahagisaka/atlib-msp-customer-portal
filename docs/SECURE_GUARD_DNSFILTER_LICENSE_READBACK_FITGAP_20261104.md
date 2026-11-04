# Secure Guard｜DNSFilterライセンス数取得 Read-only Fit/Gap

日付: 2026-11-04
対象: PR #3 `feature/secure-guard-daily-management`
区分: 公開資料調査＋現行コード確認＋ユーザー実機Read-only GET。**課金更新・アプリ内E2E・実装HAは未実施**。
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
2. **実測結果**: Test02はHTTP200だが`roaming_client_count`空欄／`user_count=1`でGUIの2台と一致しない。メトリクスを直ちにUとして採用しない。次に`GET /v1/user_agents?organization_ids=10220954`で2件・次ページなしを確認し、GUIの`Roaming Clients in Use=2`と一致した。
3. API失敗時はエラーHTTPコードのみ表示し、別経路・再認証・権限拡大を自動で試行しない。
4. **割当数量Qは依然取得不能**ならVendorへ「Core/Plusにおける各OrgのAllocated RC Licensesのread-only API/公式方法」「PATCH後のread-back手段」「未導入0台時の最低有料割当（GUIには0表示例あり）」を確認。正式手段が得られるまで自動PATCHしない。

## 実機追加結果（2026-11-04、ユーザー実行）
- 対象は既存Test02/Core ID `10220954` とTest03/Plus ID `10222523`。どちらも `GET /v1/metrics/organization_usage_detailed/{id}` はHTTP200。
- Test02: `plan=basic`, `user_count=1`, `wifi_count=0`, `term=not_applicable`。Test03: `plan=plus`, `user_count=1`, `wifi_count=0`, `term=not_applicable`。
- 両方とも `roaming_client_count` と `mobile_roaming_client_count` は**PowerShell出力空欄**。現行診断コードは「属性欠落」と「JSON null」を区別しないため、今の情報ではどちらか未確定。**0台に変換しない**。
- GUI上でTest02のRoaming Clients in Useは2台とユーザーが確認済み。したがって、返された`user_count=1`を実登録端末数として採用することは**否決**。
- プラン名称の読取は`basic=Core`, `plus=Plus`の実測対応を得たが、POST/PATCHに渡す正式`sku`の値と同一とは断定しない。
- **U（Roaming Client実登録数）の取得候補を実機で照合済み**: Test02 ID `10220954` に対する `GET /v1/user_agents?organization_ids=10220954` は `data` が**2件**、`links.next`はnull。GUI `Roaming Clients in Use=2` と一致。既存`DnsFilterInventoryClient.getInventory`は組織スコープ、全Site、ページング、整合性検証を持ち、これを実装上のU_RC取得経路として再利用する。ただし**直接の単発GETの一致は確認したが、アプリ内の同機能の実環境E2E・オフライン/古い/削除済みAgentの課金カウントは未検証**。ネットワーク経由の利用分は別途計数する。
- **割当ライセンス数Qのread-backは引き続き未確認**。既存Org GETでは返されないため、自動PATCHは未承認・未実装とする。
- 根拠: ユーザー実機出力、DNSFilter公式「Pricing license types」https://help.dnsfilter.com/hc/en-us/articles/4991568454035-Pricing-license-types 。


## GUIのAllocated/Current Usage説明（2026-11-04）
- ユーザー提示のSubscriptions画面: Test02/Coreは**Allocated RC Licenses=0、Roaming Clients in Use=2、Network Licenses in Use=0、Current License Usage=2、Cost=$0.00/mo**。Test03/Plusは割当1、実使用0、Cost=$2.00/mo。親MSPはNFR 25席、課金$0.00。
- `Current License Usage`のtooltipは「The total licenses recommended based on actual usage (Roaming Clients + Network Traffic). This may impact your DNSFilter billing.」。したがって`Current License Usage`はAgent件数単独とは定義できず、ネットワーク経由のライセンスも含む推奨値。Test02はネットワーク利用0なのでAgent2件と総利用2件が一致する。
- GUIの`Cost=$0.00/mo`は表示値であって最終Invoiceでの課金0や、割当0での継続契約適法性を確定する証拠ではない。DNSFilter公式回答の「アクティブOrganization最低1ライセンス」とGUIの0表示には不一致あり。変更が確定保存された状態かも未確認。
- 結論: U_RCの候補取得経路は確認できたが、Q（割当数）はAPI取得不可のまま。**U_RCはQではない**。自動変更の有効化はQ read-back正式経路が確定するまで保留。

## 統括訂正：課金/運用の正本は「保護状態にある端末数」、Agentレコード数ではない（2026-11-04）
- **当初からの承認済み方針**: Secure Guardが扱うのはDNSFilter Roaming Client（エージェント）による端末保護のみ。IP/DNS Network経由のサービス・ライセンスは**提供対象外**であり、その管理機能・見積もり・課金ロジックを追加しない。
- **管理画面の端末保護状態を正本**とし、顧客に対する利用台数管理の基準は**保護状態にある端末数P**。単純なAgent登録件数 `agents.length` やGUI `Roaming Clients in Use` の件数を無条件にPと見なさない。過去の「Agent件数が2で一致＝利用台数算定経路確定」という推論は**撤回**。
- Test02の `GET /v1/user_agents` 2件は、GUI `Roaming Clients in Use=2` との**登録件数の一致のみ**を示す。APIから返る `status` と `agent_state` がGUIの `Protected` とどのように対応するかは未検証。実装済み `DnsFilterInventoryClient` が取得済みの両属性を再利用し、**管理画面のProtected判定との対応を実測で決める**。プロパティ文字列を推測で「Protected」に変換しない。
- Offline/Recently Seen/Unprotected/削除待ちなどの扱いは、**保護状態の計数基準として誤って減算しない**ようGUIと契約上の計数を確認する。保護状態が読み取れない端末は `UNKNOWN` 扱いとし、0台/未請求へ変換しない。
- 独自のAgent履歴管理・手動メンテナンスを増やさない。端末行はDNSFilter正本を随時参照し、必要なら**検証済み状態**を集計するだけ。状態の誤判定を防ぐため、正確に数えられない間はライセンス割当の自動PATCHを有効化しない。
- 顧客契約上限Cと保護状態台数Pを比較し、P>Cなら上限を超える割当変更はせず、顧客へ是正依頼。契約開始時の割当はCを先取りせず、**確認済みPに追従させる**。割当QのAPI読取/更新・請求条件は引き続き別検証。
- DNSFilter Subscriptions GUIの`Current License Usage`にはNetwork Trafficが含まれるが、Secure GuardはNetwork方式を提供しないため、**それを使ってネットワーク利用分を追加課金する設計にはしない**。他経路の利用が混入した場合はサービススコープ逸脱として例外照合し、保護端末数Pに自動合算しない。
- この節は以前の「Agent件数U_RCを利用台数とする」「ネットワーク分の管理を増設する」という提案より優先する。

## 統括側再訂正（2026-11-04）— 本文中の派生数量提案を無効化
- この文書のGET実測（Test02の`user_agents` 2レコード、メトリクス応答、GUI表示）は**取得した事実の記録**に限る。レコード件数がGUIのRoaming Clients in Use=2と一致しても、保護台数・登録済み台数・課金台数の自動計算が成立したわけではない。
- **DNSFilter公式管理画面が唯一の正本**。Secure GuardはAPIが返す既存情報の参照と、正式APIによる操作を扱う薄いUI。Agentの「登録済み」等の状態を独自生成しない。
- 過去の`U_RC=Agent件数`、`P=Protected台数をstatus/agent_stateから独自計算`、`Q=min(C,max(1,P))`、自動PATCHの提案は**採用しない**。APIから直接取得できない情報は表示せず、公式GUIに委ねる。
- Secure Guardの販売対象は**Roaming Clientエージェント方式だけ**。Network DNS方式の課金集計/自動管理はしない。
- したがって、**現在のライセンス自動調整の実装可否は未確認**。直接取得可能なAPIと書込後検証が公式に確認できるまで実装しない。追加の独自状態管理システムを作って穴埋めしない。

## 後続実装ゲート
- APIで取得できる**元の事実**を表示し、公式APIで実施できる既存操作だけを提供する。
- 割当数量・保護状態をAPIで取得できないなら、Secure Guardで生成・推定・自動修正しない。管理画面へのリンクで対応する。
- 既存の顧客Scope・監査・結果不明時の停止・F5同期の回帰を維持する。
- 書込みの承認・課金API操作・DB migration・デプロイは今回未実施。
