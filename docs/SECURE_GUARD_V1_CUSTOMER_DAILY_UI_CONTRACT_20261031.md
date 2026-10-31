# Secure Guard v1｜顧客日常画面・運用UI実装契約
日付: 2026-10-31
状態: 設計記録／コード変更・HA未実施
基準: PR #3 HEAD 71cc16ba860c735a55b3d64d23afbbb5585c4912
正本: DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md
依存: SECURE_GUARD_V1_MFA_IMPLEMENTATION_CONTRACT_20261031.md
共通メールOTP: 情報セキュリティ診断レーンの実装完了後にContract照合。Secure Guard内で独自メールOTP基盤を先行実装しない。

## 1. 現行コードFact
- `src/domain/secureGuardInventory.ts`: Agent `{id,hostname,siteId,status,agentState}`、Site `{id,name,agentCount,policy:null}`。未確認Policyを推測しない。
- `src/services/dnsFilterInventoryClient.ts`: Organization別SiteとSite別Agent、Organization全Agentを独立取得し、所属・件数・ID・ページングを照合するGET-only実装。変更APIはない。
- `src/routes/secureGuard.ts`: `GET /overview`、`GET /sites`、`GET /agents`、`GET /memberships`、招待・失効・Role変更APIあり。Agent DELETE APIはない。
- `public/secure-guard-home.html`と`public/js/secureGuard.js`: Organization選択、Site/Agentリスト、端末名・Site・状態検索あり。端末撤去・利用者管理・ヘルプUIは未実装。

## 2. 顧客画面
- ヘッダー: Organization名、最終取得日時、ログアウト、必要な場合のScope選択。
- 上段: 登録端末数、保護中件数、その他の状態件数。数字は既存Inventoryの取得結果から算出。未知状態を推測で危険判定しない。
- 中央: 端末一覧（端末名、Site、DNSFilterの状態、詳細/許可された操作）。既存の検索機能を維持。選択端末の詳細と削除操作を同じ画面内で扱う。
- 下段または適切なナビゲーション: 利用者管理、導入/撤去ヘルプ、サイト許可申請、契約・請求の最小表示。実装未確定の料金をダミーの実請求として表示しない。
- 1366×768で主要情報を見やすく、横方向を利用。狭い画面は縦配置。エラーは操作の近くに表示。

## 3. 端末撤去
- 標準操作は`DELETE /v1/user_agents/{id}?queue_uninstall=true`。オンラインWindows端末でHTTP 204、Windows Agent削除、DNSFilter登録消失、DNS復元・通信正常を実測済み。
- パラメータなしSoft Deleteは実機でAgent残存・通信障害を確認。通常の顧客UIに出さない。
- 操作者は自社`org_admin`または`operator`、`viewer`は不可。既存Customer Scopeでテナントを確定し、Agent UUIDとOrganization/Site/Hostnameをサーバー側で直前照合。
- 確認UIに対象端末名、実行影響、オンライン/オフライン時の完了差を表示。HTTP 204は要求受付として表示し、Windows上のアンインストール完了と混同しない。
- 操作ID・対象・結果の監査、UNKNOWN時の自動再送禁止と二重操作防止は既存C2/PR #44の安全条件を再利用。未実装の永続claimを完成済みとみなさない。
- 未完了端末は契約期間内の撤去期間（例7日、日数未確定）と手動アンインストール手順で対応。複雑なスケジューラーはv1に追加しない。

## 4. 利用者管理
- `org_admin`は自社利用者の招待・Role変更・失効、許可対象のMFA再設定を行う。operator/viewerは変更不可。
- 利用者一覧上部に承認済み文言を表示:
「管理者の退職・異動や認証アプリの紛失に備え、管理者を2〜3名登録することを推奨します。管理者同士でMFAの再設定を支援できるため、ログインできなくなった場合にも社内で対応できます。」
- 2〜3名は推奨で強制しない。MFAリセットは自分自身、複数Org所属、MSP権限保有者に不可。再認証・セッション失効・監査・再登録待ちの条件はMFA契約を参照。
- 利用者管理のAPIは既存Membershipを再利用し、新しいIdentity基盤を作らない。

## 5. サイト許可申請・契約・ヘルプ
- サイト許可は顧客から申請し、atLIB側で内容確認・承認後に顧客限定の例外適用。危険判定を自動解除しない。DNSFilterへの許可変更APIは未実測なので勝手に実装しない。必要なら当初は既存問い合わせ運用を使用。
- 請求は仕入数量と顧客契約数量を混同しない。課金開始後の実績照合を予定。v1で未確定の金額や請求確定値を表示しない。
- 顧客ヘルプは「導入」「端末入替・退職時撤去」「サイトブロック/許可申請」「ログイン/MFA復旧」「利用者管理」「解約」の短い案内。atLIB内部手順とは分離。実装されていない操作は案内しない。
- メールOTPの共通基盤は情報セキュリティ診断レーンの実装・共有後にFit/Gapする。Secure GuardのTOTP・回復コード・リセットは固有仕様を維持。

## 6. テスト・HA
- Customer Scope別の一覧/詳細が越境しない。org_admin/operator/viewerの操作権限をAPIでも検証。
- Agent IDのすり替え、別Organization/Site、一覧取得失敗、UNKNOWN、重複要求を安全停止。Soft Deleteを通常UIから実行不可。
- Inventory取得失敗を0件と表示しない。取得日時と実状態を区別。
- 招待・Role・失効・MFAリセットの認可と監査を回帰。
- 導入・撤去・ログインのヘルプ内容が実際のUI/APIと一致。
- MSP管理画面・既存InfraVision認証/レポート等を破壊しない。

## 7. 実装境界
本書は設計記録のみ。コード、DB、Cloud Run、DNSFilter、本番操作なし。ホワイトリスト変更、Organization DELETE、請求確定は未検証・別工程。サービス開始に不要な自動化を追加しない。
