import puppeteer from 'puppeteer';
import { GoogleAuth } from 'google-auth-library';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { CustomerRepo } from '../src/services/customerRepo';
import { OpsHistoryRepo } from '../src/services/opsHistoryRepo';
import { ReportSettingsRepo } from '../src/services/reportSettingsRepo';
import { MonthlyReportRepo } from '../src/services/monthlyReportRepo';
import { ReportStorage } from '../src/services/reportStorage';
import { Mailer } from '../src/services/mailer';

const REPORT_URL = 'https://topology.zabbix.atlib.jp/atlib_monthly_report.html';

/**
 * 対象レポート期間('YYYY-MM')を決定する。
 * 毎月1日に実行し、前月分を報告する運用のため既定は「実行月の前月」。
 * テスト実行時はMONTHLY_REPORT_PERIOD_OVERRIDEで任意の月を指定できる。
 */
function resolveReportPeriod(): { year: number; month: number; label: string } {
  const override = process.env.MONTHLY_REPORT_PERIOD_OVERRIDE;
  if (override) {
    const [y, m] = override.split('-').map(Number);
    if (!y || !m) throw new Error(`Invalid MONTHLY_REPORT_PERIOD_OVERRIDE: ${override}`);
    return { year: y, month: m, label: override };
  }
  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = prevMonthDate.getFullYear();
  const month = prevMonthDate.getMonth() + 1;
  return { year, month, label: `${year}-${String(month).padStart(2, '0')}` };
}

/**
 * IAP(Identity-Aware Proxy)保護下のtopology.zabbix.atlib.jpへアクセスするための
 * OIDC IDトークンを取得する。audienceはIAP OAuthクライアントID(msp-iap-client)。
 * Cloud Run実行時はメタデータサーバー経由でこのJobのサービスアカウントから自動解決される。
 */
async function getIapIdToken(clientId: string): Promise<string> {
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(clientId);
  const headers = await client.getRequestHeaders();
  const authHeader = headers['Authorization'] ?? headers['authorization'];
  if (!authHeader) throw new Error('Failed to obtain IAP ID token');
  return authHeader.replace(/^Bearer /, '');
}

interface OpsHistoryEntryForPage {
  occurredAt: string;
  category: string;
  description: string | null;
  operator: string;
  minutesSpent: number;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const iapClientId = required('IAP_CLIENT_ID', process.env.IAP_CLIENT_ID);
  const testCustomerCode = process.env.MONTHLY_REPORT_TEST_CUSTOMER_CODE;

  const pool = createPool(config);
  const customerRepo = new CustomerRepo(pool);
  const opsHistoryRepo = new OpsHistoryRepo(pool);
  const reportSettingsRepo = new ReportSettingsRepo(pool);
  const monthlyReportRepo = new MonthlyReportRepo(pool);
  const reportStorage = new ReportStorage(config.monthlyReport.storageBucket);
  const mailer = new Mailer(config.smtp);

  const period = resolveReportPeriod();
  console.log(`月次レポート生成バッチ開始: 対象期間=${period.label}`);

  const allCustomers = testCustomerCode
    ? (await customerRepo.findAllActive()).filter((c) => c.customerCode === testCustomerCode)
    : await customerRepo.findAllActive();
  console.log(`対象顧客: ${allCustomers.length}件`);

  const idToken = await getIapIdToken(iapClientId);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let draftCount = 0;
  let failedCount = 0;

  try {
    for (const customer of allCustomers) {
      console.log(`[${customer.customerCode}] 生成開始`);
      const page = await browser.newPage();
      try {
        const groupIds = await customerRepo.resolveHostgroupIds(customer.id);
        if (groupIds.length === 0) {
          throw new Error('Zabbixホストグループが未設定です');
        }
        if (groupIds.length > 1) {
          console.warn(`[${customer.customerCode}] ホストグループが複数件あるため先頭を使用: ${groupIds.join(',')}`);
        }
        const groupId = groupIds[0]!;

        const [opsHistory, reportSettings] = await Promise.all([
          opsHistoryRepo.listByCustomerAndPeriod(customer.customerCode, period.label),
          reportSettingsRepo.findByCustomerCode(customer.customerCode),
        ]);
        const opsHistoryForPage: OpsHistoryEntryForPage[] = opsHistory.map((e) => ({
          occurredAt: e.occurredAt,
          category: e.category,
          description: e.description,
          operator: e.operator,
          minutesSpent: e.minutesSpent,
        }));

        await page.setExtraHTTPHeaders({ Authorization: `Bearer ${idToken}` });
        await page.goto(REPORT_URL, { waitUntil: 'networkidle0' });
        await page.waitForFunction(
          () => document.querySelectorAll('#target-group option').length > 1,
          { timeout: 30000 },
        );

        await page.select('#target-group', groupId);
        await page.evaluate(() => (window as any).loadHostsInGroup());
        await page.select('#target-year', String(period.year));
        await page.select('#target-month', String(period.month).padStart(2, '0'));
        await page.evaluate(() => (window as any).refreshReportData());

        if (reportSettings?.wanIfIn) await page.select('#wan-if-in', reportSettings.wanIfIn);
        if (reportSettings?.wanIfOut) await page.select('#wan-if-out', reportSettings.wanIfOut);
        if (reportSettings?.wanIfIn || reportSettings?.wanIfOut) {
          await page.evaluate(() => (window as any).onWanIfChange());
        }

        await page.evaluate((entries) => (window as any).applyOpsHistoryEntries(entries), opsHistoryForPage);

        const base64 = await page.evaluate(() => (window as any).exportToPPTX({ returnBase64: true }));
        if (typeof base64 !== 'string' || base64.length === 0) {
          throw new Error('PPTX生成結果が空でした');
        }

        const filePath = await reportStorage.uploadReport(customer.customerCode, period.label, base64);
        await monthlyReportRepo.upsertDraft(customer.customerCode, period.label, { filePath });
        draftCount += 1;
        console.log(`[${customer.customerCode}] 生成完了: ${filePath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${customer.customerCode}] 生成失敗: ${message}`);
        await monthlyReportRepo.markFailed(customer.customerCode, period.label, message);
        failedCount += 1;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`月次レポート生成バッチ完了: draft=${draftCount}, failed=${failedCount}`);

  if (draftCount + failedCount > 0) {
    await mailer.sendMonthlyReportBatchSummary(config.monthlyReport.staffNotifyEmail, draftCount, failedCount);
  }

  await pool.end();
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

main().catch((err) => {
  console.error('Fatal batch error:', err);
  process.exit(1);
});
