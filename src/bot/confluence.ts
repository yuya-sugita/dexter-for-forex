/**
 * Confluence & Decision Gate — Pure logic, no I/O
 *
 * Implements Prompt 3 (hire outsiders) + Prompt 6 (signal layers):
 * - Count agent agreement
 * - Apply edge threshold
 * - Check bankroll health
 * - Produce deterministic EXECUTE/SKIP decision
 */

import { BOT_CONFIG } from './config.js';
import type {
  OutsiderDiagnosis,
  QuantDiagnosis,
  GateDecision,
  GateChecks,
  Direction,
  BotState,
  Position,
} from './types.js';

// ----------------------------------------------------------------------------
// Confluence Counting
// ----------------------------------------------------------------------------

export interface ConfluenceResult {
  majority_direction: Direction;
  count: number;           // how many outsiders agree with majority
  total: number;           // always 5
  neutral_count: number;
}

export function computeConfluence(outsiders: OutsiderDiagnosis[]): ConfluenceResult {
  const counts: Record<Direction, number> = { YES: 0, NO: 0, NEUTRAL: 0 };

  for (const d of outsiders) {
    counts[d.direction]++;
  }

  const neutral_count = counts.NEUTRAL;

  // Majority is the non-NEUTRAL direction with most votes
  let majority_direction: Direction;
  if (counts.YES >= counts.NO) {
    majority_direction = counts.YES > 0 ? 'YES' : 'NEUTRAL';
  } else {
    majority_direction = 'NO';
  }

  const count = counts[majority_direction];

  return { majority_direction, count, total: outsiders.length, neutral_count };
}

// ----------------------------------------------------------------------------
// Confluence Modifier for Sizing
// ----------------------------------------------------------------------------

/** Returns the size modifier based on confluence strength. */
export function confluenceModifier(count: number): number {
  if (count >= BOT_CONFIG.CONFLUENCE_THRESHOLD) return 1.0;
  if (count === BOT_CONFIG.CONFLUENCE_THRESHOLD - 1) return BOT_CONFIG.WEAK_CONFLUENCE_FRACTION;
  return 0; // insufficient confluence → size = 0 → SKIP
}

// ----------------------------------------------------------------------------
// Decision Gate
// ----------------------------------------------------------------------------

export function evaluateGate(params: {
  market_id: string;
  slug: string;
  outsiders: OutsiderDiagnosis[];
  quant: QuantDiagnosis;
  state: BotState;
  open_positions: Position[];
}): GateDecision {
  const { market_id, slug, outsiders, quant, state, open_positions } = params;

  const confluence = computeConfluence(outsiders);
  const timestamp = new Date().toISOString();

  // Gate checks
  const edge_sufficient = quant.edge >= BOT_CONFIG.MIN_EDGE;
  const confluence_sufficient = confluence.count >= BOT_CONFIG.CONFLUENCE_THRESHOLD ||
    (confluence.count === BOT_CONFIG.CONFLUENCE_THRESHOLD - 1 && quant.edge >= BOT_CONFIG.MIN_EDGE * 1.5);
  const bankroll_healthy = state.alpha_value > 0;
  const concentration_ok = open_positions.length < BOT_CONFIG.MAX_OPEN_POSITIONS;
  const kill_switch_clear = !state.kill_switch_active;

  const gate_checks: GateChecks = {
    edge_sufficient,
    confluence_sufficient,
    bankroll_healthy,
    concentration_ok,
    kill_switch_clear,
  };

  // Determine outcome
  let outcome: 'EXECUTE' | 'SKIP' = 'EXECUTE';
  let skip_reason: string | undefined;

  if (!kill_switch_clear) {
    outcome = 'SKIP';
    skip_reason = 'kill_switch_active';
  } else if (!bankroll_healthy) {
    outcome = 'SKIP';
    skip_reason = `alpha_level_${state.alpha_level}`;
  } else if (!edge_sufficient) {
    outcome = 'SKIP';
    skip_reason = `edge_${quant.edge.toFixed(3)}_below_${BOT_CONFIG.MIN_EDGE}`;
  } else if (!confluence_sufficient) {
    outcome = 'SKIP';
    skip_reason = `confluence_${confluence.count}/${confluence.total}_below_threshold`;
  } else if (!concentration_ok) {
    outcome = 'SKIP';
    skip_reason = `max_positions_${open_positions.length}`;
  }

  // Neutral majority = diagnose impossible → SKIP
  if (confluence.majority_direction === 'NEUTRAL' && confluence.neutral_count >= 3) {
    outcome = 'SKIP';
    skip_reason = 'majority_neutral';
  }

  return {
    market_id,
    slug,
    outcome,
    skip_reason,
    quant,
    outsiders,
    gate_checks,
    timestamp,
  };
}
