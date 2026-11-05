# Secure Guard｜SECU:MIE共通Cloud SQL Staging合流契約（2026-11-05）

## 位置付け

- 既決定：案②。SECU:MIE（Insight主管）の新Cloud SQL**インスタンス**へSecure Guardの**独立database/role**を収容。
- 既存Portal、Sales Tools、PPAP/Secure Send本番DBは不変更。Secure Sendの将来分離は別工程。
- SECU:MIE Draft PR #42（基盤設計）、#43（runtime接続分離）、#44（旧SECU専用Staging準備）に加え、**#45（`fee66401619e994f40aeffb497d24f4f1b72b909`、2026-11-05）の共用Cloud SQL設計を現行実行正本**として照合する。PR #44の旧インスタンス作成手順は廃止。各PRのSECU:MIE単独検証をSGとの共用構成Goとみなさない。
- 共用Stagingは `msp-zabbix` / `asia-northeast1`、`secumie-sg-shared-staging-db`（PostgreSQL 16 Enterprise、ZONAL、2 vCPU / 7.5 GiB、SSD 20 GiB自動拡張、Private IPのみ、backup/PITR 7日、deletion protection）。**2026-11-05時点で未作成**。Private Service Accessは現行default VPCに未設定で、先行する別承認が必要。
- SECU PR #45の追加Preflight `cfb4c104ae96b554a2ab72457bc7bfc4132e7b4a`（第12節）でPSA候補 `172.20.0.0/16` / `google-managed-services-default`、Staging zone `asia-northeast1-c`、Proxy v2 sidecarのloopback `127.0.0.1:5432` が固定候補となった。既存SG Portalは現状のConnectorを維持し、専用DB接続/Proxy追加と新Revisionは別途承認。PSAとStaging実作成はまだNo-Go。
- 共用Productionの候補は `secumie-sg-shared-prod-db`（REGIONAL HA、2 vCPU / 7.5 GiB、SSD 30 GiB）だが、**Production No-Go**。
- 本文はSecure Guard側の実装候補とInsight側へのインターフェース要求。**Staging作成、DB作成、権限付与、Migration実行、実データ移行、本番変更は未実施。**

## 責任境界

| 項目 | Insight側 | Secure Guard側 |
|---|---|---|
| Cloud SQLインスタンス | Staging・本番構築、Tier/HA、接続上限、監視、費用、バックアップ・PITR統括 | SG接続見積と負荷・運用要件を提示 |
| SG database | DB作成、接続先と権限隔離、Secret・SA配布の調整 | SG固有テーブル定義、アプリDB機能 |
| DB principal | 個別runtime/DDLロールと最小権限の付与管理 | runtimeからDDL権限を排除、独立Migration ledger・runner |
| Migration/データ移行 | 共通Stagingと復旧条件の調整 | 新規SG baseline、旧→新データ整合、切替・切戻し |
| 障害/復旧 | **インスタンス単位**で初動・PITR統括 | SG側整合性・セッション・監査・通知状態の復旧確認 |

## SG専用database（PR #45との確定契約）

- Staging DB名 **`secure_guard_staging`**、Production DB名 **`secure_guard`**。共用インスタンスのInsight用DBは別名 `secumie_insight_staging` / `secumie_insight`。物理ログインroleは環境識別子付きでInsight側が払い出す。
- ①`runtime`：SG Web/APIの必要DML。`CREATEDB`、`CREATEROLE`、DDL、他サービスDB権限なし。
- ②`overage`：定期Job専用。`customer_organizations`・`dnsfilter_organization_mappings`の必要SELECT、`secure_guard_overage_alerts`のSELECT/INSERT/UPDATEと必要sequence操作のみ。認証個人情報、MSP権限、監査履歴、Migration ledger、DDL、他DBは不可。
- ③`migration`：**明示承認された**SG migration時のみ使用。runtime/overageと別Secret/role。CIでは従来の実装名 `secure_guard_ci_ddl` を使用。
- 3 role / 3 Secretはそれぞれ別のService Accountからのみ参照できることをInsight側と受け入れ確認する。Cloud SQL instance管理者はどのruntime roleとも共用しない。
- 移設対象は8テーブル（個人認証、Organization、membership、MSP grant、DNSFilter mapping、receipts、audit、overage）。013以前の旧PortalマイグレーションをSG DBに流用しない。
- SG専用SQL `migrations/secure_guard/001_identity_scope_baseline.sql` と `002_overage_alerts.sql`。独立ledger `secure_guard_schema_migrations`。旧Portal `customers` FKなし。
- SG専用runner `migrations/secure_guard_runner.ts` は `SECURE_GUARD_MIGRATION_APPROVED=true` と専用migration credentialを必須とし、ledgerとSHA256を検証。**既存の `npm run migrate` をSG専用DBへ向けることを禁止。**

## Runtime接続と切替Gate

- 現行Portal側のpool(max 5/instance)は変更せず、SG Repo・Overage Storeにだけ別pool(max **2/instance**)を渡す。Overage JobもSG DBにのみ書込む。
- `SECURE_GUARD_DB_MODE=dedicated` を明示した場合、別接続先・DB名・runtimeユーザー・passwordをすべて要求。欠落時は例外となり、旧DBへfallbackしない。
- SG Web/APIは`SECURE_GUARD_DB_USER/PASSWORD`、超過監視Jobは**`SECURE_GUARD_OVERAGE_DB_USER/PASSWORD`**、migrationは`SECURE_GUARD_MIGRATION_DB_USER/PASSWORD`を使用。各principalの設定欠落は必ずエラーとし、他主体の資格情報にfallbackしない。Job pool最大2、migration pool最大1。
- Overage Jobは従来のPortal `loadConfig()`を利用しない。必要な設定は `GCP_PROJECT_ID`、SG DB接続情報、DNSFilter read-only API Secret、任意の`SECURE_GUARD_LICENSE_ALERT_SLACK_WEBHOOK`、`SECURE_GUARD_MANAGEMENT_URL`（httpsの管理画面URL）だけ。Portal DB、Zabbix、SMTP、スタッフ認証のSecretはJob SAへ割り当てない。
- 既存サービスの段階移行前は互換性のため`legacy`がデフォルト。**本番切替時は**`SECURE_GUARD_DB_REQUIRE_DEDICATED=true`を設定して、env消失による旧DBへの暗黙復帰を防ぐ。
- 接続経路は `SECURE_GUARD_DB_SOCKET_PATH`（Cloud SQL socket）か `SECURE_GUARD_DB_HOST`/`SECURE_GUARD_DB_PORT`（TCP）の片方のみ。
- `SECURE_GUARD_DB_NAME`、`SECURE_GUARD_DB_USER`、`SECURE_GUARD_DB_PASSWORD` はPortalの `DB_*` を使い回さない。Secret値はPR・ログに記録しない。
- Web/APIはdedicated modeのみSIGTERM/SIGINT時にHTTP drain後、SG poolと既存Portal poolを終了する。既存Portal-only配備の停止処理は変更しない。
- 新SQLを未接続でもPortal全体の `/healthz` はSGの生存確認にならないため、Stagingでは**SGログイン・権限・管理・監査・Jobの専用E2Eを必須**とする。

## 合計接続予算（PR #45基準、実測は未実施）

- SECU:MIE 54接続（OTP 6 + PIRA 6 + 管理 40 + migration 1 + retention 1）。
- Secure Guard 24接続（Web/API: 最大5 instance × pool 2 × 2 revision = 20、超過監視Job: 1 × pool 2 = 2、migration/cutover: 2）。
- **総アプリケーション上限78接続**。既存のSG pool(max5)をそのまま共用した場合は最大111接続でNo-Go。SG側専用runtime/Job max2は本PRで実装済み。
- Stagingの接続予算受入条件は `M = SHOW max_connections`、`R = max(10, ceil(M*0.20), 実測internal/reserved peak+5)`、`M-R >= 78`。目標 **M >= 100** は実測前提であり、設定済みとはみなさない。
- Sustained 70%で警告、80%で負荷中止。CPU/メモリ、pool wait、5xx、バックアップ失敗、他サービス影響を合わせて判定。上限を増やすだけの設定変更は不可。
- SG Web max5はProduction容量見積り用、Stagingではタグ付きtest revisionを1つに限定する。旧・新revisionの同時無制御トラフィックを認めない。

## Staging開始に向けた接続条件

1. Insight側が**Private Service Accessのrange/peering**を別承認し、共用Cloud SQL Stagingインスタンスの作成・接続予算・14日/$75の費用上限を承認する。SG用DBはこの段階では作らない。
2. SG側が空の**SG専用Staging DB**だけへ独立migrationを実施し、再実行・checksum不一致・余分な権限の拒否を検証。
3. 既存Portal Stagingが存在しなかった点を解消し、legacy DBの仮想/安全なテスト環境を用意してSG dual poolだけを検証。**既存本番Portal DBへテスト負荷を加えない。**
4. 旧本番のProduction Ledger（011/012/014/015）と対象データの実件数・FKを**低負荷Read-only**で照合した後、全8テーブルのID/関連/監査等を保全する移行スクリプトとRollbackを決める。
5. SGの過去session・invitation・MSP権限・通知二重防止までStaging E2E PASSとし、Insight側と共通障害/PITR復旧責任者を確認してからProduction Go/No-Go判定。

**2026-11-05のFit/Gap:** 8テーブルの独立baseline、3 principalの分離接続コード、pool max2、専用Migration/ledger、および使い捨てPG16の権限否定テストはSG Draft PR #5に準備済み。**未了:** 本番ソースの低負荷Read-only inventory（ledger/件数/FK/権限）、移行・整合性・rollback計画の実データ適合、Insight側の3主体role/Secret承認、Staging実機接続と負荷/PITR検証。PR #45のGate 1〜4は未承認であり、SG Staging database/role/Secret作成はNo-Goを維持。

## 旧本番DB Read-only inventoryの実行前契約（未実行）

- `scripts/secureGuardSourceInventoryReadOnly.cjs` をSG側の運用者が使う候補とする。**既存ソースDBを開く処理であり、このPRでは実行しない。** Read-onlyであることは、GCP本番接続の自動承認を意味しない。
- 先にCloud SQLの監視で**現在接続数が20未満**、PPAP/Portalに遅延なし、保守責任者・実行時間・停止判断者を確認する。接続追加後の検査自身も使用接続数が20以上なら**即STOP**。既存最大25・観測ピーク22のため、繁忙時は実行しない。
- 低権限・本番の既存read-only接続主体を使用する。DBへの `CREATEDB` / `CREATEROLE` / `SUPERUSER` / `REPLICATION` 権限がある主体はスクリプト内で拒否。調査のための新規role、IAM、Secretやnetwork構成の追加は本工程で許可しない。
- 接続は**VPC内の承認済みCloud SQL Auth Proxyのloopback** `127.0.0.1:<port>`、またはCloud SQL Unix socketのみ。Public IP追加、直接DB接続、SSHトンネルの新設、旧Cloud Run revisionの変更はしない。
- 本番接続を伴うため `SECURE_GUARD_SOURCE_INVENTORY_APPROVED=true` と `SECURE_GUARD_SOURCE_DB_NAME` / `SECURE_GUARD_SOURCE_EXPECTED_DB_NAME` の一致を明示必須にする。`SECURE_GUARD_SOURCE_DB_USER/PASSWORD`、`SECURE_GUARD_SOURCE_DB_HOST/PORT`または`SECURE_GUARD_SOURCE_DB_SOCKET_PATH`は専用の環境/Secret経由で与え、値を引数・Git・Cloud Loggingに出さない。
- 実行は `node scripts/secureGuardSourceInventoryReadOnly.cjs`。**1接続のみ**、トランザクションREAD ONLY、SQL 3秒・ロック1秒タイムアウト、処理後切断。出力は旧Ledgerの011/012/014/015、SG関連8テーブルの推定件数/総容量と欠落、FK一覧、DB名/接続上限だけで、顧客名・メール・token/hash・行内容は読み出さない。
- 調査証跡は制限付きで保全し、結果が現行DDL/想定と異なればSTOP。`reltuples`は参考推定値であり、正確な移行件数やProduction Goには使わない。
- **Disposable PostgreSQL 16 CI専用の合成テスト**で承認フラグ必須・DB同一性・loopback限定・接続余裕ゲート・SQLメタデータのみ・権限不足の拒否を確認する。これは実本番調査の代替ではない。

**本PRはSG側のオフライン実装準備。SECU:MIE Staging作成や本番切替の許可を代行するものではない。**

## 2026-11-05 合成データ移行リハーサル（実DB、Production非接続）

GitHub Actionsの使い捨てPostgreSQL 16内で、**旧Portal側のSG migrations 011→012→015**を適用した合成source databaseと、**SG-only baseline 001→002**を適用したtarget databaseを並置し、次を検証する。

- 旧Portal `customers` FKを使った組織と、Portalに属さないSG独立組織の双方をsourceに用意。
- 個人ID、session_version、active/pending membership、招待token hash、MSP role、DNSFilter mapping、receipt、audit FK、overage通知状態を保持できること。
- SGの8業務テーブルのみを依存順にtargetへ移し、旧`customers`テーブルをtargetに持ち込まないこと。
- 移送途中の故障で**target全体がROLLBACK**し、中途半端な所属/監査レコードが残らないこと。
- 全フィールドの往復相当一致（TIMESTAMPTZのマイクロ秒精度も文字列のまま保持）と、overage BIGSERIALのシーケンス値補正（旧IDの重複防止）。
- 旧SourceにDraft 015が未適用の場合も、認証・Organization等の7テーブルを移し、新DBの超過監視テーブルを空で開始できること。

**注意：これはCIのfixture-only移送アルゴリズムであり、本番データ移行プログラムやProduction Goではない。** 本番側の実Migration Ledger、正確なデータ件数、旧DBの書込停止方式、認証・監査・通知の切替整合、バックアップとRollbackは未確定。Production接続用コード・権限・手順へ昇格する前に、実機Read-only調査と個別の移行承認を要する。
