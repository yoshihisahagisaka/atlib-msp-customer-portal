# atLIB Secure Guard｜超過監視 v1 実装・移行ゲート（2026-11-04）

## 統括確定スコープ

- 目的：DNSFilter顧客Organizationのローミングクライアント「利用数 > 割当数」のみを把握し、atLIB担当者が顧客へ連絡する。
- 取得：公式API organization_usage_detailed の allocated_roaming_clients と roaming_clients_in_use。2026-11-04に画面突合済：Test02 1/2、Test03 3/0。
- 通知：MSP管理画面＋専用Slack。Webhookは未確定。既存別用途の通知先を流用しない。
- 人の対応：不要端末整理か割当数増加を顧客に確認・記録。DNSFilter側の変更は公式管理画面で担当者が行う。
- 非対象：請求システム、支払金額の計算、顧客請求額の集計、単価、Network Licenses、Agent一覧からの独自推定、DNSFilterのライセンス自動変更。

## Draft PR #4 実装範囲

1. 公式API read-only client：Organizationを照合し、整数の割当／利用数を返す。不正・欠落・取得失敗は判定不可。
2. Migration 015：顧客ごとに未解消超過を最大1件。未対応・対応中・解消、顧客確認の方針、通知状態のみ保持。金額なし。
3. SecureGuardOverageStore：Organizationロック下で発生・継続・解消を更新。通知は同一エピソードにつき1回Claimし、曖昧な送信結果は自動再送しない。
4. runSecureGuardOverageCheck：1周のAPI取得→比較→永続状態→専用Webhook（設定時のみ）。顧客別データ・キー等をジョブログへ出さない。
5. MSP管理者限定の一覧APIと対応記録PATCH、画面の超過対応欄。請求機能なし。
6. npm run secure-guard:overage-once：1回のみの実行。環境変数 SECURE_GUARD_OVERAGE_JOB_ENABLED=true の明示がない場合、DB接続前に停止。Cloud SchedulerやCronは未登録。

## 本番変更前のGate（未実施）

- [ ] PR #4のReview・統括Go、Git CanonicalとのFit/Gap。
- [ ] Migration 015 と本番DB・他レーンの番号競合をread-only確認。ドラフトから撤去した旧014がどこかの環境で適用済みでないか確認。停止判断者／切り戻し責任者確定。
- [ ] DNSFilter API Secret、MSPと顧客Organizationの対応付け、GET-only権限を再確認。
- [ ] 専用Slackチャンネル／Webhook受領、Secret登録、承認済み宛先へのテスト。
- [ ] 監視間隔、ジョブ主体の最小権限、二重起動防止、障害時手順を確定。
- [ ] Stagingで過少／同数／超過／API障害／Slack障害／解消のE2E検証。
- [ ] Go後のみMigration・Jobデプロイ・Scheduler・Slack実送信。

現在：Git上のDraft実装とオフライン検証のみ。DB Migration適用・ジョブ実行・本番デプロイ・Slack送信は未実施。旧手動割当参照用Migration 014・API・UI・テストは本Draftから撤去した。本番DBでは適用履歴を未確認のため、DBスキーマを変更せず事前確認する。
