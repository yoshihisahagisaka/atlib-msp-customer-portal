# Secure Guard Source Inventory｜Production Preflight・個別承認票（2026-11-10）

> **未承認・未実行。Production No-Go / Draft PR #5を維持する。** この文書は本番適用Runbookではなく、統括・配置担当・実行担当・確認担当が同じ実測・差分を確認するための審査票。`gcloud`例はすべてRead-onlyであり、書込みコマンド・Secret payload取得・Job実行コマンドは記載しない。

## 1. 正本と対象境界

- 設計・実装・CI証跡：[`SECURE_GUARD_SOURCE_INVENTORY_ROLE_APPROVAL_20261106.md`](SECURE_GUARD_SOURCE_INVENTORY_ROLE_APPROVAL_20261106.md)。矛盾する場合は、同文書の**最新のNo-Goおよび段階別Gate**を優先する。
- GitHub：`yoshihisahagisaka/atlib-msp-customer-portal` / Draft PR #5。Stage A/B・Final verifyのSQL/runner/DockerfileはPR上の固定SHAだけを候補とし、直前に再照合する。
- Project `msp-zabbix`、region `asia-northeast1`、Cloud SQL instance `msp-customer-portal-db`、database `msp_customer_portal`、PG major 16、Ledger `public.schema_migrations`、owner `portal_app`。
- 作成候補 `sg_source_inventory_ro_20261106`：`NOLOGIN NOINHERIT PASSWORD NULL`、期待権限は **CONNECT / USAGE / Ledger SELECTの3件のみ**。Stage Aは`postgres`、Stage Bは`portal_app`の所有者直接GRANT、Final verifyは正規のRead-only接続主体。
- この審査は既存Portal/PPAP/SECU:MIEの本番、DNSFilter、専用SG Staging、Source Inventory実行、LOGIN有効化、Migrationの変更を許可しない。

## 2. 段階ごとのGo/No-Go（承認は相互に流用しない）

| Gate | 審査対象 | 今回の状態 | 解除に必要な個別承認 |
|---|---|---|---|
| P0 | 実装・使い捨てPG16統合・専用イメージ脆弱性CI | **PASS**（PR #5で証跡あり） | 新しいHEADのCIを再確認 |
| P1 | 監査可視性、依存/接続余裕、バックアップ・復旧経路、担当割当 | **STOP**（2026-11-10のRead-only構成/Backup/Operationsは観測済み。DB文監査未成立） | 監査B案の正式な別承認またはpgAudit設計変更承認、残余リスク受容、実行直前再測定・二者照合 |
| P2 | 専用SA/IAM、正式Build/Push、Digest固定、Cloud Run Jobの**作成のみ** | **未承認・未実施** | 本番GCP変更の対象/権限/差分/実行者を明記した承認 |
| P3 | Stage Aのrole作成、CONNECT/USAGE | **未承認・未実施** | P1/P2後、最新DB GateとStage A操作を指定した承認 |
| P4 | Stage BのJob**1回実行**、Ledger SELECT | **未承認・未実施** | Stage A結果・Job export/IAM再照合・実行者/時刻を指定した別承認 |
| P5 | Final verify（Read-only）と証跡照合 | **未実施** | P4結果の確認。直接検証とPASSWORD NULLの間接保証を分けて記録 |
| P6 | LOGIN化、Source Inventory、Migration、後処理（権限回収含む） | **対象外・No-Go** | それぞれ別途Go/Runbook |

**P2承認はP3/P4の承認ではない。** Jobは作成しても自動実行・Scheduler・Triggerなしとし、P4承認より先に実行者へ`run.jobs.run`を付与しない。`SG_STAGE_B_EXPLICIT_APPROVAL=APPROVED_ONCE`はアプリ内の固定値検査であり、人間の実行承認・IAMレビュー・一回限りの実行許可を代替しない。Cloud Run Jobs Executorは実行・キャンセル可能で、**同じJobを再実行できる権限**であるため、運用上の一回性はP4の単発実行記録と実行後の権限回収を別審査する（SQL側の再GRANT拒否も維持）。

## 3. P1：Read-only収集とSTOP判定

以下は**承認済みの管理者Read-only経路**からのみ実行する。Cloud SQLへの新規接続・SQL閲覧が許可されていない主体は接続せず、実施可能な担当へ委ねる。Secret本文、SQLアプリ行、認証情報、接続文字列をログ/PRへ貼らない。

### 3-A. Cloud SQL構成・監査（出力は必要な構成項目だけ保全）

```bash
gcloud sql instances describe msp-customer-portal-db \
  --project=msp-zabbix \
  --format='json(name,region,state,databaseVersion,settings.databaseFlags,settings.backupConfiguration,settings.ipConfiguration)'

gcloud sql operations list --instance=msp-customer-portal-db \
  --project=msp-zabbix --limit=20 \
  --format='table(name,operationType,status,startTime)'
```

- `RUNNABLE`、PG16、競合する進行中Operationなし、直近成功Backup/PITRと復旧担当・戻し先を確認。バックアップ設定の存在だけでは復元可能性を立証しない。
- 直近30分のCloud SQL接続/CPU/メモリ、既存Portal・Sales Tools・PPAP（upload/download/virus-scan）のReadyと5xx、他の計画変更を実測し、**承認済み接続予算・停止閾値**と照合する。前回の「接続最大6、CPU最大13.17%」は過去記録であり実行前PASSへ転用しない。
- DB statement auditは**Cloud Audit Logsの管理操作ログだけで代替不可**。`cloudsql.enable_pgaudit=on`、対象DBの`pgaudit` extension、Stage A/Bの`CREATE ROLE`/`GRANT`を捕捉する有効`pgaudit.log`設定（`role`または`all`等）をRead-onlyで確認する。DBごとの/roleごとの設定優先順位、Cloud LoggingのData Access閲覧と保持条件も照合する。
- 正規のDB Read-only SQL接続で確認する場合（DB変更なし、必ず**許可済み主体のみ**）：

```sql
BEGIN TRANSACTION READ ONLY;
SELECT current_database(), current_user, current_setting('server_version_num');
SELECT extname FROM pg_extension WHERE extname = 'pgaudit';
SELECT current_setting('pgaudit.log', true) AS effective_pgaudit_log;
SELECT current_setting('log_statement', true) AS effective_log_statement;
COMMIT;
```

この`current_setting`は**その接続主体・DBセッションでの実効値**であり、`postgres`での結果だけでは`portal_app`で実行するStage Bの監査設定を証明しない。対象DB/roleの設定上書き有無も権限があるRead-only管理者が確認し、**Stage A主体とStage B主体の双方でROLE監査が成立する根拠**をレビュー票に記録する。`portal_app`への試験ログインやSecret取得は行わない。

**STOP**：pgAuditのフラグ・extension・実効`ROLE`監査・ログ配送/閲覧のいずれかが未確認の場合。特に`cloudsql.enable_pgaudit`の有効化/無効化はCloud SQLの再起動を伴うため、この審査内で`instances patch`、`CREATE EXTENSION`、`ALTER ROLE/DATABASE`を実行しない。監査を新たに有効化する必要があれば、サービス影響を評価する別の本番変更承認へ切り出す。

### 3-B. Identity/IAMの既存状態とJob不存在

```bash
gcloud iam service-accounts list --project=msp-zabbix \
  --format='table(email,disabled)'

gcloud secrets describe portal-db-password --project=msp-zabbix \
  --format='json(name,replication,labels)'

gcloud secrets versions list portal-db-password --project=msp-zabbix \
  --format='table(name,state,createTime)'

gcloud secrets get-iam-policy portal-db-password --project=msp-zabbix \
  --format=json

gcloud run jobs list --project=msp-zabbix --region=asia-northeast1 \
  --format='table(metadata.name,status.conditions)'
```

- Secret Version `1`の`ENABLED`をメタデータで確認。**`versions access`は絶対に行わない**。Secretの既存IAM Bindingを削除/広域化しない。
- 専用SA名/メール、既存同名Job、Build先Artifact Registry、既存IAMは**まだ提案候補**であり、重複/既存依存があれば固定STOP。Jobが既に存在する場合は作成し直さず、既存設定と作成監査履歴を二者レビュー。

## 4. P2候補：新規本番GCP資産の差分審査（設定値のみ、実行禁止）

| 対象 | 許可候補の**固定差分** | STOP条件 |
|---|---|---|
| Runtime SA | 新規専用1件（メール/名前はP2承認票で確定） | 既存Portal/Compute SAの流用、秘密に広くアクセスできる既存SA |
| Cloud SQL IAM | 上記SAに`roles/cloudsql.client`、Project `msp-zabbix`でのみ | 他のProject IAM Role追加、Cloud SQL Admin付与 |
| Secret IAM | Secret **`portal-db-password`単位**で上記SAに`roles/secretmanager.secretAccessor` | Project全域Secret Accessor、Version payloadの取得、他Secret付与 |
| Build/Artifact | PR #5固定commitから正式Build/Push、成果物を`@sha256:`固定、スキャン証跡に紐付け | タグだけの指定、未検証Image、既存Portalイメージの変更 |
| Cloud Run Job | `secure-guard-source-inventory-stage-b-once`、`asia-northeast1`、Cloud SQL `msp-zabbix:asia-northeast1:msp-customer-portal-db`、専用SA | 複数コンテナ、Scheduler/Trigger、既存Serviceの更新 |
| Job run contract | task count=1、parallelism=1、max retries=0、短いtimeout（P2で秒数確定）、固定entrypoint/image digest | overrides、retry、任意args、継続実行、未固定timeout |
| Secret volume | `portal-db-password:1`を**ファイル**`/var/run/secrets/portal-db-password/password`としてmount | `latest`参照、環境変数へのPassword展開、別パス |
| 固定env | `SG_STAGE_B_EXPLICIT_APPROVAL=APPROVED_ONCE`、`DB_NAME=msp_customer_portal`、`DB_USER=portal_app`、`CLOUD_SQL_INSTANCE=msp-zabbix:asia-northeast1:msp-customer-portal-db`、`DB_PASSWORD_FILE=/var/run/secrets/portal-db-password/password` | 変数追加、値のドリフト、Secret内容をenvへ転記 |
| Deployer | 本番管理変更専任（P2で指定）。Job配置のために必要な権限は配置時のみ | 実行担当者へJob更新/SA actAs/Secret閲覧権限を付与 |
| Executor | **P4承認まで付与しない**。その後もJob単位`roles/run.jobsExecutor`のみ、実行後の回収を別審査 | `roles/run.jobsExecutorWithOverrides`、`run.jobs.runWithOverrides`、Project全体Invoker |

Job作成後、**実行前**にJob export、Runtime SA、Secret Version、Cloud SQL attachment、環境変数名と固定値、Image Digest、IAM policy、監査ログを**2名で照合**する。Job作成直後の「動作確認実行」は禁止。Deployerが`iam.serviceAccounts.actAs`を必要とする場合も、実行担当者には波及させない。管理者の上位権限によるJob更新余地は実行直前の再exportで抑える。

## 5. P3/P4/P5と結果不明・復旧（実行指示ではない）

1. **P3 Stage A**：本番最新Gate PASS + 担当・承認・時刻確定後、`postgres`の正規経路からStage A固定SQLのみ。Stage A検証で2 grant + role属性、Ledger SELECTなしを確認して停止。結果不明ならREAD ONLY照合まで再実行しない。
2. **P4 Stage B**：P3完了確認後、P2で承認されたJob export/IAM/digestを再照合し、承認された操作者がoverrideなしで**1回だけ**開始。結果不明・タイムアウト・ログ不達時は二度押し禁止。
3. **P5 Final verify**：別の正規Read-only主体が`secureGuardSourceInventoryRoleFinalVerify.sql`を使い、期待ACL（`grantor=portal_app`、`is_grantable=false`）、3権限、不要権限なしを検証。結果契約は以下の**3値を一緒に記録**する。

```text
direct_runtime_checks=PASS
password_null_runtime_status=NOT_DIRECTLY_VERIFIED
password_null_assurance=STAGE_A_DDL_AND_POSTGRESQL16_CI
```

4. **UNKNOWN分類**：事後READ ONLYで「Ledger SELECTなし」「`portal_app`からの期待SELECTあり」「想定外ACL/権限あり」に分類。どの分類も自動再GRANT・別主体による迂回GRANTはしない。最初の状態でも次の操作には新たな承認が必要。
5. **復旧**：障害時の責任者と承認者を事前確定。必要なら`portal_app`の正規所有者経路でLedger SELECTを先にREVOKE、次にStage A正規主体がUSAGE/CONNECTをREVOKE、依存をRead-only確認後にrole DROP。どれも**復旧専用の個別承認**が必要で、汎用SQL Job/自動cleanupは作らない。
6. **後処理**：Job実行権限/専用SA/Secret IAM/一時Job/成果物の回収可否と証跡保持を判断。実行後はProject上位権限/Job管理者の再実行可能性も含め、未決のまま自動削除・自動回収しない。

## 6. 統括へ提出する差分・承認記録欄（未記入はSTOP）

| 項目 | 記録すべき値 | 現状 |
|---|---|---|
| P1監査 | flag/extension/effective `pgaudit.log`、Data Accessログ可視性、照合日時 | **STOP**：`settings.databaseFlags`不表示、pgAudit有効の証拠なし。B案は提案のみ・未承認 |
| P1正常性 | Backup/PITR、Operation、接続/CPU、Ready/5xx、接続予算 | **実行直前に再測定** |
| 実装基準 | PR #5 HEAD SHA、CI URL、Docker scanner summary | **P2前に再照合** |
| P2対象 | SA email、Artifact Registry path、`@sha256:`、Job export SHA、timeout秒、IAM差分 | **未確定** |
| P2承認 | 承認者/作業者/二者レビュー者/日時/承認ID | **未取得** |
| P3承認 | DB担当/承認者/時間帯/Stage A preflight evidence | **未取得** |
| P4承認 | Job操作者/承認者/復旧責任者/実行時刻/IAM再照合 | **未取得** |
| P5判定 | direct結果/間接保証区分/ACL/Cloud Run Execution ID/監査ID | **未実施** |

**結論：P0のみ実装・CI上PASS。P1の構成・Backup・Operationsの一部はRead-only観測済みだが、DB文監査と実行直前Gateが未成立でSTOP。P2〜P4の個別承認、P5の本番実測は未成立。Production No-Goを維持する。**

## 7. 2026-11-10 運用者Read-only確認とB案の提案（監査契約未変更）

- `gcloud.cmd sql instances describe`：`POSTGRES_16` / `RUNNABLE`。`settings.databaseFlags`は返却JSONに現れず、`cloudsql.enable_pgaudit=on`の証拠なし。**DB文単位監査GateはSTOP**。pgAuditのDB内extension・`pgaudit.log`・ログ配送は本確認だけでは立証できない。
- 構成：`availabilityType=ZONAL`、Backup enabled、保持30件、PITR enabled、transaction log保持7日、10 GiB、storageAutoResize true、storageAutoResizeLimit=0。
- `gcloud.cmd sql backups list --limit=5`：直近5件すべて`AUTOMATED / SUCCESSFUL`。最新は2026-11-09 20:02:48.226 UTCに完了。復元の実証ではない。
- `gcloud.cmd sql operations list --limit=10`：表示された直近10件は全件`DONE`。実行直前の同時操作不存在の保証ではない。
- pgAudit設定変更はDB再起動を伴うため、共有本番ZONALインスタンスでの無断有効化を禁止。**本番フラグ変更・再起動・監査要件の暗黙変更を行わない。**
- 代替監査B案は[専用提案書](SECURE_GUARD_SOURCE_INVENTORY_ALTERNATIVE_AUDIT_PROPOSAL_20261110.md)を参照。Stage A管理経路記録とStage B固定Job/Executionログ、承認ID、固定SQL SHA、ACL before/after、独立Final verifyを連結する案。ただし**実行SQL文単位の直接監査とは同等ではない**。
- **承認の意味**：B案の設計・証跡文書作成のみ。正式採用、残余リスク受容、P1解除、P2〜P6の操作承認は含まない。担当/二者レビュー/保持先/保存期間も未確定。**P1=STOP・Production No-Go・Draft維持**。

### 公式参考（閲覧用）

- [Cloud Run IAM roles](https://cloud.google.com/run/docs/reference/iam/roles)（Jobs Executorは`run.jobs.run`と`run.executions.cancel`。With Overridesは別role）
- [Cloud Run JobのSecret mount](https://cloud.google.com/run/docs/configuring/jobs/secrets)（Volume path、Version指定、Runtime SA Accessor）
- [Cloud SQL pgAudit](https://cloud.google.com/sql/docs/postgres/pg-audit)（flag・extension・`pgaudit.log`・Data Access Logs。flag変更は再起動）
