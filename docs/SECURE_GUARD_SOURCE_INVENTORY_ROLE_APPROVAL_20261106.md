# Secure Guard｜旧本番Source Inventory専用Read-only role 作成準備（2026-11-06）

## 目的と現在のGate

- 対象は既存 **`msp-zabbix` / Cloud SQL instance `msp-customer-portal-db`**。共用Staging `secumie-sg-shared-staging-db` ではない。
- 2026-11-06に運用者が `gcloud.cmd sql users list --project=msp-zabbix --instance=msp-customer-portal-db --format="table(name,type)"` をRead-only実行。返却は `portal_app`、`postgres`、`ppap_app`、`ppap_sso_verify_app`、`sales_tools_app`、`sales_tools_migration`（すべて `BUILT_IN`）。**専用Read-only login候補は一覧から確認できなかった**。これは権限の確定調査ではなく、SQLで作成した非login/group roleや実効grantの不存在を証明しない。
- **2026-11-06 Read-only実機確定：** Cloud SQL Admin APIでinstanceは`RUNNABLE`、`asia-northeast1`、`POSTGRES_16`。DB一覧は`postgres` / **`msp_customer_portal`** / `ppap_transfer` / `ppap_sso_verify` / `sales_tools`。調査の移行元DB名は`msp_customer_portal`とする。1つのインスタンスに複数のサービスDBがあるため、他DBへのgrantや既存`PUBLIC` grantの変更は一切行わない。
- `portal_app` / PPAP / Sales Tools / `postgres` の認証情報を**Inventory本体のread-only主体として**流用しない。**2026-11-06統括承認：** この文書の事前Gateをすべて満たした場合に限り、`sg_source_inventory_ro_20261106` を **`NOLOGIN` / `PASSWORD NULL`** で作り、`msp_customer_portal`の`CONNECT`、`public`の`USAGE`、`public.schema_migrations`の`SELECT`だけ付与してよい。**本番での作成・grantはまだ未実行**。パスワード設定、`LOGIN`有効化、Inventory実行、Secret/IAM/Proxy変更、本番Migrationは今回のGoに含まれない。
- SG Draft PR #5の `scripts/secureGuardSourceInventoryReadOnly.cjs` の前提を維持。新roleを作っても、低負荷の本番接続とInventory実行には個別Goが必要。

## 作成前に必ず満たす条件（1つでも未了ならSTOP）

1. **完了：** 運用者のWindows PowerShellで次の**Cloud SQL Admin APIの列挙のみ**を実施し、対象DB`msp_customer_portal` / `POSTGRES_16` / `RUNNABLE`を確認した（出力は本節冒頭）。将来の実行直前にはinstanceの現在状態を再確認する。

   ```powershell
   gcloud.cmd sql databases list --project=msp-zabbix --instance=msp-customer-portal-db --format="table(name)"
   gcloud.cmd sql instances describe msp-customer-portal-db --project=msp-zabbix --format="yaml(name,state,region,databaseVersion)"
   ```

2. **一部完了：** 対象instance・DB名・PostgreSQL versionは確認済み。**未了：** SQL側`public.schema_migrations`の存在、既存role名衝突なし、実効grantを照合。既存の適切なRead-only主体がSQL側で見つかった場合は新規作成案に戻って再判断する。
3. 保守責任者、低負荷の実行時間、停止判断者、Portal/PPAPの遅延・5xx有無、現在接続数を確認する。既存instanceは最大25接続・直近ピーク22、**接続追加後の値で20未満**を厳守。低負荷判定なしに管理者セッションを張らない。
4. 既存 `msp-frontend-server` の `cloud-sql-proxy.service`（loopback `127.0.0.1:5432`）など**承認済みの管理経路だけ**を使用。管理用資格情報は既存の正規運用経路で扱い、Git・チャット・コマンド履歴・標準出力に展開しない。管理者接続の方法や権限が未確定ならSTOP。Proxy再起動/追加起動、Public IP、Firewall、IAM、Secretの変更を伴う迂回は禁止。
5. **承認済み（ただし上記1〜4の成立条件付き）：** 本番DBへの`NOLOGIN` role新設と上記3 grantのみ。保守日時・低負荷・管理経路・SQL側の所有者とrole候補の照合が未了なら、この承認があっても実行不可。障害/接続数の上昇時は直ちにSTOP。

### 実行順序（現時点はPreflight待ち）

1. 実行責任者・日時（低負荷時間帯）・停止判断者・Portal/PPAPの5xx/遅延・Cloud Monitoringの**直近本番DB接続数**を運用者が確認する。対象はPostgreSQL専用メトリクス **`cloudsql.googleapis.com/database/postgresql/num_backends`**（PostgreSQL Connections）。**`database`ラベルごとの表示値は5 DB合計**で判断する。`database/network/connections`はPostgreSQL用ではない。測定は60秒間隔、公開まで最大165秒遅延するため「瞬時の現在値」と扱わない。管理者接続1本を追加しても「20未満」であるため、保守的に**接続前18以下**を目安とし、メトリクスの遅延や増加傾向があればSTOP。最終判定は**接続後の`pg_stat_activity`**でも確認する。7日ピーク22という過去値は実行Goの根拠にならない。
2. 既存の `msp-frontend-server` の正規管理経路と既存 `cloud-sql-proxy.service` の稼働状態・loopback先を**Read-only**で確認。Proxyの追加起動・再起動・管理Secretの読み出しやアプリ資格情報の流用はしない。管理者のDB接続方法を特定できなければSTOP。
3. 認可済み管理DBセッション1本で、まず下記の**Read-only SQL**を実行し、`msp_customer_portal` / PG16 / ledgerの名前・所有者 / 全role / **接続追加後20未満** / 既存read-only候補とgrantを運用者がレビューする。`SELECT`結果に想定外があればSTOP。特に既存の適切なread-only主体が判明したら新roleの作成は中断し、統括へ差分を戻す。
4. すべてPASSした場合に限り、レビュー済み `scripts/secureGuardSourceInventoryRoleBootstrap.sql` を**同じ承認済み経路**で `psql -X -v ON_ERROR_STOP=1` により適用する。実行ファイルの配布方法が未承認ならSTOP（Gitから本番VMへの未承認配置を行わない）。ファイル自身にも期待DB・PG16・ledger・同名role不在・接続余裕の**トランザクション内Gate**があり、違反時は作成前に失敗する。途中エラー時は `ROLLBACK` と結果確認を優先し、繰り返し実行しない。
5. 作成後に `rolcanlogin=false`、grant 3件、DML/DDL/role membership無しを検証し、操作日時・role名・承認範囲・結果のみを制限付き記録する。**そこで終了**。Inventory用パスワード設定・LOGIN切替・Inventory本体は別Goであり実施しない。

```sql
-- Read-only SQL preflight: credentials/passwords/application row data are not returned.
SELECT current_database() AS source_db,
       current_setting('server_version') AS postgres_version,
       current_setting('max_connections')::integer AS max_connections,
       (SELECT count(*)::integer FROM pg_stat_activity
         WHERE backend_type = 'client backend') AS used_connections_including_this_session;
SELECT n.nspname AS schema_name, c.relname AS ledger_name,
       pg_get_userbyid(c.relowner) AS ledger_owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND c.relkind IN ('r','p');
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls
FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;
SELECT r.rolname,
       has_database_privilege(r.oid, current_database(), 'CONNECT') AS db_connect,
       has_database_privilege(r.oid, current_database(), 'CREATE') AS db_create,
       has_schema_privilege(r.oid, 'public', 'USAGE') AS schema_usage,
       has_schema_privilege(r.oid, 'public', 'CREATE') AS schema_create,
       has_table_privilege(r.oid, 'public.schema_migrations', 'SELECT') AS ledger_select
FROM pg_roles r WHERE r.rolcanlogin AND r.rolname !~ '^pg_' ORDER BY r.rolname;
```

## 作成SQL（本番未実行・条件付き承認済み）

実行正本は **`scripts/secureGuardSourceInventoryRoleBootstrap.sql`**。以下は権限範囲を示す抜粋であり、**抜粋だけを手作業で実行しない**。実行正本では、同じトランザクションで接続先・ledger・接続数・role衝突を検査し、作成後にロール属性と実効書込み権限を検証してからcommitする。パスワード期限は**今回の作成段階では設定しない**（別承認のLOGIN有効化時にだけ指定）。

```sql
-- PRE: current_database() = 'msp_customer_portal' を運用者が確認。
-- PRE: pg_rolesに同名のroleがなく、SQL側の所有者・接続GateがPASS。
BEGIN;
CREATE ROLE sg_source_inventory_ro_20261106 WITH
  NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD NULL;
GRANT CONNECT ON DATABASE msp_customer_portal
  TO sg_source_inventory_ro_20261106;
GRANT USAGE ON SCHEMA public TO sg_source_inventory_ro_20261106;
GRANT SELECT ON TABLE public.schema_migrations
  TO sg_source_inventory_ro_20261106;
COMMIT;
```

- **初期作成時は `NOLOGIN` + `PASSWORD NULL`**。パスワードはSQLファイル・引数・履歴に入れない。作成の成功だけでアクセスを有効化しない。
- 上記の `GRANT` 以外に、業務テーブル全体への `SELECT`、`pg_read_all_data`、`CREATE`、DML、role membership、他サービスDBの権限を付与しない。調査コードはmigration ledgerの行とその他メタデータだけを読む。
- PostgreSQLの既存 `PUBLIC` 権限（他DBへの `CONNECT` や `TEMPORARY` など）を**変更しない**。独立roleを作成してもそれらの権限が残る場合があるため、「他DBに絶対に接続できない」という主張はしない。対象データの参照権限と運用経路を限定する。
- 最終的な有効化は運用者が対話式 `psql` の `\password sg_source_inventory_ro_20261106` で強固な一時パスワードを設定し、**別途承認された期限**を明記して次のSQLを実行する。期限は短期（目安48時間以内）とし、`VALID UNTIL` が**パスワード認証のみに効く**ことに注意する。

```sql
ALTER ROLE sg_source_inventory_ro_20261106
  LOGIN VALID UNTIL '<APPROVED_EXPIRY_JST>';
```

## 有効化後・Inventory前の否定検査

作成・有効化それぞれの操作証跡は、role名・日時・実DB名・担当者・承認ID・成功/失敗のみを制限付き記録し、パスワードは記録しない。実行者は少なくとも次をチェックする。

- `pg_roles`：role名と`rolcanlogin`、`rolsuper=false`、`rolcreatedb=false`、`rolcreaterole=false`、`rolreplication=false`、`rolbypassrls=false`、有効期限。作成直後は `rolcanlogin=false` であること。
- 対象DB・スキーマ・ledgerだけに必要権限があること：`has_database_privilege(role, db, 'CONNECT')`、`has_schema_privilege(role, 'public', 'USAGE')`、`has_table_privilege(role, 'public.schema_migrations', 'SELECT')`。
- `has_database_privilege(role, db, 'CREATE')=false`。非system schemaの`CREATE`、非system tableの`INSERT` / `UPDATE` / `DELETE` / `TRUNCATE`が**継承/PUBLICを含めすべてfalse**。他roleへの`SET ROLE`到達可否も確認する。
- ログイン後の `scripts/secureGuardSourceInventoryReadOnly.cjs` 自体が同じ権限否定検査、期待DB名、`BEGIN READ ONLY`、接続余裕（20未満）、3秒statement/1秒lock timeoutを満たすこと。PASSしなければSTOP。SQLの書込み試験は**本番で行わず**、権限関数で判定する。
- `schema_migrations`が `public` 以外にある、所有者が想定外、対象Ledger不在、既存顧客/PPAPの障害、負荷上昇のいずれもSTOP。権限を広げたり別アカウントへ切り替えて続行しない。

## 調査直後の無効化・廃止手順案（実行は別途承認）

1. Inventory実行が完了または中断した時点で、**最優先でログイン無効化**する。`VALID UNTIL` の期限到来だけに依存しない。

   ```sql
   ALTER ROLE sg_source_inventory_ro_20261106 NOLOGIN PASSWORD NULL;
   ```

2. roleが使用中でないことと調査証跡を確認。許可を得て、roleに付けた`SELECT`、`USAGE`、`CONNECT`を取り消す（既存 `PUBLIC` grantには触れない）。

   ```sql
   REVOKE SELECT ON TABLE public.schema_migrations
     FROM sg_source_inventory_ro_20261106;
   REVOKE USAGE ON SCHEMA public FROM sg_source_inventory_ro_20261106;
   REVOKE CONNECT ON DATABASE msp_customer_portal
     FROM sg_source_inventory_ro_20261106;
   ```

3. 権限/依存関係・監査保全を確認してから`DROP ROLE`を**別承認**で検討。`REASSIGN OWNED`や`DROP OWNED`の一括操作は行わない。パスワード無効化と`NOLOGIN`までを先に実施する。

## このPRでの状態

**条件付き作成Goは取得済み・未実行。** `msp-customer-portal-db` の**DB名`msp_customer_portal`・PostgreSQL 16・RUNNABLEはRead-only実測済み**。2026-11-09にSQL側のrole/ledger/実効grant、管理者経路、接続余裕をRead-only確認した（下記記録）。ただしrole作成直前の保守日時・責任者・サービス正常性・接続余裕の再Gateと、統括の実行判断は別途必要。使い捨てPostgreSQL 16のbootstrap否定テストは本番Gateの代替ではない。専用roleの本番作成も旧Production Source Inventoryも未実施。既存Portal/PPAP、SG Staging database/role/Secret、Migration/Trafficは変更しない。**Production No-Go / PR Draft維持。**

## 2026-11-09 共用Cloud SQL管理者資格情報の復旧実績

- 実行責任者・停止判断者：萩坂。対象は`msp-zabbix` / `msp-customer-portal-db`の`postgres`のみ。
- 既存の無効化済み`portal-db-root-password`は再利用せず、管理者専用Secret `msp-customer-portal-db-postgres-admin-password` のVersion `1`を新規登録した。Version `1`は`ENABLED`。パスワード値および復元可能な情報はGit・チャット・実行ログへ記録していない。
- Secretは保護Tag `msp-zabbix/admin-secret-protection=protected` とIAM Deny Policy `portal-admin-secret-protection`の対象である。アプリケーションService Accountへ管理者Secretを配布しない。管理責任者は萩坂。
- `gcloud sql users set-password postgres --project=msp-zabbix --instance=msp-customer-portal-db --prompt-for-password`を対話入力で1回実行。Cloud SQL Operation `3ce2f0f5-09c4-435b-8341-83690000002b`（`UPDATE_USER`）は2026-11-09 10:21:00 JSTに`DONE`、エラーなし。
- 既存`msp-frontend-server`の`cloud-sql-proxy.service`（`active` / `enabled`、`127.0.0.1:5432`）経由でRead-only接続確認を実施。`current_user=postgres`、`current_database=msp_customer_portal`、PostgreSQL `16.14`、確認時client connection数`4`を確認した。業務テーブル参照、DDL、DML、role/grant変更、Migrationは実施していない。
- 事後確認：Cloud SQLは`RUNNABLE`、PortalとSales Toolsの正式healthはHTTP 200、Portal / Sales Tools / PPAP 3サービスの直近30分5xxは各0件、5サービスはReady。変更後のCloud SQL CPU利用率は約10.39%、PostgreSQL connection数は2。Cloud Run再起動・再デプロイ、既存アプリSecret変更は0件。
- 今後のローテーションまたは緊急再設定は、最新backup/PITR、競合Operation、接続数・CPU、Portal/PPAP/Sales Tools、Secret保護Tag/Deny、`postgres`依存の不在を再Gateし、既存Secretへ新Versionを1件登録してから対話式`set-password`を1回だけ実行する。結果不明時はOperationを照合してSTOPし、自動再試行・旧値推測・追加Version作成をしない。接続試験とサービス正常性確認後、旧Versionの扱いは別承認で決定する。
- この復旧は管理者接続経路を確立した事実だけを示す。`sg_source_inventory_ro_20261106`の作成、SQL preflight、GRANT、Inventory、Migrationを承認または実行したものではない。これらは引き続き**No-Go**で、本文の個別Gateと統括承認を要する。

## 2026-11-09 旧本番SQLメタデータRead-only調査

- 実行前Gate：Cloud SQLは`RUNNABLE`、競合Operation 0、既存Proxyは`active` / `enabled`。Portal / Sales Tools / PPAP 3サービスはReady、直近30分5xxは各0件。PostgreSQL接続数は実行前最新2・30分最大5、CPUは最新約9.95%・30分最大約13.49%。
- 管理者セッション1本を既存Proxy経由で使用し、`BEGIN TRANSACTION READ ONLY`から`COMMIT`までメタデータだけを照合した。接続先`msp_customer_portal`、PostgreSQL `16.14`、`max_connections=25`、セッションを含むclient connection数`4`。
- `public.schema_migrations`は通常テーブル（`relkind=r`）として存在し、所有roleは`portal_app`。対象Ledgerの存在・種別はBootstrap SQLの前提と一致する。
- 候補名`sg_source_inventory_ro_20261106`は存在せず、同名衝突なし。
- 既存の非system login主体に、再利用可能な専用Read-only主体は確認できなかった。`portal_app`は対象public 23テーブルすべてにSELECT/INSERT/UPDATE/DELETE/TRUNCATEを持ち、DB/Schema CREATEとLedger SELECTも持つため不適格。他のアプリ主体は別サービス資格情報であり、複数が`cloudsqlsuperuser` membership、DB/Schema CREATE等の管理権限を持つ。対象23テーブルへの権限が0件の主体もLedger SELECTを持たず、別サービスまたはCloud SQL管理用roleであるため流用しない。
- membership実測では`portal_app`、`postgres`、`ppap_app`、`ppap_sso_verify_app`、`sales_tools_app`等が`cloudsqlsuperuser`のmember。既存権限は今回変更しないが、専用Read-only主体を既存アプリ資格情報から分離する必要性を裏付ける。
- 新roleを`NOLOGIN` / `NOINHERIT` / `PASSWORD NULL`、role membershipなしで作成し、明示的な`CONNECT`（対象DB）、`USAGE`（public schema）、`SELECT`（`public.schema_migrations`）だけを付与する既存案は、調査対象のLedgerメタデータ参照に対して最小。LOGIN有効化前は接続主体にならず、業務23テーブルのDML/DDL、DB/Schema CREATE、他role membershipを付与しない既存否定検査を維持する。
- 調査ではCREATE ROLE、ALTER ROLE、GRANT/REVOKE、DDL/DML、Inventory、Migrationを実施していない。本番変更0件。role作成・3 GRANT・LOGIN有効化・Inventoryは引き続き**No-Go**で、作成直前Gateと別の実行承認を要する。
