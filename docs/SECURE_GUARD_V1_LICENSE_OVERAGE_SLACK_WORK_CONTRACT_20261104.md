# Secure Guard v1｜割当台数超過・管理画面＋Slack通知｜Work差分実装契約

日付: 2026-11-04
対象: `yoshihisahagisaka/atlib-msp-customer-portal` Draft PR #3
基準HEAD: `8715fb5f87cbec16bb5d6c22445f774181c6cf40`
状態: 実装指示確定・**アプリコード未変更、Migration未実行、本番送信なし**
Canonical: `DECISION_SECURE_GUARD_DNSFILTER_API_BILLING_UPDATE_20261104.md` 4A〜4C と `DECISION_SECURE_GUARD_V1_SERVICE_LAUNCH_20261030.md`

## 0. 目的と不変条件
- **DNSFilter公式管理画面が正本**。Secure GuardはAPIで得られる情報を表示し、公式APIでできる操作だけをシンプルにまとめる。
- Secure Guardは**Roaming Clientエージェント方式のみ**。Network DNS方式、Network License用の管理・計算・課金機構を作らない。
- 顧客OrganizationごとにDNSFilter管理画面で確認した**割当ライセンス数量**だけを、契約開始時および変更時にMSP管理者が手動転記できるようにする。これは**DNSFilterへの書込ではない参照値**であり、契約上限とは区別。
- DNSFilter APIで実際に提供・検証された「利用台数」に基づいて**利用数 > 参照用割当数**のみ比較し、超過があれば管理画面表示＋Slack通知。既存合意にある顧客管理者への調整依頼導線を維持する。
- **APIにない「Agent登録済み」「Protected台数」「課金台数」を独自生成・推定しない。** `user_agents`の件数を利用数として代用しない。未確認なら超過判定は`UNKNOWN`、通知しない。
- 自動割当変更、Organization SKU/PATCH、端末自動撤去、顧客の契約数自動変更は**今回の対象外**。Slackチャンネルはユーザーが後日指定するため、未設定での送信は禁止。
- 既存PoCでPASS済みのOrganization/Site/Agent/アンインストールE2Eや他レーンのOTP/解約を再テスト・再設計しない。

## 1. 最新コードFit/Gap（PR #3 HEAD実読）
- `src/services/secureGuardRepo.ts`: `listManagedOrganizations`、`findActiveDnsFilterOrganization`、`recordSystemAudit`、Organization→DNSFilter対応付け、MSP Grant/Customer Membershipがある。これを利用。
- `src/routes/secureGuard.ts`: `requireIdentity`, `requireMspAdmin`, `requireCustomerScope`、既存MSP一覧、顧客 `/overview`。非MSPは変更不可。新しい任意のOrganization IDを顧客入力から認可に使わない。
- `src/services/dnsFilterInventoryClient.ts`: 既存の全Site/AgentのGET・状態とスコープをfail-closed照合する。**登録レコード件数の取得は確定だが、公式「利用台数」フィールドへの変換は未検証**。
- `src/routes/secureGuard.ts` `/overview`: `inventory.agents.length` と`status/agentState`別の件数を返すが、これを課金用利用数と見なしてはいけない。UI上の状態表示と契約台数超過判定を混ぜない。
- DNSFilterメトリクスGET実測: `/v1/metrics/organization_usage_detailed/{id}` はHTTP200だがTest02/Coreで `user_count=1`、GUI Roaming Clients in Use=2、`roaming_client_count`空欄。したがって、この `user_count`も利用数に採用不可。
- DNSFilter Organization GETでは割当 `quantity` 未取得。MSP管理者の手動転記を承認済み。
- `src/config.ts` に既存Slack Webhook設定（顧客申込み/月次レポート）がある。`src/services/slackNotifier.ts` の `sendSlackNotification` は送信失敗時も**voidで例外を握りつぶす**。これを通知成功としてDBに記録してはならない。
- `public/secure-guard-admin.html`/`public/js/secureGuard.js` は既存一覧を表示するが、割当数参照値・超過表示は未実装。旧UIの統合/F5同期は別承認契約、ここでは壊さない。

## 2. 実装順序と変更許可
### A. 割当数量の参照用手動転記（独立して実装可能）
- 最小DB Migration案 `013_secure_guard_license_alert_snapshot.sql`：既存 `customer_organizations` に nullable の `dnsfilter_allocated_rc_licenses_snapshot`、`license_snapshot_updated_at`、`license_snapshot_updated_by` を**最小限の列**として追加。既存データを強制補完・遡及バックフィルしない。正式0台が許容されるか未確定なので、手動転記の0はGUI根拠が確認できたときのみ扱い、0か未入力(null)かを分ける。詳細の命名は既存migration規約に合わせてよい。
- `msp_admin` だけが当該顧客Organizationの割当参照値を記録・変更。新規管理ルートは既存`/admin/organizations/:organizationId` の認可を再利用し、顧客Roleでは拒否。DNSFilter IDとのmappingがactiveであり所属確認済みであること。値は安全な整数として検証。割当入力はDNSFilter APIをPATCHしない。
- MSP一覧の各行・顧客詳細に**「割当数（DNSFilter管理画面から転記）／最終転記日時」**を表示。未入力は「未設定」、APIで取得したふりをしない。DNSFilter管理画面への参照リンクは既存リンクを使う。入力成功/更新は既存監査へ記録。
- DB列を新しいライセンス正本とは呼ばない。公式画面と相違したら手動照合する。入力値以外の請求計算はしない。

### B. 超過判定データソースのFit/Gap（実装有効化の前提）
- **最初に既存PoC・Canonical・コードから、DNSFilterが実際に返していた「公式利用台数」の値と出所を特定する。** 未確認のフィールドや関係から端末数を作らない。PoCのやり直しは不要。正式な数値フィールドがまだ見つからなければ、`usage: null, status: 'unavailable'` で**停止**する。ここで質問を繰り返すのではなく、取得不可をGapとして報告する。
- 既存APIの値が公式GUIと同義だと証明できた場合のみ利用する。Queryの取得条件、MSP/顧客スコープ、ページング、GET失敗時UNKNOWNを保持。
- `overage = confirmedUsage > manualSnapshot`。`manualSnapshot===null`、`confirmedUsage===null`、API失敗、欠落/曖昧/古い値は `UNKNOWN`。ゼロや「超過なし」に変換しない。超過数は検証済み公式値同士の差だけで算出し、独自Agent件数は不可。
- これが未確認のままなら**通知・集計の実行スケジューラをOFF**。手動参照値Aと画面上の「照合不可」だけ先に完成可能。

### C. 管理画面＋Slack
- 一度の比較結果をMSP管理画面に表示する。超過時は顧客名、公式API利用台数、手動転記割当数、超過台数、確認日時、管理画面への実在する参照URLを表示/通知。個人Agent識別子・Site Key・Webhook URLは通知に含めない。
- Slack通知は**atLIB Secure Guard専用**の設定（例: `SECURE_GUARD_LICENSE_ALERT_SLACK_WEBHOOK`）を追加。ユーザーから通知チャンネルが提示されるまで未設定・送信禁止。既存顧客申込み/月次レポートWebhookは絶対に流用しない。
- `sendSlackNotification`は失敗を返さないため、**配送結果が確認できる専用の薄いAdapter**を作るか、既存呼出側と互換性を壊さず送信結果を取得できるようにする。失敗時に「Slack送信済み」と記録しない。HTTP timeoutとHTTP非2xxも失敗。
- 定期的な同じ超過の通知を連発させない。Organizationごとに**初回超過、超過数が変化したとき**を通知候補とし、最小の永続通知状態を持つ。複数Job並走時に重複しないようDB競合・トランザクションを考慮し、既存監査と重複データを作らない。
- 既存顧客管理者向け対応依頼の導線は維持する。Slack通知先はatLIB運用チャンネルであり、顧客にSlack権限を与える意味ではない。管理画面表示はSlack未設定/障害時にも継続。
- scheduler: 初期実装は**副作用のない1回実行関数**と安全なJob実行入口まで。正式利用数APIが未確定の間は起動しない。頻度・Cloud Scheduler/Run Job設定・権限・Secret・通知先実値・本番配送は統括の別承認で行う。複雑な通知管理ツールを導入しない。

## 3. 必須HA
1. 空欄/未設定割当と0を区別。MSP本人のみ更新可、顧客管理者・operator・viewer・他Orgは変更不可。監査・履歴日時を確認。
2. 作成済みOrganizationへの参照保存はDNSFilter POST/PATCHを発生させない。
3. 公式利用数が取得不可、曖昧、取得失敗の場合は`UNKNOWN`で超過通知0件。特に`GET /v1/user_agents` 2件を「保護2台」と判定しない。
4. 利用<=割当は通知0件。超過初回は管理画面とSlack、同値再実行はSlack0件、超過数が変化したら再通知。ジョブ並走・DB失敗時の二重通知・漏れの扱いをテスト。
5. Slack webhook未設定は送信0件、送信失敗時は「通知済み」にしない。既存`slackNotifier.ts`顧客申込み/レポート通知の回帰を確認する。
6. テナント認可、F5同期、Organizationマッピング維持、既存インベントリ・MFA／C2／Agent削除E2Eの回帰。不要な再実機操作はしない。

## 4. Workへの指示・STOP
- **PR #3の最新HEADを再取得**し、並行変更・別WorkのHuman Review runnerに触れず、Work専用branch/worktreeで実装する。固定HEADがずれた場合は最新CanonicalでFit/Gapを更新し、衝突なく進める。
- 優先作業は**Aの手動参照入力UI＋API＋Migration＋オフラインテスト**。Bで利用数の正本が確認できるならCの比較・Slack送信を実装。未確認なら比較・通知は停止し、**完成と主張しない**。
- Slackチャンネル未提供でもCのAdapter/モックテストまでは可能。本物のWebhookの作成・送信、DNSFilterの課金PATCH、DB実migration、Cloud Runデプロイ、Scheduler有効化は**行わない**。
- 成果物は変更ファイル一覧、TypeScript build/test実行結果、既存テストの回帰、現行APIデータソースの根拠、STOP/残Gap、Commit SHA、Draft PRリンク。実装できなかった部分は明示する。

