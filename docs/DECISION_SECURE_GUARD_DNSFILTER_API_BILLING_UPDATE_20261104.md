# Secure Guard v1｜DNSFilter正式回答による登録・課金設計更新
日付: 2026-11-04
基準: PR #3 HEAD e0ae819dddf6cb68d3e8a2ae09bbb9411a46998e
状態: ベンダー回答Fact＋統括指示に基づくv1設計更新。コード/DB/デプロイ未実施。

## 1. 正式回答Fact（2026-11-04受領）
- `POST /v1/organizations`、`PATCH /v1/organizations/{id}` で `sku`（Core/Plus）と `quantity`（割当ライセンス数）を指定できる。Core/Plusの**当該MSP向けSKU実値は後日提供予定**。一括更新APIではプラン変更不可、Organization単位で更新する。
- Organization CSV一括取込みなし。APIを顧客ごとに実行する方式は可能。レート制限は5分2,000要求との回答。請求期間（月次/年次）はMSPアカウント単位で設定される。
- 課金数量はMSP Billing上の保存済みplan/license allocation。実端末数は参考利用状況であり、超過時に自動増枠・超過請求・サービス停止は行われない。割当増減は保存時点で即時適用・日割り精算。
- MSP最低料金は月額150米ドル。親Organizationに個別のライセンス課金なし。社内/検証用NFRは標準25ユーザー、再販売・顧客割当は禁止。
- `DELETE /v1/organizations/{id}` が正式API。事前にRoaming Clientアンインストール、Site撤去、DNS参照先変更が必要。削除後はDNSサービス即停止、設定・ログ等消失、復元不可。日割りクレジットは次回請求。
- 停止状態での無課金保持はできない。アクティブOrganizationは最低1ライセンス。解約/削除後の保持・復元条件については追加回答待ち。
- `GET /v1/invoices` はプラン別請求合計/期間、`GET /v1/metrics/organization_usage/{id}` は利用状況。Organization別確定請求CSV/APIは回答されていない。請求書は画面から個別DL。
- Trialは米国東部時間2026-11-14 23:59 EST終了（日本時間2026-11-15 13:59）。カード登録済みなら自動有料化、未登録なら課金なしで停止。Trial中に有料プランを選ぶと直ちに課金開始。
- 請求締めの正確な時刻/タイムゾーン、Core/Plus SKU実値、解約後保持条件はベンダー追加回答待ち。

## 2. 旧Decisionからの変更（承認された方向）
- 旧: DNSFilter GUIでOrganization作成・プラン設定→Secure Guardで画面表示/F5自動同期。
- 新: **Secure Guard MSP管理画面でOrganization名、プラン、ライセンス数量を入力し、DNSFilter APIの作成と同時に設定**。一括顧客登録もOrganization単位のAPI操作で対応する方向。DNSFilter公式GUIは管理者用の例外・照合手段として残す。
- 画面表示/F5自動同期は**維持**。DNSFilter GUI等で作られたOrganizationの取込みと照合に利用し、既存ローカルmappingを勝手に削除/変更しない。
- 顧客利用者にDNSFilterへの直接ログイン権限を与えない。MSP管理画面の作成・プラン/割当変更はatLIB側の特権操作に限定。顧客Roleによる自己変更はしない。
- 旧Decisionの「DNSFilter GUI作成を通常運用」「Subscription API不明」は、本書のベンダーFactで更新する。それ以外のUI/認証/運用/監査/ヘルプの合意は維持。

## 3. 実装前の必須差分
- 現行`DnsFilterManagementClient.createOrganization(name)`は存在するが、`sku`/`quantity`の設定処理は未確認・未実装。既存APIのrequest body、OpenAPIの必須属性・型・課金開始条件を正式SKU受領後に照合する。
- 現行`POST /admin/dnsfilter/organizations`には作成draft/結果不明時の停止・復旧がある。再利用し、APIタイムアウト時の重複作成・二重課金を避ける。結果不明の自動再POSTは禁止。
- 登録時は課金開始の可能性を確認画面に明示。SKU値が届くまで有料planを含む作成APIを送らない。ライセンス数は非負/上限等のAPI正式制約に合わせて検証し、数量を端末数から勝手に決めない。
- 新規登録とF5同期の競合・並行作成・既存mappingの一意性を既存migration制約で保護。途中成功・失敗・UNKNOWNを分ける。
- ライセンス変更は即時仕入課金へ影響するため、権限/確認/監査を必要最小限で実装。変更後はread-backで実際の保存値を確認する。GETの利用状況を請求確定数量と取り違えない。
- Organization解約削除は既存PR #44/C2の安全ゲートと端末E2Eを再利用。DELETE API存在だけで安全な一括解約完了と判定しない。

## 4. v1で増やさないもの
- 顧客自身によるプラン/ライセンスの直接変更、独自の課金エンジン、外部PSA/Rewst導入、複雑な一括課金UI、スケジューラー/自動請求確定、未確認の契約締め処理。
- 請求開始後に実績照合し、運用上必要な差分のみ改善する。

## 4A. 統括側の既存前提の再確認（2026-11-04補記）
- Secure Guardで販売・運用するDNSFilter方式は**Roaming Clientエージェント保護に限定**。Network DNS方式をサービスに含めない。Networkライセンスの自動計数・仕入管理を勝手に増やさない。
- 管理・顧客向け台数の正本は**DNSFilter管理画面の保護状態にある端末数**。Agent登録レコード総数ではない。GET user_agents の件数がGUI Roaming Clients in Useと一致しても、**保護状態端末数の一致は示さない**。
- 既存APIの status と agent_state が管理画面のProtected判定とどう対応するかをRead-onlyで照合する。オンライン状態、オフライン端末、削除待ちは推測で切り捨てない。
- 契約上限C、検証済み保護台数P、DNSFilter割当Qを分離。契約開始時にCを先行割当せず、Pに応じてQを段階的に調整。P>CならQをCで固定し顧客へ是正依頼。PがUNKNOWN、またはQ read-back不明なら自動PATCHしない。
- DNSFilter仕入課金の保護台数算入ルールとatLIB顧客への請求条件は正式契約とGUI/API実測で確認する。管理画面の表示だけを最終請求の証拠としない。
- 上記は新機能設計ではなく既定の運用前提の訂正。先行文書の「Agent件数をUとして仕入割当に追従」「ネットワーク分をSecure Guardで課金管理」は適用しない。

## 5. 後続作業
1. SKU正式値と公式API schemaを照合し、既存作成フローのコードレベル差分を確定。
2. 旧MSP Sync/Launch契約と本Decisionの優先関係を明示して実装指示を更新。F5同期は残す。
3. API/DB/UI/監査/HA契約を揃えてからWorkへ差分実装を依頼。
4. ここではDNSFilterへの書込み、プラン選択、課金開始、DB migration、デプロイを行わない。

根拠: ユーザー提供のDNSFilter回答（2026-11-04受領）。回答未確定事項を事実として扱わない。
