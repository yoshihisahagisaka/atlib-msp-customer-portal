# Secure Guard V1 MFA｜コードレベル実装契約（2026-11-27）

- 状態：**DESIGN FIXED FOR CODEX / OFFLINE IMPLEMENTATION ONLY**。本書は設計・実装範囲の固定であって、Staging/ProductionのMigration、GCP変更、PR Merge、MFAの例外認証の許可ではない。
- 現行起点：`yoshihisahagisaka/atlib-msp-customer-portal` / Draft PR #6 / branch `feat/sg-v1-dedicated-integration-20261112` / 2026-11-27実測 HEAD `abb53b4b615b5e93193af744d16a253d205fc3ce`。Codex開始時にHEAD・Canonical・他PRの再読取を必須とする。HEAD不一致時はSTOPしてFit/Gap報告。
- 上位不変条件：`docs/DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md`、`docs/SECURE_GUARD_V1_MFA_IMPLEMENTATION_CONTRACT_20261031.md`、`docs/DECISION_SECURE_GUARD_EMPTY_START_20261113.md`、`docs/SECURE_GUARD_V1_DB_INTEGRATION_20261112.md`、`docs/SECURE_GUARD_GATE_S4_OFFLINE_ACCEPTANCE_20261118.md`。
- 既存を再利用：単一Secure Guardアプリ、環境ごとに一つのSG DB、`portal_users`、`customer_memberships`、`msp_role_grants`、`secure_guard_audit_events`、`session_version`、`SecureGuardIdentityService`、`SecureGuardRepo`、`secureGuardAuth`、`Mailer`、LoginRateLimiter、JWT Cookie。顧客単位のDB・Cloud Run・別認証基盤を作らない。
- 別レーンのSECU:MIE Insight OTPの期限/桁数・JWT/JWKS仕様を本製品へ流用しない。本書に記す数値と形式はSecure Guard V1向け設計決定である。

## 1. 現行Fit/Gapと商用Go条件

現行 `SecureGuardIdentityService.login()` は bcrypt成功後、`acceptInvitation()` は受諾成功後、いずれも既存の通常JWTを即時発行する。`createSecureGuardAuthRouter`はそのJWTを `secure_guard_session` Cookieへ保存し、`verifySession`はMFA状態を確認しない。**MFA必須のCanonicalに対する未実装Gap**である。

商用の成功判定は、TOTPとメールOTPの双方、登録と回復、バックアップコード、顧客管理者の限定リセット、MFA前JWT拒否、権限再読取、秘密保護およびオフライン/実Staging E2EがすべてPASSしてから。現行のパスワード認証/二組織Scope試験PASSはMFA PASSではない。

## 2. 最小構成

1. DBは既存SG DBに**MFA専用3表のみ**追加する。`secure_guard_mfa_settings`（Identityに現在1設定）、`secure_guard_mfa_challenges`（使い捨て/失効/試行）、`secure_guard_mfa_recovery_codes`（バックアップコードハッシュ）。MFA待ち状態はsettings.stateに置き、4番目の状態表は作らない。
2. ChallengeはDBの行ロックとトランザクションで制御し、Redis、Queue、別サービス、別テナントDB、別MFA Identityを導入しない。
3. TOTP秘密だけをAES-256-GCMで暗号化（AADは `user_id|secure_guard_totp_v1` に固定）し、暗号鍵はDB外のSecret注入、キー版数をsettingsに保持する。メールOTP/バックアップコード/Challenge tokenは平文保存しない。
4. MFAの認証成功後だけ既存JWTを発行し、JWTに `mfaVerified: true` と `mfaMethod: 'totp'|'email'` を付ける。`verifySession()`はこのclaimを必須検査し、以前のパスワードのみのJWTを拒否する。`verifyActiveSession()`は既存user/session_versionに加えsettings.state=`active`をDBで再確認する。Membership/RoleはJWTに載せず毎リクエストDB確認を維持する。
5. 既存JWT期限（環境設定、現行は24h）・CookieのSecure/HttpOnly/SameSiteを維持する。MFA前のChallengeは通常Cookieとは異なるランダム不透明tokenとし、通常APIでは受理しない。

## 3. 固定するセキュリティ数値・暗号仕様

| 項目 | Secure Guard V1の固定値 |
| --- | --- |
| TOTP | RFC 6238 / SHA-1（標準Authenticator互換）/ 6桁 / 30秒step / 許容±1 step |
| TOTP replay | `last_totp_step`以下のstepを拒否。`SELECT ... FOR UPDATE`後に更新 |
| メールOTP | CSPRNGで6桁、期限はChallengeと同じ10分 |
| Challenge | 32 bytes CSPRNGのランダムtokenをクライアントへ返し、DBにはSHA-256 hashのみ。10分、最大5回失敗、使用後再利用禁止 |
| メールOTP再送 | 60秒間隔、Challenge当たり合計3回まで（初回を含む）、期限延長なし、再送で前コード無効 |
| 再認証 | 管理者MFA再認証Challengeは5分、成功時にその同一Challengeをreset操作の一回限りproofとして消費 |
| バックアップコード | 一人10個、各16 bytes CSPRNG（128bit）、hex表記、1回表示・1回消費、再登録時は旧コード無効 |
| TOTP秘密 | 20 bytes CSPRNGをAES-256-GCM（32-byte key/12-byte random nonce/16-byte tag）で暗号化。DBへ鍵を保存しない |
| hash | Challenge: SHA-256。低エントロピーOTP/バックアップコード: `HMAC-SHA256(pepper, userId|challengeHash|code)`（バックアップはchallengeHash不要） |
| Secret | `SECURE_GUARD_MFA_ENCRYPTION_KEY_V1`（base64 32bytes）、`SECURE_GUARD_MFA_OTP_PEPPER`（base64 32bytes）。Secret Manager→環境変数注入。未設定/長さ異常時はMFA開始不可 |
| Logging | JWT/Cookie、OTP、TOTP秘密、バックアップコード、暗号鍵、メール本文、Challenge token、SQL値を記録しない |

定数は新規 `src/services/secureGuardMfa.ts` 冒頭または専用 `src/domain/secureGuardMfa.ts` に一か所に固定し、管理画面で変更可能な設定を追加しない。鍵rotationは既存鍵versionと後方復号を維持する別変更として本PRの対象外。未知versionはSTOP。暗号・TOTP実装はNode `crypto` とRFCテストベクトルを用い、自己流の独自暗号を設計しない。

## 4. DB Migration 006（設計のSQL契約）

新規 `migrations/secure_guard/006_mfa_identity.sql`。001–005はバイトもSHAも変更しない。**006は作成/オフライン検証のみ**。005が実Staging未適用の間に006をまとめて実DBへ適用しない。オフラインでのみ `secure-guard-staging-001-006.json` を生成して比較する。新Manifestを実GCP Jobへ適用するのも別承認。

```sql
CREATE TABLE secure_guard_mfa_settings (
  user_id UUID PRIMARY KEY REFERENCES portal_users(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('totp','email')),
  state TEXT NOT NULL CHECK (state IN ('enrolling','active','reset_required')),
  totp_ciphertext BYTEA,
  totp_nonce BYTEA,
  totp_tag BYTEA,
  key_version SMALLINT,
  last_totp_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state='reset_required' AND totp_ciphertext IS NULL AND totp_nonce IS NULL AND totp_tag IS NULL AND key_version IS NULL)
    OR (state<>'reset_required' AND method='totp' AND totp_ciphertext IS NOT NULL AND totp_nonce IS NOT NULL AND totp_tag IS NOT NULL AND key_version IS NOT NULL)
    OR (state<>'reset_required' AND method='email' AND totp_ciphertext IS NULL AND totp_nonce IS NULL AND totp_tag IS NULL AND key_version IS NULL)
  )
);
CREATE TABLE secure_guard_mfa_challenges (
  token_hash CHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','enroll','recovery','admin_reauth')),
  method TEXT CHECK (method IN ('totp','email')),
  otp_hmac CHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count BETWEEN 0 AND 3),
  last_sent_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sg_mfa_challenges_user_expiry ON secure_guard_mfa_challenges(user_id, expires_at);
CREATE TABLE secure_guard_mfa_recovery_codes (
  user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  code_hmac CHAR(64) NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hmac)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  secure_guard_mfa_settings, secure_guard_mfa_challenges, secure_guard_mfa_recovery_codes
TO secure_guard_runtime_staging;
```

overage roleにはこの3表の権限を与えず、Ledger・DDLへのruntime権限も与えない。既存 `SecureGuardRepo` のトランザクション境界のみ使用。Identityが1回に複数Challengeを保持する必要はないため、Challenge発行時は**`portal_users FOR UPDATE` → 未消費Challengeをconsumed化 → 1件INSERT → COMMIT**する。連続再ログインは古いChallengeを無効化する。テストはfresh 001–006と既存001–005→006の双方、replay SKIP、checksum drift STOP。

## 5. 状態遷移（通常JWTを発行する唯一の点を固定）

| 入口 | 成功時の状態 | JWT/Cookie |
| --- | --- | --- |
| パスワードログイン、有効factor | `login` Challenge発行→TOTP/メールOTP確認へ | **発行禁止** |
| パスワードログイン、factorなし/再登録待ち | `enroll` Challenge発行→方式選択へ | **発行禁止** |
| 招待受諾＋パスワード設定 | 既存Membership整合を維持し、`enroll` Challenge発行 | **発行禁止** |
| TOTP登録開始 | 暗号化factor `enrolling`→本人アプリで初回code照合 | **発行禁止** |
| メール方式登録開始 | factor `enrolling`→登録済みemailにOTP送信→本人照合 | **発行禁止** |
| 登録検証成功 | factor `active`、Challengeを原子的に消費、回復コード10個生成/ハッシュ保存・一回だけ返す | **この時だけ発行** |
| 通常MFA検証成功 | Identity/state/Challenge/試行数/コード/前回TOTP stepを同一transactionで照合・消費 | **この時だけ発行** |
| バックアップコードで復旧 | コード1つを消費、factor `reset_required`、未消費Challenge停止、TOTP暗号化秘密を消去、`session_version`加算、再登録Challenge発行 | **発行禁止** |
| org_adminの再認証 | `admin_reauth` Challengeが`verified_at`保持、5分有効 | 新規JWT発行不要 |
| 対象MFAリセット | reauth proof消費、対象factor `reset_required`（暗号化秘密消去）、全Challenge/コード失効、`session_version`加算、監査 | **対象へ発行禁止** |

暗号化済みfactorがなくても、パスワード成功時に通常Cookieを返すfallbackは禁止。Challengeが期限切れ、結果不明、競合、DB接続不可ならfail-closed。メール未到達や送信結果不明も検証成功扱いしない。再送によって旧OTPを無効化する。バックアップコードは成功消費で再登録へ進むものでありMFA迂回手段ではない。

## 6. 固定API（既存 `/api/secure-guard/auth` で拡張）

| Method/Path | Body / 身元 | 成功時 | 安全境界 |
| --- | --- | --- | --- |
| `POST /login` | `{email,password}` | `202 {flow:'MFA_REQUIRED'|'MFA_ENROLLMENT_REQUIRED',challengeToken,method?}` | Cookieなし。失敗401 `INVALID_CREDENTIALS` |
| `POST /invitations/accept` | `{token,password}` | `202 {flow:'MFA_ENROLLMENT_REQUIRED',challengeToken}` | Cookieなし。受諾前の招待競合・期限判断を維持 |
| `POST /mfa/enroll/start` | `{challengeToken,method:'totp'|'email'}` | TOTP: `200 {otpauthUrl}` / email: `202 {delivery:'sent'}` | TOTP秘密は一度のみ返し永続ログ禁止 |
| `POST /mfa/enroll/verify` | `{challengeToken,code}` | `200 {backupCodes:string[]}` + 通常Cookie | 最初の本人検証が必要。秘密の再取得APIなし |
| `POST /mfa/verify` | `{challengeToken,code}` | `204` + 通常Cookie | 期限・5回・ワンタイム・replayをatomic check |
| `POST /mfa/email/resend` | `{challengeToken}` | `202 {delivery:'sent'}` | 60秒・3送信制限、未確定送信503 |
| `POST /mfa/recovery` | `{challengeToken,backupCode}` | `202 {flow:'MFA_ENROLLMENT_REQUIRED',challengeToken}` | password確認済みrecovery Challengeのみ許可、Cookieなし |
| `POST /mfa/reauth/start` | 現行認証Cookie | `202 {challengeToken}` | org_adminでも直前MFA必須。Challenge TTL5分 |
| `POST /mfa/reauth/verify` | `{challengeToken,code}` + 現行Cookie | `204` | 同じChallengeの`verified_at`更新（通常セッションは新発行しない） |
| `POST /api/secure-guard/memberships/:membershipId/mfa/reset` | `{reauthChallengeToken}` + 現行Cookie + `X-Secure-Guard-Membership` | `204` | org_admin専用／別Identity／単一組織所属／MSP Grantなし／一回proof／transaction audit |

`mfa/recovery`の開始用Challengeはパスワード成功時の`login` Challengeを同一ユーザーに紐づけ、開始する際にそのPurposeを`recovery`へatomic変換する。別の匿名で回復開始する経路を作らない。失敗応答は固定コードで返し、ユーザー在否、OTP、TOTP秘密、backup code、DB例外を露出しない。

## 7. コード差分のホワイトリスト（Codexが勝手に増やさない）

- `migrations/secure_guard/006_mfa_identity.sql`（新規3表のみ）
- `migration-manifests/secure-guard-staging-001-006.json`、必要な固定Manifest参照（**新しいoffline imageでのみ**）。旧001–005 ManifestやSQLを変更しない
- `src/domain/secureGuard.ts`：`SecureGuardSessionPayload`にMFA claimを追加
- `src/domain/secureGuardMfa.ts`（新規）：上述固定型・定数・状態
- `migrations/secure_guard_runner.ts`、`Dockerfile.secure-guard-migration`、`scripts/readiness/verifySecureGuardMigrationManifest.cjs`の**オフライン006用の参照更新だけ**。既存001–005のSHA判定と実Staging固定Job/Templateは変更しない。006ファイルが増えると旧001–005 Manifestのままではオフライン実行がSTOPするため、stacked MFA PR内のデフォルトManifestを001–006へ固定し、CIも期待ファイルを更新する
- `src/services/secureGuardMfa.ts`（新規）：Challenge、TOTP、OTP、回復、暗号とMFA状態遷移を担当。別認証基盤を作らない
- `src/services/secureGuardIdentityService.ts`：`login`、`acceptInvitation`をChallenge開始へ置換、JWT発行の唯一の関数をMFA成功内部に限定、旧JWT reject
- `src/services/secureGuardRepo.ts`：MFA専用SQLとトランザクション。既存テナントSQLの変更なし
- `src/routes/secureGuardAuth.ts`：既存Routerを拡張（新Routerファイル不要）
- `src/routes/secureGuard.ts`：上記 `mfa/reset` 1ルートのみ
- `src/services/mailer.ts`：OTP・MFAリセット通知メソッドのみ追加、既存SMTP transport再利用
- `public/js/secureGuard.js`、`public/secure-guard-login.html`、`public/secure-guard-accept.html`、既存顧客利用者管理画面：MFA入力/登録/回復・案内を最小UIで追加。既存静的配信境界を維持
- `src/secureGuardStagingRuntime.ts`：offline検証のauth経路だけ既存安全境界内で必要最小の更新。**実Stagingの実メール・外部書込み許可は不可**

- 対応 `test/` 以下のMFA/既存認証/使い捨てPG16/E2E、既存UI受入テスト、READMEではなく本契約への証跡追記。必要なビルドManifestのoffline参照変更を明記。

新ファイルが必要なら上記許可範囲と機能の一対一対応を示して統括へSTOP報告。顧客別テーブル、Redis、Queue、KMS用常駐アプリ、請求基盤、独自DNSFilter状態管理などは作らない。

## 8. MFAリセットの厳格条件

`org_admin`は自社だけに有効Membershipがある**他Identity**のみreset可能。操作ユーザー自分自身、複数組織所属、MSP Grant保有者、無効Identity、対象不在、`operator`/`viewer`、最近のMFA再認証なしは拒否。対象ユーザーのMembership/Grant/Identity/MFAと操作側権限と`admin_reauth` Challengeを一transactionでロック・照合し、recovery codes/Challenge無効化、TOTP暗号化秘密消去、session_version+1、監査固定コードの記録後COMMIT。通知メール送信はCOMMIT後だけ。送信失敗・不明は状態を戻さず、監査し人手確認。atLIB例外復旧はAPI実装せず個別手順（別承認）。

## 9. オフライン受入契約

- 認証：passwordのみ・招待受諾のみ・旧JWT・MFA未登録・Challenge期限切れ・二重送信・Challenge並列消費で通常JWTが**1つも発行されない**。
- TOTP：RFC6238公開テストベクトル、±1 step、再利用不可、暗号化/復号と異なる鍵のSTOP、ログ非露出。
- email：6桁のCSPRNG、間隔・回数、旧コード失効、SMTP送信失敗/UNKNOWNのSTOP、同一Challengeの限度と別Org共有禁止。
- recovery：codeハッシュのみ、同時消費は1件、sessionVersion旧Cookie無効、MFA再登録までno-cookie。
- admin reset：自社単一組織所属の他者のみ、自己/複数所属/MSP grant/他社/再認証なしを拒否、監査、通知失敗でも状態巻戻しなし。
- DB：001–006 fresh、既存001–005→006、固定SHA/replay、migration role owner、runtime最小権限、overage/Insight分離、旧Portal DB不変。
- ユーザーUI：方式選択、コード入力、回復コード一度のみ、MFA登録失敗/期限切れ、初回招待で無Cookie。秘密のコンソール/HTTPログ非出力。
- VM/CI：既存CIを正本として使い、`atlib-test-runner`のローカルPostgreSQL16・localhost限定テストで相互確認。実GCP DB/SQL Job/DNSFilterをテストに流用しない。
- 旧回帰（2026-11-20実績117件）、PG16隔離とDocker起動が全PASS。負のケース全てPASSまでMFA商用GateはSTOP。

## 10. 実装順序・停止条件

- Slice M1：006 schema、domain定数、crypto/TOTP/challenge repository、unit/PG16テスト。JWT・HTTPの動作変更なし。
- Slice M2：`login`/`acceptInvitation`のJWT直発行廃止、認証/登録/メールOTPのRouter、Cookie/middleware、最小UI。既存端末/管理APIを触らない。
- Slice M3：バックアップコード、再登録、`org_admin`の限定MFA reset、監査・通知・セッション失効。
- 各SliceでCodexの変更対象/意図/証跡を独立commit、既存PR #6から**stacked Draft PR**を作成、CIとVM実測を比較。main/PR #6へ直接mergeしない。
- 実Staging：Gate S3の公式修正版Migration ImageでCritical=0/HIGH=0実測、005単独適用とACL read-back PASSが先。006・MFA app/Secret/Cloud Runは**別の明示承認**。Gate S4/Production No-Goを維持する。
- 不明な値、Canonical衝突、Git HEAD漂流、Unexpected DB state、Secrets/SDK不足、test failure、CI GCP到達の疑義は**STOP→Fit/Gap→統括報告**。自動復旧/無断再試行/テストの削除/閾値緩和は禁止。
