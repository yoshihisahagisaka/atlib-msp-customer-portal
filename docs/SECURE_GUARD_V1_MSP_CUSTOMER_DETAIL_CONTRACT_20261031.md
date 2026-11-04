# Secure Guard v1｜MSP顧客詳細・初期管理者招待 UI/API契約
日付: 2026-10-31
状態: 既存Decisionに基づく設計・実装未着手
基準: PR #3 HEAD 4138181835625c959c88a57979f63d10fe471a82
上位: DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md / SECURE_GUARD_V1_MSP_ORG_SYNC_IMPLEMENTATION_CONTRACT_20261030.md

## 目的
MSP顧客一覧で選んだOrganizationに対して、初期管理者招待・状態確認を最小操作で行う。Organization IDの手入力、独立した縦長パネル、同じ情報の重複表示を廃止する。招待・認可・監査は既存コードを再利用する。

## 既存コードのFact
- `src/routes/secureGuard.ts`: `GET /admin/organizations/:organizationId/memberships`、`POST /admin/initial-memberships/invitations`、`POST /admin/initial-memberships/invitations/cancel`、`POST /admin/initial-memberships/invitations/reissue` は `requireIdentity` + `requireMspAdmin` で保護。
- 初期招待入力は `{customerOrganizationId, email}`。招待は `initialOnly:true`、role `org_admin` 固定。成功202。配送結果不明は503 `INVITATION_DELIVERY_UNCONFIRMED`。既存トークンはpendingのままで自動再送しない。
- 取消は `{customerOrganizationId}` で成功204、対象なし404。再発行は初期招待と同じ入力で成功202。送信失敗時の既存pendingの扱いはコード記録を優先。
- `SecureGuardRepo.listManagedMemberships` は `{id,email,role,status,isInitialAdmin}` を返す。状態は pending/active/revoked。初期招待の競合・取消・再発行・監査は既存Repoに実装済み。
- 初期管理者招待のトークン・期限・再発行は既存`SecureGuardIdentityService`とRepoを再利用し、新しい招待テーブルや別のトークン体系を作らない。

## UI契約
1. MSP一覧で行を選択→同画面の右側または下段に「顧客概要」「管理者・利用者」を表示。選択対象は同期済みローカルCustomer Organization IDを使う。DNSFilter IDは表示用・照合用であり招待APIへ渡さない。
2. 顧客詳細の管理者欄はMembership一覧を読み、`isInitialAdmin`、role、statusを表示。未登録ならメール入力と「初期管理者を招待」。pendingなら招待先と「取消」「再発行」。activeならメールと管理者Roleを表示。revokedは過去状態として区別。
3. 「初期管理者招待」は1社1名の初回登録に限定。追加管理者は顧客側の利用者管理画面から招待する。初期管理者のpending/active判定を画面だけに頼らずサーバー側の既存制約で検証する。
4. 取消・再発行は選択顧客のIDを固定して実行し、別顧客へ切替中の古い非同期レスポンスを現在の顧客に表示しない。実行中は対象行の重複送信を抑止する。
5. エラーは該当管理者欄に表示。503配送不明は「招待は登録されていますがメール配信を確認できません。状態を確認して再発行してください」等の案内を表示し、成功と扱わない。自動再発行は禁止。
6. 招待操作後に当該顧客のMembershipを再取得し、実DB状態を表示。招待メールの配達/開封/本人受諾は別概念。202を受諾完了として表示しない。
7. MSP全体管理者の通常画面はOrganization一覧/選択詳細/初期招待中心。監査・例外復旧は別領域へ。ユーザーにOrganization IDを再入力させない。

## API変更
- 初期管理者の招待/取消/再発行/一覧APIは既存をそのまま利用する。新規APIを作らない。
- Organization同期POSTのレスポンスで選択対象を取得し、選択顧客のMembership GETを呼ぶ。同期の実装は別契約文書。
- Role変更や一般利用者招待の既存APIは保持するが、MSP初期登録の通常導線と混ぜない。

## 認可・監査・エラー
- 全て既存の `requireMspAdmin` を維持。atLIB運用社員と顧客管理者がMSP初期招待APIを呼べないことを回帰試験。
- 管理対象Customer Organizationの存在・状態をサーバーで検証。クライアントの表示ラベルを認可根拠にしない。
- 既存監査を再利用。秘密の招待トークン、認証情報、メール本文を監査に記録しない。
- 初期招待のメール送信結果不明時はDB上のpendingを再取得し、人の判断による取消/再発行。二重送信の自動リトライは禁止。

## HA/テスト
- 未登録→招待→pending→本人受諾→activeが正しく表示される。
- pendingの取消/再発行、配送不明503、期限切れ、競合、他Organization切替中の遅延応答を試験。
- 選択顧客以外へ招待しない、Organization ID手入力なし、非MSPは403。
- 監査、既存Membership、初期管理者1名制約、最終管理者保護の回帰。
- 1366×768で一覧と詳細を見やすく配置し、狭い画面では縦並び。エラーを画面最上部に集約しない。

## 境界
この文書は設計記録のみ。DB/GCP/DNSFilter変更、実メール送信、デプロイなし。MFA初回登録は別契約に従い、招待受諾時のJWT直発行をMFA実装時に廃止する。
