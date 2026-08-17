/**
 * cost_estimation配下のCSV取込スクリプト（import_market_rates.ts・import_market_baseline.ts）が
 * 共有する最小限のCSVパーサー。RFC4180風（ダブルクォート囲み・""エスケープ）に対応。
 */

/** 1行をフィールド配列に分解する。 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** ファイル全体を改行分割し、末尾の空行（トレーリング改行由来）だけを除く。 */
export function splitCsvLines(raw: string): string[] {
  return raw.split(/\r\n|\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
}

export function parseNumber(raw: string, lineNo: number, fieldName: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || Number.isNaN(n)) {
    throw new Error(`${lineNo}行目: ${fieldName} が数値として不正です（値: "${raw}"）`);
  }
  return n;
}

/** CSV出力用に1フィールドをエスケープする。カンマ・ダブルクォート・改行を含む場合のみ引用符で囲む。 */
export function formatCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
