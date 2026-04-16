/**
 * Kill Switch — Safety mechanism
 *
 * Implements Prompt 4 (never override) + Prompt 8 (reduce, don't panic).
 * Once activated, only manual intervention can deactivate.
 */

import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BOT_CONFIG } from './config.js';
import type { BotState } from './types.js';

const KILL_SWITCH_FILE = join(process.cwd(), '.sapiens', 'bot', 'KILL_SWITCH');

export interface KillSwitchCheck {
  should_activate: boolean;
  reason?: string;
}

/** Check all kill switch conditions. Does NOT activate — just reports. */
export function checkKillSwitch(state: BotState, current_bankroll_usd: number): KillSwitchCheck {
  // 1. Manual file
  if (existsSync(KILL_SWITCH_FILE)) {
    return { should_activate: true, reason: 'manual_kill_switch_file' };
  }

  // 2. Already active
  if (state.kill_switch_active) {
    return { should_activate: true, reason: state.kill_switch_reason || 'already_active' };
  }

  // 3. DD threshold
  const dd_pct = state.bankroll_initial_usd > 0
    ? (state.bankroll_initial_usd - current_bankroll_usd) / state.bankroll_initial_usd * 100
    : 0;

  if (dd_pct >= BOT_CONFIG.KILL_SWITCH_DD_PCT) {
    return { should_activate: true, reason: `dd_${dd_pct.toFixed(1)}pct` };
  }

  // 4. Daily loss
  const daily_limit = state.bankroll_initial_usd * BOT_CONFIG.DAILY_LOSS_LIMIT_PCT / 100;
  if (state.daily_pnl_usd < -daily_limit) {
    return { should_activate: true, reason: `daily_loss_${state.daily_pnl_usd.toFixed(2)}` };
  }

  // 5. Consecutive losses
  if (state.consecutive_losses >= BOT_CONFIG.MAX_CONSECUTIVE_LOSSES) {
    return { should_activate: true, reason: `consecutive_losses_${state.consecutive_losses}` };
  }

  return { should_activate: false };
}

/** Activate the kill switch by writing the manual file. */
export function activateKillSwitch(reason: string): void {
  writeFileSync(KILL_SWITCH_FILE, `Activated: ${new Date().toISOString()}\nReason: ${reason}\n`);
}

/** Check if manual kill switch file exists. */
export function isManualKillSwitchActive(): boolean {
  return existsSync(KILL_SWITCH_FILE);
}
