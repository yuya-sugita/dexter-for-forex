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
import { evaluateGate } from './confluence.js';
import { computeSize, computeAlphaLevel, computeDrawdown } from './sizer.js';
import { checkKillSwitch, activateKillSwitch } from './kill-switch.js';
import { runAllAgents } from './agents.js';
import {
  ensureBotDirs, loadState, saveState,
  loadOpenPositions, appendShadowLog,
  isOnCooldown, markAnalyzed, appendDailyMetric,
} from './state.js';
import type { ShadowLogEntry } from './types.js';

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

    // Call all 6 agents via LLM (sequential, Prompt 1 compliant)
    let outsiders, quant;
    try {
      const result = await runAllAgents(market);
      outsiders = result.outsiders;
      quant = result.quant;
    } catch (err) {
      console.error(`  [Analyze] Agent error, skipping market:`, err);
      state = markAnalyzed(state, market.id);
      continue;
    }

    // Compute proper position size via sizer
    const sizeResult = computeSize({
      estimated_true_prob: quant.estimated_true_prob,
      market_price: quant.market_price,
      bankroll_usd: BOT_CONFIG.INITIAL_BANKROLL_USD,
      confluence_count: quant.confluence_count,
      quant_confidence: quant.ev_per_dollar > 0 ? 0.8 : 0.4,
      alpha_value: state.alpha_value,
    });
    quant.position_size_usd = sizeResult.position_size_usd;

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
