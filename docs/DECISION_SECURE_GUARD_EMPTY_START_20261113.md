# Decision｜Secure Guard V1の新DB空開始（2026-11-13）

- Status：**ACCEPTED（対象と運用順序の変更）**
- 決定者：萩坂（統括）
- 対象：Secure Guard V1のサービスイン前Staging／将来のProduction初期化
- 正本：Portal Draft PR #6。PR #5の旧本番Source Inventory／データ移行計画は、**旧データを引き継ぐ場合だけの保留資料**とする。

## 決定

1. Secure Guardはサービスイン前で顧客データは存在せず、旧Portal DB側のSecure Guardデータは検証用と位置付ける。**旧本番DBから新Secure Guard DBへのデータ移行は実施しない**。検証データ・旧ユーザーセッション・招待・通知episode・監査レコードを新DBへコピーしない。
2. 新しい専用DBは**空から初期化**する。Stagingでは `secure_guard_staging`、将来のProductionでは `secure_guard`。各DBでSecure Guard専用Migration 001→002→003→004のみを適用し、独立ledgerとruntime／overage／migrationの権限分離を維持する。既存PortalのMigrationを流用しない。
3. 初期受入は合成データによるログイン・Organization管理・監査・ライセンス超過・通知抑止・Agent解除の無効状態を検証する。**atLIBのOrganizationなど実データは完成後に**、その時点で適切な正規登録・DNSFilter連携導線を確認してから取り込む。現時点で新規移送プログラムは作らない。
4. 旧本番Portal DB、他サービスのDBとデータ、DNSFilter実Organizationは変更も削除もしない。旧検証データの削除はこの決定に含まない。既存Portal/PPAP/Sales Toolsの継続運用を優先する。
5. 旧本番DBの一時Read-only role作成（Stage A/B）、Source Inventory P1〜P6、旧→新データ移送・移送rollbackは**本V1初期構築の前提作業から除外**する。これらの手順を実行してよいという意味ではなく、実行しない。PR #5の既存Go／No-Goを暗黙に解除しない。

## 次の最短工程と変わらないGate

1. **Insight側**：既存共用Stagingインスタンスについて接続容量 `M-R >= 78`、既存サービスへの影響、バックアップ・復旧条件を確認し、SG専用空DBと3 role／3 Secret／SAの限定的な構築を個別に許可・実施する。
2. **Secure Guard側**：Staging SG専用Migration 001〜004を明示的に承認して適用。DB role否定権限、接続・ログイン・認証・権限・監査・超過監視の合成E2Eと切戻し（新Revision停止、旧Portal本番無変更）を検証する。
3. **サービス仕上げ後**：atLIBの実データ登録／DNSFilter Organization同期を個別に行い、権限・割当数を確認する。完成前の先行投入や通知・Agent実操作はしない。
4. **Production**：別途Go判定。既存Portal DBへのDDL、Cloud Run Traffic切替、Slack実送信、DNSFilter Agent DELETEは今回承認されていない。

## STOP条件

- 旧DBに移行を要する実顧客データ・維持義務のある監査記録があると判明した場合、空開始を止めて統括に差分を報告する。
- 接続予算、復旧条件、権限分離、合成E2Eが未成立ならStagingアプリ有効化を進めない。
- 本決定は**実環境のGCP/DB/Secret/IAMへの変更承認ではない**。Production No-Go／Draftを維持する。

## PostgreSQL 16 role-membership例外（2026-11-15承認）

Secure Guard Staging専用3 Roleについて、最終membership 0件という従来条件を変更する。非SUPERUSERの`CREATEROLE`主体がRoleを作成した際にPostgreSQL 16が自動付与する、作成者をmember、bootstrap superuserをgrantor、`ADMIN TRUE / SET FALSE / INHERIT FALSE`とする3件のみを最終状態として許容する。

BootstrapはRole、member、grantorおよび3つのOptionを各行で完全一致検証する。不足、重複、追加membershipはすべてFail-closedとする。Migration Roleへの`SET TRUE`はDatabase作成中の別membershipとしてのみ許可し、同じgrantorが必ず撤去してから後続処理へ進む。この例外はBootstrap実行、Migration、Production変更の承認を意味しない。

## 2026-11-16 実Cloud SQL membership判断

上記2026-11-15の3 membership例外は履歴として維持するが、本節でSecure Guard Stagingの現行判断を置き換える。Read-only診断Execution `secure-guard-db-bootstrap-staging-once-hzbtb`では、PostgreSQL 16.15上のSecure Guard 3 Roleの属性は完全一致した一方、関連する`pg_auth_members`は0件だった。`createrole_self_grant`は空、`pg_get_userbyid(10)`は`cloudsqladmin`だった。

Insight Recovery方式1を採用し、次を現行契約とする。

- Secure Guard関連membershipはPreflight・最終状態とも0件だけを許容する。
- Secure Guard Roleがroleまたはmemberとなる行が1件でもあればFail-closedとする。
- 一時`SET` membershipは作成しない。
- `secure_guard_staging`のownerはBootstrap実行主体（Cloud SQLでは`postgres`）とする。
- Database／`public` schemaのPUBLIC権限を撤回する。
- runtime／overage／migrationにはDatabase CONNECTだけを共通付与する。
- migrationだけにDatabase CREATEおよび`public` schema USAGE／CREATEを付与する。
- runtime／overageにはCREATE権限を付与しない。
- CREATE DATABASE後の部分失敗ではDBを残して明示レビューへ戻し、自動削除・自動再試行しない。

Vanilla PostgreSQL 16では`createrole_self_grant`が空でも、非SUPERUSERのCREATEROLE主体へbootstrap superuserをgrantorとするADMIN membershipが自動生成され、作成者自身ではそのgrantを撤去できない。CIではfresh SQL経路を実Cloud SQLの0件状態を生成するsuperuser fixtureで、Recovery・Fail-closed経路を非SUPERUSERのCREATEDB／CREATEROLE主体で検証する。このfixture差は本番のmembership 0件Gateを緩和しない。

接続容量式の差異は別Fit/Gapとして維持し、本修正には混在させない。本判断はImage Build、Job更新、Bootstrap実行、Migration、Production変更の承認を意味しない。

## 2026-11-16 Staging Gate実行結果

承認Commit `d2fd694e70039d73a964c9dbf4e717aa0834bd26`のImage Buildと、ImageだけのJob更新、通常Bootstrap 1回を実施した。Execution `secure-guard-db-bootstrap-staging-once-cv5tl`は成功し、固定完了イベントは空DB、3 Role、接続上限、DB間分離、Migration 0件を報告した。

ただし後続のSELECT専用受入Execution `secure-guard-db-bootstrap-staging-once-hmlnf`は、受入スクリプトがBootstrap正本と異なるInsight Role名を使用していたため完了できなかった。実DBの不一致を示す証拠ではないが、受入未完了をPASSとは扱わない。既存DBとJobを保持し、Migration 001〜004、Synthetic E2E、Production工程はSTOPを維持する。自動再実行、DB削除・再作成、手動補正は行わない。

修正版SELECT専用Execution `secure-guard-db-bootstrap-staging-once-7dddm`で12項目を完全照合し、Gate S2はPASSへ更新した。DB owner、membership 0件、3 Role属性・ACL、PUBLIC撤回、双方向DB分離、空DB、ledger不存在はいずれも実測一致した。

Gate S3はMigration適用前にSTOPした。SG専用Migration JobおよびSQLを含む承認済み実行Artifactが存在せず、Bootstrap runtime ImageにもSQL本文が含まれない。Insight Migration Jobの流用、ad-hoc override、新規Job／Imageは既存経路ではないため採用しない。DBとGate S2の正常状態を保持し、Migration、Synthetic E2E、Production No-Goを継続する。
