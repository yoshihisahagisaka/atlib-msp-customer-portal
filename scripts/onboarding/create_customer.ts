import { loadConfig } from '../../src/config';
import { createPool } from '../../src/db/pool';
import { CustomerRepo } from '../../src/services/customerRepo';
import { AuthService } from '../../src/services/authService';
import { Mailer } from '../../src/services/mailer';
import { ZabbixClient } from '../../src/services/zabbixClient';
import { onboardCustomer } from '../../src/services/onboardingService';

/**
 * 新規顧客オンボーディング自動化スクリプト（CLI版）。
 * 本体のロジック（設計書「顧客オンボーディング時の自動セットアップ」の5ステップ）は
 * src/services/onboardingService.ts の onboardCustomer() に集約されており、
 * routes/adminOnboarding.ts（管理画面から実行するAPI版）と共通。
 * 本スクリプトはCLI固有の関心事（引数パース・進捗のconsole出力・完了サマリ表示）
 * のみを担う薄いラッパー。
 *
 * 使い方:
 *   npm run onboard -- --code atlib002 --name "サンプル株式会社様" --email admin@example.com
 *   npm run onboard -- --code atlib002 --name "サンプル株式会社様" --email admin@example.com --proxy-id 10123 --ip-range 192.168.1.1-254
 *
 * --proxy-id は顧客拠点のSensor Edge（Zabbix Proxy）経由で監視する場合のみ指定する
 * （未指定の場合はZabbixサーバーが直接監視する）。
 * --ip-range は顧客のネットワークレンジ（手順0のヒアリングで判明していれば指定）。
 * 本スクリプトはこの値を使ってディスカバリ設定を自動投入するわけではなく、完了時に
 * 表示する次のステップ（zabbixserver/batch/setup_discovery.py の実行コマンド、または
 * 管理画面「顧客オンボーディング」からのCloud Run Job起動）に埋め込むためだけに使う。
 * 管理画面（/admin/onboard-customer.html）からの実行に移行済みだが、緊急時・ローカル
 * 検証用のフォールバック手段として本CLIも維持する。
 */

interface Args {
  code: string;
  name: string;
  email: string;
  proxyId?: string;
  ipRange?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const code = get('--code');
  const name = get('--name');
  const email = get('--email');
  if (!code || !name || !email) {
    throw new Error(
      'Usage: --code <customer_code> --name <company_name> --email <admin_email> [--proxy-id <zabbix_proxy_id>] [--ip-range <customer_ip_range>]',
    );
  }

  return { code, name, email, proxyId: get('--proxy-id'), ipRange: get('--ip-range') };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  const pool = createPool(config);
  const customerRepo = new CustomerRepo(pool);
  const mailer = new Mailer(config.smtp);
  const authService = new AuthService(pool, customerRepo, mailer, config);
  const zabbixClient = new ZabbixClient(config.zabbix);

  const result = await onboardCustomer(
    {
      customerRepo,
      zabbixClient,
      authService,
      mailer,
      notificationUsrgrpId: config.zabbix.notificationUsrgrpId,
      passwordResetUrlBase: config.passwordResetUrlBase,
    },
    { customerCode: args.code, companyName: args.name, email: args.email, proxyId: args.proxyId, ipRange: args.ipRange },
    (msg) => console.log(msg),
  );

  console.log('');
  console.log('=== オンボーディング完了 ===');
  console.log(`customer_id: ${result.customerId}`);
  console.log(`customer_code: ${result.customerCode}`);
  console.log(`zabbix_userid: ${result.zabbixUserId}`);
  console.log(`zabbix_actionid: ${result.zabbixActionId}`);
  console.log(`zabbix_proxy_id: ${args.proxyId ?? '(未設定・Zabbixサーバーが直接監視)'}`);
  console.log(`hostgroups: ${result.hostGroupName}`);

  console.log('');
  console.log('=== 次のステップ: ディスカバリルール・アクションのセットアップ ===');
  console.log('管理画面「/admin/onboard-customer.html」からのオンボーディングであれば、');
  console.log('Cloud Run Job「msp-discovery-setup」が自動起動されているはずです。');
  console.log('本CLIから実行した場合や、Job起動に失敗した場合は、msp-frontend-server にSSHして');
  console.log('以下をそのまま実行してください:');
  console.log('');
  console.log('  cd /opt/atlib-msp-dev/zabbixserver/batch');
  console.log(`  python3 setup_discovery.py --apply ${buildDiscoveryArgs(args)}`);

  await pool.end();
}

function buildDiscoveryArgs(args: Args): string {
  const parts = [
    `--customer-code ${args.code}`,
    `--company-name "${args.name}"`,
    `--ip-range ${args.ipRange ?? '<顧客のIPレンジ。例: 192.168.1.1-254>'}`,
  ];
  if (args.proxyId) {
    parts.push(`--proxy-id ${args.proxyId}`);
  }
  return parts.join(' ');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
