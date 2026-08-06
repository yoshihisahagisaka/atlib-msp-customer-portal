import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { MarketRateRepo } from './marketRateRepo';
import type { EstimatePreconditionRepo } from './estimatePreconditionRepo';
import type { EstimateCategory } from '../domain/costEstimation';

export class AiAssistNotConfiguredError extends Error {
  constructor() {
    super('AI assist is not configured (ANTHROPIC_API_KEY missing)');
    this.name = 'AiAssistNotConfiguredError';
  }
}

const proposedLineItemSchema = z.object({
  itemName: z.string(),
  costType: z.enum(['fixed', 'variable']),
  unit: z.string(),
  quantity: z.number(),
  unitCost: z.number(),
  marketRateId: z.string().nullable(),
  rationale: z.string(),
});

const preconditionSuggestionSchema = z.object({
  preconditionId: z.string().nullable(),
  label: z.string(),
  isAdHoc: z.boolean(),
  draftText: z.string(),
});

const aiAssistProposalSchema = z.object({
  summary: z.string(),
  proposedLineItems: z.array(proposedLineItemSchema),
  preconditionSuggestions: z.array(preconditionSuggestionSchema),
});

export type AiAssistProposal = z.infer<typeof aiAssistProposalSchema>;

// @anthropic-ai/sdkのzodOutputFormatヘルパーはzod v4系のスキーマを要求するが、本リポジトリは
// zod v3系(^3.23.8)を全ルートで使っている（既存コードとの整合を優先し、AI機能のためだけに
// zodのメジャーバージョンを上げない）。そのため構造化出力はoutput_config.formatへ生のJSON Schemaを
// 渡す方式にし、返ってきたJSONはaiAssistProposalSchema（zod v3）でランタイム検証する。
const AI_ASSIST_PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    proposedLineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemName: { type: 'string' },
          costType: { type: 'string', enum: ['fixed', 'variable'] },
          unit: { type: 'string' },
          quantity: { type: 'number' },
          unitCost: { type: 'number' },
          marketRateId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          rationale: { type: 'string' },
        },
        required: ['itemName', 'costType', 'unit', 'quantity', 'unitCost', 'marketRateId', 'rationale'],
        additionalProperties: false,
      },
    },
    preconditionSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          preconditionId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          label: { type: 'string' },
          isAdHoc: { type: 'boolean' },
          draftText: { type: 'string' },
        },
        required: ['preconditionId', 'label', 'isAdHoc', 'draftText'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'proposedLineItems', 'preconditionSuggestions'],
  additionalProperties: false,
} as const;

export interface AiAssistRequest {
  category: EstimateCategory;
  requirementsText: string;
  referenceDocumentBase64?: string;
}

const CATEGORY_LABELS: Record<EstimateCategory, string> = {
  network: 'ネットワーク構築',
  server: 'サーバー構築',
  kitting: 'PCキッティング',
  dev: 'システム開発',
  other: 'その他',
};

const SYSTEM_PROMPT = [
  'あなたはIT関連（ネットワーク構築・サーバー構築・PCキッティング・システム開発）の見積もり作成を支援するアシスタントです。',
  'スタッフが最終的に確認・編集する下書きを作ることが役割であり、金額や条件を決定する立場ではありません。',
  '出力は必ず「〜と推定されます」「〜を想定した場合の目安」のようなヘッジ表現を使い、断定は避けてください。',
  '費用項目の単価（unitCost）は、提示する相場マスタのprice_low〜price_highの範囲内に収めることを原則とします。',
  '該当する相場マスタがない場合はmarketRateIdをnullにし、rationaleに「相場マスタに該当なし、参考値」である旨を明記してください。',
  '前提条件は、まず提示する前提条件マスタとの一致を優先して提案し（preconditionIdを設定、isAdHoc:false）、',
  '該当がない場合のみその場入力として提案してください（preconditionIdはnull、isAdHoc:true）。',
  'すべての出力は日本語で記述してください。',
].join('\n');

type UserContentBlock =
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
  | { type: 'text'; text: string };

/**
 * Claude API（claude-sonnet-5）による見積もり提案支援。本リポジトリ初のLLM外部API連携。
 * すべての提案は下書きであり、スタッフが選別してestimate-detail.html上で反映するまで
 * 見積データには一切書き込まれない（この service はDBへの書き込みを一切行わない）。
 */
export class AiAssistService {
  private readonly client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    private readonly marketRateRepo: MarketRateRepo,
    private readonly estimatePreconditionRepo: EstimatePreconditionRepo,
  ) {
    this.client = apiKey ? new Anthropic({ apiKey, timeout: 60_000 }) : null;
  }

  async proposeEstimateAssist(input: AiAssistRequest): Promise<AiAssistProposal> {
    if (!this.client) throw new AiAssistNotConfiguredError();

    const [marketRates, preconditions] = await Promise.all([
      this.marketRateRepo.list({ category: input.category }),
      this.estimatePreconditionRepo.list({ category: input.category }),
    ]);

    const marketRateTable =
      marketRates.length > 0
        ? marketRates
            .map((mr) => `${mr.id}|${mr.itemName}|${mr.unit}|下限${mr.priceLow}|推奨${mr.priceRecommended ?? '-'}|上限${mr.priceHigh}`)
            .join('\n')
        : '(このカテゴリに登録された相場マスタはありません)';

    const preconditionTable =
      preconditions.length > 0
        ? preconditions.map((pc) => `${pc.id}|${pc.label}`).join('\n')
        : '(このカテゴリに登録された前提条件マスタはありません)';

    const userText = [
      `案件区分: ${CATEGORY_LABELS[input.category]}`,
      '',
      '相場マスタ（id|品目名|単位|下限|推奨|上限）:',
      marketRateTable,
      '',
      '前提条件マスタ（id|内容）:',
      preconditionTable,
      '',
      '案件の要件・前提:',
      input.requirementsText,
    ].join('\n');

    const content: UserContentBlock[] = [];
    if (input.referenceDocumentBase64) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: input.referenceDocumentBase64 },
      });
    }
    content.push({ type: 'text', text: userText });

    const response = await this.client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: AI_ASSIST_PROPOSAL_JSON_SCHEMA },
      },
      messages: [{ role: 'user', content }],
    });

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    if (!textBlock) {
      throw new Error('AiAssistService: no text block in Claude response');
    }

    const parsed = aiAssistProposalSchema.safeParse(JSON.parse(textBlock.text));
    if (!parsed.success) {
      throw new Error(`AiAssistService: response did not match expected schema: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
