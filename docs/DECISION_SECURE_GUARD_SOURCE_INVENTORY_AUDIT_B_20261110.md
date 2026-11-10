# Decision｜Secure Guard Source Inventory Bootstrapの単発代替監査B案（2026-11-10）

- Decision ID：`SG-SOURCE-INV-AUDIT-B-20261110`
- Status：**ACCEPTED（監査方式の限定採用のみ）**
- 決裁者：萩坂（統括。直前の3つの残余リスクを提示した対話に対し、2026-11-10に「承認します」と明示）
- 実行可否：**Production No-Go。P1は引き続きSTOP。P2〜P6はすべて未承認**
- 対象PR：[Draft PR #5](https://github.com/yoshihisahagisaka/atlib-msp-customer-portal/pull/5)

## 決定内容

既存の`msp-zabbix / msp-customer-portal-db / msp_customer_portal`で、候補role `sg_source_inventory_ro_20261106`を初期Bootstrapする**Stage A（NOLOGIN role作成、CONNECT/USAGE）およびStage B（所有者`portal_app`がLedger SELECTを1件付与）のそれぞれ一回**に限り、DB再起動を伴うpgAuditの新規有効化を求めず、[代替監査B案](SECURE_GUARD_SOURCE_INVENTORY_ALTERNATIVE_AUDIT_PROPOSAL_20261110.md)の証跡突合方式を採用する。

Stage Aの固定SQL／正規管理経路の操作記録／ACL before-after、Stage Bの固定SQL SHA256／image digest／Job export／Execution/固定event／Cloud Audit Logs参照／ACL before-after、および独立Final verifyをセットで保全・照合する。Cloud Audit Logs・Jobログが実DBで流れたSQL文を直接監査するものとは**主張しない**。

## 統括が受容した残余リスク

1. PostgreSQLが実際に処理した`CREATE ROLE` / `GRANT` SQL文そのものの直接監査ログがなく、固定SQLとの一致は間接保証に限られる。
2. 正規管理経路またはJob以外からの同時・第三者SQL操作がなかったことを、B案だけで完全には証明できない。
3. Cloud Run Jobの実行権限は一回性を技術的に保証しない。別承認・権限回収・結果不明STOPなどの運用統制に依存し、ログ欠損時には経過を再構成できない可能性が残る。

## 変更しない安全条件

- これは**監査方式の限定例外**であり、`LOGIN`化、password設定、Source Inventory、Migration、SG専用DB、本番切替、復旧、他のCloud SQL操作に拡大しない。
- Stage A / Bは独立した個別承認、事前・事後のRead-only検証、結果不明時の再実行禁止を維持。Jobは最大1 task、parallelism 1、retry 0、Schedulerなし、SQL SHAとImage Digestを固定。
- `PASSWORD NULL`の本番直接確認ができない場合は`password_null_runtime_status=NOT_DIRECTLY_VERIFIED`、`password_null_assurance=STAGE_A_DDL_AND_POSTGRESQL16_CI`と正直に記録する。
- B案を採用しても、人的な責任者・二者レビュー、証跡保存先/保持期間/アクセス権、最新Backup/PITRと復旧担当・戻し先、DB接続余裕/CPU、Portal/PPAP/Sales Toolsの稼働状況、Job/IAM/Secret差分、実行時刻は**未確定**。不足なら**P1=STOP**。
- **P2**のSA/IAM/Build/Job作成、**P3** Stage A、**P4** Stage B 1回実行、**P5**独立Final verify、**P6** LOGIN/Inventory/Migration/後処理はそれぞれ別の明示承認が必要。P2承認はP3/P4に流用しない。

## 証拠と未実施

- 実DBのRead-only観測：PG16/RUNNABLE、ZONAL、直近5件のバックアップ成功、PITR有効、直近10件Operations DONE、disk自動拡張有効。一方、`settings.databaseFlags`にpgAudit有効設定は表示されず、DB文単位監査は未成立。復元試験は未実施。
- 決裁時点のコード/監査契約の基準：Draft PR #5の既存Canonical、[Production Preflight](SECURE_GUARD_SOURCE_INVENTORY_PRODUCTION_PREFLIGHT_20261110.md)、[B案決裁欄](SECURE_GUARD_SOURCE_INVENTORY_ALTERNATIVE_AUDIT_PROPOSAL_20261110.md)。
- **今回の実施はGit文書への決定記録のみ。** 本番Cloud SQL/Cloud Run/IAM/Secret/Artifact/Role/GRANT/Inventory/Migration、DB再起動、PR mergeは実施しない。Production No-Go / Draftを継続する。
