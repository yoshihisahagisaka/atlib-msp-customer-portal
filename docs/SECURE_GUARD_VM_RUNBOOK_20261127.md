# Secure Guard｜atlib-test-runner 検証VM利用手順（2026-11-27）

用途：**既存VM上でのオフライン実装/CI再現だけ**。GCP本番・共用Cloud SQL・DNSFilter・Slack/SMTPへ接続しない。VM上で実証できていない値をPASSと報告しない。実行前に現行Git・Canonical・Design Contract・Codex Work Orderを照合する。

## 1. 対象VM（ユーザー提供値）

| 属性 | 固定値 |
| --- | --- |
| Instance | `atlib-test-runner` |
| Project / zone | `msp-zabbix` / `asia-northeast1-a` |
| VM size | e2-standard-4 / 4 vCPU / 16 GiB |
| OS | Ubuntu 24.04 LTS |
| Disk | 100 GB（free容量は実測） |
| Local IP | 10.90.0.2 |
| 起動時外部IP | 35.243.111.243（現在値として扱わない・直結SSHは使用しない） |
| Access | Google Cloud OS Login + IAP SSH |
| HOME | `/home/yoshihisa_hagisaka_atlib_jp/` |

## 2. Cloud Shell/認証済み端末からIAPでSSH

Google Cloud CLIにて次を実行（OS Loginが自動的にログインIDを管理する）。管理者ロール、Firewall、VM設定をこの手順で変更しない。

```bash
gcloud compute ssh atlib-test-runner \
  --project=msp-zabbix \
  --zone=asia-northeast1-a \
  --tunnel-through-iap
```

IAP/OS Login認可不足、VM停止、SSH不可であればそこでSTOP。公開IPへ直結する方法へ切替えない。

## 3. VM内のSecure Guard専用Workspace

VMにログイン後、**別プロジェクト領域へ触れずに**次だけ実行。

```bash
set -euo pipefail
test "$HOME" = "/home/yoshihisa_hagisaka_atlib_jp"
test "$(id -u)" != 0
umask 077
ROOT="$HOME/projects/secure-guard"
test ! -L "$ROOT"
mkdir -p "$ROOT"/{evidence,tmp}
chmod 700 "$ROOT" "$ROOT/evidence" "$ROOT/tmp"
```

この後、GitHubのrepo read permissionがVM上で使える場合のみ：

```bash
set -euo pipefail
ROOT="$HOME/projects/secure-guard"
test ! -e "$ROOT/source" || {
  echo "STOP: source already exists; inspect before reusing"
  exit 1
}
git clone --single-branch \
  --branch feat/sg-v1-dedicated-integration-20261112 \
  https://github.com/yoshihisahagisaka/atlib-msp-customer-portal.git \
  "$ROOT/source"
cd "$ROOT/source"
git status --porcelain
git rev-parse HEAD
bash scripts/readiness/secureGuardVmPreflight.sh
```

`git clone`の認証失敗時はSTOP。VMにPATを平文配置、Git credentialを全プロジェクト共用、`sudo`で資格情報を追加することを禁止。Sourceが既存の場合は上書きcloneせず、元の作業内容を保全し、別途整合レビュー。

## 4. Offlineテスト（必要なツールが実測存在する場合だけ）

`node`・`npm`・`docker`に不足があればその情報をCodex統括に返す。自動apt/Docker daemon設定変更やグローバルnpm installをしない。

```bash
set -euo pipefail
cd "$HOME/projects/secure-guard/source"
test -z "$(git status --porcelain)"
export PUPPETEER_SKIP_DOWNLOAD=true
npm ci --no-audit --no-fund
npm run build
npm test
npm run typecheck:secure-guard-migration
```

PostgreSQL16統合は、手元の実Cloud SQLへ接続せず、**VM上の一時Docker PG16**に限る。Dockerが利用可能・ディスク容量とローカルport `55432`が空いているときだけ実施：

```bash
set -Eeuo pipefail
cd "$HOME/projects/secure-guard/source"
NAME="sg-pg16-verify-$(id -u)"
if docker container inspect "$NAME" >/dev/null 2>&1; then
  echo "STOP: exact named container already exists"
  exit 1
fi
if command -v ss >/dev/null && ss -ltn '( sport = :55432 )' | grep -q ':55432'; then
  echo "STOP: PostgreSQL fixture port already occupied"
  exit 1
fi
created=0
cleanup() {
  if [ "$created" = 1 ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
docker run -d --name "$NAME" \
  --label "atlib.project=secure-guard" \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=local_ci_fixture_password_not_a_secret \
  postgres:16 >/dev/null
created=1
for i in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null
CI=true NODE_ENV=test \
  SECURE_GUARD_DB_E2E_ENABLED=true \
  SECURE_GUARD_DB_E2E_HOST=127.0.0.1 \
  SECURE_GUARD_DB_E2E_PORT=55432 \
  npm run test:secure-guard-db-e2e
```

このスクリプトはDockerの**自己作成container 1件のみ**をtrapで削除し、他プロジェクトのDocker assetsや既存PG、ネットワーク、ボリュームに触れない。`docker system prune`、`docker volume prune`、GCP SQL接続、Credentials注入は禁止。画像を初回pullする場合はストレージ消費を事前確認すること。

## 5. 証跡とCodex引継ぎ

- `git rev-parse HEAD`／ブランチ／VM hostname／日時、`npm test`件数、隔離PG16件数、失敗の固定コード、`git diff --check`を `~/projects/secure-guard/evidence/` のプロジェクト内に保存する。
- 機密（JWT、API key、DB password、OTP、session Cookie、実顧客メール、Secret参照値）をログ・Issue・Gitへ載せない。
- 検証用DBはローカルの`127.0.0.1:55432`、アプリはローカルloopbackのみ。VM外部IPにHTTP/PG portを公開しない。
- VM結果は補助証跡であり、GitHub Actions結果と一致しない場合はSTOP。VM環境不足を理由に仕様を変更しない。
- **この手順はVM接続/環境確認の指示書であり、VMでの実行済み証跡ではない。**
