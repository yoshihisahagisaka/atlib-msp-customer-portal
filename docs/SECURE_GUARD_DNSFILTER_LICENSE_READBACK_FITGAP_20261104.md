# Secure Guard｜DNSFilterライセンスAPI Read-only Fit/Gap（2026-11-04）

状態: **実測Fact記録・自動ライセンス管理未実装・未承認**。
優先Decision: `DECISION_SECURE_GUARD_DNSFILTER_API_BILLING_UPDATE_20261104.md` 4A。
対象: PR #3 `feature/secure-guard-daily-management`。

## 0. 最上位原則
1. **DNSFilter公式管理画面が正本**。Secure GuardはAPIで確認できる情報と、APIで正式に可能な操作だけを提供するシンプルな管理画面。
2. 「Agent登録済み」「保護中」「課金対象」など、APIにない独自状態・台数を作らない。Agentレコード一覧に関するGETがあっても、それだけで登録状態や保護対象を判定できるわけではない。
3. Secure Guardの対象は**Roaming Clientエージェント方式のみ**。Network DNS方式やNetwork Licenseの独自管理は対象外。
4. 取得できない情報は取得不可/公式管理画面へ誘導。UNKNOWNを0に変換しない。想定した派生集計や自動PATCHを先に実装しない。

## 1. ユーザーの実機GETとGUIのFact
- MSP ID 11473のTest02/Core ID `10220954`, Test03/Plus ID `10222523`。
- `GET /v1/organizations` と個別Organization GET: Planの正式SKU / 割当数量は取得できなかった。
- Distributor専用 `GET /v1/distributors/skus_available`: HTTP404。MSPキーで使用可能とは確認できない。
- `GET /v1/metrics/organization_usage_detailed/{id}`: 両OrgでHTTP200。Test02は `plan=basic`, `user_count=1`, `wifi_count=0`; Test03は `plan=plus`, `user_count=1`, `wifi_count=0`。いずれも `roaming_client_count` はPowerShell出力が空欄で、nullか非存在か未確定。この`user_count`を端末台数と解釈しない。
- `GET /v1/user_agents?organization_ids=10220954`: Agentリソース2件、nextページなし。GUI `Roaming Clients in Use=2` と数値が一致。しかしこれは**Agent一覧件数が2件**というFactだけ。「登録済み」の別状態や「Protected=2台」は取得できていない。
- GUI Subscriptions のTest02は Allocated RC Licenses=0, Roaming Clients in Use=2, Network Licenses in Use=0, Current License Usage=2, Cost=$0.00/mo の表示。ツールチップではCurrent License UsageはRoaming ClientsとNetwork Trafficに基づく推奨数量。GUI表示と最終Invoiceの確定課金額は同義ではない。
- Test03/PlusのGUIは割当1、利用0、表示Cost=$2.00/mo。親MSPのNFR25は顧客に転用不可。
- DNSFilter正式回答: Organization POST/PATCHの`sku`・`quantity`指定をサポート。Core/Plus SKUの実値は後送予定、数量変更は日割り精算、顧客利用実数で自動増枠しない。アクティブ組織最低1との回答とGUI 0表示は未解決の差異。

## 2. 現行コードFit/Gap
- `src/services/dnsFilterInventoryClient.ts` はDNSFilter提供のAgentリソース一覧、`status`、`agent_state` を取得し、顧客Organizationスコープを検証できる。**これを独自の保護判定・登録判定・請求数量に変換しない。**
- `src/services/dnsFilterManagementClient.ts` はOrg一覧・個別読取・新規作成があるが、正式SKU/quantityを付けた作成、現在割当数の読取・変更後検証は未実装。
- 顧客組織のローカルmappingは認可/ID連携用として維持するが、DNSFilterの端末状態・契約台数を別DBで正本として保存しない。
- 必要な操作のみAPI化し、元の情報を欠落なしに表示する。未公開の課金状態を推定しない。

## 3. 今後の方針とゲート
- 新規Organizationの`sku`/`quantity`指定は、正式SKU値・数量制約を確認できてから実装/HA。API実行結果不明時に再POSTしない。
- Allocated RC LicensesがAPIで読めない間は、**Secure Guardによる割当数の自動調整を実装しない**。DNSFilter公式画面で確認・操作する。
- DNSFilterの画面にしかないProtected状態などを、端末一覧の行数や未検証のstatusフィールドから勝手に作らない。正式な対応が確認され、かつ実際に必要なUIのときだけ、APIの事実として扱う。
- 契約上限を超えて仕入課金させず、日常運用を簡素化したいという事業目的は維持する。しかしAPIに存在しない自動申告機能をローカルで再構築して解決しない。
- 既存Scope/Role、監査、UNKNOWN停止、F5組織同期は維持。既存の成功済みAgent撤去PoC等をやり直さない。

変更していないこと: DNSFilterへのPOST/PATCH/DELETE、Secret/API Key/本番デプロイ、DB migration、API Clientコード。
