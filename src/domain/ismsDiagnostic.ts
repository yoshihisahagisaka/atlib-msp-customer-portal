import { z } from 'zod';

/**
 * ISMS支援プラン診断フォームの質問・配点・しきい値を1箇所に集約したモジュール。
 * 元は「【atLIB】ISMS支援プラン診断シート」(xlsx)の点数マスタ+質問シートを移植したもの。
 * 質問を追加・変更する場合はこのファイルのみを編集すればよく、ルート層・DBスキーマの変更は不要
 * （回答はJSONBで保存され、スコア計算もこのモジュールの設定のみに依存するため）。
 *
 * 質問文言・配点（X/Yカテゴリ、Q1-Q7）はxlsxの点数マスタと完全一致させている。xlsx側は
 * 質問側の選択肢文言と点数マスタ側の文言が完全一致しないとXLOOKUPが無言でブランクを返す脆さが
 * あったが、ここでは選択肢と配点を1つのオブジェクトで持つため同種の不整合は起こり得ない。
 */
export const QUESTION_SET_VERSION = 'v1'; // 質問・選択肢・しきい値を変更したら手動でインクリメントする

export type QuestionType = 'single-choice' | 'text';

export interface QuestionOption {
  value: string;
  label: string;
  /** 採点対象の質問（scored: true）のみ持つ。プロフィール質問は score を持たない。 */
  score?: number;
  /**
   * 顧客向けレポートの「対策」セクションに使う定性的な一言（v1ドラフト、営業観点でのレビュー・修正を想定）。
   * 配点1・2（弱点）の選択肢のみ持つ。配点3（最上位）は課題なしのため持たない。
   */
  actionHint?: string;
}

export interface Question {
  id: string;
  categoryId: string;
  prompt: string;
  type: QuestionType;
  required: boolean;
  /** false の場合、価格判定ロジック（カテゴリしきい値）には一切使われないプロフィール/リード情報質問。 */
  scored: boolean;
  options?: QuestionOption[];
}

export interface CategoryThreshold {
  min: number;
  max: number;
  planCode: string;
  label: string;
  recommended?: boolean;
  /** 実質負担額（IT導入補助金1/2採択時、年額・税抜）。 */
  priceJpy?: number;
  /** パッケージ総費用（補助金適用前、年額・税抜）。priceJpyのちょうど2倍（＝1/2補助）。 */
  packagePriceJpy?: number;
}

export interface Category {
  id: string;
  label: string;
  scored: boolean;
  thresholds?: CategoryThreshold[];
}

export const CATEGORIES: Category[] = [
  {
    id: 'X',
    label: 'ISMS推進リソース・知識（コンサルプランの判定）',
    scored: true,
    thresholds: [
      {
        min: 11,
        max: 12,
        planCode: 'light',
        label: '自走（ライト）プラン',
        priceJpy: 570000,
        packagePriceJpy: 1140000,
      },
      {
        min: 7,
        max: 10,
        planCode: 'standard',
        label: '伴走（スタンダード）プラン',
        recommended: true,
        priceJpy: 900000,
        packagePriceJpy: 1800000,
      },
      {
        min: 4,
        max: 6,
        planCode: 'premium',
        label: '徹底伴走（プレミアム）プラン',
        priceJpy: 1230000,
        packagePriceJpy: 2460000,
      },
    ],
  },
  {
    id: 'Y',
    label: 'ITインフラ実作業力（環境整備・別発注の判定）',
    scored: true,
    thresholds: [
      { min: 8, max: 9, planCode: 'outsourcing-not-needed', label: 'インフラ実作業の別発注は不要' },
      {
        min: 3,
        max: 7,
        planCode: 'outsourcing-recommended',
        label: 'ITインフラ最適化ソリューション（別発注）の併用を推奨',
      },
    ],
  },
  {
    id: 'profile',
    label: '組織・予算・スケジュール',
    scored: false,
  },
];

export const QUESTIONS: Question[] = [
  // --- カテゴリX（xlsx Q1-Q4、文言・配点はxlsxと同一） ---
  {
    id: 'x1',
    categoryId: 'X',
    prompt: 'Q1. プロジェクトの推進体制（人）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      { value: 'x1-a', label: 'ISMS/SCS評価対応の専任、または主担当として動けるメンバーが社内にいる', score: 3 },
      {
        value: 'x1-b',
        label: '他業務と兼任の担当者はいるが、知識や経験に不安がある',
        score: 2,
        actionHint: 'PMO/事務局代行など、伴走支援によるプロジェクト推進体制の補強を推奨',
      },
      {
        value: 'x1-c',
        label: '担当者を誰にするか決まっていない、またはITが苦手なメンバーしかいない',
        score: 1,
        actionHint: '外部コンサルタントが実質的な推進役を担う「徹底伴走」レベルの支援が必要',
      },
    ],
  },
  {
    id: 'x2',
    categoryId: 'X',
    prompt: 'Q2. 担当者がISMSに割ける時間（リソース）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      { value: 'x2-a', label: '担当者が週に10時間以上、このプロジェクトに時間を割くことができる', score: 3 },
      {
        value: 'x2-b',
        label: '兼任のため、週に3〜5時間程度しか時間を確保できない',
        score: 2,
        actionHint: '作業の一部を外部委託し、担当者の負荷を軽減する体制が必要',
      },
      {
        value: 'x2-c',
        label: '日々の通常業務（情シス・総務など）で手一杯で、時間はほとんど割けない',
        score: 1,
        actionHint: '高頻度の伴走支援により、担当者の稼働を最小限に抑えた進行が必要',
      },
    ],
  },
  {
    id: 'x3',
    categoryId: 'X',
    prompt: 'Q3. セキュリティや規程作成に関する知見（知識）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      { value: 'x3-a', label: '過去にPマークやISMSの取得・運用経験があり、セキュリティ規程のイメージが湧く', score: 3 },
      {
        value: 'x3-b',
        label: '知識はないが、クラウドツール（SecureNavi）のガイドを読めば自力で理解できそう',
        score: 2,
        actionHint: '規程作成のテンプレート提供・レビュー支援があれば自走可能',
      },
      {
        value: 'x3-c',
        label: '専門用語が全く分からず、規程のチェックや読解を自社だけで行うのは不安',
        score: 1,
        actionHint: '規程の作成・チェックを外部が主体的に担う支援が必要',
      },
    ],
  },
  {
    id: 'x4',
    categoryId: 'X',
    prompt: 'Q4. 2026年度下期に向けたスケジュール管理（推進力）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      { value: 'x4-a', label: '社内のプロジェクト管理能力が高く、自社主導で期限通りに進行できる', score: 3 },
      {
        value: 'x4-b',
        label: '月1回程度の定期的な進捗チェック（お尻叩き）があれば、なんとか進められる',
        score: 2,
        actionHint: '定期的な進捗確認・リマインドの仕組みが有効',
      },
      {
        value: 'x4-c',
        label: '外部から高頻度でマイルストーンを管理・リードしてもらわないと、後回しになる',
        score: 1,
        actionHint: 'マイルストーン管理を外部が主導する体制が必要',
      },
    ],
  },
  // --- カテゴリY（xlsx Q5-Q7、文言・配点はxlsxと同一） ---
  {
    id: 'y1',
    categoryId: 'Y',
    prompt: 'Q5. ネットワーク・インフラ機器の設定・管理（施工能力）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      { value: 'y1-a', label: '自社のルーターやUTM、Wi-Fi等の設定変更、アクセスログの確認を自社内で完結できる', score: 3 },
      {
        value: 'y1-b',
        label: '基本的な設定はできるが、ISMS水準（境界防御やネットワーク分離）の変更は不安',
        score: 2,
        actionHint: '境界防御・ネットワーク分離など高度な設定部分のみ別途支援が有効',
      },
      {
        value: 'y1-c',
        label: 'ネットワーク機器の設定はすべて外部ベンダー任せ、または社内にできる人がいない',
        score: 1,
        actionHint: 'ネットワーク設定・運用を含めた別発注（ITインフラ最適化ソリューション）を推奨',
      },
    ],
  },
  {
    id: 'y2',
    categoryId: 'Y',
    prompt: 'Q6. クラウドサービスおよびIDの管理（実装能力）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      {
        value: 'y2-a',
        label: '主要なクラウド（SaaS）のアカウント一括管理（IdP）や、多要素認証（MFA）の強制設定を自社で実装・運用できる',
        score: 3,
      },
      {
        value: 'y2-b',
        label: '各ツールの個別設定はできるが、組織全体の統合的なアクセス制御の設計は難しい',
        score: 2,
        actionHint: 'IdP導入など統合アクセス管理の設計支援が有効',
      },
      {
        value: 'y2-c',
        label: '誰がどのツールのアカウントを持っているか、把握・制御できていない',
        score: 1,
        actionHint: 'クラウドID管理の実装を含めた別発注を推奨',
      },
    ],
  },
  {
    id: 'y3',
    categoryId: 'Y',
    prompt: 'Q7. PCやスマホなどの端末管理（MDM運用能力）',
    type: 'single-choice',
    required: true,
    scored: true,
    options: [
      {
        value: 'y3-a',
        label: '全社の端末（OSやセキュリティソフト）を一括管理するMDMの導入や、紛失時のリモートワイプ設定を自社で施工・運用できる',
        score: 3,
      },
      {
        value: 'y3-b',
        label: 'セキュリティソフトの導入はしているが、紛失時の遠隔消去などの高度な制御は未対応',
        score: 2,
        actionHint: 'MDM導入によるリモートワイプ等の高度な制御の追加を推奨',
      },
      {
        value: 'y3-c',
        label: '社員のPCやスマホの設定は個人の裁量に近く、会社として一括制御・施工する技術がない',
        score: 1,
        actionHint: 'MDM導入・運用を含めた別発注を推奨',
      },
    ],
  },
  // --- プロフィール質問（非スコア、営業判断材料としてのボリューム増） ---
  {
    id: 'profile-employees',
    categoryId: 'profile',
    prompt: 'Q8. 従業員数',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'emp-1', label: '〜20名' },
      { value: 'emp-2', label: '21〜100名' },
      { value: 'emp-3', label: '101〜300名' },
      { value: 'emp-4', label: '301名以上' },
    ],
  },
  {
    id: 'profile-sites',
    categoryId: 'profile',
    prompt: 'Q9. 拠点数',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'site-1', label: '1拠点' },
      { value: 'site-2', label: '2〜3拠点' },
      { value: 'site-3', label: '4拠点以上' },
    ],
  },
  {
    id: 'profile-certification',
    categoryId: 'profile',
    prompt: 'Q10. 目標認証',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'cert-isms', label: 'ISMS(ISO27001)' },
      { value: 'cert-pmark', label: 'プライバシーマーク' },
      { value: 'cert-soc2', label: 'SOC2' },
      { value: 'cert-other', label: 'その他' },
      { value: 'cert-undecided', label: 'まだ未定' },
    ],
  },
  {
    id: 'profile-policy-maturity',
    categoryId: 'profile',
    prompt: 'Q11. 現在の規程整備状況',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'policy-none', label: '規程はまだ無い' },
      { value: 'policy-partial', label: '一部整備されているが更新できていない' },
      { value: 'policy-ready-unaudited', label: '整備済みだが第三者評価は未経験' },
      { value: 'policy-iso9001', label: 'ISO9001等の他マネジメントシステム運用経験あり' },
    ],
  },
  {
    id: 'profile-cloud-usage',
    categoryId: 'profile',
    prompt: 'Q12. クラウド・SaaS利用状況',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'cloud-heavy', label: 'ほぼクラウド中心' },
      { value: 'cloud-mixed', label: 'オンプレとクラウドが混在' },
      { value: 'cloud-onprem', label: 'オンプレ中心' },
    ],
  },
  {
    id: 'profile-executive-commitment',
    categoryId: 'profile',
    prompt: 'Q13. 経営層のコミットメント',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'exec-leading', label: '経営層が主導・号令をかけている' },
      { value: 'exec-passive', label: '現場要請で経営層は消極的関与' },
      { value: 'exec-none', label: '経営層の理解がまだ得られていない' },
    ],
  },
  {
    id: 'profile-budget',
    categoryId: 'profile',
    prompt: 'Q14. ご予算感',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'budget-1', label: '60万円未満' },
      { value: 'budget-2', label: '60万〜100万円程度' },
      { value: 'budget-3', label: '100万〜150万円程度' },
      { value: 'budget-4', label: '150万円以上' },
      { value: 'budget-undecided', label: '未定' },
    ],
  },
  {
    id: 'profile-timeline',
    categoryId: 'profile',
    prompt: 'Q15. 希望スケジュール（審査申込み予定時期）',
    type: 'single-choice',
    required: true,
    scored: false,
    options: [
      { value: 'timeline-3m', label: '3ヶ月以内' },
      { value: 'timeline-6m', label: '半年以内' },
      { value: 'timeline-1y', label: '1年以内' },
      { value: 'timeline-undecided', label: '未定' },
    ],
  },
];

function findQuestion(id: string): Question | undefined {
  return QUESTIONS.find((q) => q.id === id);
}

/** 質問リストからzodスキーマを動的生成する。質問を追加してもここのコードは変更不要。 */
export function buildAnswersSchema() {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const question of QUESTIONS) {
    let fieldSchema: z.ZodTypeAny;
    if (question.type === 'single-choice') {
      const values = (question.options ?? []).map((o) => o.value);
      if (values.length === 0) {
        throw new Error(`Question ${question.id} is single-choice but has no options`);
      }
      fieldSchema = z.enum(values as [string, ...string[]]);
    } else {
      fieldSchema = z.string().min(1).max(500);
    }
    shape[question.id] = question.required ? fieldSchema : fieldSchema.optional();
  }
  return z.object(shape);
}

export interface AnswerInput {
  questionId: string;
  value: string;
}

export interface AnswerSnapshot {
  questionId: string;
  questionPrompt: string;
  categoryId: string;
  value: string;
  valueLabel: string;
  score?: number;
}

export interface CategoryRecommendation {
  planCode: string;
  label: string;
  recommended?: boolean;
  priceJpy?: number;
  packagePriceJpy?: number;
}

export interface ScoredSubmission {
  questionSetVersion: string;
  answers: AnswerSnapshot[];
  categoryScores: Record<string, number>;
  recommendations: Record<string, CategoryRecommendation>;
}

/**
 * サーバー側でスコアを計算する（クライアントの自己申告スコアは信用しない）。
 * 質問文・選択肢ラベルも一緒にスナップショットして返す。将来 QUESTIONS の文言や選択肢を
 * 変更・削除しても、DBに保存済みの過去回答がadmin画面で読めなくならないようにするため。
 */
export function scoreSubmission(rawAnswers: AnswerInput[]): ScoredSubmission {
  const answers: AnswerSnapshot[] = [];
  const categoryScores: Record<string, number> = {};

  for (const raw of rawAnswers) {
    const question = findQuestion(raw.questionId);
    if (!question) continue; // 未知の質問IDは無視（不正なリクエストはzodスキーマ側で既に弾かれている前提）

    const option = question.options?.find((o) => o.value === raw.value);
    answers.push({
      questionId: question.id,
      questionPrompt: question.prompt,
      categoryId: question.categoryId,
      value: raw.value,
      valueLabel: option?.label ?? raw.value,
      score: option?.score,
    });

    if (question.scored && option?.score !== undefined) {
      categoryScores[question.categoryId] = (categoryScores[question.categoryId] ?? 0) + option.score;
    }
  }

  const recommendations: Record<string, CategoryRecommendation> = {};
  for (const category of CATEGORIES) {
    if (!category.scored || !category.thresholds) continue;
    const score = categoryScores[category.id];
    if (score === undefined) continue;
    const matched = category.thresholds.find((t) => score >= t.min && score <= t.max);
    if (matched) {
      recommendations[category.id] = {
        planCode: matched.planCode,
        label: matched.label,
        recommended: matched.recommended,
        priceJpy: matched.priceJpy,
        packagePriceJpy: matched.packagePriceJpy,
      };
    }
  }

  return { questionSetVersion: QUESTION_SET_VERSION, answers, categoryScores, recommendations };
}
