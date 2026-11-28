# Secure Guard V1｜SECU:MIE脆弱性対策との共通運用基準（2026-11-28）

## 参照した既存正本

- SECU:MIE Insight: [Production Release Gate A / PR #47](https://github.com/yoshihisahagisaka/atlib-sales-tools/pull/47), `docs/secumie-production-release-gate-a-20261114.md`。
- SECU:MIE系のSales Tools共通セキュリティ改善: [R4a / PR #120](https://github.com/yoshihisahagisaka/atlib-sales-tools/pull/120), `docs/sales-tools-common-r4a-security-remediation.md`。Zod 3→4は型・入力検証の互換修正を必要範囲に限定し、実ブラウザ/認証/DB回帰を使用。未修正Critical/Highは残存GateとしてNO-GO、除外しない。
- Secure Guardの承認済み設計: [PR #6](https://github.com/yoshihisahagisaka/atlib-msp-customer-portal/pull/6), [Issue #13](https://github.com/yoshihisahagisaka/atlib-msp-customer-portal/issues/13), [アプリPR #18](https://github.com/yoshihisahagisaka/atlib-msp-customer-portal/pull/18)。

## サービス横断で統一する基準

1. **先に現物のFit/Gap。** CVE/GHSA、effectiveSeverityとsourceSeverityを分け、導入版、修正版、OS/npm種別、依存導入元、Scanner、Build ID、scan ID、対象immutable image digestを証跡化する。異なるScannerの件数が食い違っても相殺しない。既存Scan IDを再利用し、同一digestを理由なく再スキャン・再Pushしない。
2. **最小の再現可能な修正。** 提供元の修正版が利用できる場合に、対象パッケージを固定バージョンまたは検証済みimmutableベースdigestで修正。npmは`package.json`とレビュー済み`package-lock.json`をセットで固定し、`npm ci`のみで再現する。`npm audit fix --force`、無関係のMajor更新、全パッケージ一括upgrade、脆弱性の重大度変更は行わない。
3. **ランタイム最小化と非root。** Multi-stage、直接Node起動、不要なnpm/npxをランタイムへ持ち込まない。非root実行と権限を実コンテナで検査。SECU:MIEは公式distroless Node24を採用しているが、**OSを跨いだ無条件コピーはしない**：Secure Guardアプリは固定Alpine Node24が親PRの受入正本で、Alpine修正版を限定採用して先にC0/H0を測定する。MigrationはDebian13 distrolessを独立検証する。いずれも環境ごとに実証・承認されたimmutable digestを要求。
4. **コード互換を別Gateで確認。** Zod 3→4はSECU:MIE R4aの検証方法を流用し、Secure Guard実Routerのメール、UUID、Enum、coerce、400レスポンス、MFA/Organization Scopeに対する正・負テストを確認。通常回帰136、独立PG16 5、migration image 1、月次バッチTypeScriptを失わない。型チェックPASSだけではZod4互換PASSと認定しない。メール・Puppeteer等のMajor更新も同様。
5. **CIをGitの同一HEADに結びつける。** PRのsynthetic merge SHAではなく明示PR HEADをcheckoutし、`git rev-parse HEAD`で照合、OCI revisionラベル、Docker platformとbase digest、固定Lockfile SHA、Trivy C0/H0、コンテナの非root起動・隔離Smokeを同一HEADで確認。
6. **GCP実Imageで独立判定。** Registry immutable digestとCloud Build結果を突合し、Artifact Analysis On-Demand scanのCritical/High/Unknownを保存。**Critical 0 / High 0、Unknownは内容を分類して解消または既存の正式Gateで明示判断するまでNO-GO**。修正版のないHIGHも検出値として残す。スキャン除外・重大度変更・`ignore-unfixed`・暗黙例外は禁止。
7. **公開Gateを混ぜない。** アプリImage PASSはSecure Guard Migration専用Image S3 PASSでもMFA S4 PASSでもない。Migration ImageのDebian13 OpenSSL HIGH 4件は別STOP。実Staging 005→独立ACL受入→006/MFA/E2E→Productionの順番を維持。SECU:MIE/InsightのShared Instanceもdatabase/role/ledger/Secret/責任範囲を厳格分離する。
8. **副作用のある操作は別承認。** Git Draft変更・CI検証と、GCP Build/Push/Scan、Cloud Run deploy、DB/IAM/Secret/Job実行、本番Trafficを区別する。GCP再Build、Scan、0% Revision、Production切替を自動連結しない。既存サービスと顧客データを変更しない。

## PR #19の適用境界（現状）

- GCP実測アプリImage `sha256:369fab324e2cd0c086ea326ea3d6b17dc9da71c846b2a8f2a9ba0551a3b66001`、scan `3e056a92-5070-4720-9b6a-a5520ea4f26f` は C0/H5/UNKNOWN1。H4 OpenSSLのAlpine `3.5.9-r0`→候補 `3.5.9-r1`、Unknown1 zlib `1.3.2-r1`→候補 `1.4-r0`、H1 Zod3 `3.25.76`→候補Zod4 `4.6.7`（実versionは候補CI lockで確認）。
- PR #19の`Dockerfile`、`package.json`、CIは**検証候補**。Zod4候補Lockfileのレビュー固定と互換テスト、Nonroot/C0H0の再受入、GCP実測の再検査が完了するまで**修正済みとは判定しない**。
- uuid `9.0.1` のCVE-2026-41907はsource HIGH/effective MEDIUMで、別途経路・到達性を確認し、対処を監視する。重大度を任意に変えない。
- **本書は公開承認ではない。** PR Draft維持、GCP変更なし。Secure Guard Gate S3 STOP、S4/Production No-Go。
