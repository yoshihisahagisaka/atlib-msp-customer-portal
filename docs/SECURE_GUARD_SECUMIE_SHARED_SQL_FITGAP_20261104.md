# Secure Guard × SECU:MIE｜新Cloud SQLインスタンス共有 Fit/Gap（2026-11-04）

## 位置づけ・判断状態

**判定：Conditional Fit（設計候補）。Production/Staging適用はNo-Go。**

ユーザー提起：SECU:MIE向けに新設を計画するCloud SQLへ、Secure Guardも同居できるのではないか。既存 `msp-customer-portal-db`（最大接続25、7日間実測ピーク22）に新規負荷を継ぎ足し続けず、将来のサービス拡大とPPAP無停止性を考慮する。

本書はSG側からのFit/Gap。**SECU:MIEの承認済み「専用Cloud SQL」Decisionを上書きしない。** 同居を正式採用する場合は、Insight統括側とSG側で、新インスタンスの所有者・名称・費用・接続budget・復旧責任を再承認する。Git文書以外の実環境変更は行わない。

## Canonical／照合済み実装

- SECU:MIE：`atlib-sales-tools` Draft PR #42、`docs/secumie-dedicated-cloud-sql-design-20261104.md`、HEAD `a0992f90266d48f8a356ef5bb80db7baff31ba5e`。専用インスタンスの実作成は未承認。現時点の候補はPostgreSQL 16 / Enterprise / REGIONAL HA / 東京 / 1 vCPU・3.75 GiB / SSD 20 GiB。
- SG：`atlib-msp-customer-portal` Draft PR #4、HEAD `2a1dcf105c76d8b500bc1e2a8e53009d5adf6072` をFit/Gap基準に使用。Migration `011_secure_guard_identity_scope.sql`、`012_secure_guard_organization_independence.sql`、`015_secure_guard_overage_alerts.sql`、`src/db/pool.ts`、`src/server.ts`、`src/services/secureGuardRepo.ts`、`src/services/secureGuardOverageStore.ts`、`src/jobs/secureGuardOverageOnce.ts`。
- GCP運用者実機read-only（同日）：`msp-zabbix`に顧客ポータル専用Stagingは見当たらない。`sales-tools-staging-db`は別レーンの資産であり流用しない。
- DNSFilterの合意済み範囲は変更しない：公式GETで `allocated_roaming_clients` と `roaming_clients_in_use`、超過時にMSP管理UI＋専用Slack、顧客判断は手動。請求・金額計算なし。

## 目標配置（正式承認前の候補）

| 層 | SECU:MIE | Secure Guard | 境界 |
|---|---|---|---|
| Cloud SQL **インスタンス** | 新設候補1基を共用 | 同じ新設インスタンス | CPU、memory、接続総数、HA、backup/PITR、障害は共有 |
| PostgreSQL **database** | `secumie_insight`、将来 `secumie_web`（各独立） | `secure_guard`（仮称） | DBを分離。直接クロスDB参照しない |
| Runtime／SA／Secret | OTP、PIRA、Web、管理主体を分離 | SG API、監視Job、管理主体を分離 | credential、role、pool、監査を分離 |
| Migration | Insight 037–041とWeb予約台帳 | SG専用migration manifest／ledger | 番号・適用Job・排他をDB単位で管理 |
| 接続 | 実体のpool上限と最大instance数で予算化 | SG側のAPI/UI/Jobを独立予算化 | **DBインスタンス全体**の接続予算に合算 |

SG管理画面が既存ポータルに残る場合でも、SGデータへの接続経路・認可・ロールバックを明確にする。最終的にSG APIを別Cloud Runへ切り離すことも可能な境界とし、現時点でサービス分割の実装を自動決定しない。

## 実コードFit/Gap

| 項目 | 状態 | 根拠／必要差分 |
|---|---|---|
| DNSFilter公式GET、超過判定 | **Fit** | DBに依存しない。API/判定の確定仕様は維持 |
| 超過履歴テーブルだけ移設 | **Gap** | Migration 015は `customer_organizations(id)` と `portal_users(id)` の外部キーを持つ。別DBへそのまま適用不可 |
| SG Organization/認証一括移設 | **Gap** | `SecureGuardRepo` は `portal_users`、`customer_memberships`、`msp_role_grants`、`customer_organizations`、`dnsfilter_organization_mappings` 等を同一poolで読む |
| SG初期Migration | **Gap** | 011の `customer_organizations.customer_id` は旧 `customers` への外部キー。012で解除されるが、空のSG専用DBへ011をそのまま適用できない。既存適用履歴・データを保護した専用baseline／移行計画が必要 |
| 超過監視の排他／監査 | **Gap** | `SecureGuardOverageStore.observe` はOrganization行に `FOR UPDATE`、顧客の対応更新は `secure_guard_audit_events` へのINSERTを同一transactionで行う。別DB間へ分断するとトランザクション原子性とロック前提が崩れる。関連テーブル移設または一貫性維持方式の設計が必要 |
| PortalからのDB接続 | **Gap** | `src/server.ts` で単一 `createPool(config)` をSG RepoとOverage Storeに注入。`src/db/pool.ts` は1インスタンスあたり `max: 5` 固定。別DB pool・IAM/Secret・障害分離・shutdownを設計する |
| 監視Job | **Conditional Fit** | 明示有効化、セッションロック、同一エピソードの通知Claimは既存実装で成立。ただし専用DB側のロックを使うよう接続変更、Job同時起動数・APIレート・接続枠の再測定が必要 |
| 管理画面／認可 | **Gap** | MSP認可はPortalのSG Repoと同一DBに依存。SGDB移設時の本人照合・権限境界・退会/停止反映・監査API経路を定義 |
| Staging／運用 | **Gap** | SECU:MIE側の一時ZONAL StagingにSG専用DB/role/migrationを追加して共用E2Eを行う計画が必要。共有Stagingであっても本番Secret/顧客データ禁止 |
| 将来スケール | **Gap（非ブロッキングな設計課題）** | SG監視は現行 `runSecureGuardOverageCheck` でOrganizationを直列GET。大量Organization時の完了時間、DNSFilter制限、バッチ/分割、冪等性、履歴保持量を計測して拡張方式を定義 |

`011`／`012`の既存本番適用状況、異なる機能が `portal_users` を参照しているか、SGの正式な移設可能範囲は**未確認**。本番DBの読み取りと全repoの依存確認なしに「SGテーブルを全件移動できる」とは判断しない。

## 接続予算：従来のSECU:MIE予算のままではGoにしない

SECU:MIE PR #42は次を明記している：

- OTP Cloud Run: 最大4、PIRA Cloud Run: 最大4、Sales Tools管理用SECU pool: 最大40、Migration: 1、保持Job: 1、計**構成上限50**。
- DB role上限候補合計は**54**。
- `M = SHOW max_connections`、`R = max(10, ceil(M*0.20), 内部実測最大接続+5)`、`A = M-R` とし、現行SECU単独のGateは `A >= 54`。

共有案ではSG側も加算する：

```text
S = Σ(SGを利用するCloud Run各サービスの最大instance数 × その専用DB pool上限)
    + SG監視Jobの最大並行実行によるDB接続上限
    + SG固有の管理／migration接続上限
M = 実機で確認した max_connections
R = max(10, ceil(M × 0.20), 内部・保守接続実測最大 + 5)
Go条件の最低ライン: M - R >= 54 + S
```

`S` は未確定。Portal現行max-instances、サービス別pool設定、SG Jobの独立DB接続本数を実測・コード照合し、インスタンス全体の容量・CPU・memory・IOPS・将来のSECU:MIE Web接続需要を再見積りする。SGを単に `secumie-prod-db` に向け替えるだけでは可としない。必要ならSECU:MIE初期候補のmachine構成を変更する。最大instance数は短時間超過し得るため、role接続上限と監視で超過影響を制御する。

## 共有による運用上のトレードオフ

- メリット：現在接続逼迫しているPPAP/Portal/Sales Tools共用インスタンスに新規接続枠を足さない。SECU:MIEとSGで新規DBインスタンスの固定費を共用できる。
- リスク：SECU:MIEのOTP/PIRAとSG管理・超過監視が新インスタンス上の障害・性能・バックアップ復旧を共有。専用databaseや別roleでもインスタンス障害は分離できない。
- **Secure Guardの端末側DNSFilter保護そのものは監視DBとは別**だが、DB障害中は管理画面・超過案件の更新/通知が止まり得る。SECU:MIE側のOTP受付への影響は独立して厳しく評価する。
- 本番変更を抑えるため、既存 `msp-customer-portal-db` からのデータ移設は、read-only inventory、移行順・同期/切替・整合検査・旧経路切り戻し、Staging rehearsalを済ませるまで開始しない。
- 共有instanceの運用責任者は両サービス共通の基盤ownerを明確化し、個別データの業務owner（Insight／SG）は分離する。SECU:MIE Webの担当境界は既定のまま維持する。

## Next Gate／決定が必要なこと

1. **統括判断**：新インスタンスを「SECU:MIE専用」から「atLIBセキュリティサービス基盤（仮）」へ改めるか。実インスタンス名は未確定。SECU:MIE側Decisionの変更はInsight統括側の同意を要する。
2. **SG実コード境界の確定**：Portalから必要なidentity/Organization/mapping/auditテーブルの所有・移設範囲と、既存顧客データ／Secure Guard外部参照のread-only検査。
3. **接続予算**：SECU:MIEの既定54＋SG追加分S、内部接続、Web将来増加、role上限を同時に満たすmachineとpool設定。予算不足なら条件付きNo-Go。
4. **移行方式**：SG用新database・独立role/Secret/Service Account、独立migration ledger、同一DBトランザクションの一貫性、監査・アクセス制御、RPO/RTO、復旧責任。
5. **価格・運用**：SECU:MIE既存の月額試算は**単独前提**。共有案採用時は構成・費用・HA/Backup/PITR・Staging費用を再計算。
6. **Staging E2E**：空DBからの適用、移行/戻し、両サービスの並行接続負荷、OTP優先時のSG監視遅延、SG超過アラート・通知の障害/冪等性検証。

**現時点の結論：共有案を比較対象の第一候補として精査する価値はあるが、実装差分は大きい。既存PR #4はDraftのまま保持し、Migration 015を既存本番DBへ適用しない。** 比較対象の独立SGインスタンス案、現行Portal DB続投案との費用・移行リスク比較が完了するまで共有案を最終承認としない。
