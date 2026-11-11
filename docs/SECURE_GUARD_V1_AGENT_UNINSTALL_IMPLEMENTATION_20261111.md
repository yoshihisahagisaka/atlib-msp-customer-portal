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
2. `migrations/014_secure_guard_agent_uninstall_claims.sql`：Agent UUID一意の永続claim。timeout/UNKNOWN/再登録でも自動期限切れ・再発行なし。
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

**デプロイ・実API実行・本番有効化は未実施。** `SECURE_GUARD_AGENT_UNINSTALL_ENABLED` はデフォルトOFF。以下を満たすまでtrueにしない。

1. 専用Cloud SQL / DB責任分担・接続予算・Migration 014・role/権限・バックアップを実環境で確認。
2. 本番相当HA・再起動・複数インスタンス同時操作でDB unique claimが有効と確認（**端末DELETEなしの合成検証**）。
3. 監査、UNKNOWN時の運用担当と端末状態確認フローを確定。
4. Stagingで顧客権限、UI・確認文言、No-Goをレビュー。公開・DNSFilter書込には別途明示承認が必要。

この工程では既存PoC PASSを変えず、既存の解約C2 GET-only DryRunの安全思想だけを適用する。Site/Organization解約の本番経路を新たに有効化しない。
