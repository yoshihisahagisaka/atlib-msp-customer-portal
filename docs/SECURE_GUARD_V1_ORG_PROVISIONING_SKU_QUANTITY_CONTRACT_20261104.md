# Secure Guard v1｜Organization作成・SKU／割当数量のコード実装契約

日付: 2026-11-04
状態: コードレベル設計・未実装・未HA
基準: PR #3 HEAD `23a9b1da03af3733feb43a1758ddf4364b6bcbd3`
優先Decision: `DECISION_SECURE_GUARD_DNSFILTER_API_BILLING_UPDATE_20261104.md`
関連: `DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md`, `SECURE_GUARD_V1_MSP_ORG_SYNC_IMPLEMENTATION_CONTRACT_20261030.md`

## 1. 確定済みFactと未確定を区別
- DNSFilterの回答: Organization作成／更新APIの `sku` はCore/Plus識別子、`quantity` は割当ライセンス数。`POST /v1/organizations`, `PATCH /v1/organizations/{id}` に対応。契約期間はMSPアカウント単位。
- ユーザーが実際に取得したOpenAPI: `OrganizationCreateSpec` は `{organization: OrganizationCreate}`。 `OrganizationCreate` 内の `name:string`, `managed_by_msp_id:integer` が必須、`sku:string`, `quantity:integer` は任意定義。skuのenum・具体値は非公開。
- 同一MSPのTest Organization 02/Coreと03/PlusのGETではSKU、Quantity、Planが得られない。Distributor向け `GET /v1/distributors/skus_available` はHTTP404。プラン識別値・Billingのread-backフィールドは**未確定**。DNSFilterがアカウント用SKU値を別途通知予定。
- 有料プラン保存で即時課金開始、変更は日割り精算。端末の実登録数と割当数量は別。
- この契約は**個別Organization登録**と**契約上限を超えないライセンス整合方針**を固定する。画面表示/F5の既存Org同期は別契約のまま維持。大量登録・独自請求エンジンは別工程。

## 2. 既存コードの利用箇所
- `src/services/dnsFilterManagementClient.ts`: `createOrganization(name)` は `POST /v1/organizations` に `{organization:{name,managed_by_msp_id:Number(mspId)}}` を送信し、レスポンスのOrg IDとMSP所属を検証。8秒タイムアウト・raw本文非表示。これを拡張する。新規クライアントを作らない。
- `src/routes/secureGuard.ts`: `POST /admin/dnsfilter/organizations` は `requireIdentity` + `requireMspAdmin`。 `createProvisioningDraft` → DNSFilter POST → `finalizeProvisioning` を実装。結果不明時に停止状態のdraftと監査を残す。自動再POST禁止を維持。
- `src/services/secureGuardRepo.ts`: `createProvisioningDraft`, `finalizeProvisioning`, `listManagedOrganizations` と監査を再利用。既存テーブルにSKUや請求数を二重の正本として記録しない。
- `public/secure-guard-admin.html`: 現在「新規顧客登録」はDNSFilter公式へのリンク。変更後は当該MSP画面のフォームへ。例外時の公式リンクは管理者ヘルプに維持する。
- `public/js/secureGuard.js`: 旧作成フォーム処理は削除済み。新フォームを再配線するが旧の手入力取込みパネルへ戻さない。

## 3. 要求・検証契約
ブラウザ入力（代表名称）:
- `organizationName`: 空白trim後1〜255文字。正式な顧客Organization名として使う。
- `plan`: `core | plus` の二択。SKU生値をブラウザから受け取らない。
- 顧客登録画面の`contractSeatLimit`（契約上限台数）: 正の整数、最低1。これはatLIBの顧客契約の上限であって、DNSFilterの現在の割当数量`quantity`とは**別の概念**。上限超過の申請/設定を拒否する。正式APIの数量制約も別途確認する。
- `managed_by_msp_id` をブラウザから受けない。Server固定の設定値11473を使用し、数値形式・MSP所属を照合。

Server: `POST /api/secure-guard/admin/dnsfilter/organizations` の既存routeを拡張。
- Body案: `{organizationName:string, plan:'core'|'plus', contractSeatLimit:number}`。サーバーは顧客契約上限を保管し、DNSFilter POSTの`quantity`は初期割当（最低1、導入時点の確認済み利用数を基準）として別途導出する。契約上限をそのまま初期割当にして未利用分まで早期課金しない。
- Roleは既存 `msp_admin` のみ。顧客Roleでは拒否。
- `SKU_CORE` / `SKU_PLUS` のような**サービス側設定**で実値に変換し、取得できない/空/同値/不正ならDNSFilterへPOSTせずエラー。変数名と管理方法は既存Config/Secret/部署運用のFit/Gapで最小化する。仮のSKUを送信してはならない。
- 正式値が揃うまでは、作成APIはfail closed。通常画面の課金開始操作を無効化し、何が未準備かを管理者に明示。単純にskuなしで作って成功扱いにしない。
- 実際のDNSFilter POST bodyは既存実測形状を拡張した `{organization:{name,managed_by_msp_id,sku,quantity}}` とし、正式OpenAPIに対して一致させる。不要な billing term/unique_id/住所等は送らない。
- 通常登録フォームの大きな課金注意書きパネルは**不要**。呼出直前の最終確認は顧客名・plan・契約上限台数を簡潔に表示し、連打・二重クリックを防ぐ。課金条件の重要情報はMSP管理者向けの登録説明/契約ルールに保持し、利用者への不必要な警告を常時出さない。
- DNSFilter POST後に `id` と `managed_by_msp_id` を検証し、`finalizeProvisioning` でローカルmappingを確定。SKU/数量が作成レスポンスに存在する保証はないため、返らない項目を成功した事実として断定しない。正式なread-back手段が未確定なら `subscriptionVerification:unverified` 等の未検証状態を明示し、別途DNSFilter Billingで照合。
- HTTP 2xxでも応答shape不明・ローカルDB失敗時は `DNSFILTER_CREATE_OUTCOME_UNKNOWN` または対応付け未解決を返し、**自動再POSTしない**。既存復旧導線と監査に接続する。エラー時の生レスポンス、API Key、秘密情報をログに出さない。
- 競合・F5同期との前後関係: DNSFilter上にOrgが作成できたがローカル確定前の場合にF5同期が別のローカルレコードを作成してしまう競合を検証し、同一DNSFilter IDの一意制約・結果不明復旧で安全に停止/解決する。無条件のlocal upsertや既存mapping上書きは禁止。

## 4. UI/UX
- MSPヘッダーの「新規顧客登録」からコンパクトなフォーム。入力は「Organization名／プラン Core・Plus／契約上限台数」の3項目。割当ライセンスはサーバーが導出し、通常の手入力必須項目にしない。
- 契約期間はMSP設定で決まるので顧客単位の入力欄は設けない。入力フォームに生SKU、MSP ID、DNSFilter IDを入力させない。
- 簡潔な登録内容の確認のみを表示し、登録成功時は一覧へ反映・顧客選択→初期管理者招待へ遷移。Site/Policy/Block Pageは別途承認済み標準構成を適用。
- 実行中、成功、結果不明、DB対応未解決をフォーム近傍に表示。失敗時に自動再試行しない。「再実行」ボタンを結果不明時に出さず、例外復旧へ誘導。
- 既存のF5同期POSTを維持。DNSFilter公式ログインへのリンクは例外・管理者ヘルプ用に保持。
- 複数社登録UI/CSV、契約プラン自由編集、独自課金ダッシュボードなどはこの実装に含めない。

## 5. テスト/HA（SKU実値なしでも可能な範囲）
- Core/Plusの内部SKU解決、契約上限1・複数・0・負数・小数・文字列・過大値、空名称、他Role拒否、SKU未設定時DNSFilter POSTゼロ。初期割当は契約上限より大きくならず、導入0台時はDNSFilter最小1台。
- DNSFilter送信bodyに `organization` wrapper、`name`, `managed_by_msp_id`, `sku`, `quantity` のみ。MSP親へ書き込まない。
- DNSFilter成功レスポンスのOrg ID/MSP所属照合、DB確定・監査、DB失敗時の未解決、通信タイムアウト/不明応答で再POSTゼロ。
- F5同期との競合、重複mapping、一時的なDNSFilter一覧エラー。既存の顧客招待・越境・監査回帰。
- SKU値が正式に確定するまで、モックでのみPOST試験可。実DNSFilterへの有料プラン割当・課金開始操作は別承認。
- 正式SKU・read-back確認後にレビューRevisionで対象限定HAを実施、本番トラフィックの変更は別承認。

## 6. ライセンス管理の運用最小化・契約上限ゲート（2026-11-04追加要求）
### 目的・責任範囲
- atLIBの顧客との**契約上限台数C**をSecure Guardで一度登録し、これを課金仕入割当の**強制上限**とする。契約上限CはatLIB独自の契約情報なのでローカル保持してよいが、DNSFilterの実際の割当・端末台数を二重の正本としてDBへ複製しない。
- **実際の利用台数U**はDNSFilterの正式な利用状況APIから取得する（候補: `GET /v1/metrics/organization_usage/{id}`）。GUIの`Current License Usage`/Roaming Client数との一致、および削除済み・オフライン端末のカウント規則をHAで検証し、単なるオンライン台数・Protected台数と混同しない。
- **目標割当Q = min(C, max(1, U))**。C=100、U=20ならQ=20、U=100ならQ=100、U=105ならQ=100**で停止し超過5台を要是正として通知**。これは合法・契約適合状態を作る上限処理であって、超過した5台を無償利用のまま容認する設計ではない。
- DNSFilterは割当超過のインストールを自動ブロックしない。Site Keyを知る顧客による直接インストールはこの式だけでは技術的に停止できない。未承認の追加配布はSecure Guard側で抑制できる範囲を制限し、**U>C**は顧客に契約変更または超過端末のアンインストールを促す例外状態として残す。保護中端末の無断強制停止はしない。
- atLIBによるSKU/Quantityの更新は**サーバー側でC以内に強制制限**。顧客RoleはC/plan/Qを変更不可。DNSFilter公式GUIでの直接変更は少数の特権担当者に限定し、後で実際の割当を照合する。**MSP最低料金150米ドル/月はこの台数上限制御とは別の仕入条件**である。

### 自動整合の成立条件（未実装・実データが確認できるまでは有効化しない）
1. DNSFilterからU（課金上の実利用台数）を正しい定義で取得できる。
2. 現在の割当数Qの正式な取得/保存後検証手段を確定する。現行Org GETには`sku`/`quantity`が出ないため、**read-back不明のまま盲目的なPATCHを自動反復しない**。
3. 正式SKU値・PATCH body・変更時課金の事実をHAで確認。変更先Q<=Cのサーバー検証、MSP所属・Role、監査、APIエラー/タイムアウト時結果不明の停止処理を必須にする。
4. 成立後のみ、定期的な**差分がある場合だけ**の自動調整を行う。毎回人が修正したり、端末1台増減ごとに無条件PATCHしたりしない。失敗・不明・U>Cのみ例外にする。UNKNOWNを0台と誤認しない。
5. atLIBから顧客への請求の計数日・対象端末定義は、先行する顧客請求方針（指定日時点の台数）と照合し、**DNSFilterの仕入割当/日割り処理と別管理**。自動的に顧客契約数を増やさない。

### v1リリースゲート
- SKU確定前は有料登録API未開放。割当read-backと課金対象Uの整合が未確認なら、**自動課金調整を「完成」と表示しない**。
- 一時対応はDNSFilter利用数/割当の管理画面照合と例外処理に限定。上記を満たしたら通常時は人手不要を目標とする。
- モック/HA: U=0,1,C-1,C,C+1、U不明、オフライン/キューアンインストール、read-back不明、PATCH timeout、F5同期の並走、顧客Roleからの越境/不正なC変更、MSP公式GUIでのドリフトをテストする。

## 7. 未確定・次のFit/Gap
1. DNSFilterから送付されるCore/Plus正式SKU文字列。
2. Organization作成時のSKU/数量保存値を確認できる公式GET/Billing手段。現行`GET /v1/organizations/{id}`は値を返さない。
3. 数量の正式な上限制約、顧客契約上限Cの最小保持先、既存Config/SecretでSKUを保持する最小方式。
4. 公式利用数Uの課金カウント定義、現在割当Qの正式GETまたは請求照合手段。これが未解決なら自動調整は保留する。
5. Work実装前にPR #3最新版とのFit/Gap、テスト差分、稼働中のreview revisionを照合する。

本記録は**設計のみ**。コード・DB Migration・DNSFilter書込・Cloud Run・Secret・IAM・Production操作を行わない。
