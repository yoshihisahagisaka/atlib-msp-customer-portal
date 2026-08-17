import * as fs from 'fs';
import { loadConfig } from '../../src/config';
import { createPool } from '../../src/db/pool';
import { MarketRateRepo } from '../../src/services/marketRateRepo';
import type { EstimateCategory } from '../../src/domain/costEstimation';
import { parseCsvLine, parseNumber, splitCsvLines } from './csvUtil';

/**
 * 外部市場調査ベースライン（market_baseline_low/high/recommended・market_research_source）の
 * CSV一括取込スクリプト。export_catalog_for_research.tsで書き出した品目リストを外部調査
 * （Genspark等）にかけた結果を取り込む想定。
 *
 * 使い方:
 *   npm run import:market-baseline -- path/to/research.csv
 *
 * CSV列（ヘッダ行必須、この順序固定）:
 *   category,item_name,unit,market_baseline_low,market_baseline_high,market_baseline_recommended,market_research_source
 *   - category は network/server/kitting/dev/other のいずれか
 *   - market_baseline_recommended, market_research_source は空欄可
 *   - adjustment_coefficient（当社調整係数）はこのスクリプトの対象外。従来通り管理画面から個別入力する。
 *
 * (category, item_name, unit) が相場マスタに存在しない行はエラーにせずスキップする
 * （調査対象がまだカタログに無い新規品目である場合を想定。存在しない分は管理画面から手動で埋める）。
 * CSVの構造・値そのものが不正な行が1件でもあれば、実データ投入前に行番号付きエラーで中断する（部分投入しない）。
 */

const EXPECTED_HEADER = [
  'category',
  'item_name',
  'unit',
  'market_baseline_low',
  'market_baseline_high',
  'market_baseline_recommended',
  'market_research_source',
];
const VALID_CATEGORIES: EstimateCategory[] = ['network', 'server', 'kitting', 'dev', 'other'];

interface BaselineImportRow {
  category: EstimateCategory;
  itemName: string;
  unit: string;
  marketBaselineLow: number;
  marketBaselineHigh: number;
  marketBaselineRecommended: number | null;
  marketResearchSource: string | null;
}

function parseRow(fields: string[], lineNo: number): BaselineImportRow {
  if (fields.length !== EXPECTED_HEADER.length) {
    throw new Error(`${lineNo}行目: 列数が想定と異なります（${EXPECTED_HEADER.length}列必要、実際は${fields.length}列）`);
  }
  const category = fields[0] ?? '';
  const itemName = fields[1] ?? '';
  const unit = fields[2] ?? '';
  const baselineLowRaw = fields[3] ?? '';
  const baselineHighRaw = fields[4] ?? '';
  const baselineRecommendedRaw = fields[5] ?? '';
  const researchSourceRaw = fields[6] ?? '';

  if (!VALID_CATEGORIES.includes(category as EstimateCategory)) {
    throw new Error(`${lineNo}行目: category が不正です（値: "${category}"、有効値: ${VALID_CATEGORIES.join('/')}）`);
  }
  if (!itemName.trim()) {
    throw new Error(`${lineNo}行目: item_name が空です`);
  }
  if (!unit.trim()) {
    throw new Error(`${lineNo}行目: unit が空です`);
  }

  const marketBaselineLow = parseNumber(baselineLowRaw, lineNo, 'market_baseline_low');
  const marketBaselineHigh = parseNumber(baselineHighRaw, lineNo, 'market_baseline_high');
  if (marketBaselineHigh < marketBaselineLow) {
    throw new Error(`${lineNo}行目: market_baseline_high(${marketBaselineHigh})がmarket_baseline_low(${marketBaselineLow})を下回っています`);
  }

  const marketBaselineRecommended =
    baselineRecommendedRaw.trim() === '' ? null : parseNumber(baselineRecommendedRaw, lineNo, 'market_baseline_recommended');
  if (
    marketBaselineRecommended !== null &&
    (marketBaselineRecommended < marketBaselineLow || marketBaselineRecommended > marketBaselineHigh)
  ) {
    throw new Error(
      `${lineNo}行目: market_baseline_recommended(${marketBaselineRecommended})がmarket_baseline_low〜market_baseline_highの範囲外です`,
    );
  }

  return {
    category: category as EstimateCategory,
    itemName: itemName.trim(),
    unit: unit.trim(),
    marketBaselineLow,
    marketBaselineHigh,
    marketBaselineRecommended,
    marketResearchSource: researchSourceRaw.trim() === '' ? null : researchSourceRaw.trim(),
  };
}

function parseCsvFile(filePath: string): BaselineImportRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = splitCsvLines(raw);
  if (lines.length === 0) {
    throw new Error('CSVファイルが空です');
  }

  const header = parseCsvLine(lines[0] ?? '').map((h) => h.trim());
  if (header.length !== EXPECTED_HEADER.length || header.some((h, i) => h !== EXPECTED_HEADER[i])) {
    throw new Error(
      `1行目: ヘッダ列が想定と異なります。期待: ${EXPECTED_HEADER.join(',')} / 実際: ${header.join(',')}`,
    );
  }

  const rows: BaselineImportRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    rows.push(parseRow(parseCsvLine(line), lineNo));
  }
  return rows;
}

async function run(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error('Usage: npm run import:market-baseline -- path/to/research.csv');
  }

  console.log(`CSVを検証中: ${filePath}`);
  const rows = parseCsvFile(filePath);
  console.log(`検証OK: ${rows.length}件`);

  const config = await loadConfig();
  const pool = createPool(config);
  const repo = new MarketRateRepo(pool);

  let updated = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    const matched = await repo.updateBaselineByKey(
      { category: row.category, itemName: row.itemName, unit: row.unit },
      {
        marketBaselineLow: row.marketBaselineLow,
        marketBaselineHigh: row.marketBaselineHigh,
        marketBaselineRecommended: row.marketBaselineRecommended,
        marketResearchSource: row.marketResearchSource,
      },
    );
    if (matched) updated += 1;
    else skipped.push(`${row.category}/${row.itemName}/${row.unit}`);
  }

  console.log('');
  console.log('=== 取込完了 ===');
  console.log(`更新: ${updated}件 / スキップ（相場マスタ未登録）: ${skipped.length}件`);
  if (skipped.length > 0) {
    console.log('スキップした品目（先に管理画面等でカタログへ登録が必要）:');
    for (const s of skipped) console.log(`  - ${s}`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
