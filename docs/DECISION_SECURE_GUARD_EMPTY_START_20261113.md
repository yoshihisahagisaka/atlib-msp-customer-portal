# Decision｜Secure Guard V1の新DB空開始（2026-11-13）

- Status：**ACCEPTED（対象と運用順序の変更）**
- 決定者：萩坂（統括）
- 対象：Secure Guard V1のサービスイン前Staging／将来のProduction初期化
- 正本：Portal Draft PR #6。PR #5の旧本番Source Inventory／データ移行計画は、**旧データを引き継ぐ場合だけの保留資料**とする。

## 決定

1. Secure Guardはサービスイン前で顧客データは存在せず、旧Portal DB側のSecure Guardデータは検証用と位置付ける。**旧本番DBから新Secure Guard DBへのデータ移行は実施しない**。検証データ・旧ユーザーセッション・招待・通知episode・監査レコードを新DBへコピーしない。
2. 新しい専用DBは**空から初期化**する。Stagingでは `secure_guard_staging`、将来のProductionでは `secure_guard`。各DBでSecure Guard専用Migration 001→002→003→004のみを適用し、独立ledgerとruntime／overage／migrationの権限分離を維持する。既存PortalのMigrationを流用しない。
3. 初期受入は合成データによるログイン・Organization管理・監査・ライセンス超過・通知抑止・Agent解除の無効状態を検証する。**atLIBのOrganizationなど実データは完成後に**、その時点で適切な正規登録・DNSFilter連携導線を確認してから取り込む。現時点で新規移送プログラムは作らない。
4. 旧本番Portal DB、他サービスのDBとデータ、DNSFilter実Organizationは変更も削除もしない。旧検証データの削除はこの決定に含まない。既存Portal/PPAP/Sales Toolsの継続運用を優先する。
5. 旧本番DBの一時Read-only role作成（Stage A/B）、Source Inventory P1〜P6、旧→新データ移送・移送rollbackは**本V1初期構築の前提作業から除外**する。これらの手順を実行してよいという意味ではなく、実行しない。PR #5の既存Go／No-Goを暗黙に解除しない。

## 次の最短工程と変わらないGate

1. **Insight側**：既存共用Stagingインスタンスについて接続容量 `M-R >= 78`、既存サービスへの影響、バックアップ・復旧条件を確認し、SG専用空DBと3 role／3 Secret／SAの限定的な構築を個別に許可・実施する。
2. **Secure Guard側**：Staging SG専用Migration 001〜004を明示的に承認して適用。DB role否定権限、接続・ログイン・認証・権限・監査・超過監視の合成E2Eと切戻し（新Revision停止、旧Portal本番無変更）を検証する。
3. **サービス仕上げ後**：atLIBの実データ登録／DNSFilter Organization同期を個別に行い、権限・割当数を確認する。完成前の先行投入や通知・Agent実操作はしない。
4. **Production**：別途Go判定。既存Portal DBへのDDL、Cloud Run Traffic切替、Slack実送信、DNSFilter Agent DELETEは今回承認されていない。

## STOP条件

- 旧DBに移行を要する実顧客データ・維持義務のある監査記録があると判明した場合、空開始を止めて統括に差分を報告する。
- 接続予算、復旧条件、権限分離、合成E2Eが未成立ならStagingアプリ有効化を進めない。
- 本決定は**実環境のGCP/DB/Secret/IAMへの変更承認ではない**。Production No-Go／Draftを維持する。
