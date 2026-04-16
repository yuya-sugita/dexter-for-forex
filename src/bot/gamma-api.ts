/**
 * Polymarket Gamma API Client — Read-only market data
 *
 * Public REST API, no authentication required.
 * https://gamma-api.polymarket.com/
 */

import { BOT_CONFIG } from './config.js';
import type { PolymarketMarket } from './types.js';

const BASE = BOT_CONFIG.GAMMA_API_BASE;

async function fetchJSON<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`[Gamma API] ${res.status} ${res.statusText} — ${url.pathname}`);
  }

  return res.json() as Promise<T>;
}

// ----------------------------------------------------------------------------
// Public Endpoints
// ----------------------------------------------------------------------------

/** List markets, optionally filtered by category. Sorted by volume desc. */
export async function listMarkets(options: {
  category?: string;
  limit?: number;
  active?: boolean;
  closed?: boolean;
} = {}): Promise<PolymarketMarket[]> {
  const params: Record<string, string> = {
    limit: String(options.limit ?? 50),
    order: 'volume24hr',
    ascending: 'false',
    active: String(options.active ?? true),
    closed: String(options.closed ?? false),
  };
  if (options.category) {
    params.tag = options.category;
  }

  return fetchJSON<PolymarketMarket[]>('/markets', params);
}

/** Get a single market by ID or slug. */
export async function getMarket(idOrSlug: string): Promise<PolymarketMarket> {
  // Gamma API accepts both UUID and slug at /markets/{id}
  return fetchJSON<PolymarketMarket>(`/markets/${encodeURIComponent(idOrSlug)}`);
}

/** Search markets by keyword. */
export async function searchMarkets(query: string, limit = 20): Promise<PolymarketMarket[]> {
  return fetchJSON<PolymarketMarket[]>('/markets', {
    search: query,
    limit: String(limit),
    active: 'true',
  });
}

// ----------------------------------------------------------------------------
// Derived Helpers
// ----------------------------------------------------------------------------

/** Extract YES price from a market's tokens. Returns 0 if not found. */
export function getYesPrice(market: PolymarketMarket): number {
  const yesToken = market.tokens?.find(
    (t) => t.outcome.toLowerCase() === 'yes'
  );
  return yesToken?.price ?? 0;
}

/** Extract NO price from a market's tokens. Returns 0 if not found. */
export function getNoPrice(market: PolymarketMarket): number {
  const noToken = market.tokens?.find(
    (t) => t.outcome.toLowerCase() === 'no'
  );
  return noToken?.price ?? 0;
}

/** Days until resolution (negative if past). */
export function daysToResolve(market: PolymarketMarket): number {
  const end = new Date(market.end_date_iso).getTime();
  const now = Date.now();
  return (end - now) / (1000 * 60 * 60 * 24);
}

/** Check if a market passes the basic selection filters. */
export function passesFilters(market: PolymarketMarket): { pass: boolean; reason?: string } {
  const days = daysToResolve(market);

  if (!market.active || market.closed) {
    return { pass: false, reason: 'inactive_or_closed' };
  }
  if (market.volume_24hr < BOT_CONFIG.MIN_LIQUIDITY_USD) {
    return { pass: false, reason: `low_volume_${market.volume_24hr}` };
  }
  if (days < BOT_CONFIG.MIN_DAYS_TO_RESOLVE) {
    return { pass: false, reason: `too_close_${days.toFixed(1)}d` };
  }
  if (days > BOT_CONFIG.MAX_DAYS_TO_RESOLVE) {
    return { pass: false, reason: `too_far_${days.toFixed(0)}d` };
  }

  return { pass: true };
}
