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
- この契約は**DNSFilter APIによる個別Organization登録**だけを具体化し、ライセンス自動調整はAPI読取・検証手段が確定するまで保留する。画面表示/F5の既存Org同期は別契約のまま維持。大量登録・独自請求エンジンは別工程。

## 2. 既存コードの利用箇所
- `src/services/dnsFilterManagementClient.ts`: `createOrganization(name)` は `POST /v1/organizations` に `{organization:{name,managed_by_msp_id:Number(mspId)}}` を送信し、レスポンスのOrg IDとMSP所属を検証。8秒タイムアウト・raw本文非表示。これを拡張する。新規クライアントを作らない。
- `src/routes/secureGuard.ts`: `POST /admin/dnsfilter/organizations` は `requireIdentity` + `requireMspAdmin`。 `createProvisioningDraft` → DNSFilter POST → `finalizeProvisioning` を実装。結果不明時に停止状態のdraftと監査を残す。自動再POST禁止を維持。
- `src/services/secureGuardRepo.ts`: `createProvisioningDraft`, `finalizeProvisioning`, `listManagedOrganizations` と監査を再利用。既存テーブルにSKUや請求数を二重の正本として記録しない。
- `public/secure-guard-admin.html`: 現在「新規顧客登録」はDNSFilter公式へのリンク。変更後は当該MSP画面のフォームへ。例外時の公式リンクは管理者ヘルプに維持する。
- `public/js/secureGuard.js`: 旧作成フォーム処理は削除済み。新フォームを再配線するが旧の手入力取込みパネルへ戻さない。

## 3. Organization作成の差分実装（DNSFilter APIに限る）
- `POST /admin/dnsfilter/organizations`の既存`msp_admin`認可／draft／結果不明停止／監査を再利用する。
- 入力はDNSFilterへ送信する**Organization名・プランCore/Plus・割当ライセンス数(quantity)**。別の端末台数や「登録済み」状態を作らない。
- `sku`はブラウザから受けず、正式に通知されたCore/Plus SKUへサーバー側で変換。未確定ならfail-closed（APIへのPOSTなし）。
- OpenAPI確認済みのrequest形状は `{organization:{name,managed_by_msp_id,sku,quantity}}`。MSP IDはServer側固定。 `quantity`の最低値・0の扱いはDNSFilter回答とGUI表示に差異があるため、正式確認後に入力検証を決める。未確認の値を仮定してPOSTしない。
- 契約上限台数とDNSFilter割当台数を混同しない。DNSFilterのAPIに存在しない契約管理・台数算定・台数自動同期を新設しない。初期作成時に顧客の最大契約台数を機械的に設定することもしない。
- 正式SKU設定・課金開始の承認前は有料APIへの書込みをしない。作成結果不明時は自動再POSTしない。
- 現行`getOrganization`がSKU/数量を返さない実測があるため、**レスポンスにない値をローカルの正本として記録・表示しない**。読取手段が確定するまで通常の課金変更自動化は保留。

## 4. 管理画面
- DNSFilterの管理画面を正とし、APIから取得した値のみ表示する。新規Organization入力は必要最低限の3項目。普段から大きな課金警告パネルは表示せず、実行前に送信内容を確認する。
- 既存のMSP全件取得・F5時自動同期、Organization一覧統合、顧客別Site/Agent管理、初期管理者招待は維持。DNSFilter画面へのリンクはAPIで実施できない操作の導線として残す。
- Agent APIのレコード件数や `status` 等から、「登録台数」「保護台数」「課金台数」を独自生成しない。利用者向け状態名もDNSFilter公式画面との対応が未確認なら推測表示しない。
- 登録済みAgentの別管理テーブル、端末状態履歴、Network License管理、独自の課金エンジン、契約台数超過ロジックは作らない。

## 5. テスト・HA
- Core/Plus SKU解決、SKU未確定時POSTゼロ、MSP権限・Tenant Scope、quantityバリデーション、送信bodyの厳格性、APIタイムアウト/未知結果時の再POSTゼロ、F5同期競合、監査を既存テストへ差分追加する。
- API結果に存在しない項目・unknown/nullをゼロとして表示しない。Agent件数をProtected/課金台数と同一視しない。
- SKU実値・量の仕様・書込後read-back未確定のため、実DNSFilterへの有料操作は行わない。既存PoCでPASS済みの操作の再試験は要求しない。

## 6. ライセンス運用方針：可能なAPIのみ自動化
- 顧客契約上限を超える仕入と日々の手作業を避けたい、という要件は維持する。ただし現時点で割当数量を読み取れるAPIは確認されておらず、**勝手な推定値を使った自動PATCHは作らない**。
- 「端末保護状態」もDNSFilter管理画面の表示が正本。現行`GET /v1/user_agents`で行数が一致した事実はProtected/課金対象の確認とは異なる。
- **提供サービスはRoaming Client方式のみ。** Network経由のライセンス計数や課金処理をSecure Guardへ追加しない。
- 公式APIで同一の割当数/保護状態を直接取得・検証でき、公式の変更操作が確認された場合だけ改めて最小の差分自動化を検討する。できない場合はDNSFilter公式画面で管理する。
- 独自のC/P/U/Q算式・派生状態・定期自動パッチ・例外通知ロジックの先行実装は撤回。別途明示承認がない限り開発対象外。

## 7. 未確定・次のFit/Gap
1. DNSFilterから送付されるCore/Plus正式SKU文字列。
2. Organization作成時のSKU/数量保存値を確認できる公式GET/Billing手段。現行`GET /v1/organizations/{id}`は値を返さない。
3. 数量の正式な制約、既存Config/Secretで正式SKUを保持する最小方式。独自の契約台数テーブルは本契約の対象外。
4. DNSFilter管理画面とAPIで同じ台数・状態・割当数を直接参照できる公式手段。これらが未解決ならSecure Guardでは値を作らず、自動調整も保留する。
5. Work実装前にPR #3最新版とのFit/Gap、テスト差分、稼働中のreview revisionを照合する。

本記録は**設計のみ**。コード・DB Migration・DNSFilter書込・Cloud Run・Secret・IAM・Production操作を行わない。
