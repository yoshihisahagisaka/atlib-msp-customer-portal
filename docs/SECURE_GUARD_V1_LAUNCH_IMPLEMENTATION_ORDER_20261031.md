# Secure Guard v1｜サービス開始に向けた実装順序とGo/No-Go
2026-10-31 / PR #3 HEAD 63aa336477f6fd3b935fd54237341396a04a7694
状態: 実装順序の整理。実装・HA・デプロイ承認ではない。
正本: DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md、およびMSP Sync/Customer Detail/MFA/Customer Daily UI各契約。

## 原則
- 技術×運用×管理でシンプルにサービス開始。未確認の機能を増やさない。顧客の実際の反応から改善。
- 既存コード・PR #3・解約C2/PR #44を再利用し、確認済みPoCをやり直さない。
- 共通メールOTPは情報セキュリティ診断側の完成Contractを待つ。Secure Guard独自のメールOTP基盤を実装しない。
- 仕様書に記載があることと実装/HAがPASSしたことを分離する。

## 実装順序
### 1. MSP管理画面
- F5/初回表示でMSP配下Organizationを同期POST、一覧を統合、顧客選択→初期管理者招待。既存GET/取込み/監査を再利用。
- DNSFilterでOrganizationを作成・プラン設定。PortalにOrganization作成/課金変更UIを作らない。
- 合格: 1回目取込み、再F5冪等、競合同期、MSP親除外、失敗/途中失敗の局所表示、招待のpending/active/配送不明、非MSP拒否。

### 2. 顧客日常画面
- 既存GET-only Inventoryを中心に登録端末・保護状態・検索・取得時刻、利用者管理、ヘルプ導線を配置。
- 既存Membershipの招待/Role変更/失効を再利用。顧客org_admin向け管理者2〜3名推奨の固定文言を表示。
- 合格: Customer Scope/RoleのAPI認可、別テナントの閲覧拒否、一覧取得失敗と0件を区別、既存Zabbix/Staffセッション回帰。

### 3. 端末アンインストール＆削除
- 実機PASSの `DELETE /v1/user_agents/{id}?queue_uninstall=true` のみを通常UIに採用。Soft Deleteは通常UIに出さない。
- サーバーで直前所属照合、権限、監査、要求受付と端末完了を区別。UNKNOWN時の自動再送禁止と永続的二重実行防止を確認。既存C2の安全資産と整合。
- 合格: org_admin/operatorのみ許可、viewer拒否、別Org/別Site拒否、204は受付表示、UNKNOWN停止、監査、通信影響の案内。

### 4. MFA
- 既存Identity/JWT/Membership/Mailerを再利用。TOTP、共通メールOTP連携、両方式バックアップコード、管理者リセット。
- loginとacceptInvitationの両経路でMFA完了前の通常JWT発行を禁止。既存セッション移行・旧Cookie失効を検証。
- 共通メールOTP完成待ちの間はDB/認証境界/TOTP/復旧の設計と独立テストを進める。ただしMFA未完成の状態で商用公開しない。
- 合格: OTP/回復コードの一回消費・期限・試行上限、自己/越境/MSP保有者リセット拒否、旧セッション失効、既存認証回帰。

### 5. 運用・ヘルプ
- 顧客向け: 初期導入、端末入替/撤去、ブロック/許可申請、ログイン/MFA復旧、利用者招待、解約。短い操作手順のみ。
- atLIB向け: DNSFilter Organization作成/プラン設定、Portal同期確認、初期招待、許可申請の判断/例外適用、未撤去端末への案内、MFA例外復旧、解約手順。
- 既存問い合わせフォームで許可申請を扱えるなら新規APIを作らない。実際のフォーム導線・受付/監査を確認する。DNSFilter Allow List APIは未実測。
- 課金開始後の仕入請求照合は別工程。未確定料金を顧客に確定請求として表示しない。

## サービス開始Go/No-Go
- 必須: MFA迂回不可、Customer/MSP認可・越境防止、招待/失効、端末操作の安全条件、最低限の監査とヘルプ、DNSFilter標準保護・Site設定の整合、実際の運用担当と手順が明確。
- 未完了ならNo-Go: パスワードだけで通常JWT発行、他社Agent操作可能、Soft Deleteの顧客通常操作公開、UNKNOWN自動再送、未確認の課金額/解除操作を確定扱い。
- 運用代替が可能: Organization削除の完全自動化、詳細請求ダッシュボード、Site Key定期自動更新、複雑な通知/分析。解約は既存C2の最終承認条件を勝手に緩めない。
- リリースは別承認。現段階ではDB migration/GCP/DNSFilter/SMTP/本番操作を行わない。

## Workへ渡す前の限定確認
- 既存PR #3の現HEAD/テスト/DB migrationと、PR #44の現状を再照合し、コード変更の差分と安全ゲートを特定。
- 顧客向け許可申請の現行問い合わせフォームの実導線、共通OTPの共有Contractの完成状況を確認。未確認は未確認と記録。
- Workには上記の順に限定実装・テストを依頼し、独自の機能追加や再設計は認めない。
