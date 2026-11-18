# Secure Guard Gate S4｜Syntheticオフライン受入と残存Fit/Gap（2026-11-18）

## 判断の境界

- 正本：Portal Draft PR #6、`docs/SECURE_GUARD_V1_DB_INTEGRATION_20261112.md`、`docs/SECURE_GUARD_STAGING_BOOTSTRAP_EXECUTION_20261114.md`、`docs/DECISION_SECURE_GUARD_EMPTY_START_20261113.md`。
- Gate S2は実StagingでPASS、Migration 001〜004は適用済み。Migration 005はオフライン実装済みで**実Staging未適用**。
- 2026-11-17のMigration Image scanはCritical 0／High 4（OpenSSL `libssl3t64`由来）でSecurity Gate FAIL。**Gate S3 STOP／Gate S4・Synthetic E2E・Production No-Go**は変更しない。
- 共用Cloud SQL `secumie-sg-shared-staging-db`は2026-12-04 10:12:12 JSTまでの保全延長、追加費用上限75 USDを経営者承認済み。基盤OwnerはInsight側。この承認は実行・配備の許可ではない。

## 今回追加したオフライン受入

`npm run test:secure-guard-s4-offline`／通常`npm test`に、`test/secureGuardGateS4Offline.test.cjs`を追加する。

本試験は既存Express Routerの**同一Synthetic操作シナリオ**に、ローカルの固定Identity、Organization A/B、Inventory、公式Usage、overage Storeを注入する。実Cloud SQL、既存Portal DB、DNSFilter、Slack、SMTP、GCP Secret／IAM、実顧客データには接続しない。

| 合成操作 | 必須の期待結果 |
| --- | --- |
| 無Cookie・他Membership・MSPの顧客Membership流用 | 401／403。Customer AのAgent一覧やBのScopeが漏れない |
| Customer AのOverview | Aに限定したSite／Agentが返る。Agent queued uninstall能力はfalse |
| Agent queued uninstall要求 | 503 `AGENT_UNINSTALL_NOT_ENABLED`。外部DELETE 0件 |
| CustomerからのMSP超過管理アクセス | 403 |
| MSPによる公式Usage参照 | 事前に固定した値から超過1を正しく表示。DNSFilter GETはモック内で完結 |
| MSPの超過対応記録 | `reduce_clients`と対応メモのみローカルStoreへ反映。DNSFilter割当変更なし |
| MSPの手動license-alert check | `managed_by_scheduled_monitor`を返す。Slack送信・claim・解消処理0件 |
| MSPの割当スナップショット記録 | ローカル値更新のみ。DNSFilter API書込み0件 |

この試験は個別テストの代替でも、実DB/APIのE2E合格証跡でもない。**Offline Contract PASSのみ**を認める。

## Gate S4 Staging実環境に残るGap

1. **実行環境**：現行Gitと2026-11-16 GCP Read-onlyではSecure Guard専用StagingアプリServiceが存在しない。既存`sales-tools-staging`やProduction PortalをSG S4として流用しない。Cloud RunのService／Revision／SA／Ingress／ネットワーク／接続予算の新規または変更操作は別レビュー・別承認。
2. **認証・DB**：SG dedicated runtime接続のほか、`src/server.ts`は現行PortalのPoolとルートも起動する。S4向けApplication Artifactでは既存Portalに影響しないサービス境界、認証・Secret接続、runtime/overage Roleおよび隔離を実環境で確認する。コードは今回変更しない。
3. **外部書込みの物理的抑止**：既存MSP管理APIにはDNSFilter Organization／Site作成ルートが存在するため、Synthetic試験で**実DNSFilter書込みを許可するCredential／権限／通信経路を供給しないこと**が適用前Gate。Agent DELETE、Slack、SMTPの実送信も不許可。API上の操作を単に呼ばないだけでは実環境の安全性証明としない。
4. **Syntheticデータ・後処理**：実Stagingで合成Organization／Membership／Invitation／overage episode／監査レコードを作る場合は、事前固定の識別・行数・排他条件、結果採取、再試行禁止、承認された後処理、残存0件のRead-only確認を必要とする。実DBの無条件DELETE、Ledger変更、旧Portalデータの移送・消去は不可。
5. **依存Gate**：Migration 005適用＋最小権限ACLの再受入、公式修正版ImageのCritical／High 0実測がGate S3でPASSになるまで、S4のCloud Run適用と実Synthetic E2EはNo-Go。

## 今回の変更・非変更

- 変更：合成HTTP受入テスト1件、テスト実行導線と本Fit/Gap文書。
- 非変更：業務仕様、DB Migration 001〜005とSHA、Cloud Run Job／SA／Secret、Application Router、DNSFilter API、Slack、Production。
- GitはDraft PR #6の既存積み上げ方針を維持。Merge／Productionデプロイなし。
