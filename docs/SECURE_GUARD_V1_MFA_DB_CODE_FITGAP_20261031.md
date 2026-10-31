# Secure Guard v1｜MFA DB・認証コードFit/Gap
日付: 2026-10-31
状態: Read-onlyコード調査に基づく設計補足。コード変更・migration実行・HAなし。
基準: PR #3 HEAD 5103dafe5435b5de32bcc9410552d11bf247912f
正本: DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md / SECURE_GUARD_V1_MFA_IMPLEMENTATION_CONTRACT_20261031.md

## 実装上確認したFact
- `migrations/011_secure_guard_identity_scope.sql`: `portal_users`はUUID主キー、email、password_hash、status(invited/active/disabled)、session_versionを保持。`customer_memberships`は(user_id,customer_organization_id) UNIQUE、`msp_role_grants`は(user_id,role) UNIQUE。監査テーブル`secure_guard_audit_events`はactor_user_id/customer_organization_id/membership_id/action/result/receipt_id/created_atを保持し、target_user_id列は現状ない。
- `migrations/012_secure_guard_organization_independence.sql`: Organization名を追加し、旧customers依存を緩和。既存migration runnerはファイル名昇順・schema_migrations記録・ファイルごとのtransaction。新規MFA migrationは既存011/012を編集せず、次番号013を候補とする（最新migrationが追加されていないか実装直前に再確認）。
- `src/services/secureGuardIdentityService.ts`: `login()`、`acceptInvitation()`は通常JWTを直発行。MFA用の一時Challenge、方式、登録状態は未実装。`verifyActiveSession()`はuser.status/sessionVersion照合。
- `src/routes/secureGuardAuth.ts`: /login、/invitations/accept、/logoutのみ。パスワードログインはIPとメール単位の制限あり。MFA未完了を区別しない。
- `src/middleware/rateLimit.ts`: ログイン失敗5回で15分ロック、IPは15分30回。いずれもインメモリMapでCloud Runインスタンスをまたぐ共有保証なし。
- `src/services/authService.ts`: InfraVisionのパスワードリセットは`customers`と`password_reset_tokens(customer_id)`を使い、1時間期限のランダムトークンをSHA-256ハッシュで照合。Secure Guardの`portal_users`とは別Identityなので、直接流用せずロジックとMailerを再利用する。
- `src/services/mailer.ts`: 既存SMTP送信でInfraVisionパスワード再設定とSecure Guard招待を処理。メールOTP/リセット通知用の専用メソッド追加候補。
- `public/secure-guard-login.html`、`public/secure-guard-accept.html`、`public/js/secureGuard.js`: MFA未実装。成功後に直接ホームへ遷移する。
 
## コードレベルで固定する設計境界
1. MFA設定・Challenge・回復コードは`portal_users.id`に紐付く追加テーブルを使う。既存`portal_users.status`はIdentity状態として維持し、MFA未登録/再登録待ちは専用MFA状態で扱う。MFA未完了を理由に既存Membershipを削除しない。
2. Challengeの期限・試行数・消費・メール送信回数はDB上で原子的に管理する。ログインの既存IP制限は残すが、インメモリMapだけをMFAの安全性根拠としない。
3. MFA成功前は通常JWT/Cookieを発行しない。招待受諾経路も同様。既存Cookieがある場合のMFA導入時の失効・再ログインをテストする。
4. MFAリセットは対象Identityをロックし、最新の全有効MembershipとMSP Grantを照合。自己・複数Org・MSP保有者を拒否。設定/Challenge/回復コード失効、sessionVersion更新、監査を同一transactionで確定。監査のtargetUserIdをどう表現するかは既存schemaを見て最小追加を決める（監査を新設しない）。
5. Secure Guardパスワード忘れは`portal_users`向けの独立したトークン保存/消費を設計する。既存InfraVisionの`customers`用トークンを共有しない。パスワード再設定はMFAを解除しない。
6. Mailerは既存SMTPを再利用し、メールOTPと本人通知の本文だけ追加。メール配送結果不明と認証成功を混同しない。
7. TOTP秘密鍵の暗号鍵運用、OTP期限/試行数/発行数、チャレンジの具体的なAPIフィールド、CSRF対策は既存契約で未確定と明示されているため、実装前に最小の安全な値/方法を確定する。現段階で実装済みと扱わない。

## 次に行う限定設計
- 013 migrationのDDL、制約、ロック・消費SQL、既存監査のtarget表現。
- 認証APIのrequest/responseとCookie/Challenge/CSRF境界。
- MFA登録・再設定・パスワード忘れのUIと最小ヘルプ。
- その後、Workへ限定実装指示。現行認証・招待の回帰とMFA迂回試験を必須とする。

## 作業境界
この記録はコードとMigrationのRead-only Fit/Gap。DB操作、コード変更、SMTP送信、DNSFilter操作、デプロイなし。
