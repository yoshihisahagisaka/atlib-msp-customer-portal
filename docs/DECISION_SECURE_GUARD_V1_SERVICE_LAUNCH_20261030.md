# Secure Guard v1｜サービス開始に向けた統合Decision Log
決定日: 2026-10-30
状態: 方針承認済み／実装・HAは別途Fit/Gap
対象: MSP管理画面、顧客ポータル、認証・MFA、DNSFilter連携、端末管理、運用・ヘルプ

## 0. 最上位の判断基準
- 目的は**シンプルな運用で安全にサービスを開始すること**。機能を先回りして増やさず、開始後の顧客反応・問い合わせ・運用実績から改善する。
- IT経営KAIZENの「**技術 × 運用 × 管理**」を適用する。技術でできることを使い、運用で補い、管理で統制する。
- DNSFilterがOrganization/Site/Agent/Policy等の正本。Secure GuardはAPI参照・許可された操作とIdentity/Membership/監査を担当する。DNSFilterの登録台数や契約状態を独自に手動変更する二重管理はしない。
- 顧客単位の認可、監査、API結果不明時の安全停止・二重送信防止は最優先。既存Canonical、ADR、PR、PoC、C2の資産を再利用し、ゼロから再設計しない。
- Workには本Decisionと現行コードのFit/Gap・API/DB/UI/HA仕様をこちらで固めてから差分実装のみ依頼する。

## 1. DNSFilterとSecure Guardの役割
- atLIBのOwner／Super Adminを必要最小限の責任者数名に付与。Organization追加・プラン/ライセンス設定などDNSFilter公式の特権操作を担当。個人アカウント、MFA、監査を前提。
- 通常のatLIB運用社員、顧客管理者・運用者・閲覧者はDNSFilterへ招待せずSecure Guardへログインする。
- **新規Organization作成はDNSFilter公式GUI**。MSP画面の「新規顧客登録」は https://app.dnsfilter.com/login へ遷移。既存Organization作成APIは現時点で保持するが通常UIから撤去。
- プラン/ライセンス設定もDNSFilter公式GUIで行う。Subscription設定API・大量登録手段はDNSFilterへ問い合わせ済み、回答未確定。将来APIが正式提供されたときだけ自動化を再評価。
- Site/Policy/Block PageはatLIB標準設定で運用し、顧客が自由に変更するUIは設けない。Site作成時の標準適用・read-backの実装詳細は既存PoCと照合。
- Organization解約削除は追加と同じGUIに固定しない。**安全な一連の自動実行が可能ならSecure Guard側から行う**ことを目指す。正式API・依存順序・Portal整合とC2の安全ゲートが確定するまでは未実装/未承認として扱う。

## 2. MSP管理画面・UI/UX
- 縦に多数の独立パネルを積まず、横並びを活用。日常的な操作を優先し、低頻度・例外・監査/復旧を分離。1366×768程度を意識し、狭い画面では縦配置。
- DNSFilter Organization一覧とSecure Guard側連携済み一覧は**1つに統合**。選択顧客の概要・Site/Agent状況・初期管理者招待/招待状況を横並びの詳細領域に表示。Organization IDの繰返し手入力をなくす。
- **MSP管理画面の初回表示時・F5再読み込み時に自動同期**。DNSFilter全件取得→MSP所属検証→未連携だけ自動取込み→最新一覧を表示。既存連携は変更せず重複登録しない。DNSFilterから見えないだけでローカル連携を削除・停止しない。GETにDB書込を混ぜず、認可済みの同期POSTで処理。
- 個別取込み・一括取込みボタンは通常運用では不要。同期失敗時のみ「再同期」を提供。初期管理者招待は自動化しない。
- エラーは対象パネル/行の近くに表示し、読み込み中・0件・失敗・結果不明を区別。成功/失敗/未処理件数を区別して監査。
- MSP画面は顧客管理・初期招待・監査中心。端末の日常操作は顧客ポータルと共通化する方向。MSPによる顧客Scopeの切替は既存認可を迂回させない。
- 独自のOrganization停止/有効化、契約プラン変更、独自台数調整、顧客Policy編集は通常UIに置かない。内部状態・既存復旧依存は削除前にFit/Gap。

## 3. 利用者・権限
- 既存Identity、独立したMSP Grant、Customer Membershipを維持。役割は `msp_admin`、`org_admin`、`operator`、`viewer`。
- atLIB全体管理者はMSP管理、atLIB運用社員は割当顧客の日常操作。運用社員には顧客の招待・Role変更・失効権限を与えない。
- 顧客`org_admin`は自社運用者等を招待し、Role変更・失効を実施できる。`operator`は許可された自社運用操作、`viewer`は閲覧のみ。最終管理者失効防止を維持。
- 顧客の端末一覧・保護状態は権限範囲で閲覧。顧客向けの端末「アンインストール＆削除」は`org_admin`/`operator`に許可、`viewer`は禁止。MSP全体管理者は管理権限内。対象AgentのDNSFilter所属はサーバー側で検証する。
- ホワイトリストは顧客の申請・状況確認と、許可された担当者による適用を分離。実際の変更API・適用権限は未検証であり勝手に有効化しない。
- 請求表示は「○月○日時点の登録台数でご請求／○月度・○台・○円」程度の簡潔なもの。DNSFilter仕入課金とatLIB販売契約の数量は区別。集計タイミングは決めて実装し、複雑な管理UIは作らない。実際の仕入請求照合は課金開始後。

## 4. 端末削除E2Eの実測Fact（2026-10-30）
- Test Organization 02: DNSFilter Org `10220954`、Windows `atl20260003`、Agent `2a7659c5-68ec-4704-850f-e0f65347b2ee`。
- `DELETE /v1/user_agents/{id}?queue_uninstall=true` → HTTP 204。Windows Agentがアンインストールされ、Roaming Clientsから消失、Wi-Fi DNSが127.0.0.2→192.168.0.1、名前解決正常。本人確認後MSI再導入し、同一Agent IDでactive/protected復帰。
- `DELETE /v1/user_agents/{id}`（Soft Delete）→ Roaming Clientsから消失する一方、Windows AgentとService ManagerはRunning、Wi-Fi DNS 127.0.0.2のまま、インターネット接続不能。手動アンインストールで復旧。Soft Delete時のHTTPコードは会話中未提示。内部原因は断定しない。
- 正式OpenAPIの説明は `DELETE` = Soft delete、`queue_uninstall` = Uninstall user agent、`clear_registry` = Clear registry when uninstalling user agent。
- **通常の端末撤去はリモート「アンインストール＆削除」を標準**とし、Soft Deleteは通常顧客UIから除外。既に端末側でアンインストール済みの残存登録等の例外用途は別途安全確認。
- HTTP 204は要求受付であり端末側完了の保証ではない。Pending/オフライン/UNKNOWN時の再送禁止と観測を区別。
- 解約時は契約期間内に撤去期間（例: 7日、日数未確定）を設け、未撤去端末には手動アンインストール手順を案内する運用を採用候補とする。完全撤去と課金停止は別の完了条件。
- Pending中のSoft Deleteと命令残存、Site/Organization削除の実E2Eは未完了。Organization削除は既存PR #44 C2の最終承認・Portal mapping整合等の安全条件を維持。

## 5. MFA・ログイン・復旧（設計承認、実装未完了）
- 全Secure Guard利用者にパスワード＋MFA。TOTPを推奨、メールOTPを代替として初回登録時に選択。登録済みTOTPからメールOTPへの無条件切替はしない。
- TOTP・メールOTPの**両方に使い捨てバックアップコード**を発行。パスワード確認後にコードを消費し、MFA再登録へ進む。
- パスワード忘れは既存InfraVision顧客ポータルの再設定実装とFit/Gapし、再利用可能なものを利用。
- MFA未完了では通常JWT/Cookieを発行しない。現行`SecureGuardIdentityService.login()`と`acceptInvitation()`が直ちにJWT発行するため変更必須。短期チャレンジ、試行・再送制限、ワンタイム消費、TOTP秘密鍵の暗号化、コードのハッシュ、監査・セッション失効を設計する。
- 顧客`org_admin`は**自社のみの有効Membershipを持つ別Identity**のMFAをリセット可能。自分自身、他社にも所属するIdentity、MSP権限保有者は不可。複数所属者/全管理者がログイン不能の場合はatLIB全体管理者による例外復旧。
- リセットでは本人確認・操作側のMFA再認証、対象Identityの`session_version`更新、既存セッション失効、再登録待ち化、監査、本人通知を必須とする。管理者が秘密鍵やOTPを見ることはない。
- 管理者は**2〜3名の登録を推奨、強制しない**。顧客`org_admin`の利用者管理画面上部に次の文言を常時表示し、ポップアップや管理者数監視は追加しない。
> 管理者の退職・異動や認証アプリの紛失に備え、管理者を2〜3名登録することを推奨します。管理者同士でMFAの再設定を支援できるため、ログインできなくなった場合にも社内で対応できます。
- MFAのDB/API詳細は設計案段階。専用MFA設定・チャレンジ・回復コードの最小テーブルを検討し、既存監査テーブルと二重管理しない。既存のMembership・Identityと認可境界を再利用。

## 6. 顧客ポータルとヘルプ
- 顧客画面は端末一覧・保護状態を中心に、利用台数/請求の簡潔な表示、アンインストール＆削除、ホワイトリスト申請、インストーラーDL、利用者管理、ヘルプへの導線を配置。
- MSI/PKGは共通静的配布を基本候補とし、Site Key埋込の動的生成はPoC/将来検討。Site Keyローテーション（月1回等）は実装済みと扱わず後工程。
- 顧客向けヘルプは実際に提供する機能に限定し、初期導入、PC入替・退職時の撤去、ブロック/許可申請、ログイン/MFA復旧、利用者招待、解約を短く説明。atLIB内部運用手順は別文書。
- ヘルプ文面・UI・APIは同じ仕様を参照し、未実装操作を実装済みとして案内しない。

## 7. v1開始前の必須Fit/Gapと後工程
**開始前の実装/HA対象**: MSP画面自動同期・一覧統合・初期招待、顧客Scope/Role別表示、MFA・復旧、端末の安全なアンインストール＆削除、ホワイトリストの許可された操作、監査、最低限のヘルプ、標準Site設定の整合。既存実装・PoCのPASSを再試験のためにやり直さず、差分を検証する。
**後工程または運用で対応**: 高度な請求管理、請求の実績照合、Site Key定期自動ローテーション、動的インストーラー、詳細分析、複雑な通知・例外処理の自動化。Organization削除一括自動化は既存C2と別承認で進め、必要なら当面は手順運用とする。
**未確定**: DNSFilterのSubscription API・課金締め/creditの正式回答、顧客別Allow List変更APIの実測、Organization DELETEの正式仕様・Portal mapping/権限失効、Pending端末の扱い、実装差分のHA。未確定を推測で埋めない。

## 8. 実装・記録の境界
- 本文は**決定事項の記録**。新規機能の実装、デプロイ、GCP/DB/DNSFilter操作、Production traffic変更を承認するものではない。
- Git/Canonical/PR #3と解約PR #44の現行状態を照合し、Fit/Gapから再開。設計案と実測PASSを混同しない。
