import * as fs from 'fs';
import { loadConfig } from '../../src/config';
import { createPool } from '../../src/db/pool';
import { MarketRateRepo } from '../../src/services/marketRateRepo';
import { formatCsvField } from './csvUtil';

/**
 * 相場マスタ（market_rates）の品目カタログをCSVに書き出す。外部調査（Genspark等）に
 * 調査対象リストとして渡すためのもので、import_market_baseline.tsとは対の関係にある。
 *
 * 使い方:
 *   npm run export:catalog-for-research -- path/to/output.csv [--missing-only]
 *   --missing-only を付けると、まだ外部相場ベースライン（market_baseline_recommended）が
 *   未設定の品目のみに絞る。
 *
 * 出力列: category,item_name,unit,existing_market_baseline_recommended
 * 社内の実効価格帯（price_low/high/recommended）は意図的に含めない。外部調査に社内の
 * 安値を見せてしまうと、それに引っ張られた調査結果を誘発しかねないため。
 */

const HEADER = ['category', 'item_name', 'unit', 'existing_market_baseline_recommended'];

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith('--'));
  const missingOnly = args.includes('--missing-only');
  if (!filePath) {
    throw new Error('Usage: npm run export:catalog-for-research -- path/to/output.csv [--missing-only]');
  }

  const config = await loadConfig();
  const pool = createPool(config);
  const repo = new MarketRateRepo(pool);

  const rates = await repo.list({ includeInactive: false });
  const targets = missingOnly ? rates.filter((r) => r.marketBaselineRecommended === null) : rates;

  const lines = [HEADER.join(',')];
  for (const rate of targets) {
    lines.push(
      [
        formatCsvField(rate.category),
        formatCsvField(rate.itemName),
        formatCsvField(rate.unit),
        rate.marketBaselineRecommended !== null ? String(rate.marketBaselineRecommended) : '',
      ].join(','),
    );
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

  console.log(`書き出し完了: ${filePath}`);
  console.log(`件数: ${targets.length}件${missingOnly ? '（外部ベースライン未設定のみ）' : `（全${rates.length}件）`}`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
