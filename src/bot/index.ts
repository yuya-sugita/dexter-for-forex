/**
 * Renaissance Polymarket Bot — Entry Point
 *
 * Phase 1: Shadow Trading (read-only, no real orders)
 *
 * Usage:
 *   bun run src/bot/index.ts
 *   bun run src/bot/index.ts --phase 1
 */

import { BOT_CONFIG } from './config.js';
import { listMarkets, passesFilters, getYesPrice } from './gamma-api.js';
import { computeConfluence, evaluateGate } from './confluence.js';
import { computeSize, computeAlphaLevel, computeDrawdown } from './sizer.js';
import { checkKillSwitch, activateKillSwitch } from './kill-switch.js';
import {
  ensureBotDirs, loadState, saveState,
  loadOpenPositions, appendShadowLog,
  isOnCooldown, markAnalyzed, appendDailyMetric,
} from './state.js';
import type { ShadowLogEntry, OutsiderDiagnosis, QuantDiagnosis } from './types.js';

// ============================================================================
// Main Loop
// ============================================================================

async function runAnalysisCycle(): Promise<void> {
  let state = loadState();
  const positions = loadOpenPositions();

  // Reset daily PnL if date changed
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_pnl_date !== today) {
    state = { ...state, daily_pnl_usd: 0, daily_pnl_date: today };
  }

  // Kill switch check
  const ks = checkKillSwitch(state, BOT_CONFIG.INITIAL_BANKROLL_USD + state.daily_pnl_usd);
  if (ks.should_activate) {
    if (!state.kill_switch_active) {
      console.log(`[KILL SWITCH] Activated: ${ks.reason}`);
      activateKillSwitch(ks.reason!);
      state = {
        ...state,
        kill_switch_active: true,
        kill_switch_reason: ks.reason,
        kill_switch_at: new Date().toISOString(),
      };
      saveState(state);
    }
    return;
  }

  // Discover markets
  console.log(`[Discovery] Fetching markets (categories: ${BOT_CONFIG.ALLOWED_CATEGORIES.join(', ')})...`);

  let markets = [];
  for (const category of BOT_CONFIG.ALLOWED_CATEGORIES) {
    try {
      const batch = await listMarkets({ category, limit: 50, active: true });
      markets.push(...batch);
    } catch (err) {
      console.error(`[Discovery] Error fetching ${category}:`, err);
    }
  }

  // Filter
  const candidates = markets
    .filter((m) => passesFilters(m).pass)
    .filter((m) => !isOnCooldown(state, m.id))
    .filter((m) => !positions.some((p) => p.market_id === m.id))
    .slice(0, BOT_CONFIG.MAX_MARKETS_PER_CYCLE);

  console.log(`[Discovery] ${markets.length} fetched → ${candidates.length} candidates`);

  // Analyze each candidate
  for (const market of candidates) {
    console.log(`\n[Analyze] ${market.slug} (${market.question.slice(0, 60)}...)`);
    console.log(`  YES: ${getYesPrice(market).toFixed(2)} | Vol 24h: $${market.volume_24hr?.toFixed(0)}`);

    // TODO (Phase 1 next step): Call 6 agents via LLM for real diagnoses.
    // For now, produce a placeholder to validate the full pipeline.
    const outsiders = createPlaceholderOutsiderDiagnoses(market.id);
    const quant = createPlaceholderQuantDiagnosis(market.id, getYesPrice(market), state);

    // Decision Gate
    const decision = evaluateGate({
      market_id: market.id,
      slug: market.slug,
      outsiders,
      quant,
      state,
      open_positions: positions,
    });

    console.log(`  → Decision: ${decision.outcome}${decision.skip_reason ? ` (${decision.skip_reason})` : ''}`);

    // Shadow log
    const entry: ShadowLogEntry = {
      timestamp: new Date().toISOString(),
      market_id: market.id,
      slug: market.slug,
      decision,
    };
    appendShadowLog(entry);

    // Mark analyzed
    state = markAnalyzed(state, market.id);
  }

  // Save state
  saveState(state);

  // Daily metrics
  appendDailyMetric({
    phase: state.phase,
    alpha_level: state.alpha_level,
    markets_fetched: markets.length,
    candidates: candidates.length,
    open_positions: positions.length,
    daily_pnl_usd: state.daily_pnl_usd,
  });

  console.log(`\n[Cycle Complete] Next in ${BOT_CONFIG.ANALYSIS_INTERVAL_MIN}min`);
}

// ============================================================================
// Placeholder Agent Diagnoses (to be replaced by real LLM calls)
// ============================================================================

function createPlaceholderOutsiderDiagnoses(market_id: string): OutsiderDiagnosis[] {
  // In Phase 1 implementation, these will call the LLM with each
  // outsider's SKILL.md prompt and parse structured JSON output.
  // For pipeline validation, return NEUTRAL placeholders.
  const agents = [
    'outsider-mathematician',
    'outsider-physicist',
    'outsider-astronomer',
    'outsider-speech-recognition',
    'outsider-cryptanalyst',
  ] as const;

  return agents.map((agent) => ({
    agent,
    market_id,
    direction: 'NEUTRAL' as const,
    confidence: 0,
    reasoning_key: 'placeholder — LLM integration pending',
    data_points: {},
  }));
}

function createPlaceholderQuantDiagnosis(
  market_id: string,
  yes_price: number,
  state: import('./types.js').BotState,
): QuantDiagnosis {
  return {
    agent: 'quant-analyst',
    market_id,
    estimated_true_prob: yes_price, // no edge in placeholder
    market_price: yes_price,
    edge: 0,
    direction: 'YES',
    kelly_fraction: 0,
    recommended_fraction: 0,
    position_size_usd: 0,
    ruin_probability: 0,
    confluence_count: 0,
    ev_per_dollar: 0,
  };
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  console.log('=== Renaissance Polymarket Bot — Phase 1 (Shadow) ===\n');
  ensureBotDirs();

  // Run once immediately
  await runAnalysisCycle();

  // Then schedule recurring
  const intervalMs = BOT_CONFIG.ANALYSIS_INTERVAL_MIN * 60 * 1000;
  setInterval(() => {
    runAnalysisCycle().catch((err) => {
      console.error('[Scheduler] Cycle error:', err);
    });
  }, intervalMs);

  console.log(`\n[Scheduler] Running every ${BOT_CONFIG.ANALYSIS_INTERVAL_MIN}min. Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
