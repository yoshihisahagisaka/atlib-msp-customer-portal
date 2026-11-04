# Secure Guard v1｜MFA実装契約

日付: 2026-10-31
状態: 統括合意済みの実装契約。コード、migration、テスト、デプロイは未実施。
基準: PR #3 HEAD `25b17b21c93f0284a58b827cdd52a4bb2baff83d`
上位: `DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md`、`SECURE_GUARD_V1_IMPLEMENTATION_FITGAP_20261030.md`、`SECURE_GUARD_V1_MSP_ORG_SYNC_IMPLEMENTATION_CONTRACT_20261030.md`、`SECURE_GUARD_V1_MSP_CUSTOMER_DETAIL_CONTRACT_20261031.md`

## 1. 目的と不変条件

全Secure Guard利用者を、個人Identity単位のパスワードとMFAで認証する。Customer MembershipとMSP Grantは既存の独立した認可境界を維持し、MFAの方式・設定はIdentityにだけ属する。Customer Organization、DNSFilter Organization、端末、契約情報へMFA設定を複製しない。

- TOTPを推奨し、メールOTPも利用者が選択できる代替方式とする。
- MFA未完了のIdentityへ、既存の通常JWT／`secure_guard_session` Cookieを発行しない。
- MFAを用いない例外ログイン、Customer RoleからのMSP権限推論、管理者によるOTP／TOTP秘密鍵の閲覧は作らない。
- `login()`と`acceptInvitation()`の双方をMFA経由に変更する。招待受諾はパスワード設定後にMFA登録へ進み、通常セッションを発行しない。
- MFA設定・検証・復旧・リセットでは、既存のIdentity、Membership、`session_version`、監査、Mailer、レート制限を再利用する。
- 実装前に決まっていないDB制約値、暗号方式の鍵運用、APIフィールド名、OTPの正確な期限／回数は、本書で確定済みとして扱わない。

## 2. 現行実装とのFit/Gap

| 既存資産 | 確認済みFact | MFA実装での扱い |
| --- | --- | --- |
| `portal_users` | 個人Identity、password hash、status、`session_version`を保持 | 維持する。MFAリセット時は`session_version`を更新して旧通常JWTを失効させる。 |
| `SecureGuardIdentityService.login()` | パスワード成功後に通常JWTを即時発行 | MFA Challenge開始へ置換する。MFA成功だけが通常JWTを発行できる。 |
| `SecureGuardIdentityService.acceptInvitation()` | パスワード設定・Membership受諾後に通常JWTを即時発行 | パスワード設定後にMFA登録を必須化する。招待受諾だけでログイン完了としない。 |
| `verifyActiveSession()` | user statusと`session_version`を照合 | 維持する。MFA再設定待ちのIdentityは通常セッションを利用できない状態にする。 |
| `customer_memberships`／`msp_role_grants` | Customer ScopeとMSP Scopeを分離 | MFAリセット可否を、トランザクション内の最新Membership数とMSP Grantで判定する。 |
| `secure_guard_audit_events` | Organization、Membership、provisioningの監査を記録 | MFA登録、検証失敗、復旧、リセット、通知結果を安全な固定コードで記録する。OTP・秘密鍵・回復コードは記録しない。 |
| `Mailer` | 招待メールと既存ポータルのパスワード再設定メールを送信可能 | メールOTPとMFAリセット通知に再利用候補。本文・送信失敗時の状態遷移は別に試験する。 |
| 既存レート制限 | Secure GuardログインにIP・アカウント単位の制限あり | MFA Challenge／OTP検証／OTP再送／回復コード検証へ拡張する。別の無制限経路を作らない。 |
| InfraVisionのパスワード再設定 | 既存`authService`、token hash、Mailer、`PASSWORD_RESET_URL_BASE`がある | Secure Guardのパスワード忘れ復旧に再利用可能かをFit/Gapする。既存の顧客共有アカウント用テーブルをそのまま流用することは未決定。 |

## 3. 決定済みの利用者フロー

### 3.1 通常ログイン

1. 利用者がメールアドレスとパスワードを送信する。
2. サーバーがIdentityの有効状態とパスワードを確認する。
3. 成功時、通常JWTは発行せず、短期かつ一回限りのMFA Challengeへ進める。
4. TOTP利用者はTOTPを検証する。メールOTP利用者はサーバーが制限付きでOTPを送信し、利用者が検証する。
5. MFA検証が成功した時だけ、既存形式の通常JWT／httpOnly Cookieを発行する。
6. 失敗、期限切れ、試行上限、再送上限、Identity無効化、Challenge消費済みは安全な固定エラーで停止する。自動再送・通常JWTへのfallbackはしない。

### 3.2 初回登録・招待受諾

1. 招待トークンとパスワードを検証し、既存の招待受諾・Membership整合性を維持する。
2. パスワード設定後、IdentityをMFA登録待ちとして扱う。
3. 利用者はTOTP又はメールOTPを選び、MFA設定を完了する。
4. バックアップコードを一度だけ利用者へ提示する。サーバーには検証用ハッシュだけを保存する。
5. MFAの初回検証成功後にのみ通常JWTを発行する。

### 3.3 復旧

- TOTP・メールOTPの両方式に使い捨てバックアップコードを発行する。
- バックアップコードはパスワード認証後にだけ使用できる。コード単独で通常セッション、メールアドレス変更、権限変更を許可しない。
- 有効なバックアップコードを消費した後は、既存MFA設定を成功扱いで復帰させず、MFA再登録待ちにする。MFA再登録と検証が完了するまで通常JWTを発行しない。
- パスワード忘れは既存InfraVisionの再設定実装をFit/Gapした上で利用する。再設定トークンの有効化だけでMFAを解除してはならない。

## 4. MFA最小データ構造案

次はmigration設計の候補であり、テーブル名、列名、unique制約、暗号鍵の格納先を確定するものではない。既存`portal_users`、`customer_memberships`、`msp_role_grants`、`secure_guard_audit_events`を変更・置換しない。

| 論理データ | Identityとの関係 | 最小保持内容 | 保護・状態 |
| --- | --- | --- | --- |
| MFA設定 | Identityごとに現在有効な設定を一つ | MFA方式、設定状態、登録・無効化時刻、TOTP用の暗号化済み秘密またはメール方式の設定参照 | TOTPの平文秘密をDB・ログ・APIレスポンスへ置かない。暗号化鍵の取得・rotation方式はSecret管理の既存方針とFit/Gapする。 |
| MFA Challenge | Identityごとの短期Challenge | 用途、方式、検証値のハッシュ又はサーバー側検証参照、発行／期限／消費時刻、試行・送信回数 | 一回限り。消費済み、期限切れ、上限到達は再利用不可。通常JWTと混同しない。 |
| バックアップコード | Identityごとの複数コード | コードハッシュ、発行時刻、消費時刻、失効理由 | 平文を永続化しない。消費は同一トランザクションで一回だけ。 |
| MFA再登録待ち状態 | Identityの認証状態に紐付く状態 | 要求理由、開始時刻、完了時刻又は解除時刻 | 通常ログイン・通常JWT発行を止める。Identity無効化、Membership、MSP Grantとは別概念として扱う。 |

TOTP秘密の具体的な暗号アルゴリズム、鍵IDの表現、キーrotation、メールOTPの保存形態、バックアップコードの発行数、OTPの桁数は、既存Secret運用・依存ライブラリ・脅威分析を確認するまで未確定とする。暗号化していることだけを理由に、秘密を管理者画面や監査へ返してはならない。

## 5. API契約案

既存のSecure Guard認証ルートを拡張する。ルート名・JSONフィールド名・HTTPステータスの最終値は、現行ルートのmount path、ブラウザ画面、既存テストを確認して固定する。本節は認可と状態遷移の契約であり、未実装のAPIを公開済みと表現しない。

| 操作 | 入力・認可 | 成功時 | 拒否・安全条件 |
| --- | --- | --- | --- |
| パスワードログイン開始 | メールアドレス、パスワード、既存IP／アカウント制限 | MFA Challengeだけを返す。通常Cookieなし | Identity不在・無効・パスワード不一致・制限超過を区別しない安全な失敗にする。 |
| MFA検証 | Challenge、TOTP又はメールOTP | Challengeを消費し、通常JWT／Cookieを発行 | 期限・回数・方式・消費済みを検証。再送や別方式への暗黙切替なし。 |
| メールOTP送信／再送 | 未消費のメール方式Challenge、再送制限 | メール送信を試行し、安全な送信状態を返す | 送信結果不明を成功扱いしない。自動連続再送なし。 |
| 招待受諾開始 | 招待トークン、パスワード | MFA登録待ちへ進む。通常Cookieなし | 招待／Membershipの既存整合性、競合、期限切れを維持する。 |
| MFA初回登録・検証 | MFA登録待ちのIdentity | MFA設定を有効化し、バックアップコードを一度だけ提示後、通常JWTを発行 | TOTP秘密・OTP・バックアップコードをログ／監査／再取得APIへ返さない。 |
| バックアップコード復旧 | パスワード認証済みの短期復旧Challenge、未消費コード | コードを消費し、MFA再登録待ちへ遷移 | 通常JWTは発行しない。並行利用、再送、同一コード再利用を拒否。 |
| 顧客管理者によるMFAリセット | MFA再認証済みの`org_admin`、対象Identity | 対象の旧セッション失効とMFA再登録待ち化。本人通知を要求 | 自己、他Organizationにも所属する対象、MSP Grant保有者、同一Organization外、無効な操作側MFAを拒否。 |
| atLIB例外復旧 | 全体管理者の別承認済み運用 | 個別手順で扱う | 顧客管理者リセットAPIの権限拡大として実装しない。 |

## 6. 顧客管理者によるMFAリセット

`org_admin`は、自社だけに有効Membershipを持つ別IdentityのMFAだけをリセットできる。対象Identity自身のリセットは許可しない。複数Organization所属者、`msp_admin` Grant保有者、所属外Identity、無効なIdentityは対象外とする。これらの例外はatLIB全体管理者が担当する。

リセット要求は、操作する`org_admin`の通常セッションだけでは足りない。操作直前のMFA再認証を要求する。再認証済みの証明は短期・一回限り・操作Identityへ束縛し、通常JWTやCustomer Scopeの値で代用しない。

### トランザクション境界

1. 操作Identity、対象Identity、対象の有効Membership、対象のMSP Grant、MFA状態を同一トランザクションでロックして再読取する。
2. 操作Identityが当該Organizationの有効`org_admin`であり、対象が別Identityかつ同一Organizationだけに有効Membershipを持つことを検証する。
3. 対象が有効MSP Grantを持たないことを検証する。
4. 対象のMFA設定・未消費Challenge・未消費バックアップコードを無効化し、MFA再登録待ちへ遷移する。
5. 対象の`session_version`を更新して既存通常セッションを失効し、監査イベントを同一トランザクションで記録する。
6. commit後に本人通知メールを送る。配送失敗・結果不明は認証状態を元へ戻さず、通知失敗を安全に監査して人が確認する。メール送信を理由にリセットを自動再実行しない。

操作側MFA再認証、対象セッション失効、MFA再登録待ち、監査のいずれかを欠いた成功応答を返してはならない。

## 7. OTP・秘密情報の安全条件

- OTP、バックアップコード、TOTP秘密、Authorization、JWT、Cookie、Mailer本文、例外本文を通常ログ・監査・APIエラーへ出さない。
- OTPとバックアップコードは平文で保存せず、検証に必要なハッシュだけを保存する。
- TOTP秘密は平文保存を禁止し、Identity単位で暗号化する。復号は検証処理だけに限定する。
- OTP期限、OTP試行回数、Challenge再送回数、バックアップコード発行数、MFA再認証の有効時間は安全設定値として実装前に決める。現時点で数値を固定しない。
- 既存IP・アカウント単位のログイン制限を維持し、MFA検証・再送・回復にも相応の制限を加える。正確なカウンタ共有範囲は既存`rateLimit`実装を確認して決定する。
- OTP送信と検証は、同一Identityの未消費Challengeを増殖させない。結果不明・送信失敗は成功扱いせず、無制限の自動再送をしない。

## 8. UI/UX契約

顧客`org_admin`の利用者管理画面上部に、次の固定文言を常時表示する。管理者を2〜3名にすることは推奨であり、登録数の強制、警告、通知、監視は行わない。

> 管理者の退職・異動や認証アプリの紛失に備え、管理者を2〜3名登録することを推奨します。管理者同士でMFAの再設定を支援できるため、ログインできなくなった場合にも社内で対応できます。

画面は、TOTP登録、メールOTP選択、バックアップコードの一回表示、MFA再登録待ち、リセット完了、期限切れ、再送制限、送信結果不明を区別する。顧客管理者には対象者の秘密、OTP、バックアップコード、ログイン履歴の生情報を表示しない。

## 9. HA・回帰の受入条件

実装後のHAと自動試験では、少なくとも次を確認する。

1. TOTPとメールOTPの双方で、MFA成功前に通常JWT／Cookieが発行されない。
2. `login()`と`acceptInvitation()`の双方がMFAを迂回できない。
3. TOTP登録、メールOTP送信・検証、期限切れ、試行上限、再送上限、Challenge再利用、方式不一致を安全に拒否する。
4. バックアップコードは一度だけ消費でき、成功後にMFA再登録を完了するまで通常セッションを得られない。
5. 既存セッションはMFAリセット後の`session_version`更新で拒否される。
6. `org_admin`が自社だけに所属する別Identityをリセットできる一方、自己、他社所属、複数所属、MSP Grant保有者、`operator`、`viewer`、未再認証の`org_admin`は拒否される。
7. リセットは監査され、本人通知が失敗・結果不明でも秘密を出さず、認証状態と通知結果を混同しない。
8. 既存Secure Guard招待、Membership、最終`org_admin`保護、MSP認可、Zabbix顧客ログイン、Staff認証、既存パスワード再設定の回帰が維持される。
9. ログ、監査、レスポンスに秘密情報が含まれない。

## 10. 未確定事項と実装開始ゲート

以下は実装前にFit/Gapで確定し、本契約だけで推測実装しない。

- 既存InfraVisionパスワード再設定をSecure Guard個人Identityへ再利用する正確な境界。
- MFA用migrationの既存migration ledgerとの採番、外部キー、unique制約、保持・削除方針。
- TOTP秘密の暗号鍵の保管・取得・rotation、依存ライブラリ、暗号化形式。
- OTP／Challenge／バックアップコードの具体的な期限・回数・桁数・発行数と、既存レート制限との共有範囲。
- MFA再登録待ちを既存`portal_users.status`へ追加するか、MFA専用状態として保持するか。その際の招待受諾・無効化・パスワード再設定との状態遷移。
- メールOTP・本人通知に必要なMailerテンプレート、配信結果不明のUI・監査コード、メールアドレス変更時の本人確認。
- atLIB全体管理者の例外復旧の本人確認・承認記録。顧客管理者APIの拡張で解決しない。

本書は記録のみであり、MFA API、DB migration、暗号鍵、メール送信、Cloud Run、IAM、Secret、DNSFilter、Production trafficを変更する承認ではない。
