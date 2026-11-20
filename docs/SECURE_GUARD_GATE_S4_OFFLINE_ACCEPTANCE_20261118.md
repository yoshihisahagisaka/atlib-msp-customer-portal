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

## 2026-11-20 共有アプリのStaging限定起動（最小Fit/Gap修正）

ユーザー再確認の設計原則は**1つのSecure Guardアプリ＋1つのSecure Guard DB（複数OrganizationがMembership Scopeで共有）**。顧客別アプリ、顧客別DB、新Identity、追加テナント管理レイヤーは作成しない。

実GitのFit/Gapでは、既存 `src/server.ts` をそのままStaging専用DBへ配備すると `loadConfig()` が既存Portal DB・Zabbix・SMTP・Staff OAuthの秘密情報を要求し、レガシーPortal APIも起動する。これは共通マルチテナントの要件ではなく同居アプリの起動依存であり、SG専用DBの設計不備ではない。

解消のため**既存 `dist/server.js` を唯一の起動エントリポイントのまま**、`SECURE_GUARD_STAGING_ISOLATED=true` のときのみ既存Secure Guard RouterをStaging制限付きで起動する。独立した商用サービスや顧客別プロセスを追加するものではない。既存Portalは未設定／false時に従来経路を継続する。

- 前提条件：`SECURE_GUARD_DB_MODE=dedicated`、`SECURE_GUARD_DB_REQUIRE_DEDICATED=true`、SG runtime DB接続設定、`SECURE_GUARD_JWT_SECRET`、`SECURE_GUARD_BASE_URL`。失敗時にPortal DBやPortal JWTへフォールバックしない。
- 起動：既存SG Repository・Identity・Routerを一組だけ起動。従来PortalのDB／Zabbix／Google OAuth／SMTP／月次報告／Admin APIは一切初期化・マウントしない。
- Staging安全境界：SGログイン・ログアウト以外のPOST/PATCH/PUT/DELETE等をRouter到達**前**に503停止する。Agent queued uninstall、DNSFilter Organization/Site作成、招待作成、Slack実送信、SMTPを無効化。DNSFilter API keyや管理Clientを注入せず、外部GETも原則UnavailableでFail closed。既存のエンドユーザー操作UIと専用DBの権限モデルは変更しない。
- 影響範囲：`src/server.ts` の冒頭条件分岐と `src/secureGuardStagingRuntime.ts` のStaging限定組立、隔離起動／API露出／書込み拒否のオフラインテスト。Migration 001–005、DNSFilter API実装、既存Production server動作は変更しない。
- 受入：`npm test` と `npm run test:secure-guard-staging-isolated`、隔離PG16／Image CIで判定。ローカル・CIのPASSは**Staging配備承認／Gate S4 PASSではない**。

**未完了**：実Cloud SQL Migration 005権限受入、OpenSSL High 4件のSecurity Gate、Staging専用Cloud Run配備および認証/MFA/合成データcleanupを含む実Synthetic E2E、顧客向け本番の招待／操作有効化。Stagingの書込み禁止は試験用制限であり、将来の商用機能を恒久的に削除・仕様変更する決定ではない。これらの作業は別レビュー・別承認。Gate S3 STOP、Gate S4およびProduction No-Go、Draft状態を維持する。
