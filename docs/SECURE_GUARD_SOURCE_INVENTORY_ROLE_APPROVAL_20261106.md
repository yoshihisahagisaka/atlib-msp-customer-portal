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
- 新roleを`NOLOGIN` / `NOINHERIT` / `PASSWORD NULL`で作成し、新roleを他roleのmemberにせず、明示的な`CONNECT`（対象DB）、`USAGE`（public schema）、`SELECT`（`public.schema_migrations`）だけを付与する既存案は、調査対象のLedgerメタデータ参照に対して最小。LOGIN有効化前は接続主体にならず、業務23テーブルのDML/DDL、DB/Schema CREATE、他roleからの権限継承を拒否する既存否定検査を維持する。
- 調査ではCREATE ROLE、ALTER ROLE、GRANT/REVOKE、DDL/DML、Inventory、Migrationを実施していない。本番変更0件。role作成・3 GRANT・LOGIN有効化・Inventoryは引き続き**No-Go**で、作成直前Gateと別の実行承認を要する。

## 2026-11-09 Bootstrap実行権限の最終Read-only確認

- 実行前Gate：Cloud SQLは`RUNNABLE`、競合Operation 0、既存Proxyは`active` / `enabled`。Portal / Sales Tools / PPAP 3サービスはReady、直近30分5xxは各0件。PostgreSQL接続数は最新2・30分最大5、CPUは最新約9.61%・30分最大約13.88%。
- 既存Proxy経由の管理者セッション1本で、`BEGIN TRANSACTION READ ONLY`、statement timeout 3秒、lock timeout 1秒を設定してGrant Optionだけを実測し、`COMMIT`した。本番変更0件。
- 実行主体`postgres`、Ledger所有者`portal_app`。`postgres`はDatabase `CONNECT WITH GRANT OPTION=true`、Schema `USAGE WITH GRANT OPTION=true`だが、`public.schema_migrations`の`SELECT WITH GRANT OPTION=false`。また`portal_app`のmemberではなく、`SET ROLE portal_app`も不可。
- よって既存Bootstrapの最初の2 GRANTは実行可能だが、3つ目のLedger SELECT GRANTは実行不能。現行スクリプトは単一トランザクションのため失敗時に永続的な途中role/grantは残さない設計だが、実行不能と判明したスクリプトを本番で試行しない。**現行BootstrapはNo-Go**。
- PostgreSQL 16公式仕様では、`NOLOGIN`は初期セッション主体としてのログインを禁止し、`PASSWORD NULL`はパスワード認証を常に失敗させる。PG16の`NOINHERIT`は、そのroleが他roleのmemberに追加される際のmembership inheritance既定値に作用する。membership自体を作る指定ではない。
- 非SUPERUSERの`CREATEROLE`主体は、作成したroleに対する管理用`ADMIN OPTION`を暗黙に持ち、`createrole_self_grant`設定により作成者が新roleをINHERIT/SET可能なmembershipを自動取得し得る。これは「作成者が新roleを管理・利用できる」方向であり、「新roleが別roleのmemberとなり権限継承する」方向ではない。Bootstrapの`pg_auth_members.member = reader`否定検査は後者を拒否しており、目的に整合する。ただし既存CIは通常PostgreSQL 16のbootstrap superuserで実行しており、Cloud SQLの非SUPERUSER `postgres`とLedger別所有者・Grant Option不足を再現していない。
- 仕様根拠：PostgreSQL 16公式の[CREATE ROLE](https://www.postgresql.org/docs/16/sql-createrole.html)、[Role Membership](https://www.postgresql.org/docs/16/role-membership.html)、[Client Connection Defaults](https://www.postgresql.org/docs/16/runtime-config-client.html)、[GRANT](https://www.postgresql.org/docs/16/sql-grant.html)。
- 最小是正候補は、DDL前Gateに3つの`WITH GRANT OPTION`検査を追加し、不足時はrole作成前に固定STOPすること、および非SUPERUSER CREATEROLE実行者と別Ledger所有者を用いる合成回帰試験を追加すること。Ledger権限の取得方法は未決定であり、`portal_app`資格情報流用、membership付与、`SET ROLE`、所有者変更、権限拡張を独自に行わない。
- 解消には「Ledger所有者または正規にGrant Optionを持つ別の承認済み実行主体・手順」の決定が必要。設計変更と本番権限変更は別承認とする。role作成、GRANT、LOGIN有効化、Inventory、Migrationは引き続き**No-Go**。

### 2026-11-09 DDL前Gateと非SUPERUSER CIの最小是正

- `scripts/secureGuardSourceInventoryRoleBootstrap.sql`の既存DDL前Gateへ、Database CONNECT、public Schema USAGE、Ledger SELECTの各`WITH GRANT OPTION`検査を追加した。いずれかが不足する場合は、それぞれ固定STOPコードで`CREATE ROLE`前に終了する。fallback、別roleへの切替、自動権限拡張は追加していない。
- 使い捨てPostgreSQL 16試験を、非SUPERUSERかつCREATEROLEの実行者と、別role所有のLedgerを用いるfixtureへ変更した。3つのGrant Optionを個別に不足させ、各ケースでDDL前STOP、候補role不在、ACL不変を確認。3つすべてを付与した合成正常系ではBootstrapがPASSした。
- PostgreSQL 16が作成者へ与え得る新roleの管理用membershipは逆方向として扱い、新role自身が他roleのmemberにならないことを検証した。正常作成後のNOLOGIN / NOINHERIT / PASSWORD NULL相当属性、DB/Schema CREATEなし、Ledger以外の業務表権限なし、DMLなしも既存どおりPASS。
- 検証結果：非SUPERUSER Bootstrap統合試験 1 PASS / 0 FAIL、通常TypeScript buildと既存テスト 62 PASS / 0 FAIL、Secure Guard migration typecheck PASS。GCP・本番DB接続、role作成、GRANT、Inventory、Migrationは0件。
- このオフライン実装・CI合格は、本番BootstrapのGoを意味しない。本番`postgres`はLedger SELECT Grant Optionを持たず、正規の付与主体・承認済み手順は未決定。**Production No-Go / PR Draftを維持する。**

## 2026-11-09 Ledger SELECT付与経路のFit/Gap

### 確定事項と推奨候補

- PostgreSQL 16では、object所有者は対象objectの全Grant Optionを暗黙に持つ。実測済み所有者`portal_app`は、`sg_source_inventory_ro_20261106`へLedger SELECTだけを直接付与できる仕様上の主体である。`postgres`はLedger SELECT Grant Optionを持たず、`portal_app`のmemberでもSET可能でもないため、現行の単一主体Bootstrapは実行不能。
- 現時点の推奨候補は、**所有者による直接GRANTを含む二段階方式**。ただし`portal_app`資格情報の安全な管理操作経路は未確認であり、方式Goではない。既存アプリ資格情報をInventoryのログイン主体として流用せず、所有者として1文のLedger GRANTを行うことについても、正規経路・担当者・監査・資格情報非露出を別承認する。
- 所有者以外の正規Grant Option保有主体は未確定。追加の実環境確認が許可された場合は、`pg_class.relacl`を`aclexplode()`し、`public.schema_migrations`のSELECTを`is_grantable=true`で保持するgrantee・grantorだけをRead-only列挙する。該当候補はrole属性、LOGIN、membership、管理責任、認証経路を別途照合し、Cloud SQL内部roleや他サービス主体を自動採用しない。

### 二段階の最小実行契約案（実装・本番実行は未承認）

1. **Stage A（承認済みrole管理主体、候補`postgres`）**：単一トランザクションで全既存Gateを確認し、`NOLOGIN / NOINHERIT / PASSWORD NULL`の専用roleを作成。Database CONNECTとpublic Schema USAGEだけを付与し、Ledger SELECT・業務表権限・DML/DDL・他roleからの継承がないことを検証してcommitする。
2. **Stage B（Ledger所有者または正規Grant Option主体）**：別トランザクションで、対象DB・PG16・Ledger所有者・候補role名と厳格なrole属性・Stage Aの2権限・業務表権限なしを再検査した後、`GRANT SELECT ON TABLE public.schema_migrations TO sg_source_inventory_ro_20261106`だけを実行する。直後にLedger SELECTあり、Ledger書込みなし、業務表権限なしを検証してcommitする。
3. **Final verify（Read-only）**：role属性、3権限、業務表DML/DDLなし、候補roleが他roleのmemberでないこと、grantorを照合して終了する。ここではLOGIN・password・Inventoryを有効化しない。
4. LOGIN有効化、期限付きpassword、Inventory本体は従来どおり別Gate・別承認とする。

### 中断・結果不明・復旧

- Stage Aのトランザクション失敗は全体ROLLBACK。Stage A commit後に停止した場合、NOLOGIN roleとCONNECT/USAGEだけが残る。ログイン不能でLedger・業務表の参照権限を持たないためfail-closedだが、自動継続・自動削除はしない。
- Stage Bの結果不明時は再GRANTせず、先にRead-onlyでLedger SELECTの有無とACL上のgrantorを確認する。GRANT 1文はトランザクション単位だが、観測不能を成功扱いしない。
- 廃止復旧は逆順で、Ledgerの正規grantorがLedger SELECTをREVOKEし、Stage A実行主体がSchema USAGEとDatabase CONNECTをREVOKEする。その後、依存権限0件とNOLOGINを確認して候補roleだけをDROPする。`DROP OWNED`、`REASSIGN OWNED`、既存PUBLIC権限変更は行わない。Stage B未実行ならLedger REVOKEは不要だが、Read-onlyで不存在を確認する。
- 復旧に必要な各主体・資格情報・操作も別承認とし、片方の主体で権限を迂回しない。

### 使い捨てPostgreSQL 16合成検証

- 非SUPERUSER / CREATEROLEのStage A主体と、別roleのLedger所有者で検証。Stage A commit後の中断状態は`rolcanlogin=false`、Ledger SELECT=false、業務表SELECT=false。
- 所有者によるStage B後はCONNECT=true、USAGE=true、Ledger SELECT=true、業務表SELECT=false、Ledger INSERT=false。最小3権限だけが成立した。
- 所有者がLedger SELECTをREVOKEし、Stage A主体がUSAGE/CONNECTをREVOKEした後、Stage A主体の管理用ADMIN権限で候補roleをDROPでき、role残存0件を確認した。
- これはオフラインでの方式適合確認であり、本番の所有者認証経路、ACL上の他Grant Option主体、実行者、監査方法を証明しない。

### 実装Fit/Gapと未確認事項

- 現行Bootstrapは3つのGrant Optionを単一主体へ要求するため、二段階方式とは不整合。方式選定後にStage A、Stage B、Final verifyを責任主体別の明示スクリプトへ最小分割し、各段階の固定Gate・中断・結果不明・復旧試験を追加する必要がある。現時点では本番スクリプトを変更しない。
- 追加Read-only確認候補：Ledger ACLのgrantable grantee/grantor、`portal_app`を所有者として使用する既存の正規管理経路、資格情報を表示せず対話・実行できる方法、実行責任者、監査記録先。値の取得や既存アプリ接続への流用は行わない。
- Ledger ACLの追加調査は、業務行を読まず次のメタデータだけを対象とする。結果に現れたroleをそのまま採用せず、正規管理主体かを別途審査する。

  ```sql
  SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
              ELSE pg_get_userbyid(acl.grantee) END AS grantee,
         pg_get_userbyid(acl.grantor) AS grantor,
         acl.privilege_type,
         acl.is_grantable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(
    COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
  WHERE n.nspname = 'public'
    AND c.relname = 'schema_migrations'
    AND acl.privilege_type = 'SELECT'
  ORDER BY grantee, grantor;
  ```

- 二段階方式の実装、`portal_app`または別grantorによる本番GRANT、復旧操作、role作成はいずれも未承認。**Production No-Go / PR Draftを維持する。**

## 2026-11-09 二段階Bootstrapのオフライン実装・検証

### 実装した責任境界

- 既存の単一主体Bootstrapは、本番実行正本として置き換えず、そのまま保持した。
- `scripts/secureGuardSourceInventoryRoleStageA.sql`を追加した。`postgres`相当の非SUPERUSER / CREATEROLE主体を想定し、対象DB、PostgreSQL 16、Ledgerと所有者、接続余裕、同名role不存在、CONNECT / USAGE Grant OptionをDDL前に検査する。単一トランザクションで`NOLOGIN / NOINHERIT / PASSWORD NULL`のroleを作成し、Database CONNECTとSchema USAGEだけを付与する。Ledger SELECT、業務表権限、DML / DDL、readerから他roleへのmembershipがないことを確認してcommitする。
- `scripts/secureGuardSourceInventoryRoleStageB.sql`を追加した。Stage A完了状態、Ledger所有者、実行主体、Ledger SELECT Grant Option、既存SELECT不存在、不要権限不存在をDDL前に検査する。実行主体はLedger所有者自身に限定し、Ledger SELECTだけを単一トランザクションで付与する。既にSELECTがある場合は、結果不明後の再実行として固定STOPし、自動再GRANTしない。
- `scripts/secureGuardSourceInventoryRoleFinalVerify.sql`を追加した。Read-onlyトランザクションで、role属性、CONNECT / USAGE / Ledger SELECT、Ledger grantor、業務表・DML・DDL権限なし、readerから他roleへのmembershipなしを最終確認する。LOGIN有効化、password設定、Inventory実行は含まない。
- 各Stageにfallback、別roleへの自動切替、権限拡張、自動再試行、自動削除を追加していない。想定外の所有者・role・ACL・権限は固定STOPとする。

### PostgreSQL 16統合試験

- 使い捨てPostgreSQL 16で、非SUPERUSER / CREATEROLEのStage A主体と、別roleのLedger所有者を再現した。
- Stage A正常系、Stage Aの検証失敗時ROLLBACK、Stage A後中断、Stage A再実行STOP、Stage B実行主体不正STOP、Stage B Grant Option不足STOP、Stage B正常系、Stage Bトランザクション失敗時のStage A状態維持、Stage B再実行STOP、Final verify正常系、想定外業務表権限STOP、逆順復旧を確認した。
- 復旧リハーサルでは、所有者によるLedger SELECT REVOKE、Stage A主体によるUSAGE / CONNECT REVOKE、明示ACL依存0件、候補role DROP、role残存0件を確認した。これは本番復旧の実行承認ではない。
- 統合試験結果：既存単一主体Bootstrap 1 PASS / 0 FAIL、二段階Bootstrap 1 PASS / 0 FAIL。通常回帰試験 62 PASS / 0 FAIL、Secure Guard migration typecheck PASS。
- GitHub Actionsの既存PostgreSQL 16 Jobへ二段階統合試験を追加した。既存単一主体試験と二段階試験は同一の使い捨てservice上で順次実行し、相互に残存role / DBを残さない。

### PASSWORD NULL検査と残る本番Gate

- PostgreSQL 16では、非SUPERUSERが`pg_roles.rolpassword`を参照すると、実際にpasswordがNULLでもマスク値`********`として観測される。したがってStage A / Bで`pg_roles.rolpassword IS NULL`を真偽判定に使用しない。
- PASSWORD NULLは、権限のある最終検証主体が`pg_authid.rolpassword IS NULL`で確認する。参照権限がない場合、Final verifyは固定STOPし、推測で完了扱いしない。Cloud SQL本番でFinal verifyを行う正規主体・経路は別途確認と承認が必要である。
- `portal_app`の正規管理経路と資格情報非露出の実行方法は未確認であり、Stage Bの本番実行主体は確立していない。オフラインCIの合格は、本番role作成、GRANT、LOGIN有効化、Source InventoryのGoを意味しない。
- GCP・本番Cloud SQLへの接続または変更は0件。**Production No-Go / PR Draftを維持する。**

## 2026-11-10 Stage B管理経路・Final verify主体のRead-only調査

### 実行前Gate

- PR #5のlocal / remote HEADは`4ea05c47cc3e16e877d2a1f711921785d9e1bd03`で一致した。
- Cloud SQL `msp-customer-portal-db`は`RUNNABLE`、PostgreSQL 16.14、競合中Operation 0件。既存`msp-frontend-server`はRUNNING、既存`cloud-sql-proxy.service`はactive / enabled。
- PortalとSales Toolsの承認済みhealth endpointはHTTP 200。Portal、Sales Tools、PPAP download / upload / virus-scanの5サービスはReadyで、直近30分のHTTP 5xxは各0件。
- 直近30分のCloud SQL CPUは最新11.93%、最大13.17%。5つのDBを合算したclient connection数は最新6、最大6で、管理者セッション追加後も20未満のGateを満たした。

### SQLメタデータ実測

- 既存Proxy経由の`postgres`セッション1本で、`BEGIN TRANSACTION READ ONLY`、statement timeout 3秒、lock timeout 1秒を設定した。接続先は`msp_customer_portal`、serverはPostgreSQL 16.14、当該セッションを含むclient connection数は4。全照会後に`COMMIT`した。
- `public.schema_migrations`の所有者は`portal_app`。ACLのSELECT行はgrantee=`portal_app`、grantor=`portal_app`、`is_grantable=false`の1行だけだった。所有者以外の明示的なSELECT Grant Option主体は確認されなかった。object所有者が持つ暗黙のgrant権限は、この明示ACLの`is_grantable=false`とは区別する。
- `postgres`に対する`has_table_privilege(current_user, 'pg_catalog.pg_authid', 'SELECT')`はfalse。`pg_authid`のrecordまたは`rolpassword`は取得していない。`pg_roles.rolpassword`のマスク値もPASSWORD NULLの証拠として使用していない。

### `portal_app`管理経路のFit/Gap

- Secret Managerの`portal-db-password`はVersion 1がenabled。Cloud Run `msp-customer-portal`は`DB_USER=portal_app`、対象DB / Cloud SQL socket、`portal-db-password:latest`を使用している。Secret payloadは取得していない。
- Secret単位のAccessorはPortal Runtime SA、monthly report SA、Compute Engine default SA。萩坂はProject Ownerとして上位IAMを持つ。直近30日の対象Secret AccessSecretVersion監査記録は取得結果0件だったため、人間による既存のStage B実行実績または専用監査経路の証拠にはならない。
- 既存VM / Proxy / Git管理外`.env`を用いるmigration運用はCanonicalにあるが、これはアプリケーション接続の運用である。アプリ資格情報を表示せず、Ledger所有者として1文のGRANTだけを実行し、誰が承認・実行・監査するかを定めたStage B専用手順は未確立。
- したがって、仕様上の正規grantor候補はLedger所有者`portal_app`に限定できたが、正規の管理実行経路は**Gap**。Secret取得や`portal_app`ログインは今回実施しておらず、別承認なしに既存アプリ資格情報を使用しない。

### Final verifyのFit/Gapと判定

- 現行`secureGuardSourceInventoryRoleFinalVerify.sql`はPASSWORD NULLを`pg_authid`で確定する。Cloud SQLの`postgres`はSELECT権限を持たないため、現行スクリプトは固定STOPとなり、本番で完走できない。
- `portal_app`もPASSWORD NULL検証主体として承認・立証されていない。権限付与、SET ROLE、別カタログのマスク値、認証試行による迂回は採用しない。
- Stage Bには、`portal_app`を使う専用の資格情報非露出手順、実行責任者、監査方法、結果不明時の照合を別承認する必要がある。Final verifyには、PASSWORD NULLを権限拡張なしで証明する承認済み方式、または検証契約の設計変更とオフライン回帰試験が必要である。
- 今回はrole作成、GRANT / REVOKE、DDL / DML、`portal_app`接続、Secret payload取得、Stage A / B / Final verify、Inventory、Migrationを実施していない。本番DBのRead-only transaction以外の変更0件、GCP変更0件。**Production No-Go / PR Draftを維持する。**

## 2026-11-10 Decision: Stage B一時ワークロードとFinal verify保証境界

### 決定

- Stage Bは、通常Portalプロセスや管理VMの`.env`から実行せず、固定SQLだけを内包する一回限りのCloud Run Jobを本番候補とする。Jobの配置・IAM・実行は本書の実装完了によって承認されず、別の実行前Gateと統括承認を要する。
- `portal_app`資格情報はLedger所有者としてStage Bの1文を実行するためだけに使い、Source InventoryのLOGIN主体にはしない。Secretは環境変数に展開せず、Secret Manager Version 1を専用volumeの`/var/run/secrets/portal-db-password/password`へmountする。runnerは値・driver error・接続文字列をログへ出さない。
- Final verifyは、本番で直接観測できる項目と、Stage A DDLおよびPostgreSQL 16 CIで保証する項目を分離する。直接観測できないPASSWORD NULLをPASSと表示せず、`NOT_DIRECTLY_VERIFIED`と`STAGE_A_DDL_AND_POSTGRESQL16_CI`を返す。これはBootstrap全体の無条件PASSではない。

### Stage B固定runner

- `scripts/secureGuardSourceInventoryStageBJob.cjs`を追加した。DB名、DB user、Cloud SQL instance、Secret file path、明示承認値を固定値照合し、ずれがあればSecret読出し・接続前にSTOPする。
- runnerが実行できるSQLは`secureGuardSourceInventoryRoleStageB.sql`だけであり、改行を正規化したSHA-256をコード内の承認値と照合する。任意SQL、CLI引数、fallback、別user、別DB、別instance、自動再試行を受け付けない。
- SQLは既存どおり単一トランザクションで、事前Gate、`GRANT SELECT ON TABLE public.schema_migrations`の1文、grantor / 最小権限の事後検査、COMMITだけを実行する。query dispatch後の例外は`STAGE_B_RESULT_UNKNOWN_OR_FAILED`として固定STOPし、再送しない。
- ログは固定event / ENTER / COMPLETE / STOP codeだけ。Cloud Runのexecution / task / image digest / timestampはplatformのresource labelとAdmin Activityで追跡する。Secret、SQL error、URL、接続文字列をアプリログへ含めない。
- `scripts/Dockerfile.secure-guard-source-inventory-stage-b`はrunnerとStage B SQLだけをruntimeへ含め、非root userで固定ENTRYPOINTを実行する。通常Portal server、migration、Inventoryコードは含めない。

### 本番候補構成とIAM境界（未適用）

- 候補Job名は`secure-guard-source-inventory-stage-b-once`、regionは`asia-northeast1`。imageは検証済みdigest固定、Cloud SQL attachmentは`msp-zabbix:asia-northeast1:msp-customer-portal-db`、task 1、parallelism 1、max retries 0、短いtimeout、Schedulerなし、実行時overrideなしとする。
- 推奨runtime identityは専用SA。`roles/cloudsql.client`と、`portal-db-password` Secret単位の`roles/secretmanager.secretAccessor`だけを付与する。既存Portal Runtime SAの流用はIAM変更を減らすが、既存の複数Secret accessとアプリ責務を一時管理Jobへ持ち込むため不採用候補とする。
- 配置主体と実行主体を分ける。実行担当者にはJob単位の`roles/run.jobsExecutor`相当だけを候補とし、`run.jobs.runWithOverrides`、Job update、Service Account Userを与えない。Google公式では`run.jobs.run`と`run.jobs.runWithOverrides`は別permissionである。
- Cloud Run JobのSecret volumeはJob runtime SAのSecret Accessorを必要とし、Cloud SQL接続はCloud SQL Clientを必要とする。根拠：[Cloud Run Job IAM permissions](https://cloud.google.com/run/docs/reference/iam/permissions)、[Cloud Run Job secrets](https://cloud.google.com/run/docs/configuring/jobs/secrets)、[Cloud SQL from Cloud Run](https://cloud.google.com/sql/docs/postgres/connect-run)。
- 専用SA作成、Secret IAM、Cloud SQL Client、Job作成、Build / Push、Invoker付与はいずれも本番変更であり今回未実施。Project Owner等の上位権限保有者がJobやimageを変更できる残存管理リスクは、実行前のJob export / image digest / IAM差分照合と二者レビューで扱う。

### 結果不明・監査・復旧

- COMPLETE時も、別主体のFinal verifyでACLのgrantee / grantor、3権限、不要権限なしを確認するまで完了扱いしない。UNKNOWN時はJobを再実行せず、同じRead-only確認で「SELECTなし」「期待するowner-granted SELECTあり」「想定外ACL」のいずれかに分類する。
- Cloud Run execution、Build ID、source SHA、image digest、Job export、Secret version参照、固定runner event、Final verify結果を一つの実行証跡として保全する。DB側のstatement auditが有効であることは未確認であり、実行前にログ設定をRead-only確認する。監査設定変更は別承認とする。
- 復旧主体はLedger所有者`portal_app`。既存統合試験どおりLedger SELECTを先にREVOKEし、Stage A主体がUSAGE / CONNECTをREVOKEし、依存0件後にroleをDROPする。復旧用の任意SQL runnerや自動cleanupは作らず、各操作は別承認とする。

### Final verifyの直接・間接保証

| 項目 | 本番で直接検証 | 保証区分 |
|---|---:|---|
| NOLOGIN / NOINHERIT / 非SUPERUSER等のrole属性 | Yes (`pg_roles`) | Direct |
| CONNECT / USAGE / Ledger SELECT | Yes | Direct |
| Ledger grantor=`portal_app` / grantable=false | Yes (ACL) | Direct |
| 業務表権限、DML / DDL、readerから他roleへのmembershipなし | Yes | Direct / fail-closed |
| PASSWORD NULL | No (`postgres`は`pg_authid` SELECT不可) | Stage Aの固定DDL + PostgreSQL 16 CIによるIndirect |

- Final verifyのdirect検査が通過すると`direct_runtime_checks=PASS`を返すが、同時に`password_null_runtime_status=NOT_DIRECTLY_VERIFIED`を必ず返す。運用記録は両方を保持し、単独のPASSへ要約しない。
- CIはStage A後に権限のある使い捨てPostgreSQL 16主体で`pg_authid.rolpassword IS NULL=true`を実測する。本番では`pg_authid`権限追加、SET ROLE、マスク値解釈、認証試行による代替を行わない。

### オフライン検証と残存Gate

- 通常回帰試験はStage B runnerの固定SQL1回、設定drift事前拒否、SQL digest不一致、Secret空、query結果不明、秘密・driver error非出力、retry 0、専用Dockerfileを検証する。
- PostgreSQL 16統合試験はStage A / B正常系、各事前STOP、Stage A中断、Stage B rollback / unknown再実行STOP、直接Final verify、想定外業務表権限STOP、逆順復旧を維持し、PASSWORD NULLのCI実測を追加する。
- 専用imageのオフラインBuildは成功し、設定なし起動はSecretへ触れる前に`CONFIG_EXPLICIT_APPROVAL_REQUIRED`でSTOPした。既存lockfileのproduction依存についてnpm audit警告が出ているため、imageの脆弱性評価は本番Build前の残存Gate。自動`npm audit fix`や依存更新は今回行わない。
- 本番Goには、専用SA / IAM方式、Job配置・実行担当者、実行時刻、Cloud SQL / service health Gate、DB statement auditの確認、Build / image digest、Job export、Secret Version 1 mount、復旧承認の確定が必要。
- 本番Stage A / B / Final verify、Secret payload取得、IAM / Cloud Run変更、LOGIN有効化、Inventory、Migrationは未実施。**Production No-Go / PR Draftを維持する。**

## 2026-11-10 Stage B専用イメージの依存分離・Runtime Hardening（オフライン）

### 目的と変更境界

- 統括レビューで指摘されたNode.js 20 EOLと、Portal全体のproduction依存をStage B Jobへ持ち込む問題を解消する。Stage B固定SQL、SHA-256、認証・ACL・トランザクション、Final verifyの保証境界は変更しない。
- `scripts/Dockerfile.secure-guard-source-inventory-stage-b`はNode.js 24のDigest固定ビルドステージとDistroless Node.js 24のDigest固定実行ステージへ分離。実行イメージにはShell、npm、Portal/PPAPの業務コード、Migration、Inventoryを含めない。実行ユーザーは`nonroot`、固定CMDはStage B runnerのみ。
- `scripts/secure-guard-stage-b/package.json`と専用lockfileを新設し、直接依存を`pg@8.22.0`のみに限定する。lockfileは既存Portal lockfileから同一の`pg`と推移依存のversion/integrityを抜き出したもので、Portal本体の依存は変更しない。
- Dockerfile固有の`.dockerignore`でコンテキストを専用runner、固定SQL、最小依存manifest/lockfileに限定する。他のDockerfileのBuild対象は変更しない。
- Stage B SQLは既存のDigest照合を維持する。Secretは`/var/run/secrets/portal-db-password/password`のファイルmountとし、環境変数・ログへの展開を行わない。

### 追加CIの証明対象

1. Node.js 24、非root UID、`pg`読込み成功、Express / Puppeteer / bcrypt / Nodemailer不存在を実行イメージ内部で確認する。
2. 本物の認証情報を使わない合成ファイル（0444）をroot所有相当のマウントで読み、`--network none`・Cloud SQL socket未接続状態で`ENTER`後に固定`STAGE_B_RESULT_UNKNOWN_OR_FAILED`となることを確認する。ファイル本文をログに出さない。
3. TrivyをCommit固定のActionで実行し、実行イメージのOS/ライブラリの`CRITICAL,HIGH`を`ignore-unfixed=false`でFail-closedにする。スキャンが成功するまで脆弱性Gateは未解除とする。
4. 既存の通常回帰・Migration型検査・PostgreSQL 16統合試験・Source Inventory否定試験・合成移送試験を維持する。

### 初回CI受入証跡

- Runtime Hardening Commit `36570d75e14623d585385d0f4b1151d7189753f7`、[GitHub Actions run 42745482133](https://github.com/yoshihisahagisaka/atlib-msp-customer-portal/actions/runs/42745482133)はSUCCESS。
- 既存build / offline tests / migration型検査 / PostgreSQL16 E2E / Source Inventory権限否定 / 二段階Bootstrap / 合成移送：全ステップPASS。
- Node.js 24 Distroless image Build、実行UID=65532、不要ライブラリ不存在、`--network none`でのsynthetic 0444 Secretファイルmount・固定STOP・本文非出力：PASS。
- Trivy v0.70.0の実行イメージOS / Node依存スキャンはCRITICAL=0、HIGH=0（`ignore-unfixed=false`、`exit-code=1`）。検証時にv0.76.2が公開されていたため、CIのscanner versionをv0.76.2へ明示固定して再試験する。再試験結果が確定するまでは当該追加Gateは未確定。
- ローカルのrunner単体試験は6 PASS。ローカルフル`npm test`は`tsc`バイナリ不在、専用`npm ci --offline`はtarball cache不足で未実行とし、GitHub Actions実行結果と混同しない。

### 最終CI受入証跡（Trivy v0.76.2）

- Scanner明示固定Commit `3146be728db54b6677e46fcd6b5a71c3fa614b4c`の[GitHub Actions run 42745881636](https://github.com/yoshihisahagisaka/atlib-msp-customer-portal/actions/runs/42745881636)は全ステップSUCCESS。
- Node.js 24 Distroless image Build、非root UID 65532・`pg`のみの依存確認、合成0444 Secret mount・接続結果不明時固定STOP・Secret非出力、PostgreSQL 16二段階回帰、旧Portal回帰・合成移送はいずれもPASS。
- Trivy v0.76.2（OS + Node library、`CRITICAL,HIGH`、`ignore-unfixed=false`、`exit-code=1`）のReport Summaryは各対象の脆弱性0件。**Stage B専用ランタイムの脆弱性GateはPASS**。これは通常Portal全体のnpm依存監査結果とは別評価であり、Portal本体の脆弱性を解消したとの意味ではない。
- 実環境Secret、Cloud SQL、IAM、Jobの配備・実行は一切試していない。**Production No-Go継続**。

### 本番境界と残存Gate

- Docker CIイメージのBuild成功と脆弱性検査合格は、本番Artifact RegistryへのBuild/Push、専用SA/Secret IAM/Cloud SQL Client、Job作成、Job実行の承認を意味しない。
- 合成Secret mountはCloud Runの実際のSecret Manager/IAM、volume設定、Cloud SQL socket疎通の実環境確認に代わらない。実行前のJob export/Image Digest/権限差分二者レビュー、DB statement auditのRead-only確認、担当者・復旧責任者、Cloud SQL/Portal/PPAP正常性Gateが必要。
- 本変更には本番GCP、Cloud SQL、Secret、IAM、Cloud Run、Stage A/B/Final verify、LOGIN、Source Inventory、Migrationの実行を含めない。**Production No-Go / Draft PR #5を維持する。**

## 2026-11-10 次の本番Gateに向けた審査票（文書化のみ）

- [`SECURE_GUARD_SOURCE_INVENTORY_PRODUCTION_PREFLIGHT_20261110.md`](SECURE_GUARD_SOURCE_INVENTORY_PRODUCTION_PREFLIGHT_20261110.md)に、P0〜P6の個別承認境界、監査・正常性のRead-only収集、専用SA/IAM/Jobの固定差分、Stage A/Bと復旧責任分界、二者レビューと結果不明STOPを整理した。
- Cloud Run Jobs Executorはoverride権限がない一方、同じJobを再実行できる`run.jobs.run`を持つため、P4までは付与せず、実行後の権限回収も別審査とする。固定runnerの`APPROVED_ONCE`検査のみで人的な単発承認を代替しない。
- DB statement auditはCloud SQL側の`cloudsql.enable_pgaudit`・extension・有効`pgaudit.log`・Cloud Logging Data Access可視性の実測が必要。pgAuditを新規有効化する場合、インスタンス再起動を伴う本番変更として審査から分離する。
- 審査票はGo・配置・実行の承認を与えない。本番GCP、Cloud SQL、IAM、Secret、Job、Stage A/B、LOGIN、Source Inventory、Migration変更0件。**Production No-Go / Draft PR維持。**

## 2026-11-10 P1 DB文監査STOPと代替監査B案（提案のみ）

- 運用者のRead-only `gcloud.cmd`照合で、`msp-customer-portal-db`は`POSTGRES_16 / RUNNABLE`、`ZONAL`、Backup enabled（30件保持）、PITR enabled（7日）、自動ストレージ拡張有効、直近5件の自動Backupは`SUCCESSFUL`、直近10件のCloud SQL Operationsは`DONE`。復元実証・実行時点の健康状態は別途必要。
- `settings.databaseFlags`が応答に表示されず、pgAuditのROLE文監査が成立する証拠はない。Cloud SQLで`cloudsql.enable_pgaudit`の変更はインスタンス再起動を伴うため、既存Portal/PPAP等と共有する本番DBの無断再起動はしない。**既存P1監査要件は未達=STOP**。
- 統括が承認したのは、再起動不要の**B案を文書上で提案する作業のみ**。採用判断、DB文監査を代替する残余リスクの受容、本番P1解除、Stage A/Bの実施、IAM/Secret/Job配置・実行は未承認。
- 詳細：[本番Bootstrap代替監査B案（2026-11-10）](SECURE_GUARD_SOURCE_INVENTORY_ALTERNATIVE_AUDIT_PROPOSAL_20261110.md)。Stage Aの管理操作記録とDB ACL before/after、Stage Bの固定SQL SHA / Job export / image digest / Execution / platform audit、独立Final verifyを連結する。**DBで実際に流れたSQL文を直接証明せず、他管理操作の不存在も保証しない。**
- 正式採用には、適用範囲を本Bootstrapの一回限りとした監査契約の変更、証跡の責任者・原本/保持期間・二者レビュー、残余リスクの承認者、実行直前Gateが必要。その後もP2（資産作成のみ）、P3（Stage A）、P4（Stage B単発）、P5（独立検証）、P6（LOGIN/Inventory等）は別承認。
- 今回は**Git文書更新のみ**。本番GCP/DB/Cloud Run/Secret/IAM/Stage A・B/Final verify/Source Inventory/Migration変更なし。**Production No-Go / Draft PR #5を維持**。

## 2026-11-10 Decision：代替監査B案の一回限り正式採用

- **正式決定ID：** `SG-SOURCE-INV-AUDIT-B-20261110`。[決定記録](DECISION_SECURE_GUARD_SOURCE_INVENTORY_AUDIT_B_20261110.md)を正本とする。
- 直前の監査方式B案決裁票で提示した3点（SQL文の直接監査なし、他経路での同時SQL不存在を完全に証明できない、Cloud Run Jobの再実行防止を人的統制に依存）の残余リスクについて、統括・萩坂が2026-11-10に「承認します」と明示した。
- **監査契約の限定例外**：`msp-customer-portal-db / msp_customer_portal / sg_source_inventory_ro_20261106`の初期Bootstrap、Stage A role作成・CONNECT/USAGEとStage B Ledger SELECT 1件の一回限りにB案を正式採用。pgAuditのDB文監査と同等でないことを受容し、固定SQL/Job/管理経路/ACL before-after/独立検証の証跡突合を必須とする。
- この決定は上記「提案のみ」時点の記述を**監査方式に限って**更新するものであり、P1の実行前停止条件を解除しない。担当者・二者照合・証跡原本/保持場所/期間・復旧担当/戻し先・最新DB/Portal/PPAP正常性の確認が未了で**P1=STOP**。
- P2 専用SA/IAM/Job作成、P3 Stage A、P4 Stage B単発、P5 Final verify、P6 LOGIN/Source Inventory/Migration/後処理は**各個別承認**。本番Cloud SQL/Cloud Run/Secret/IAM変更、Role作成、GRANT、Job実行、DB再起動は本決裁の対象外。**Production No-Go / Draft PR #5維持**。
