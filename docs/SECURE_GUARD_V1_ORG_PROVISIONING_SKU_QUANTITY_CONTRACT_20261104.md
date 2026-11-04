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
- この契約の実装対象は**個別の新規Organization登録**。画面表示/F5時の既存Organization自動同期は別契約のまま維持。大量登録・既存Orgのプラン変更は別工程。

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
- `quantity`: 正の整数、最低1。上限・APIの数量制約は正式仕様/契約を調査し、不明な上限を勝手に定めない。
- `managed_by_msp_id` をブラウザから受けない。Server固定の設定値11473を使用し、数値形式・MSP所属を照合。

Server: `POST /api/secure-guard/admin/dnsfilter/organizations` の既存routeを拡張。
- Body案: `{organizationName:string, plan:'core'|'plus', quantity:number}`。
- Roleは既存 `msp_admin` のみ。顧客Roleでは拒否。
- `SKU_CORE` / `SKU_PLUS` のような**サービス側設定**で実値に変換し、取得できない/空/同値/不正ならDNSFilterへPOSTせずエラー。変数名と管理方法は既存Config/Secret/部署運用のFit/Gapで最小化する。仮のSKUを送信してはならない。
- 正式値が揃うまでは、作成APIはfail closed。通常画面の課金開始操作を無効化し、何が未準備かを管理者に明示。単純にskuなしで作って成功扱いにしない。
- 実際のDNSFilter POST bodyは既存実測形状を拡張した `{organization:{name,managed_by_msp_id,sku,quantity}}` とし、正式OpenAPIに対して一致させる。不要な billing term/unique_id/住所等は送らない。
- 呼出直前に顧客名・plan・数量・「保存による課金開始」を示す確認画面を設ける。連打・二重クリックを防ぐ。
- DNSFilter POST後に `id` と `managed_by_msp_id` を検証し、`finalizeProvisioning` でローカルmappingを確定。SKU/数量が作成レスポンスに存在する保証はないため、返らない項目を成功した事実として断定しない。正式なread-back手段が未確定なら `subscriptionVerification:unverified` 等の未検証状態を明示し、別途DNSFilter Billingで照合。
- HTTP 2xxでも応答shape不明・ローカルDB失敗時は `DNSFILTER_CREATE_OUTCOME_UNKNOWN` または対応付け未解決を返し、**自動再POSTしない**。既存復旧導線と監査に接続する。エラー時の生レスポンス、API Key、秘密情報をログに出さない。
- 競合・F5同期との前後関係: DNSFilter上にOrgが作成できたがローカル確定前の場合にF5同期が別のローカルレコードを作成してしまう競合を検証し、同一DNSFilter IDの一意制約・結果不明復旧で安全に停止/解決する。無条件のlocal upsertや既存mapping上書きは禁止。

## 4. UI/UX
- MSPヘッダーの「新規顧客登録」からコンパクトなフォーム。入力は「Organization名／プラン Core・Plus／割当ライセンス数」の3項目。
- 契約期間はMSP設定で決まるので顧客単位の入力欄は設けない。入力フォームに生SKU、MSP ID、DNSFilter IDを入力させない。
- 課金開始の確認を表示し、登録成功時は一覧へ反映・顧客選択→初期管理者招待へ遷移。Site/Policy/Block Pageは別途承認済み標準構成を適用。
- 実行中、成功、結果不明、DB対応未解決をフォーム近傍に表示。失敗時に自動再試行しない。「再実行」ボタンを結果不明時に出さず、例外復旧へ誘導。
- 既存のF5同期POSTを維持。DNSFilter公式ログインへのリンクは例外・管理者ヘルプ用に保持。
- 複数社登録UI/CSV、契約プラン自由編集、独自課金ダッシュボードなどはこの実装に含めない。

## 5. テスト/HA（SKU実値なしでも可能な範囲）
- Core/Plusの内部SKU解決、数量1・複数・0・負数・小数・文字列・過大値、空名称、他Role拒否、SKU未設定時DNSFilter POSTゼロ。
- DNSFilter送信bodyに `organization` wrapper、`name`, `managed_by_msp_id`, `sku`, `quantity` のみ。MSP親へ書き込まない。
- DNSFilter成功レスポンスのOrg ID/MSP所属照合、DB確定・監査、DB失敗時の未解決、通信タイムアウト/不明応答で再POSTゼロ。
- F5同期との競合、重複mapping、一時的なDNSFilter一覧エラー。既存の顧客招待・越境・監査回帰。
- SKU値が正式に確定するまで、モックでのみPOST試験可。実DNSFilterへの有料プラン割当・課金開始操作は別承認。
- 正式SKU・read-back確認後にレビューRevisionで対象限定HAを実施、本番トラフィックの変更は別承認。

## 6. 未確定・次のFit/Gap
1. DNSFilterから送付されるCore/Plus正式SKU文字列。
2. Organization作成時のSKU/数量保存値を確認できる公式GET/Billing手段。現行`GET /v1/organizations/{id}`は値を返さない。
3. 数量の正式な上限制約と、既存Config/SecretでSKUを保持する最小方式。
4. Work実装前にPR #3最新版とのFit/Gap、テスト差分、稼働中のreview revisionを照合する。

本記録は**設計のみ**。コード・DB Migration・DNSFilter書込・Cloud Run・Secret・IAM・Production操作を行わない。
