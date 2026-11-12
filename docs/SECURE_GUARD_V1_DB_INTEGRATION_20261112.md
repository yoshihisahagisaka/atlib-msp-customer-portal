# Secure Guard V1｜顧客操作と専用DBの統合（2026-11-12）

## 目的と正本

- 顧客操作・画面：Portal Draft PR #3 `feature/secure-guard-daily-management`、基準HEAD `2a57110778a02cd774184b585439e860867a9ecd`。
- 専用DB・超過監視：Portal Draft PR #5 `feat/secure-guard-shared-sql-db-prep-20261105`。当該PRのStaging handoff／Source Inventory／実データ移送Gateが正本。
- この統合ブランチは**PR #3への積み上げ**。PR #5のCloud SQL整備・Source Inventory Role承認・実データ移送までを置き換えるものではない。

## Fit／実装

1. 既存Portalの通常DB接続は維持。Secure GuardのRepoと監視状態だけ `SECURE_GUARD_DB_MODE=dedicated` 時に別Poolへ向ける。専用runtimeの接続上限は2、overage Jobも別principalの専用Pool上限2、migrationは1。
2. 専用Migration runnerはPortalの旧全Migrationを呼ばない。独立Ledger、SHA-256照合、advisory lock、`SECURE_GUARD_MIGRATION_APPROVED=true` 必須。専用順序は **001 identity/scope → 002 overage → 003 license snapshot → 004 Agent uninstall claim**。Portal 011〜013は変更なし。
3. PR #3の顧客画面・Agent解除の二重送信防止・監査、MSP画面のライセンス割当転記と都度確認は維持。
4. PR #5由来のDNSFilter公式usage read API、独立超過episode/対応記録API、1回実行の監視Jobも統合。JobはデフォルトOFF、`SECURE_GUARD_OVERAGE_JOB_ENABLED=true` の明示設定が必要。Slack未設定時に送信しない。
5. 専用DB時の終了処理はHTTP停止後にPortal／SGの各Poolを解放。既存Portal単独運用の終了挙動は変更しない。
6. **Slack送信OwnerをDB modeで一本化**：旧Portal `legacy` は既存の手動通知、`dedicated` はPR #5の定期監視Jobのみ。専用DBモードの手動確認POSTは状態を返すだけで、通知claim・解消処理・Slack送信をしない。管理画面の通常の使用数確認GETは変えない。新しい設定フラグは不要。

## 未完了・停止条件

- これは**ローカル合成検証・GitHubの隔離CI用コード**。GCP、Cloud SQL Staging/Production、Secrets、IAM、DNSFilter実データ・DELETE、Slack送信、デプロイは行わない。
- Insight側が所有する共有Staging instance自体の準備と、SG database/role/secretsの作成は別Gate。PR #5のSource Inventory・移送・接続予算・rollback検証も未実行。**Production No-Go / Draftを維持**。
- Agent解除は `SECURE_GUARD_AGENT_UNINSTALL_ENABLED=true`、専用DB mode、dedicated requireの三条件がなければOFF。実行承認まで有効にしない。
- 専用DBモードで通知を送れるのは定期Jobのみ。Jobは承認・Webhook設定までOFF。既存の手動通知用Slack設定が残っていても専用DBモードの手動APIから送信されないことを合成テストで確認する。Stagingでは定期Jobの通知episodeと人手対応の受入が別途必要。
- PostgreSQL 16実DBによる001〜004 Migration再実行、Runtime/Overageの否定権限、Agent claim一意制約は使い捨てCIで検証し、PASSを確認してから次Gateへ。

## オフライン受入

- `npm run build`、`npm run typecheck:secure-guard-migration`：PASS。
- `npm test`：97 PASS / 0 FAIL（Agent解除、顧客Scope、Slack抑止、公式usage、超過episode、専用DB設定）。専用DBで手動APIを反復しても通知・DB claimがないことを追加検証。
- 実PostgreSQL E2E：`test/integration/secureGuardDatabaseE2E.test.cjs`。固定 `127.0.0.1:55432` の使い捨てPG16、CI opt-inのみ。旧Portal本番には接続しない。
