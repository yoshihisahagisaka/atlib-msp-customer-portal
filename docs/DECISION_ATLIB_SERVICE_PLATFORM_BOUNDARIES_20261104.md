# atLIBサービス基盤構想・Secure Guard DB配置 Decision（2026-11-04）

## 状態／決定の階層

**事業・アーキテクチャ方針は採用。実環境変更はNo-Go（未承認）。**

経営方針として、Secure Guardは**選択肢②：SECU:MIE用に計画中の新Cloud SQLインスタンスへ同居**する方向で進める。サービスごとの別database、runtime role、Secret、Service Account、Migration ledger／ownerを必須境界とする。

先行記録 `SECURE_GUARD_SECUMIE_SHARED_SQL_FITGAP_20261104.md` のConditional Fitは、技術的課題が残ることを表すものとして存続させる。今回の事業方針採用は、Fit/Gap Gateの無条件PASSやMigration／本番Goを意味しない。既存のDB共用案（`msp-customer-portal-db`への増築）はSG本番新設分の第一候補から外す。

## 将来のサービス配置（全体構想）

| 基盤 | 所属 | 方針 |
|---|---|---|
| Secure Send独立基盤 | Secure Send／現PPAP代替 | 現在はatLIB社内利用、将来は外部向けSaaS展開予定。DB、ファイル保存・送受信・スキャン・監視／認証などの分離を近いうちに計画。**現段階で移行は実行しない。無停止運用・後方互換・切り戻しを最優先** |
| セキュリティサービス共有Cloud SQL | SECU:MIE Insight、将来SECU:MIE Web、Secure Guard | 新規Cloud SQLインスタンスを共用する第一候補。**サービス単位の独立database/role/Secret/Migration**、容量・接続・HA・復旧を合算して設計。Secure Sendはこの共有対象に含めない |
| 社内管理・既存基盤 | Sales Tools、既存顧客ポータルなど | 現有資産を維持しつつ、各サービスのAPI境界と負荷・データを段階的に整理。PPAP等の稼働中サービスを無断で移動・停止しない |

顧客ポータルを共通入口として使う場合も、各製品の業務データを単一の従来DBへ集約することはしない。将来のサービス別独立インスタンス化が可能なAPI・データ所有境界を残す。

## Secure Guardで採用する構成方針

1. **インスタンス共有／DB分離**：SECU:MIE新設Cloud SQLに `secure_guard` 等の独立databaseを設ける候補。SECU:MIE `secumie_insight`、将来 `secumie_web` と同一database/schema/roleを共有しない。
2. **専用接続・権限**：SG API/監視Job/管理UI/migrationを最小権限で独立。SECU:MIE側のpublic_auth／piraをSG runtimeから直接参照しない。
3. **データ移行設計が先**：SGの `011`／`012`／`015` は既存Portalテーブルと外部キー・同一トランザクションに結合。新インスタンスへ向け替えるだけでは動かない。関係するidentity、customer_organizations、DNSFilter mapping、監査を実装依存・適用済みledger・実データで照合して専用baseline／移行・復旧経路を確定。
4. **共同容量・接続Gate**：SECU:MIE単独の接続budget（構成50、role上限候補54）にSG runtime／Job分を加え、Cloud SQL `max_connections`、実内部接続、CPU/memory、将来のWeb需要まで見積もり直す。旧1 vCPU／3.75 GiBと月額試算は**単独前提であり、共有構成の承認値ではない**。
5. **運用と規模拡大**：SG周期取得は独立Job／安全な並列数・APIレート制御・通知冪等性。SG保護クライアント側のDNS遮断は管理DB停止で解除されないが、管理UI・超過通知はDB停止時に影響を受ける。OTP/PIRA受付への共有DB障害波及を受入基準に含める。
6. **サービス仕様維持**：DNSFilter公式APIの確定した割当数／利用数を比較し、超過でatLIB管理UI＋専用Slack通知、顧客への人手確認を行う。請求システム、コスト計算、DNSFilter自動割当変更、Network License計算は作らない。

## Change Gate／担当境界

- **SECU:MIE Insight側**：新Cloud SQLインスタンスの共通基盤owner。インスタンスの命名、容量・接続予算、Backup/PITR、ネットワーク、SA/IAM、共通Migration適用・運用契約の改定を担当。SECU:MIEの既存承認済み仕様とPR #43の実装済み専用poolを維持しつつ、共有案に必要な差分だけを検討する。
- **Secure Guard側**：SGデータ範囲のread-only実体調査、専用database／role／移行用baseline、SG Repo・API・Job・管理UIの接続経路と回帰テスト、移行／切り戻しを担当。
- **Secure Send側（後日別Work）**：外部展開と独立運用のFit/Gap、既存稼働資産の無停止移行計画。現時点でDB新設、Secret変更、DB移行、デプロイは行わない。
- **統括**：SECU:MIE側の「専用」から「セキュリティサービス共通」への設計変更を記録し、費用・接続budget・Staging E2E・運用責任・RPO/RTOを確認した上で別途実行Go/No-Go。

## 現在の明示的STOP

- SG Draft PR #4のMigration `015_secure_guard_overage_alerts.sql` を旧本番 `msp-customer-portal-db`へ適用しない。Job/Scheduler/Slack実送信なし。
- SECU:MIE PR #42／#43はDraftのまま、Cloud SQL本番／Stagingの作成、OTP/PIRA/SGの移動、Secret/IAM/traffic変更をしない。
- 旧DBにおける接続上限25・観測ピーク22、PPAP/Secure Send稼働継続を優先。新基盤への共有配置が決まったことを既存DBの変更・拡張承認と混同しない。

## Canonical参照と優先順位

- SG：Draft PR #4、`docs/SECURE_GUARD_SECUMIE_SHARED_SQL_FITGAP_20261104.md`、`docs/SECURE_GUARD_OVERAGE_MONITOR_V1_IMPLEMENTATION_20261104.md`。
- SECU:MIE：`atlib-sales-tools` PR #42 `docs/secumie-dedicated-cloud-sql-design-20261104.md`、PR #43 `feat/secumie-dedicated-db-connections`。
- 本文は**DB配置・将来サービス構想に限り**従来の「SGは既存Portal DBに追加」を上書きする。SECU:MIEのセキュリティ、分離、認証、保持、顧客支援の既定仕様は上書きしない。

**次の作業は、既存テーブル依存・Production Ledger・Cloud Run接続設定のRead-only確認と、SECU:MIE側の接続予算改訂・双方の移行Fit/Gap。実装やGCP作成は別途承認。**
