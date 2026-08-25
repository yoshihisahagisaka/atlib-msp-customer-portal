import * as crypto from 'crypto';
import type { CustomerRepo } from './customerRepo';
import type { AuthService } from './authService';
import type { Mailer } from './mailer';
import type { ZabbixClient } from './zabbixClient';

/**
 * 新規顧客オンボーディングの5ステップ（設計書「顧客オンボーディング時の自動セットアップ」）を実装する。
 * scripts/onboarding/create_customer.ts（CLI）と routes/adminOnboarding.ts（管理画面API）の
 * 両方から呼ばれる共通ロジック。ipRangeはここでは一切使わない（Zabbixディスカバリ設定は
 * 別途Cloud Run Job「setup_discovery.py」が担当するため、呼び出し側がその起動時引数として
 * 保持するためだけに存在する）。
 */

export interface OnboardCustomerInput {
  customerCode: string;
  companyName: string;
  email: string;
  proxyId?: string;
  ipRange?: string;
}

export interface OnboardCustomerResult {
  customerId: string;
  customerCode: string;
  companyName: string;
  zabbixUserId: string;
  zabbixActionId: string;
  hostGroupId: string;
  hostGroupName: string;
}

export interface OnboardCustomerDeps {
  customerRepo: CustomerRepo;
  zabbixClient: ZabbixClient;
  authService: AuthService;
  mailer: Mailer;
  notificationUsrgrpId: string;
  passwordResetUrlBase: string;
}

export class DuplicateCustomerCodeError extends Error {
  constructor(customerCode: string, existingId: string) {
    super(`customer_code "${customerCode}" は既に登録済みです（customer_id: ${existingId}）。二重登録を防ぐため処理を中止しました。`);
    this.name = 'DuplicateCustomerCodeError';
  }
}

function generateTemporaryPassword(): string {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
}

export async function onboardCustomer(
  deps: OnboardCustomerDeps,
  input: OnboardCustomerInput,
  onProgress?: (message: string) => void,
): Promise<OnboardCustomerResult> {
  const log = onProgress ?? ((): void => {});

  const existing = await deps.customerRepo.findByCustomerCode(input.customerCode);
  if (existing) {
    throw new DuplicateCustomerCodeError(input.customerCode, existing.id);
  }

  log(`[1/5] ホストグループ作成: MSP/${input.companyName}`);
  const hostGroupName = `MSP/${input.companyName}`;
  const hostGroupId = await deps.zabbixClient.createHostGroup(hostGroupName);

  log(`[2/5] 通知用Zabbixユーザー作成: notify_${input.customerCode}`);
  const zabbixUserId = await deps.zabbixClient.createNotificationUser(
    `notify_${input.customerCode}`,
    deps.notificationUsrgrpId,
  );

  log(`[3/5] 顧客専用アクション作成: ${input.customerCode}_alert`);
  const zabbixActionId = await deps.zabbixClient.createAction(
    `${input.customerCode}_alert`,
    [hostGroupId],
    zabbixUserId,
  );

  log('[4/5] DBにレコード登録');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await deps.authService.hashPassword(temporaryPassword);
  const customerId = await deps.customerRepo.insertCustomer({
    customerCode: input.customerCode,
    companyName: input.companyName,
    email: input.email,
    passwordHash,
    zabbixUserId,
    zabbixActionId,
    zabbixProxyId: input.proxyId,
  });
  await deps.customerRepo.insertHostgroup(customerId, hostGroupId, hostGroupName);

  log('[5/5] 初期パスワード通知メール送信');
  const loginUrl = `${new URL(deps.passwordResetUrlBase).origin}/login.html`;
  await deps.mailer.sendWelcomeEmail(input.email, input.companyName, temporaryPassword, loginUrl);

  return {
    customerId,
    customerCode: input.customerCode,
    companyName: input.companyName,
    zabbixUserId,
    zabbixActionId,
    hostGroupId,
    hostGroupName,
  };
}
