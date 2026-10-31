# Secure Guard v1｜実装前Fit/Gap・変更契約
基準: PR #3 HEAD 66192c8d94be5351b6beee96343d3ac28b64c291
上位Decision: DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md
状態: コード確認済みの設計差分。未実装・未HA。Workへの実装指示ではない。

## 確認した実装
- `public/secure-guard-admin.html`: Organization手入力取込み、復旧、atLIB Organization一覧、DNSFilter一覧、Site/Policyフォーム、初期管理者招待、監査が縦に独立配置。「新規顧客登録」リンクは実装済みだが説明文は手入力取込みを案内。
- `public/js/secureGuard.js`: `renderAdmin()` は `/admin/organizations` と `/admin/audit` を取得。DNSFilter一覧は更新ボタン押下時のみ取得。独自停止/有効化PATCH、取込み手入力、初期管理者ID手入力、Site Policy複数選択が残存。
- `public/secure-guard-home.html`: 顧客Scope選択、Site/Agent Inventory、端末名検索あり。アンインストール、利用者管理、ヘルプ導線は未実装。
- `src/routes/secureGuard.ts`: MSP一覧 `GET /admin/organizations`、DNSFilter一覧 `GET /admin/dnsfilter/organizations`、取込み `POST /admin/dnsfilter/organizations/import`、初期管理者招待、Membership、監査、Site/Policy取得・作成を実装。顧客InventoryとMembership APIあり。同期API・AgentアンインストールAPIは未実装。
- `src/services/dnsFilterManagementClient.ts`: MSP配下Organizationを全ページ取得し、親Organizationを除外。単一Org GETでMSP所属を検証。GETのページング/shapeガードあり。Agent変更は未実装。
- `src/services/secureGuardRepo.ts`: `listManagedOrganizations()` と `createManagedOrganization()`、監査、Membership、`session_version`あり。新規取込みはDBトランザクションだが、画面表示時の同時同期・既存競合を安全にskipする専用処理は未実装。
- `src/services/secureGuardIdentityService.ts`: `login()` と `acceptInvitation()` が即時JWT発行。`verifyActiveSession()` はuser状態・sessionVersionを検証。MFA未実装。
- `src/routes/secureGuardAuth.ts`: パスワードログイン/招待受諾でCookie設定。既存IP/ログインレート制限あり。MFA前セッションの区別なし。
- `src/middleware/secureGuardAuth.ts`: `requireSecureGuardIdentity`、`requireSecureGuardCustomerScope`、`requireMspAdmin`、httpOnly Cookieを実装。MFA強制ゲート未実装。

## 差分A：MSP管理画面（先行実装候補）
1. 一覧を1つに統合。選択Organizationの概要と初期管理者招待を横並びにし、監査/復旧は低頻度領域へ。顧客名・DNSFilter IDを再入力させない。
2. 管理画面初回ロード/F5時、認証済み`msp_admin`が同期POSTを一度発火。サーバーでDNSFilter一覧を全ページ取得、既存mappingと照合し未連携だけ登録。GETはread-onlyのまま。失敗は当該領域に表示。成功/skip/失敗件数を返す。
3. 既存`createManagedOrganization`とDB一意制約を再利用し、並行F5・二重同期・途中失敗時の競合を正常skip/要対応に分類。DNSFilter GET失敗では書込開始禁止。消えたOrgの自動無効化・削除は禁止。招待は自動化しない。
4. 手入力取込み/個別・一括取込みボタンは通常UIから撤去。同期エラー時の再同期だけ表示。新規顧客登録リンクは維持。
5. 独自停止/有効化、顧客任意Policy選択、通常画面での作成結果不明復旧を整理。既存API/DB状態を無条件削除しない。
6. `POST /admin/dnsfilter/organizations/sync` は設計候補。正確なAPI応答とDBのunique/監査境界は既存migrationを読んでから確定。

## 差分B：顧客端末・利用者画面
1. 既存Inventory取得とMembership認可を再利用。日常の端末一覧/保護状態を中心にし、Agent操作は`org_admin`/`operator`に限定、`viewer`は閲覧のみ。
2. アンインストール＆削除は実測PASSの`DELETE /v1/user_agents/{id}?queue_uninstall=true`をサーバー経由で実行。Agent ID/Org/Site所属の直前照合、監査、UNKNOWN自動再送禁止。HTTP 204は受付であり実機完了と区別。Soft Deleteを通常UIに置かない。
3. `org_admin`の利用者管理UIは既存Membership APIを使用。利用者招待・Role変更・失効、MFA再設定を提供。atLIB運用社員には招待/Role変更権限なし。
4. 利用者管理上部の固定案内文は上位Decisionに記録した全文をそのまま使用。管理者数の強制・通知・監視は作らない。
5. インストーラー/ヘルプ、ホワイトリスト、請求表示は上位Decisionの最小構成。ホワイトリスト変更APIは未検証のため推測で実装しない。

## 差分C：MFA（商用開始前の必須安全変更）
1. `login()`だけでなく`acceptInvitation()`のJWT直接発行を廃止し、パスワード認証成功後はMFA専用短期チャレンジへ遷移。MFA成功後のみ既存通常JWT/Cookieを発行。
2. TOTP推奨/メールOTP選択、両方式のバックアップコード、失敗/期限/再送制限、TOTP秘密の暗号化、OTP/回復コードの検証用ハッシュ、使い捨て消費を追加。
3. 顧客管理者のMFAリセットは本人不可・自社のみ所属する他Identityに限定。MSP権限保有者と複数Org所属者は禁止。DB最新状態をトランザクション内で照合し、sessionVersion更新・再登録待ち・監査を一体化。メール送信とDB成功は区別。
4. 既存Identity/Membership/監査を維持。MFA設定/チャレンジ/回復コードのDB migration、Mailer、既存InfraVisionパスワード再設定とのFit/Gapは追加確認対象。
5. 全ログイン経路・招待受諾経路・旧Cookie・既存セッション・MFAリセット後の旧JWTを含め、MFAバイパス不可の自動試験を必須とする。

## 実装前にコードで確認する限定項目
- 既存DB migrationのOrganization mapping unique制約・監査transactionの詳細、並行同期時のskip/rollback契約。
- 認証ルートのmount path、ログイン画面と招待受諾画面、Mailer、既存パスワード再設定との再利用境界。
- 端末InventoryのAgent ID/Org/SiteのshapeとC2の永続claim/監査の実装状況。C2未完成を理由に安全条件を省略しない。
- ホワイトリストAPI、Organization解約の正式操作は別途実測/既存PR #44の承認ゲートで確定。未確認仕様を推測で補完しない。

## 作業境界
本書はFit/Gap記録のみ。コード変更・本番デプロイ・DB migration・DNSFilter変更なし。上位Decisionにない機能をWorkへ追加提案させない。
