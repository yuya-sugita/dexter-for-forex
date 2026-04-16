/**
 * Kelly Criterion Position Sizer — Pure math, no I/O
 *
 * Implements Prompt 2 (51% edge) + Prompt 8 (alpha reduction):
 * - Binary Kelly: f* = (p - q) / (1 - q)
 * - Quarter-Kelly with confluence/confidence/alpha modifiers
 * - Hard caps from RISK_LIMITS
 */

import { BOT_CONFIG } from './config.js';
import type { AlphaLevel } from './types.js';

export interface SizerInput {
  estimated_true_prob: number;  // p
  market_price: number;         // q
  bankroll_usd: number;
  confluence_count: number;     // out of 5
  quant_confidence: number;     // 0-1
  alpha_value: number;          // 0.0 - 1.0
}

export interface SizerOutput {
  direction: 'YES' | 'NO';
  edge: number;
  kelly_full: number;           // f*
  kelly_adjusted: number;       // after all modifiers
  position_size_usd: number;    // final size in USD
  capped_by?: string;           // which cap was binding
}

/** Compute Kelly fraction and position size for a binary bet. */
export function computeSize(input: SizerInput): SizerOutput {
  const { estimated_true_prob: p, market_price: q, bankroll_usd } = input;

  // Determine direction
  const direction: 'YES' | 'NO' = p > q ? 'YES' : 'NO';

  // Edge
  const edge = Math.abs(p - q);

  // Full Kelly
  let kelly_full: number;
  if (direction === 'YES') {
    kelly_full = (p - q) / (1 - q);
  } else {
    kelly_full = (q - p) / q;
  }

  // Clamp to [0, 1] — negative Kelly = no edge, shouldn't happen past gate
  kelly_full = Math.max(0, Math.min(1, kelly_full));

  // Apply modifiers
  const confluence_mod = input.confluence_count >= BOT_CONFIG.CONFLUENCE_THRESHOLD
    ? 1.0
    : BOT_CONFIG.WEAK_CONFLUENCE_FRACTION;

  const confidence_mod = input.quant_confidence >= BOT_CONFIG.LOW_CONFIDENCE_THRESHOLD
    ? 1.0
    : BOT_CONFIG.LOW_CONFIDENCE_FRACTION;

  const kelly_adjusted = kelly_full / BOT_CONFIG.KELLY_DIVISOR
    * confluence_mod
    * confidence_mod
    * input.alpha_value;

  // Position size in USD
  let position_size_usd = bankroll_usd * kelly_adjusted;
  let capped_by: string | undefined;

  // Apply hard caps
  const max_pct = bankroll_usd * BOT_CONFIG.MAX_POSITION_PCT / 100;
  if (position_size_usd > BOT_CONFIG.MAX_POSITION_USD) {
    position_size_usd = BOT_CONFIG.MAX_POSITION_USD;
    capped_by = 'MAX_POSITION_USD';
  }
  if (position_size_usd > max_pct) {
    position_size_usd = max_pct;
    capped_by = 'MAX_POSITION_PCT';
  }
  if (position_size_usd < BOT_CONFIG.MIN_POSITION_USD) {
    position_size_usd = 0; // too small to execute
    capped_by = 'MIN_POSITION_USD';
  }

  position_size_usd = Math.round(position_size_usd * 100) / 100;

  return {
    direction,
    edge,
    kelly_full,
    kelly_adjusted,
    position_size_usd,
    capped_by,
  };
}

// ----------------------------------------------------------------------------
// Alpha Level Computation (Prompt 8)
// ----------------------------------------------------------------------------

export function computeAlphaLevel(dd_pct: number, consecutive_losses: number): {
  level: AlphaLevel;
  value: number;
} {
  if (dd_pct >= BOT_CONFIG.KILL_SWITCH_DD_PCT) {
    return { level: 'L4_STOP', value: 0.0 };
  }
  if (dd_pct >= BOT_CONFIG.L3_DD_PCT) {
    return { level: 'L3', value: 0.25 };
  }
  if (dd_pct >= BOT_CONFIG.L2_DD_PCT || consecutive_losses >= BOT_CONFIG.L2_CONSECUTIVE_LOSSES) {
    return { level: 'L2', value: 0.5 };
  }
  if (dd_pct >= BOT_CONFIG.L1_DD_PCT || consecutive_losses >= BOT_CONFIG.L1_CONSECUTIVE_LOSSES) {
    return { level: 'L1', value: 0.75 };
  }
  return { level: 'NORMAL', value: 1.0 };
}

/** Compute drawdown percentage. */
export function computeDrawdown(current_bankroll: number, initial_bankroll: number): number {
  if (initial_bankroll <= 0) return 0;
  return Math.max(0, (initial_bankroll - current_bankroll) / initial_bankroll * 100);
}
