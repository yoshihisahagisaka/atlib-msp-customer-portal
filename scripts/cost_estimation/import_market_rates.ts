import * as fs from 'fs';
import { loadConfig } from '../../src/config';
import { createPool } from '../../src/db/pool';
import { MarketRateRepo, type MarketRateInput } from '../../src/services/marketRateRepo';
import type { EstimateCategory } from '../../src/domain/costEstimation';
import { parseCsvLine, parseNumber, splitCsvLines } from './csvUtil';

/**
 * 相場マスタ（market_rates）のCSV一括取込スクリプト。
 * 過去見積もり資料（Excel等）から本スクリプトが読める固定フォーマットのCSVへ整える作業は
 * スタッフ側で行う前提（任意のExcel書式を自動解析するパーサーは作らない＝コスト見合いの判断）。
 *
 * 使い方:
 *   npm run import:market-rates -- path/to/rates.csv
 *
 * CSV列（ヘッダ行必須、この順序固定）:
 *   category,item_name,unit,price_low,price_high,price_recommended,source_note
 *   - category は network/server/kitting/dev/other のいずれか
 *   - price_recommended, source_note は空欄可
 *   - 外部市場調査ベースライン（market_baseline_*・market_research_source・adjustment_coefficient）は
 *     CSV一括取込の対象外（手動入力方針のため）。取り込んだ行は常にnullで、必要な行は管理画面の
 *     編集フォームから個別に補記する。
 *
 * (category, item_name, unit) の組でON CONFLICT DO UPDATEするため、再実行しても安全。
 * 不正な行が1件でもあれば、実データ投入前に行番号付きエラーで中断する（部分投入しない）。
 */

const EXPECTED_HEADER = ['category', 'item_name', 'unit', 'price_low', 'price_high', 'price_recommended', 'source_note'];
const VALID_CATEGORIES: EstimateCategory[] = ['network', 'server', 'kitting', 'dev', 'other'];

function parseRow(fields: string[], lineNo: number): MarketRateInput {
  if (fields.length !== EXPECTED_HEADER.length) {
    throw new Error(`${lineNo}行目: 列数が想定と異なります（${EXPECTED_HEADER.length}列必要、実際は${fields.length}列）`);
  }
  // fields.lengthは直前のチェックで7であることを確認済みだが、tsconfigのnoUncheckedIndexedAccess
  // により配列添字アクセスの型はstring|undefinedになるため、?? ''で明示的に解消する。
  const category = fields[0] ?? '';
  const itemName = fields[1] ?? '';
  const unit = fields[2] ?? '';
  const priceLowRaw = fields[3] ?? '';
  const priceHighRaw = fields[4] ?? '';
  const priceRecommendedRaw = fields[5] ?? '';
  const sourceNoteRaw = fields[6] ?? '';

  if (!VALID_CATEGORIES.includes(category as EstimateCategory)) {
    throw new Error(`${lineNo}行目: category が不正です（値: "${category}"、有効値: ${VALID_CATEGORIES.join('/')}）`);
  }
  if (!itemName.trim()) {
    throw new Error(`${lineNo}行目: item_name が空です`);
  }
  if (!unit.trim()) {
    throw new Error(`${lineNo}行目: unit が空です`);
  }

  const priceLow = parseNumber(priceLowRaw, lineNo, 'price_low');
  const priceHigh = parseNumber(priceHighRaw, lineNo, 'price_high');
  if (priceHigh < priceLow) {
    throw new Error(`${lineNo}行目: price_high(${priceHigh})がprice_low(${priceLow})を下回っています`);
  }

  const priceRecommended = priceRecommendedRaw.trim() === '' ? null : parseNumber(priceRecommendedRaw, lineNo, 'price_recommended');
  if (priceRecommended !== null && (priceRecommended < priceLow || priceRecommended > priceHigh)) {
    throw new Error(`${lineNo}行目: price_recommended(${priceRecommended})がprice_low〜price_highの範囲外です`);
  }

  return {
    category: category as EstimateCategory,
    itemName: itemName.trim(),
    unit: unit.trim(),
    priceLow,
    priceHigh,
    priceRecommended,
    sourceNote: sourceNoteRaw.trim() === '' ? null : sourceNoteRaw.trim(),
    marketBaselineLow: null,
    marketBaselineHigh: null,
    marketBaselineRecommended: null,
    marketResearchSource: null,
    adjustmentCoefficient: null,
  };
}

function parseCsvFile(filePath: string): MarketRateInput[] {
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

  const rows: MarketRateInput[] = [];
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
    throw new Error('Usage: npm run import:market-rates -- path/to/rates.csv');
  }

  console.log(`CSVを検証中: ${filePath}`);
  const rows = parseCsvFile(filePath);
  console.log(`検証OK: ${rows.length}件`);

  const config = await loadConfig();
  const pool = createPool(config);
  const repo = new MarketRateRepo(pool);

  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const result = await repo.upsertFromImport(row);
    if (result.created) created += 1;
    else updated += 1;
  }

  console.log('');
  console.log('=== 取込完了 ===');
  console.log(`新規登録: ${created}件 / 更新: ${updated}件`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
