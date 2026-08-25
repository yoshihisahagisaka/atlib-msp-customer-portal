import { Router } from 'express';
import { z } from 'zod';
import type { CustomerRepo } from '../services/customerRepo';
import type { ZabbixClient } from '../services/zabbixClient';
import type { Config } from '../config';
import type { MonthlyReportRepo, MonthlyReportStatus } from '../services/monthlyReportRepo';
import type { ReportStorage } from '../services/reportStorage';
import type { Mailer } from '../services/mailer';

const STATUS_VALUES: MonthlyReportStatus[] = ['draft', 'approved', 'sent', 'failed'];

const listQuerySchema = z.object({
  status: z.enum(['draft', 'approved', 'sent', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const approveSchema = z.object({
  approvedBy: z.string().min(1).optional(),
});

/** requireStaffAuthの配下でマウントされる前提(server.ts側で適用)。 */
export function createAdminMonthlyReportsRouter(
  monthlyReportRepo: MonthlyReportRepo,
  customerRepo: CustomerRepo,
  zabbixClient: ZabbixClient,
  zabbixConfig: Config['zabbix'],
  reportStorage: ReportStorage,
  mailer: Mailer,
  monthlyReportFromEmail: string,
): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    // 承認画面のデフォルト用途は「承認待ちを一覧する」ことなので、statusを省略した場合はdraftを既定にする。
    const status = parsed.data.status ?? 'draft';
    const { items, total } = await monthlyReportRepo.listByStatus(status, {
      limit: parsed.data.limit ?? 100,
      offset: parsed.data.offset ?? 0,
    });
    res.json({ items, total, statusOptions: STATUS_VALUES });
  });

  router.get('/:id', async (req, res) => {
    const report = await monthlyReportRepo.findById(req.params.id);
    if (!report) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(report);
  });

  router.get('/:id/download', async (req, res) => {
    const report = await monthlyReportRepo.findById(req.params.id);
    if (!report || !report.filePath) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const buffer = await reportStorage.downloadReport(report.filePath);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.set('Content-Disposition', `attachment; filename="${report.customerCode}_${report.reportPeriod}.pptx"`);
    res.send(buffer);
  });

  // ブラウザ確認用のプレビューPDF(ダウンロードさせず<iframe>等でインライン表示させる想定)。
  router.get('/:id/preview.pdf', async (req, res) => {
    const report = await monthlyReportRepo.findById(req.params.id);
    if (!report || !report.filePath) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const buffer = await reportStorage.downloadReportPdf(report.filePath);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${report.customerCode}_${report.reportPeriod}.pdf"`);
      res.send(buffer);
    } catch {
      res.status(404).json({ error: 'PDF not found (古いレポートはPDF未生成の可能性があります)' });
    }
  });

  router.post('/:id/approve', async (req, res) => {
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const report = await monthlyReportRepo.findById(req.params.id);
    if (!report || !report.filePath) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const customer = await customerRepo.findByCustomerCode(report.customerCode);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    await monthlyReportRepo.markApproved(report.id, parsed.data.approvedBy ?? 'staff');

    try {
      const zabbixUserId = await customerRepo.getZabbixUserId(customer.id);
      const medias = await zabbixClient.getUserMedias(zabbixUserId);
      const emailMedia = medias.find((m) => m.mediatypeid === zabbixConfig.mediaTypeEmailId);
      if (!emailMedia) throw new Error('通知先メールアドレスが未設定です');
      const to = (Array.isArray(emailMedia.sendto) ? emailMedia.sendto : [emailMedia.sendto]).join(',');

      const buffer = await reportStorage.downloadReport(report.filePath);
      await mailer.sendMonthlyReportEmail(
        to,
        monthlyReportFromEmail,
        { companyName: customer.companyName, reportPeriod: report.reportPeriod },
        buffer,
      );
      await monthlyReportRepo.markSent(report.id);
      res.json({ status: 'sent' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await monthlyReportRepo.markSendFailed(report.id, message);
      res.status(502).json({ error: 'approved_but_send_failed', details: message });
    }
  });

  return router;
}
