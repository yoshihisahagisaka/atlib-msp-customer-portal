# Secure Guard v1｜顧客Agent「アンインストール＆削除」実装記録（2026-11-11）

## 結論・根拠

既存PoCで **Windows Roaming Clientへの `DELETE /v1/user_agents/{uuid}?queue_uninstall=true` → HTTP 204 →端末での削除・DNS復旧** はPASS済み。再実証を目的としたPoCは繰り返さない。`queue_uninstall`なしのSoft Deleteは既存PoCでAgent残留・名前解決障害があったため実装経路を作らない。

参照：

- `docs/DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md`
- `docs/SECURE_GUARD_V1_CUSTOMER_DAILY_UI_CONTRACT_20261031.md`
- `docs/SECURE_GUARD_V1_LAUNCH_IMPLEMENTATION_ORDER_20261031.md`
- `yoshihisahagisaka/atlib-corporate-site` Draft PR #44、C1/C2契約（C2はGET-only DryRun、実削除サービスではない）

## 新設箇所

1. `src/services/dnsFilterAgentUninstallClient.ts`：固定エンドポイント、`queue_uninstall=true`のみ、204以外はUNKNOWN、HTTPリダイレクト禁止、再送なし。API Keyはサーバーのみ。
2. `migrations/secure_guard/003_agent_uninstall_claims.sql`：SG専用DB向けAgent UUID一意の永続claim。timeout/UNKNOWN/再登録でも自動期限切れ・再発行なし。旧Portalの全Migration runnerには追加しない。
3. `SecureGuardRepo`：actor/user、active membership、role、customer Organization、DNSFilter mappingをDBトランザクション内で再照合。claimと監査イベントを同一commit、HTTP送信後の結果監査も記録。
4. `POST /api/secure-guard/agents/:agentId/queued-uninstall`：顧客Membership + `org_admin`/`operator`限定、viewer禁止、全Site/Agent GET照合、Site ID・Agent UUID・hostname・確認入力・通信リスク同意を照合した後、claimを先に確定して1回だけ送信。
5. `GET /api/secure-guard/agents/:agentId/uninstall-status`：所属Organizationの履歴確認。既存claimがある端末は再送禁止。
6. 顧客端末詳細：サーバーから `capabilities.agentQueuedUninstall=true` が与えられる場合のみ、対象端末名再入力と確認後に表示・操作可能。

## 受付結果の意味・停止条件

- HTTP 202 + `accepted`：DNSFilter側の**キュー受付（HTTP 204）**まで確認。**端末での削除完了を意味しない**。
- `AGENT_UNINSTALL_OUTCOME_UNKNOWN_NO_RETRY`：DNSFilter未応答・タイムアウト・サーバー結果保存失敗など。**再送しない**。
- `AGENT_UNINSTALL_ALREADY_CLAIMED_NO_RETRY`：過去にcommit済み。結果がacceptedでもUNKNOWNでも再送不可。
- DB commit/claim、Role・mapping、完全Inventory、結果確認のいずれかが不明なら外部送信を停止。
- 端末がオフラインのときの処理完了時間は保証しない。通信影響・DNS復旧は既存PoCの範囲を超えて保証しない。
- V1はAgent UUIDの同一端末再インストール後も保守的に再送不可。再操作が必要なら人のレビューによる新しいライフサイクル規定を別途承認する。

## Release Gate（未解除）

**デプロイ・実API実行・本番有効化は未実施。** `SECURE_GUARD_AGENT_UNINSTALL_ENABLED` はデフォルトOFF。加えて `SECURE_GUARD_DB_MODE=dedicated` と `SECURE_GUARD_DB_REQUIRE_DEDICATED=true` の両方が揃わなければAgent操作は無効。以下を満たすまでtrueにしない。

1. SG DB Draft PR #5の専用pool・専用Migration runnerを統合し、Insight主管の共通Cloud SQL Staging側で `secure_guard_staging`／SG用3 principal・Secret・接続予算・バックアップのGateを確認。**既存Portal DBへ014等のSG claim表を追加しない。**
2. 専用runnerでSG baseline 001/002の後に003を適用する別承認を得る。`runtime` にclaim表の必要SELECT/INSERT/UPDATEのみを付与し、`overage`へ権限を付けず、runtime DDL/ledger権限を拒否する。
3. 本番相当HA・再起動・複数インスタンス同時操作でDB unique claimが有効と確認（**端末DELETEなしの合成検証**）。
4. 監査、UNKNOWN時の運用担当と端末状態確認フローを確定。
5. Stagingで顧客権限、UI・確認文言、No-Goをレビュー。公開・DNSFilter書込には別途明示承認が必要。

### 2026-11-12 Staging Fit/Gap

- PR #5正本 `SECURE_GUARD_SHARED_SQL_STAGING_HANDOFF_20261105.md` と照合。既存PortalのMigration runnerは旧業務DDL一式を扱うためSG専用DBに適用禁止。前回Draftのlegacy `014`は適用前に撤回し、SG独立ledgerへ登録される `003` に移動。
- 共通Staging **インスタンス** `secumie-sg-shared-staging-db` は作成済みとの記録だが、SG用database/role/Secretは未作成・No-Go。SG DB baselineと新claim schemaを適用したと推定しない。
- 旧本番DB Source InventoryはRead-only主体の付与段階がSTOP（PR #5）。このブロッカーを迂回せず、Synthetic DB受入準備を先行する。
- PR #3とPR #5は未統合。`SECURE_GUARD_AGENT_UNINSTALL_ENABLED=true` のみで送信可能にならないよう、専用DB二重Gateを追加。統合・Migration・実API操作は別のRelease Gate。

この工程では既存PoC PASSを変えず、既存の解約C2 GET-only DryRunの安全思想だけを適用する。Site/Organization解約の本番経路を新たに有効化しない。
