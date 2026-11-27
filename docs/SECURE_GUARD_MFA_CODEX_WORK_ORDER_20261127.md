# Codex実装指示｜Secure Guard V1 MFA（2026-11-27）

## 0. これは実装依頼書。仕様検討依頼ではない

**実装対象はこのIssue/本書に固定された差分のみ。** 目的は単一マルチテナントSaaSの必須MFAを最小実装すること。Codexに再設計・新規アーキテクチャ検討・本番操作を任せない。

先に以下を必ず読む：
1. `docs/SECURE_GUARD_MFA_V1_CODE_CONTRACT_20261127.md`（**今回の具体的API/SQL/状態遷移の唯一の実装仕様**）
2. `docs/SECURE_GUARD_V1_MFA_IMPLEMENTATION_CONTRACT_20261031.md`（上位MFA製品条件）
3. `docs/DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md`（最上位のシンプル運用方針）
4. `docs/DECISION_SECURE_GUARD_EMPTY_START_20261113.md`（SG新DB空開始）
5. `docs/SECURE_GUARD_V1_DB_INTEGRATION_20261112.md`、`docs/SECURE_GUARD_GATE_S4_OFFLINE_ACCEPTANCE_20261118.md`、既存Gate S3証跡/PRコメント。

実装前に最新Git HEAD/PR/CIを再取得。2026-11-27時点の**コード基準HEAD**は `abb53b4b615b5e93193af744d16a253d205fc3ce`。本契約をコミットした後のDraft PR #6 HEADはドキュメントの追記だけ進む可能性があるため、基準コードからの差分を確認する。MFA以外のコード変更、main/PR baseの変動、別Workの変更があれば実装せずSTOPしてFit/Gap。

## 1. Branchと変更方法

- 元repo：`yoshihisahagisaka/atlib-msp-customer-portal`。
- 元ブランチ：`feat/sg-v1-dedicated-integration-20261112`（Draft PR #6）。
- 作業ブランチ新規：`feat/secure-guard-mfa-v1-20261127`。**既存PR #6からstacked Draft PR**。PR #6は変更しない。
- M1→M2→M3の順に実装し、各SliceのCommit、テスト、SHA、Gateを報告。各Sliceで仕様の拡大・変更ファイル増加が必要ならSTOPし統括へ判断を返す。
- `migrations/secure_guard/001`–`005`、既存Manifest `001–005`、既存Portal migrations、および既存DNSFilter/Slack/Agent実装は不変。Migration 006はオフライン検証用。
- PR Draft／Production No-Go／Gate S3 STOP維持。自動merge、GCP Deploy、Cloud SQLへのDDL、SQL Instance/IAM/Secret/DNS変更は0件。

## 2. M1｜MFA Domain・DB・暗号・原子的操作

変更許可：
- `migrations/secure_guard/006_mfa_identity.sql`（コード契約のSQL3表をそのまま）
- `migration-manifests/secure-guard-staging-001-006.json`（001–005 SHAは固定。006だけ実ファイルから既存CRLF規則で計算）
- `src/domain/secureGuardMfa.ts`、`src/services/secureGuardMfa.ts`
- `src/services/secureGuardRepo.ts`（MFA専用SQLのみ）
- `test/secureGuardMfa*.test.cjs`、`test/integration/secureGuardDatabaseE2E.test.cjs`、既存Migrations SQLファイル一覧を検証するテスト、移行イメージのオフライン受入に必要な最小ファイル
- 006を `migrations/secure_guard/` に追加した場合、現在のrunner（ディレクトリ全件列挙）と旧001–005 manifestの組み合わせは必ずSTOPする。**MFA stacked PR内のオフライン実行に限り** `migrations/secure_guard_runner.ts`、`Dockerfile.secure-guard-migration`、`scripts/readiness/verifySecureGuardMigrationManifest.cjs`のManifest参照を001–006へ整合させ、CIの期待ファイル/旧テストを更新する。001–005のSQL/SHAは一切変えない。既存PR #6・実GCP Job Template/Deploy定義は更新せず、S3での005単独適用経路を温存する。

禁止：
- DB Migrationを実Stagingへ適用、既存001–005 SQL/SHA書換え、メール/GCP実送信、JWT/ログインの仕様変更（M1中のみ）、別認証基盤、複数Tenant DB、Redis、Queue。
- MFA状態をOrganization/Membershipに書くこと、OTPや秘密の平文保存。

M1受入：
- 3表のみ・FK/owner/runtime権限/overage否定、fresh/upgrade/replay、Challenge 10分/5失敗/メール最大3回/60秒/単一未使用、TOTP SHA1/RFC6238 vector、AES-GCM/未知keyVersion拒否、OTP HMAC/recovery hash、再利用拒否、秘密ログなし。
- 全テストと`git diff --check`。未確認ならM2へ進まない。

## 3. M2｜JWT直発行の廃止、MFAログイン・登録

変更許可：
- `src/domain/secureGuard.ts`、`src/services/secureGuardIdentityService.ts`、`src/routes/secureGuardAuth.ts`、`src/middleware/secureGuardAuth.ts`
- `src/services/mailer.ts`（MFA OTP/リセット通知追加のみ）
- `public/js/secureGuard.js`、`public/secure-guard-login.html`、`public/secure-guard-accept.html`、必要な最小MFA UI（新JSフレームワーク禁止）
- `src/secureGuardStagingRuntime.ts`（オフラインAuth試験だけ、実送信の有効化禁止）、対応認証・HTTPテスト
- 既存Identity/Repo/SQLを再利用する。新Router/独自session storeは作らない。

コード契約で固定した各APIとレスポンスを厳守。`login()`と`acceptInvitation()`からの通常JWT直接発行を廃止。認証CookieはTOTP/メールOTP検証成功時以外発行しない。JWT `mfaVerified === true` 必須。旧JWT fail closed。既存パスワード/招待・Scopeテストは「MFAなしログイン成功」を期待させず、**MFA検証前にはCookie 0**へ更新する。

M2受入：
- TOTPとメールOTP双方の初回登録、通常ログイン、Challenge使い捨て、間違い/時間切れ/再送/並行消費、UIにおける未認証状態、秘密非出力、旧Portalの運用・トラフィック未変更。
- 有効なMFA検証の前に通常JWTが発行されたら**直ちにSTOP**。

## 4. M3｜復旧・管理者限定Reset

変更許可：
- M1/M2の既存変更ファイル範囲内のみ（新表/新サービス/新監視は不可）。
- `src/routes/secureGuard.ts` に `POST /memberships/:membershipId/mfa/reset` を追加。
- 既存監査表、`session_version`、既存Mailer送信路を使用。

コード契約の「自社のみ・別Identity・有効org_admin・MSP grantなし・複数所属なし・MFA直前再認証5分・一回proof」を厳守。DB transactionでロック・検証・コード失効・sessionVersion加算・auditをCOMMITし、通知は後送。本人通知失敗でも認証状態を復旧してはならない。atLIB特例復旧APIは作らない。

M3受入：
- 使用済み回復コード再利用不可、同時消費1回、復旧後は再登録必須、既存Cookieは失効。
- 他社、自己、viewer/operator、複数組織所属、MSP権限者、操作側MFA未再認証、期限切れ・再利用proofすべて403/409（固定コード）。監査記録と通知失敗の扱い確認。
- 管理者2〜3名推奨の既存文言を指定顧客管理UIに表示するが、人数制限や監視は新設しない。

## 5. 検証VMの利用

ユーザーが提供した既存VM（**新規VM作成禁止**）：
- `atlib-test-runner` / project `msp-zabbix` / `asia-northeast1-a` / Ubuntu 24.04 / e2-standard-4（4CPU/16GB）/ OS Login + IAP。
- Home `/home/yoshihisa_hagisaka_atlib_jp/`。**既存Clone `~/atlib-test/atlib-msp-customer-portal/` のみ**を使用（再Clone禁止）。他プロジェクトのディレクトリに触れない。
- IAP SSH/OS Loginで接続し、`scripts/readiness/secureGuardVmPreflight.sh` を実行。既存Git/Node/npm/Docker/PG readinessを確認。Docker/Node未導入、GitHub認証失敗ならSTOP。sudo/apt/npm global/install VM設定変更は承認を得てから。
- コードをローカルclone/fetchし、**固定SHAでcheckout、working tree cleanを照合**。VMからProduction DB、共用Cloud SQL、DNSFilter実API、SMTP/Slackへ接続しない。テストDBは `127.0.0.1:55432` のDisposable PG16のみ。実認証情報をenv/ファイル/CLIへ注入しない。
- VMはテスト・ビルド・静的診断専用。結果はGitの追跡対象にしない `~/atlib-test/evidence/atlib-msp-customer-portal/` に日時・Git HEAD・固定テスト結果・安全なログのみ記録。VM内GitのCommit/Pushは実装担当のレビュー済み作業ブランチに限定。CI/GitHubを唯一の提出先とする。
- VMが未準備でも通常GitHub Actionsは実行可能。環境整備のために設計を変えない。

## 6. 必須実行と報告様式

各Slice完了時：
1. `git status --short`、`git rev-parse HEAD`、`git diff --name-only`、`git diff --check`。
2. `PUPPETEER_SKIP_DOWNLOAD=true npm ci`（repo固定lockfile）、`npm run build`、`npm test`、`npm run typecheck:secure-guard-migration`。
3. CIの既存 `isolated-postgres` PG16テスト、専用Migration Image CI、Secure Guard Staging Docker SmokeをすべてPASSにする。VMが使用可能なら対応するローカル実行で照合。
4. SHA-256 Manifest（既存001–005固定、006のみ新規計算）、SQL/ACL/Identity/HTTP/UI/RecoveryのPASS/FAIL/STOPを一覧化。
5. `Branch/HEAD/Base/Draft PR/Actions Run/変更ファイル/確認結果/未完了/環境変更0` を既存PRへ証跡記録。
6. 一つでもUnknown/Fail/仕様解釈ギャップなら**STOPしその場で報告。自動的に制限を緩和したり、スコープ外実装を足してPASSさせない**。

### CodeX最終完了判定

M1・M2・M3全実装・オフラインCIがPASSして初めて「MFAオフライン実装完了」。これは本番リリースではない。Gate S3:公式修正版Image Critical/High=0と005の実Staging ACL再受入がPASSするまで006適用は禁止。006実Staging移行、Cloud Run/Secret/SMTP/DNSFilter連携の実行は経営者の**別途明示承認**が必要。Production No-Go維持。
