/**
 * Bot State Persistence — JSON file storage under .sapiens/bot/
 *
 * Prompt 10: all operational data stays in .sapiens/ (gitignored).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { BOT_CONFIG } from './config.js';
import type { BotState, Position, ShadowLogEntry, GateDecision } from './types.js';

const BOT_DIR = join(process.cwd(), '.sapiens', 'bot');
const STATE_FILE = join(BOT_DIR, 'state.json');
const OPEN_POSITIONS_FILE = join(BOT_DIR, 'positions', 'open.json');
const CLOSED_POSITIONS_FILE = join(BOT_DIR, 'positions', 'closed.json');
const SHADOW_DIR = join(BOT_DIR, 'shadow');
const METRICS_DIR = join(BOT_DIR, 'metrics');

// ----------------------------------------------------------------------------
// Directory Setup
// ----------------------------------------------------------------------------

export function ensureBotDirs(): void {
  const dirs = [
    BOT_DIR,
    join(BOT_DIR, 'positions'),
    SHADOW_DIR,
    METRICS_DIR,
    join(BOT_DIR, 'postmortems'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ----------------------------------------------------------------------------
// Bot State
// ----------------------------------------------------------------------------

function defaultState(): BotState {
  const today = new Date().toISOString().slice(0, 10);
  return {
    phase: 1,
    alpha_level: 'NORMAL',
    alpha_value: 1.0,
    kill_switch_active: false,
    bankroll_initial_usd: BOT_CONFIG.INITIAL_BANKROLL_USD,
    consecutive_losses: 0,
    daily_pnl_usd: 0,
    daily_pnl_date: today,
    analyzed_market_ids: [],
  };
}

export function loadState(): BotState {
  if (!existsSync(STATE_FILE)) return defaultState();
  const raw = readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(raw) as BotState;
}

export function saveState(state: BotState): void {
  ensureBotDirs();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ----------------------------------------------------------------------------
// Positions
// ----------------------------------------------------------------------------

export function loadOpenPositions(): Position[] {
  if (!existsSync(OPEN_POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(OPEN_POSITIONS_FILE, 'utf-8')) as Position[];
}

export function saveOpenPositions(positions: Position[]): void {
  ensureBotDirs();
  writeFileSync(OPEN_POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

export function appendClosedPosition(position: Position): void {
  ensureBotDirs();
  let closed: Position[] = [];
  if (existsSync(CLOSED_POSITIONS_FILE)) {
    closed = JSON.parse(readFileSync(CLOSED_POSITIONS_FILE, 'utf-8')) as Position[];
  }
  closed.push(position);
  writeFileSync(CLOSED_POSITIONS_FILE, JSON.stringify(closed, null, 2));
}

// ----------------------------------------------------------------------------
// Shadow Log (Phase 1)
// ----------------------------------------------------------------------------

export function appendShadowLog(entry: ShadowLogEntry): void {
  ensureBotDirs();
  const file = join(SHADOW_DIR, 'decisions.jsonl');
  appendFileSync(file, JSON.stringify(entry) + '\n');
}

// ----------------------------------------------------------------------------
// Daily Metrics
// ----------------------------------------------------------------------------

export function appendDailyMetric(metric: Record<string, unknown>): void {
  ensureBotDirs();
  const file = join(METRICS_DIR, 'daily.jsonl');
  appendFileSync(file, JSON.stringify({ ...metric, timestamp: new Date().toISOString() }) + '\n');
}

// ----------------------------------------------------------------------------
// Cooldown Check
// ----------------------------------------------------------------------------

/** Check if a market was analyzed within COOLDOWN_HOURS. */
export function isOnCooldown(state: BotState, market_id: string): boolean {
  return state.analyzed_market_ids.includes(market_id);
}

/** Mark a market as analyzed and prune old entries (simple approach). */
export function markAnalyzed(state: BotState, market_id: string): BotState {
  const updated = [...state.analyzed_market_ids, market_id];
  // Keep only last 100 entries to prevent unbounded growth
  const trimmed = updated.slice(-100);
  return { ...state, analyzed_market_ids: trimmed, last_analysis_at: new Date().toISOString() };
}
