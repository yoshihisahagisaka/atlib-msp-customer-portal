import * as crypto from 'crypto';
import { loadConfig } from '../../src/config';
import { createPool } from '../../src/db/pool';
import { CustomerRepo } from '../../src/services/customerRepo';
import { AuthService } from '../../src/services/authService';
import { Mailer } from '../../src/services/mailer';
import { ZabbixClient } from '../../src/services/zabbixClient';

/**
 * 新規顧客オンボーディング自動化スクリプト。
 * 設計書「顧客オンボーディング時の自動セットアップ」の5ステップを実装する。
 *
 * 使い方:
 *   npm run onboard -- --code atlib002 --name "サンプル株式会社様" --email admin@example.com
 *   npm run onboard -- --code atlib002 --name "サンプル株式会社様" --email admin@example.com --plan "エントリープラン"
 *
 * --plan は複数指定可（本体グループに加えてプラン別サブグループを追加作成する）。
 * Sensor Edge/add_customer.sh と同様、冪等性より「一度きりの手動実行を前提とした
 * シンプルさ」を優先している（重複実行時の再入可能性は今後の課題）。
 */

interface Args {
  code: string;
  name: string;
  email: string;
  plans: string[];
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const result: string[] = [];
    argv.forEach((arg, i) => {
      if (arg === flag) {
        const v = argv[i + 1];
        if (v) result.push(v);
      }
    });
    return result;
  };

  const code = get('--code');
  const name = get('--name');
  const email = get('--email');
  if (!code || !name || !email) {
    throw new Error('Usage: --code <customer_code> --name <company_name> --email <admin_email> [--plan <plan_name>]...');
  }

  return { code, name, email, plans: getAll('--plan') };
}

function generateTemporaryPassword(): string {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  const pool = createPool(config);
  const customerRepo = new CustomerRepo(pool);
  const mailer = new Mailer(config.smtp);
  const authService = new AuthService(pool, customerRepo, mailer, config);
  const zabbixClient = new ZabbixClient(config.zabbix);

  console.log(`[1/5] ホストグループ作成: MSP/${args.name}`);
  const baseGroupId = await zabbixClient.createHostGroup(`MSP/${args.name}`);
  const groupIds: Array<{ id: string; name: string }> = [{ id: baseGroupId, name: `MSP/${args.name}` }];

  for (const plan of args.plans) {
    const planGroupName = `MSP/${args.name} ${plan}`;
    console.log(`       追加サブグループ作成: ${planGroupName}`);
    const planGroupId = await zabbixClient.createHostGroup(planGroupName);
    groupIds.push({ id: planGroupId, name: planGroupName });
  }

  console.log(`[2/5] 通知用Zabbixユーザー作成: notify_${args.code}`);
  const zabbixUserId = await zabbixClient.createNotificationUser(
    `notify_${args.code}`,
    config.zabbix.notificationUsrgrpId,
  );

  console.log(`[3/5] 顧客専用アクション作成: ${args.code}_alert`);
  const actionId = await zabbixClient.createAction(
    `${args.code}_alert`,
    groupIds.map((g) => g.id),
    zabbixUserId,
  );

  console.log('[4/5] DBにレコード登録');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await authService.hashPassword(temporaryPassword);
  const customerId = await customerRepo.insertCustomer({
    customerCode: args.code,
    companyName: args.name,
    email: args.email,
    passwordHash,
    zabbixUserId,
    zabbixActionId: actionId,
  });
  for (const g of groupIds) {
    await customerRepo.insertHostgroup(customerId, g.id, g.name);
  }

  console.log('[5/5] 初期パスワード通知メール送信');
  const loginUrl = config.passwordResetUrlBase.replace(/\/reset-password$/, '/login');
  await mailer.sendWelcomeEmail(args.email, args.name, temporaryPassword, loginUrl);

  console.log('');
  console.log('=== オンボーディング完了 ===');
  console.log(`customer_id: ${customerId}`);
  console.log(`customer_code: ${args.code}`);
  console.log(`zabbix_userid: ${zabbixUserId}`);
  console.log(`zabbix_actionid: ${actionId}`);
  console.log(`hostgroups: ${groupIds.map((g) => g.name).join(', ')}`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
