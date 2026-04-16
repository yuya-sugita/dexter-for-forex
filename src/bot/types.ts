/**
 * Renaissance Polymarket Bot — Shared Type Definitions
 */

// ============================================================================
// Agent Diagnosis Types (JSON output contract)
// ============================================================================

export type Direction = 'YES' | 'NO' | 'NEUTRAL';

export type AgentName =
  | 'quant-analyst'
  | 'outsider-mathematician'
  | 'outsider-physicist'
  | 'outsider-astronomer'
  | 'outsider-speech-recognition'
  | 'outsider-cryptanalyst';

export const OUTSIDER_AGENTS: AgentName[] = [
  'outsider-mathematician',
  'outsider-physicist',
  'outsider-astronomer',
  'outsider-speech-recognition',
  'outsider-cryptanalyst',
];

/** Diagnosis from one of the 5 outsider agents */
export interface OutsiderDiagnosis {
  agent: AgentName;
  market_id: string;
  direction: Direction;
  confidence: number;        // 0.0 - 1.0
  reasoning_key: string;     // 1-line summary in agent's native language
  data_points: Record<string, number>;
}

/** Diagnosis from the quant-analyst (requires outsider inputs) */
export interface QuantDiagnosis {
  agent: 'quant-analyst';
  market_id: string;
  estimated_true_prob: number;
  market_price: number;
  edge: number;
  direction: 'YES' | 'NO';
  kelly_fraction: number;
  recommended_fraction: number;
  position_size_usd: number;
  ruin_probability: number;
  confluence_count: number;
  ev_per_dollar: number;
}

// ============================================================================
// Decision Gate Types
// ============================================================================

export interface GateChecks {
  edge_sufficient: boolean;
  confluence_sufficient: boolean;
  bankroll_healthy: boolean;
  concentration_ok: boolean;
  kill_switch_clear: boolean;
}

export interface GateDecision {
  market_id: string;
  slug: string;
  outcome: 'EXECUTE' | 'SKIP';
  skip_reason?: string;
  quant: QuantDiagnosis;
  outsiders: OutsiderDiagnosis[];
  gate_checks: GateChecks;
  timestamp: string;
}

// ============================================================================
// Position Lifecycle
// ============================================================================

export type PositionStatus =
  | 'OPEN'
  | 'MONITORING'
  | 'ALPHA_REDUCED'
  | 'RESOLVED'
  | 'CLOSED_MANUAL';

export interface Position {
  id: string;
  market_id: string;
  slug: string;
  outcome_side: 'YES' | 'NO';
  entry_price: number;
  size_usd: number;
  status: PositionStatus;
  opened_at: string;
  closed_at?: string;
  exit_price?: number;
  pnl_usd?: number;
  alpha_level: number;        // current α (1.0 / 0.75 / 0.5 / 0.25)
  rationale: {
    estimated_true_prob: number;
    market_price_at_entry: number;
    edge: number;
    kelly_fraction: number;
    confluence_count: number;
  };
  postmortem?: Postmortem;
}

export interface Postmortem {
  facts: string;
  hypothesis: string;
  failure_mode: 'data' | 'assumption' | 'execution' | 'timing' | 'none';
  new_rule: string;
  mc_delta: string;
}

// ============================================================================
// Polymarket Market Data (Gamma API shapes)
// ============================================================================

export interface PolymarketToken {
  token_id: string;
  outcome: string;           // "Yes" or "No"
  price: number;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  category: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  tokens: PolymarketToken[];
  volume: number;
  volume_24hr: number;
  liquidity: number;
}

// ============================================================================
// Bot State (persisted to .sapiens/bot/)
// ============================================================================

export type AlphaLevel = 'NORMAL' | 'L1' | 'L2' | 'L3' | 'L4_STOP';

export interface BotState {
  phase: 1 | 2 | 3 | 4;
  alpha_level: AlphaLevel;
  alpha_value: number;        // 1.0 / 0.75 / 0.5 / 0.25 / 0.0
  kill_switch_active: boolean;
  kill_switch_reason?: string;
  kill_switch_at?: string;
  bankroll_initial_usd: number;
  consecutive_losses: number;
  daily_pnl_usd: number;
  daily_pnl_date: string;     // YYYY-MM-DD
  last_analysis_at?: string;
  last_monitor_at?: string;
  analyzed_market_ids: string[];  // cooldown tracking
}

export interface ShadowLogEntry {
  timestamp: string;
  market_id: string;
  slug: string;
  decision: GateDecision;
  hypothetical_pnl?: number;  // filled when market resolves
}
