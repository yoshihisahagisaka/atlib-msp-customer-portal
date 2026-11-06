# Secure Guard｜旧本番Source Inventory専用Read-only role 作成準備（2026-11-06）

## 目的と現在のGate

- 対象は既存 **`msp-zabbix` / Cloud SQL instance `msp-customer-portal-db`**。共用Staging `secumie-sg-shared-staging-db` ではない。
- 2026-11-06に運用者が `gcloud.cmd sql users list --project=msp-zabbix --instance=msp-customer-portal-db --format="table(name,type)"` をRead-only実行。返却は `portal_app`、`postgres`、`ppap_app`、`ppap_sso_verify_app`、`sales_tools_app`、`sales_tools_migration`（すべて `BUILT_IN`）。**専用Read-only login候補は一覧から確認できなかった**。これは権限の確定調査ではなく、SQLで作成した非login/group roleや実効grantの不存在を証明しない。
- **2026-11-06 Read-only実機確定：** Cloud SQL Admin APIでinstanceは`RUNNABLE`、`asia-northeast1`、`POSTGRES_16`。DB一覧は`postgres` / **`msp_customer_portal`** / `ppap_transfer` / `ppap_sso_verify` / `sales_tools`。調査の移行元DB名は`msp_customer_portal`とする。1つのインスタンスに複数のサービスDBがあるため、他DBへのgrantや既存`PUBLIC` grantの変更は一切行わない。
- `portal_app` / PPAP / Sales Tools / `postgres` の認証情報を調査用に流用しない。調査用の新規roleの**設計準備のみ承認**。本番 `CREATE ROLE`、`GRANT`、パスワード設定、DB接続、Inventory実行、Secret/IAM/Proxy変更は**未承認・未実行**。
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
5. **本番DBへの限定的なrole新設とgrantについて別途明示承認**を得る。承認前に以下のSQLを実行しない。

## 作成SQL案（未実行・DB名は確定、期限/接続Gateは未確定）

以下は**レビュー用テンプレート**。DB名は実機確認した`msp_customer_portal`を指定済み。`<APPROVED_EXPIRY_JST>`を実行承認日時に沿って確定し、旧本番の対象DBに接続していることを`SELECT current_database()`で確認してから、権限を持つ運用者が低負荷時間に実施する。未承認のまま実行しない。

```sql
-- PRE: current_database() = 'msp_customer_portal' を運用者が確認。
-- PRE: pg_rolesに同名のroleがないことを確認。実施には別途Goが必要。
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

**準備のみ。** `msp-customer-portal-db` の**DB名`msp_customer_portal`・PostgreSQL 16・RUNNABLEはRead-only実測済み**。一方、SQL側のrole/ledger/実効grant、管理者経路、保守時間、接続余裕は未確認。Read-only principalの新設も旧Production Source Inventoryも未実施。既存Portal/PPAP、SG Staging database/role/Secret、Migration/Trafficは変更しない。**Production No-Go / PR Draft維持。**
