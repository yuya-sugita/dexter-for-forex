/**
 * Renaissance Polymarket Bot — 6 Agent LLM Caller
 *
 * Calls each agent's SKILL.md as a system prompt via callLlm(),
 * with Zod schemas for structured JSON output.
 *
 * Prompt 3: Hire outsiders — each agent sees the same market data
 * but diagnoses it in their own native language.
 * Prompt 4: Never override — agents return deterministic structured
 * output, no narrative persuasion.
 */

import { z } from 'zod';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import matter from 'gray-matter';
import { callLlm } from '../model/llm.js';
import type {
  AgentName,
  OutsiderDiagnosis,
  QuantDiagnosis,
  PolymarketMarket,
  Direction,
  OUTSIDER_AGENTS,
} from './types.js';
import { getYesPrice, getNoPrice, daysToResolve } from './gamma-api.js';

// ============================================================================
// Config
// ============================================================================

/** Model to use for agent calls. Override via BOT_LLM_MODEL env var. */
const AGENT_MODEL = process.env.BOT_LLM_MODEL || 'claude-sonnet-4-20250514';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, '..', 'skills');

// ============================================================================
// Zod Schemas for structured output
// ============================================================================

const OutsiderOutputSchema = z.object({
  direction: z.enum(['YES', 'NO', 'NEUTRAL']),
  confidence: z.number().min(0).max(1),
  reasoning_key: z.string().max(200),
  data_points: z.record(z.number()).optional().default({}),
});

const QuantOutputSchema = z.object({
  estimated_true_prob: z.number().min(0).max(1),
  edge: z.number(),
  direction: z.enum(['YES', 'NO']),
  kelly_fraction: z.number(),
  recommended_fraction: z.number(),
  ruin_probability: z.number(),
  ev_per_dollar: z.number(),
  confidence: z.number().min(0).max(1),
});

// ============================================================================
// Skill Loading (cached)
// ============================================================================

const skillCache = new Map<string, string>();

function loadSkillInstructions(skillName: string): string {
  if (skillCache.has(skillName)) return skillCache.get(skillName)!;

  const path = join(SKILLS_DIR, skillName, 'SKILL.md');
  const raw = readFileSync(path, 'utf-8');
  const { content } = matter(raw);
  const instructions = content.trim();
  skillCache.set(skillName, instructions);
  return instructions;
}

// ============================================================================
// Market Context Builder
// ============================================================================

function buildMarketContext(market: PolymarketMarket): string {
  const yesPrice = getYesPrice(market);
  const noPrice = getNoPrice(market);
  const days = daysToResolve(market);

  return [
    `## 分析対象の市場データ`,
    ``,
    `- **質問**: ${market.question}`,
    `- **市場ID**: ${market.id}`,
    `- **slug**: ${market.slug}`,
    `- **カテゴリ**: ${market.category}`,
    `- **YES価格**: ${yesPrice.toFixed(3)} (暗黙確率 ${(yesPrice * 100).toFixed(1)}%)`,
    `- **NO価格**: ${noPrice.toFixed(3)} (暗黙確率 ${(noPrice * 100).toFixed(1)}%)`,
    `- **24h出来高**: $${(market.volume_24hr ?? 0).toFixed(0)}`,
    `- **累積出来高**: $${(market.volume ?? 0).toFixed(0)}`,
    `- **流動性**: $${(market.liquidity ?? 0).toFixed(0)}`,
    `- **解決日**: ${market.end_date_iso} (残り ${days.toFixed(1)} 日)`,
    `- **アクティブ**: ${market.active}`,
    ``,
    `上記のデータに基づいて、あなたの専門分野の視点から診断してください。`,
    `金融用語ではなく、あなた自身の分野の言語で分析してください。`,
  ].join('\n');
}

// ============================================================================
// Outsider Agent Caller
// ============================================================================

export async function callOutsiderAgent(
  agentName: AgentName,
  market: PolymarketMarket,
): Promise<OutsiderDiagnosis> {
  const instructions = loadSkillInstructions(agentName);
  const marketContext = buildMarketContext(market);

  const prompt = [
    marketContext,
    ``,
    `## 出力形式（厳守）`,
    ``,
    `以下のJSON形式のみで回答してください。散文や説明は不要です。`,
    ``,
    `- direction: この市場のYESコントラクトを買うべきか？ "YES" / "NO" / "NEUTRAL"`,
    `- confidence: あなたの診断の確信度 (0.0〜1.0)`,
    `- reasoning_key: あなたの分野の言語での診断要約（1行、200文字以内、金融用語禁止）`,
    `- data_points: 判断に使った数値のキーバリュー`,
  ].join('\n');

  try {
    const { response } = await callLlm(prompt, {
      model: AGENT_MODEL,
      systemPrompt: instructions,
      outputSchema: OutsiderOutputSchema,
    });

    const parsed = response as z.infer<typeof OutsiderOutputSchema>;

    return {
      agent: agentName,
      market_id: market.id,
      direction: parsed.direction as Direction,
      confidence: parsed.confidence,
      reasoning_key: parsed.reasoning_key,
      data_points: parsed.data_points ?? {},
    };
  } catch (err) {
    console.error(`[Agent] ${agentName} error:`, err);
    throw err;
  }
}

// ============================================================================
// Quant Analyst Caller
// ============================================================================

export async function callQuantAnalyst(
  market: PolymarketMarket,
  outsiderDiagnoses: OutsiderDiagnosis[],
): Promise<QuantDiagnosis> {
  const instructions = loadSkillInstructions('quant-analyst');
  const marketContext = buildMarketContext(market);
  const yesPrice = getYesPrice(market);

  // Build outsider summary for quant-analyst input
  const outsiderSummary = outsiderDiagnoses.map((d) =>
    `- ${d.agent}: direction=${d.direction}, confidence=${d.confidence.toFixed(2)}, reasoning="${d.reasoning_key}"`
  ).join('\n');

  const confluenceYes = outsiderDiagnoses.filter((d) => d.direction === 'YES').length;
  const confluenceNo = outsiderDiagnoses.filter((d) => d.direction === 'NO').length;

  const prompt = [
    marketContext,
    ``,
    `## 5人の異邦人スペシャリストの診断結果`,
    ``,
    outsiderSummary,
    ``,
    `YESコンフルエンス: ${confluenceYes}/5, NOコンフルエンス: ${confluenceNo}/5`,
    ``,
    `## あなたの役割`,
    ``,
    `上記の5人の診断を入力として、この市場の**推定真確率**を算出し、`,
    `市場価格 (YES=${yesPrice.toFixed(3)}) との差（エッジ）からケリー基準で`,
    `推奨ポジションサイズを計算してください。`,
    ``,
    `5人の診断が散らばっている場合は、confidence を低く設定してください。`,
    ``,
    `## 出力形式（厳守）`,
    ``,
    `以下のJSON形式のみで回答してください。`,
    ``,
    `- estimated_true_prob: あなたの推定する真の確率 (0.0〜1.0)`,
    `- edge: |estimated_true_prob - market_price|`,
    `- direction: エッジがある方向 "YES" or "NO"`,
    `- kelly_fraction: フルケリー比 f* = (p-q)/(1-q) or (q-p)/q`,
    `- recommended_fraction: quarter-Kelly = f*/4`,
    `- ruin_probability: 100ベットでバンクロール50%を割る推定確率`,
    `- ev_per_dollar: 1ドルあたりの期待値`,
    `- confidence: この推定の確信度 (0.0〜1.0)`,
  ].join('\n');

  try {
    const { response } = await callLlm(prompt, {
      model: AGENT_MODEL,
      systemPrompt: instructions,
      outputSchema: QuantOutputSchema,
    });

    const parsed = response as z.infer<typeof QuantOutputSchema>;

    return {
      agent: 'quant-analyst',
      market_id: market.id,
      estimated_true_prob: parsed.estimated_true_prob,
      market_price: yesPrice,
      edge: parsed.edge,
      direction: parsed.direction,
      kelly_fraction: parsed.kelly_fraction,
      recommended_fraction: parsed.recommended_fraction,
      position_size_usd: 0, // will be computed by sizer.ts
      ruin_probability: parsed.ruin_probability,
      confluence_count: Math.max(confluenceYes, confluenceNo),
      ev_per_dollar: parsed.ev_per_dollar,
    };
  } catch (err) {
    console.error(`[Agent] quant-analyst error:`, err);
    throw err;
  }
}

// ============================================================================
// Full 6-Agent Pipeline
// ============================================================================

const OUTSIDER_AGENT_NAMES: AgentName[] = [
  'outsider-mathematician',
  'outsider-physicist',
  'outsider-astronomer',
  'outsider-speech-recognition',
  'outsider-cryptanalyst',
];

/**
 * Run all 6 agents sequentially on a market.
 * Sequential execution per Prompt 1: see results before proceeding.
 */
export async function runAllAgents(market: PolymarketMarket): Promise<{
  outsiders: OutsiderDiagnosis[];
  quant: QuantDiagnosis;
}> {
  console.log(`  [Agents] Running 6-agent diagnosis...`);

  // Call 5 outsiders sequentially
  const outsiders: OutsiderDiagnosis[] = [];
  for (const agentName of OUTSIDER_AGENT_NAMES) {
    console.log(`    → ${agentName}...`);
    const diagnosis = await callOutsiderAgent(agentName, market);
    console.log(`      ${diagnosis.direction} (${(diagnosis.confidence * 100).toFixed(0)}%) — ${diagnosis.reasoning_key.slice(0, 80)}`);
    outsiders.push(diagnosis);
  }

  // Call quant-analyst with outsider results as input
  console.log(`    → quant-analyst (translating ${outsiders.length} diagnoses)...`);
  const quant = await callQuantAnalyst(market, outsiders);
  console.log(`      true_prob=${quant.estimated_true_prob.toFixed(3)} market=${quant.market_price.toFixed(3)} edge=${quant.edge.toFixed(3)} → ${quant.direction}`);

  return { outsiders, quant };
}
