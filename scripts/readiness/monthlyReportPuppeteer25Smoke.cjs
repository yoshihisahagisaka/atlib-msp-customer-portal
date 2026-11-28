'use strict';

// Offline browser compatibility smoke for the existing monthly-report batch.
// No DB, IAP, Zabbix, Cloud Storage, SMTP, Slack, or external network.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    try {
      const html = [
        '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
        '<style>body{font-family:"Noto Sans CJK JP",sans-serif}.slide{page-break-after:always}@media print{.admin-panel{display:none}}</style>',
        '</head><body><section class="slide">',
        '<h1>月次レポート・合成検証</h1>',
        '<div class="admin-panel">印刷時非表示</div>',
        '<select id="target-group"><option value="">選択</option><option value="synthetic-group">合成</option></select>',
        '<select id="target-year"><option value="2026">2026</option></select>',
        '<select id="target-month"><option value="11">11</option></select>',
        '<select id="wan-if-in"><option value="synthetic-in">受信</option></select>',
        '<select id="wan-if-out"><option value="synthetic-out">送信</option></select>',
        '<div id="operations"></div>',
        '<script>',
        'window.loadHostsInGroup=()=>{document.body.dataset.groupLoaded="yes"};',
        'window.refreshReportData=()=>{document.body.dataset.reportRefreshed="yes"};',
        'window.onWanIfChange=()=>{document.body.dataset.wanUpdated="yes"};',
        'window.applyOpsHistoryEntries=entries=>{document.querySelector("#operations").textContent=entries[0].description};',
        '/* Only the call signature is tested; real Zabbix PPTX export is external. */',
        'window.exportToPPTX=({returnBase64})=>returnBase64?btoa("synthetic-pptx-contract-only"):"";',
        '</script></section></body></html>',
      ].join('');
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.waitForFunction(
        () => document.querySelectorAll('#target-group option').length > 1,
        { timeout: 30000 },
      );
      assert.deepEqual(await page.select('#target-group', 'synthetic-group'), ['synthetic-group']);
      await page.evaluate(() => window.loadHostsInGroup());
      await page.select('#target-year', '2026');
      await page.select('#target-month', '11');
      await page.evaluate(() => window.refreshReportData());
      await page.select('#wan-if-in', 'synthetic-in');
      await page.select('#wan-if-out', 'synthetic-out');
      await page.evaluate(() => window.onWanIfChange());
      await page.evaluate(entries => window.applyOpsHistoryEntries(entries),
        [{ description: '問い合わせ対応・合成データ' }]);
      assert.equal(await page.$eval('#operations', el => el.textContent),
        '問い合わせ対応・合成データ');

      const pdf = await page.pdf({
        width: '10in',
        height: '5.625in',
        printBackground: true,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      assert.equal(Buffer.from(pdf).subarray(0, 5).toString('ascii'), '%PDF-');
      assert.ok(pdf.byteLength > 1000, 'PDF unexpectedly small');

      const base64 = await page.evaluate(
        () => window.exportToPPTX({ returnBase64: true }));
      assert.equal(Buffer.from(base64, 'base64').toString('utf8'),
        'synthetic-pptx-contract-only');
      const flags = await page.evaluate(() => ({
        loaded: document.body.dataset.groupLoaded,
        refreshed: document.body.dataset.reportRefreshed,
        wan: document.body.dataset.wanUpdated,
      }));
      assert.deepEqual(flags, { loaded: 'yes', refreshed: 'yes', wan: 'yes' });
      console.log('MONTHLY_REPORT_PUPPETEER25_OFFLINE_BROWSER_SMOKE=PASS');
      console.log('NODE=' + process.version + ' PUPPETEER=' +
        require('puppeteer/package.json').version + ' PDF_BYTES=' + pdf.byteLength);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('MONTHLY_REPORT_PUPPETEER25_OFFLINE_BROWSER_SMOKE=STOP', err);
  process.exitCode = 1;
});
