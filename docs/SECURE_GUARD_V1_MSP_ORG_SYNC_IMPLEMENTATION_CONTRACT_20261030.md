# Secure Guard v1｜MSP Organization自動同期・UI実装契約
状態: 既存Decisionに基づく実装仕様。コード変更・HA未実施。
基準: PR #3 HEAD ac47bb86c5db4ab8c2f6552f3788de2f87de8a06
上位: DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md

## 目的・範囲
DNSFilter公式画面でOrganization/プランを登録後、Secure Guard MSP画面を開く/F5するだけで、MSP配下の未連携Organizationを自動取込みする。個別・一括取込みの通常ボタンを不要にする。認証、テナント分離、監査、失敗時の安全停止は維持。

## 現行実装の確認
- `src/services/dnsFilterManagementClient.ts`: `listOrganizations()` はページング、MSP親除外、managed_by_msp_id一致、ID一意、shape検証済み。DNSFilterへの書込みは不要。
- `src/services/secureGuardRepo.ts`: `listManagedOrganizations()`、`createManagedOrganization(actorUserId, organizationName, dnsfilterOrganizationId)`、監査を再利用可能。ただし並行同期・既存mappingの競合を安全に分類する専用契約は未実装。
- `src/routes/secureGuard.ts`: `requireIdentity`、`requireMspAdmin`、既存一覧/取込みAPIが存在。新しい認可基盤は作らない。
- `public/secure-guard-admin.html`、`public/js/secureGuard.js`: 取込み手入力、DNSFilter別一覧、独自停止ボタン、初期招待でID手入力、Site/Policy自由選択が残る。UI変更対象。

## 新規API契約
`POST /api/secure-guard/admin/dnsfilter/organizations/sync`
- 認証: `requireIdentity` + `requireMspAdmin(repo)`。bodyで任意のOrganization ID一覧を受け取らない。
- 1) DNSFilter `listOrganizations()` を**全ページ成功**させる。失敗/shape不一致ならローカルDBへの書込み開始前に502/503等のエラーを返す。空一覧は取得成功0件と取得失敗を区別。
- 2) 既存mappingを取得し、DNSFilter IDで照合する。既存mappingがactiveなら既存顧客を保持しスキップ。disabled/suspended/重複/未対応のローカルdraftなどは**勝手に再活性化・再紐付けしない**。要確認として報告。
- 3) 未連携IDのみ `createManagedOrganization` 相当の既存transactionを使用。既存のMSP所属検証を省略しない。DB unique制約で並行登録競合を抑止し、競合時は再読取して同じDNSFilter IDに正しく紐付いていればskipped、異常ならfailedとする。単純な409一括成功扱いは禁止。
- 4) 監査: 新規取込みごとにactor/Org/action/result。途中失敗は件数と対象ID/安全な理由コードを記録。APIキー、レスポンス生本文は記録しない。
- 5) 返却例（設計上のshape）: `{organizations:[{id,organizationName,dnsfilterOrganizationId,linkState}],sync:{imported,skipped,failed,needsReview},fetchedAt}`。対象IDの失敗情報は安全なコードのみ。最終フィールド名はテストContractで固定。
- 6) 途中失敗でも成功済み取込みを巻き戻さない。自動リトライやタイマー連続ポーリングは実装しない。次回F5/「再同期」で冪等に再開する。
- 7) DNSFilterに見えなくなったローカルmappingは自動削除・無効化せず、確認が必要と表示。認可用のローカルMembershipをDNSFilter一覧から推測で失効させない。

## UI契約
- MSP画面初回ロード/F5時に同期POSTを1回。二重イベントによる同時呼出を避ける。画面遷移を増やさない。
- ヘッダーに「新規顧客登録」外部リンク（https://app.dnsfilter.com/login）。戻ってF5すれば反映。
- DNSFilter Organization一覧とローカル連携一覧を1つの顧客一覧に統合。行選択→顧客詳細・Site/Agent概要・初期管理者招待。Organization名/IDの手入力は不要。
- 同期中/成功/失敗/要確認を一覧付近に表示。取得失敗を「0件」と表示しない。失敗時のみ「再同期」導線を表示。
- 手入力取込みフォーム、DNSFilter別一覧、独自停止/有効化ボタン、顧客のPolicy自由選択は通常UIから撤去。既存API/DBの削除は依存関係を確認する別判断。
- 監査と作成結果不明時の復旧は低頻度の管理領域に分離し、通常の操作を妨げない。
- 取得中に招待・取込みの対象IDが曖昧になる状態を作らない。招待は同期後に選択したローカルCustomer Organization IDを使用。

## 変更ファイル候補
- `src/routes/secureGuard.ts`: syncルート追加。
- `src/services/secureGuardRepo.ts`: 競合/既存mapping分類を含む冪等同期用メソッド追加。既存監査を再利用。
- `src/services/dnsFilterManagementClient.ts`: 既存listOrganizationsを再利用。必要性の証拠がない限り変更しない。
- `public/secure-guard-admin.html`、`public/js/secureGuard.js`: 画面再配置、初回同期、一覧統合、行選択・招待、エラー局所表示。
- 自動試験: 既存テストを調べて最小限の追加。新しい同期フレームワークは作らない。

## 必須テスト
- 初回同期で未連携のみ登録、再同期/F5で0件追加。
- 2つの同期要求が競合してもDNSFilter IDへのmappingが重複しない。
- MSP親Organizationを顧客として取り込まない。他MSP/不正shapeは拒否。
- DNSFilter GET途中失敗時はDB変更0。途中のローカル登録失敗時は成功済みと失敗を区別。
- disabled/suspended/矛盾したmappingを勝手に有効化・上書きしない。
- 非MSPは403。監査・招待・既存Membership認可は回帰PASS。
- UI初回/F5の同期、選択顧客招待、エラー表示、再同期、二重送信防止をHA。

## 実装前の確認ゲート
1. 既存DB migrationの`dnsfilter_organization_mappings`のunique制約と`customer_organizations`の状態遷移をコードで確認。必要なDB差分があれば最小化。
2. 既存初期管理者招待APIのレスポンス/状態取得と監査の実際のContractを確認。
3. 現行テストファイル・PR履歴・Canonicalを確認し、成功済みのPoC/HAを繰り返さない。

## 非対象
DNSFilter Organization作成/削除、Subscription変更、Agent削除、MFA実装、課金計算、Scheduler/Webhook同期。別の確定仕様・工程で扱う。
