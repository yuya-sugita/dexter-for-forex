/**
 * Renaissance Polymarket Bot — Configuration
 *
 * All parameters from DECISION_POLICY.md and RISK_LIMITS.md,
 * confirmed at Phase 0 graduation.
 */

export const BOT_CONFIG = {
  // --- Market Selection Filters ---
  MIN_LIQUIDITY_USD: 5_000,
  MIN_DAYS_TO_RESOLVE: 3,
  MAX_DAYS_TO_RESOLVE: 180,
  ALLOWED_CATEGORIES: ['politics'] as string[],
  COOLDOWN_HOURS: 12,
  MAX_MARKETS_PER_CYCLE: 5,

  // --- Confluence & Edge ---
  CONFLUENCE_THRESHOLD: 4,        // out of 5 outsiders
  WEAK_CONFLUENCE_FRACTION: 0.5,  // size modifier for 3/5
  MIN_EDGE: 0.05,                 // 5%
  LOW_CONFIDENCE_THRESHOLD: 0.6,
  LOW_CONFIDENCE_FRACTION: 0.5,

  // --- Kelly Sizing ---
  KELLY_DIVISOR: 4,               // quarter-Kelly
  MAX_POSITION_USD: 20,           // Phase 2 hard cap
  MAX_POSITION_PCT: 10,           // % of bankroll
  MIN_POSITION_USD: 1,

  // --- Alpha Levels (Prompt 8) ---
  L1_DD_PCT: 10,
  L1_CONSECUTIVE_LOSSES: 3,
  L2_DD_PCT: 20,
  L2_CONSECUTIVE_LOSSES: 4,
  L3_DD_PCT: 30,
  KILL_SWITCH_DD_PCT: 40,
  DAILY_LOSS_LIMIT_PCT: 5,        // % of bankroll
  MAX_CONSECUTIVE_LOSSES: 5,
  RECOVERY_WINS: 5,

  // --- Concentration ---
  MAX_OPEN_POSITIONS: 10,
  MAX_CATEGORY_PCT: 50,
  MAX_CORRELATED_POSITIONS: 3,

  // --- Timing ---
  ANALYSIS_INTERVAL_MIN: 60,
  MONITOR_INTERVAL_MIN: 15,
  MAX_HOLDING_DAYS: 90,

  // --- API ---
  GAMMA_API_BASE: 'https://gamma-api.polymarket.com',
  CONSECUTIVE_API_ERRORS_LIMIT: 5,

  // --- Phase ---
  INITIAL_BANKROLL_USD: 200,

  // --- Alerts ---
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
} as const;

export type BotConfig = typeof BOT_CONFIG;
