import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { api, resolveSymbol, rateLimitedFetch } from './api.js';

export const MACRO_ANALYSIS_DESCRIPTION = `
Econometric macro analysis engine for FX and cross-asset markets. Analyzes leading indicators, rate differentials, yield curves, and macro regime states to provide fundamental context for trading decisions.

## When to Use

- Interest rate differential analysis between currency pairs (carry trade evaluation)
- Leading indicator composite scoring (ISM, PMI, CPI trends, employment data)
- Macro regime classification per economy (expansion, slowdown, contraction, recovery)
- Cross-asset regime analysis (risk-on/risk-off detection via equity-bond-FX-gold correlations)
- Central bank policy divergence scoring

## When NOT to Use

- Technical price data (use get_market_data)
- Statistical computations on price series (use statistical_analysis tools)
- Specific economic event times (use economic_calendar)
- Strategy backtesting (use quant_strategy tools)

## Usage Notes

- Macro data sourced from Twelve Data economic indicators
- Leading indicators typically lead FX moves by 1-3 months
- Rate differentials are the strongest medium-term FX driver
- Regime analysis uses a composite of multiple indicators
- All macro assessments include confidence levels and data recency
`.trim();

function getApiKey(): string {
  return process.env.TWELVE_DATA_API_KEY || '';
}

async function fetchEconomicIndicator(
  symbol: string,
  country: string,
  outputsize: number = 24,
): Promise<Array<{ date: string; value: number }>> {
  const url = new URL('https://api.twelvedata.com/economic_indicators');
  const apiKey = getApiKey();
  if (apiKey) url.searchParams.append('apikey', apiKey);
  url.searchParams.append('symbol', symbol);
  url.searchParams.append('country', country);
  url.searchParams.append('outputsize', String(outputsize));

  try {
    const response = await rateLimitedFetch(url.toString());
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json() as Record<string, unknown>;
    const values = data.values as Array<{ date: string; value: string }> | undefined;
    if (!values || !Array.isArray(values)) return [];
    return values
      .map(v => ({ date: v.date, value: parseFloat(v.value) }))
      .filter(v => !isNaN(v.value))
      .reverse();
  } catch (error) {
    logger.error(`[Macro Analysis] Failed to fetch ${symbol} for ${country}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

const CENTRAL_BANK_RATES: Record<string, { rate: number; lastChanged: string; direction: string; bank: string }> = {
  USD: { rate: 4.50, lastChanged: '2025-01', direction: 'cutting', bank: 'Federal Reserve' },
  EUR: { rate: 2.65, lastChanged: '2025-03', direction: 'cutting', bank: 'ECB' },
  GBP: { rate: 4.50, lastChanged: '2025-02', direction: 'cutting', bank: 'Bank of England' },
  JPY: { rate: 0.50, lastChanged: '2025-01', direction: 'hiking', bank: 'Bank of Japan' },
  CHF: { rate: 0.25, lastChanged: '2025-03', direction: 'cutting', bank: 'Swiss National Bank' },
  AUD: { rate: 4.10, lastChanged: '2025-02', direction: 'holding', bank: 'Reserve Bank of Australia' },
  CAD: { rate: 2.75, lastChanged: '2025-03', direction: 'cutting', bank: 'Bank of Canada' },
  NZD: { rate: 3.75, lastChanged: '2025-02', direction: 'cutting', bank: 'Reserve Bank of New Zealand' },
};

const RateDiffInputSchema = z.object({
  baseCurrency: z.string().describe('Base currency (e.g., EUR, GBP, AUD)'),
  quoteCurrency: z.string().describe('Quote currency (e.g., USD, JPY, CHF)'),
});

export const getRateDifferential = new DynamicStructuredTool({
  name: 'get_rate_differential',
  description: 'Analyze interest rate differential between two currencies. Includes carry trade yield, policy divergence scoring, and directional bias. Rate differentials are the strongest medium-term FX driver.',
  schema: RateDiffInputSchema,
  func: async (input) => {
    const base = input.baseCurrency.toUpperCase();
    const quote = input.quoteCurrency.toUpperCase();
    const baseRate = CENTRAL_BANK_RATES[base];
    const quoteRate = CENTRAL_BANK_RATES[quote];

    if (!baseRate || !quoteRate) {
      return formatToolResult({
        error: `Rate data not available for ${!baseRate ? base : quote}`,
        availableCurrencies: Object.keys(CENTRAL_BANK_RATES),
      }, []);
    }

    const differential = baseRate.rate - quoteRate.rate;
    const pair = `${base}/${quote}`;
    const directionScore: Record<string, number> = { hiking: 1, holding: 0, cutting: -1 };
    const divergence = (directionScore[baseRate.direction] ?? 0) - (directionScore[quoteRate.direction] ?? 0);
    const dailyCarry = differential / 365;

    let bias: string;
    if (differential > 1.0 && divergence >= 0) {
      bias = `BULLISH ${pair} — Positive carry (${differential.toFixed(2)}%) with supportive policy divergence`;
    } else if (differential < -1.0 && divergence <= 0) {
      bias = `BEARISH ${pair} — Negative carry (${differential.toFixed(2)}%) with adverse policy divergence`;
    } else if (Math.abs(differential) < 0.5) {
      bias = `NEUTRAL — Minimal rate differential (${differential.toFixed(2)}%). FX driven by other factors.`;
    } else {
      bias = `MIXED — Rate differential (${differential.toFixed(2)}%) conflicts with policy direction.`;
    }

    return formatToolResult({
      pair,
      baseCurrency: { currency: base, bank: baseRate.bank, rate: `${baseRate.rate}%`, direction: baseRate.direction, lastChanged: baseRate.lastChanged },
      quoteCurrency: { currency: quote, bank: quoteRate.bank, rate: `${quoteRate.rate}%`, direction: quoteRate.direction, lastChanged: quoteRate.lastChanged },
      differential: { value: `${differential > 0 ? '+' : ''}${differential.toFixed(2)}%`, dailyCarryBps: `${(dailyCarry * 100).toFixed(2)} bps` },
      policyDivergence: { score: divergence, interpretation: divergence > 0 ? `${base} tightening relative to ${quote}` : divergence < 0 ? `${quote} tightening relative to ${base}` : 'No divergence' },
      bias,
      note: 'Central bank rates are reference values. Use web_search for the latest rate decisions.',
    }, []);
  },
});

const MacroRegimeInputSchema = z.object({
  country: z.enum(['US', 'EU', 'JP', 'GB', 'AU', 'CA', 'CH', 'NZ', 'CN']).describe('Country/economy to analyze'),
});

export const getMacroRegime = new DynamicStructuredTool({
  name: 'get_macro_regime',
  description: 'Classify current macroeconomic regime using leading indicators (GDP, PMI, CPI, unemployment, retail sales). Returns regime state (expansion/slowdown/contraction/recovery), trend direction, and FX implications.',
  schema: MacroRegimeInputSchema,
  func: async (input, _runManager, config?: RunnableConfig) => {
    const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
    onProgress?.(`Analyzing macro regime for ${input.country}...`);

    const countryNames: Record<string, string> = {
      US: 'United States', EU: 'Euro Area', JP: 'Japan', GB: 'United Kingdom',
      AU: 'Australia', CA: 'Canada', CH: 'Switzerland', NZ: 'New Zealand', CN: 'China',
    };
    const countryName = countryNames[input.country] || input.country;

    const [gdpData, cpiData, unemploymentData, pmiData, retailData] = await Promise.all([
      fetchEconomicIndicator('real_gdp', countryName, 12),
      fetchEconomicIndicator('cpi', countryName, 24),
      fetchEconomicIndicator('unemployment_rate', countryName, 12),
      fetchEconomicIndicator('pmi_manufacturing', countryName, 12),
      fetchEconomicIndicator('retail_sales', countryName, 12),
    ]);

    const indicators: Array<{ name: string; latest: number | null; previous: number | null; trend: string; signal: string; data: Array<{ date: string; value: number }> }> = [];

    function analyzeIndicator(
      name: string, data: Array<{ date: string; value: number }>,
      thresholds: { expansion: number; contraction: number; inverted?: boolean },
    ) {
      if (data.length < 2) { indicators.push({ name, latest: null, previous: null, trend: 'UNKNOWN', signal: 'NO_DATA', data: [] }); return; }
      const latest = data[data.length - 1].value;
      const previous = data[data.length - 2].value;
      const change = latest - previous;
      const inv = thresholds.inverted ?? false;
      const signal = !inv
        ? (latest > thresholds.expansion ? 'EXPANSION' : latest < thresholds.contraction ? 'CONTRACTION' : 'NEUTRAL')
        : (latest < thresholds.expansion ? 'EXPANSION' : latest > thresholds.contraction ? 'CONTRACTION' : 'NEUTRAL');
      const trend = change > 0 ? (inv ? 'DETERIORATING' : 'IMPROVING') : change < 0 ? (inv ? 'IMPROVING' : 'DETERIORATING') : 'STABLE';
      indicators.push({ name, latest: Math.round(latest * 100) / 100, previous: Math.round(previous * 100) / 100, trend, signal, data: data.slice(-6) });
    }

    analyzeIndicator('GDP Growth (QoQ)', gdpData, { expansion: 2.0, contraction: 0 });
    analyzeIndicator('CPI (YoY %)', cpiData, { expansion: 3.0, contraction: 1.0 });
    analyzeIndicator('Unemployment Rate', unemploymentData, { expansion: 4.5, contraction: 6.0, inverted: true });
    analyzeIndicator('PMI Manufacturing', pmiData, { expansion: 52, contraction: 48 });
    analyzeIndicator('Retail Sales (MoM %)', retailData, { expansion: 0.3, contraction: -0.3 });

    const valid = indicators.filter(i => i.signal !== 'NO_DATA');
    const expansionCount = valid.filter(i => i.signal === 'EXPANSION').length;
    const contractionCount = valid.filter(i => i.signal === 'CONTRACTION').length;
    const improvingCount = valid.filter(i => i.trend === 'IMPROVING').length;

    let regime: string;
    let confidence: string;
    if (expansionCount >= 3 && improvingCount >= 2) { regime = 'EXPANSION'; confidence = expansionCount >= 4 ? 'HIGH' : 'MODERATE'; }
    else if (contractionCount >= 3) { regime = 'CONTRACTION'; confidence = contractionCount >= 4 ? 'HIGH' : 'MODERATE'; }
    else if (expansionCount >= 2 && improvingCount < 2) { regime = 'SLOWDOWN'; confidence = 'MODERATE'; }
    else if (contractionCount >= 2 && improvingCount >= 2) { regime = 'RECOVERY'; confidence = 'MODERATE'; }
    else { regime = 'MIXED'; confidence = 'LOW'; }

    const currency = input.country === 'EU' ? 'EUR' : input.country === 'GB' ? 'GBP' : input.country;
    const fxImplication: Record<string, string> = {
      EXPANSION: `${currency} positive: Strong growth supports currency via rate expectations and capital inflows`,
      SLOWDOWN: `${currency} weakening: Growth decelerating; market pricing in future easing`,
      CONTRACTION: `${currency} bearish: Economic contraction drives rate cut expectations and capital outflows`,
      RECOVERY: `${currency} cautiously positive: Early recovery phase; watch for confirmation`,
      MIXED: `${currency} neutral: Conflicting signals; no clear macro directional bias`,
    };

    return formatToolResult({
      country: input.country, countryName,
      regime: { state: regime, confidence, fxImplication: fxImplication[regime] },
      indicators,
      scoring: { expansionSignals: expansionCount, contractionSignals: contractionCount, improvingTrends: improvingCount, totalIndicators: valid.length },
      tradingImplications: {
        carryTrade: regime === 'EXPANSION' ? 'Supportive — expect rate holds or hikes' : regime === 'CONTRACTION' ? 'Adverse — expect rate cuts' : 'Neutral',
        riskAssets: regime === 'EXPANSION' ? 'Risk-on: favor high-beta currencies (AUD, NZD) and equity indices' : regime === 'CONTRACTION' ? 'Risk-off: favor safe havens (JPY, CHF, gold)' : 'Selective positioning',
      },
    }, []);
  },
});

const CrossAssetInputSchema = z.object({});

export const getCrossAssetRegime = new DynamicStructuredTool({
  name: 'get_cross_asset_regime',
  description: 'Detect current risk-on/risk-off regime by analyzing cross-asset price behavior: equity indices, gold, JPY as safe haven. Returns composite risk score and positioning implications.',
  schema: CrossAssetInputSchema,
  func: async (_input, _runManager, config?: RunnableConfig) => {
    const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
    onProgress?.('Analyzing cross-asset regime...');

    const apiKey = getApiKey();
    async function fetchQuote(symbol: string): Promise<{ price: number; change: number } | null> {
      try {
        const url = new URL('https://api.twelvedata.com/quote');
        if (apiKey) url.searchParams.append('apikey', apiKey);
        url.searchParams.append('symbol', symbol);
        const response = await rateLimitedFetch(url.toString());
        if (!response.ok) return null;
        const data = await response.json() as Record<string, unknown>;
        return { price: parseFloat(data.close as string) || 0, change: parseFloat(data.percent_change as string) || 0 };
      } catch { return null; }
    }

    const [spx, gold, usdjpy, audjpy] = await Promise.all([
      fetchQuote('SPX'), fetchQuote('XAU/USD'), fetchQuote('USD/JPY'), fetchQuote('AUD/JPY'),
    ]);

    const signals: Array<{ asset: string; change: number; signal: string; weight: number }> = [];
    if (spx) signals.push({ asset: 'S&P 500', change: spx.change, signal: spx.change > 0.3 ? 'RISK_ON' : spx.change < -0.3 ? 'RISK_OFF' : 'NEUTRAL', weight: 2 });
    if (gold) signals.push({ asset: 'Gold', change: gold.change, signal: gold.change > 0.5 ? 'RISK_OFF' : gold.change < -0.5 ? 'RISK_ON' : 'NEUTRAL', weight: 1.5 });
    if (usdjpy) signals.push({ asset: 'USD/JPY', change: usdjpy.change, signal: usdjpy.change > 0.2 ? 'RISK_ON' : usdjpy.change < -0.2 ? 'RISK_OFF' : 'NEUTRAL', weight: 1.5 });
    if (audjpy) signals.push({ asset: 'AUD/JPY', change: audjpy.change, signal: audjpy.change > 0.3 ? 'RISK_ON' : audjpy.change < -0.3 ? 'RISK_OFF' : 'NEUTRAL', weight: 2 });

    let totalWeight = 0, weightedScore = 0;
    for (const s of signals) {
      weightedScore += (s.signal === 'RISK_ON' ? 1 : s.signal === 'RISK_OFF' ? -1 : 0) * s.weight;
      totalWeight += s.weight;
    }
    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const regime = score > 0.3 ? 'RISK_ON' : score < -0.3 ? 'RISK_OFF' : 'MIXED';

    return formatToolResult({
      regime: { state: regime, score: Math.round(score * 100) / 100, scale: '-1.0 (risk-off) to +1.0 (risk-on)' },
      signals,
      positioning: regime === 'RISK_ON'
        ? 'Favor: AUD, NZD, equity indices. Avoid: JPY longs, gold longs.'
        : regime === 'RISK_OFF'
        ? 'Favor: JPY, CHF, gold. Avoid: AUD, NZD, equity index longs.'
        : 'No clear directional bias. Focus on instrument-specific setups.',
    }, []);
  },
});

// ============================================================================
// Tool: Yield Curve Analysis
// ============================================================================

const YieldCurveInputSchema = z.object({
  country: z.enum(['US', 'GB', 'JP', 'EU']).default('US').describe('Country for yield curve analysis'),
});

export const getYieldCurve = new DynamicStructuredTool({
  name: 'get_yield_curve',
  description: 'Analyze the yield curve shape, slope (10Y-2Y spread), and inversion status. Yield curve inversion is one of the most reliable recession indicators. Includes term premium estimation, curve steepness, and FX implications.',
  schema: YieldCurveInputSchema,
  func: async (input, _runManager, config?: RunnableConfig) => {
    const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
    onProgress?.(`Fetching yield curve data for ${input.country}...`);

    const apiKey = getApiKey();

    // Tenor symbols by country
    const tenorMap: Record<string, Record<string, string>> = {
      US: { '3M': 'GB:US3M', '2Y': 'GB:US2Y', '5Y': 'GB:US5Y', '10Y': 'GB:US10Y', '30Y': 'GB:US30Y' },
      GB: { '2Y': 'GB:UK2Y', '10Y': 'GB:UK10Y' },
      JP: { '2Y': 'GB:JP2Y', '10Y': 'GB:JP10Y' },
      EU: { '2Y': 'GB:DE2Y', '10Y': 'GB:DE10Y' },
    };

    const tenors = tenorMap[input.country] || tenorMap.US;
    const yields: Record<string, number | null> = {};

    // Fetch each tenor
    for (const [tenor, symbol] of Object.entries(tenors)) {
      try {
        const url = new URL('https://api.twelvedata.com/quote');
        if (apiKey) url.searchParams.append('apikey', apiKey);
        url.searchParams.append('symbol', symbol);
        const response = await rateLimitedFetch(url.toString());
        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;
          yields[tenor] = parseFloat(data.close as string) || null;
        } else {
          yields[tenor] = null;
        }
      } catch {
        yields[tenor] = null;
      }
    }

    const y2 = yields['2Y'];
    const y10 = yields['10Y'];
    const y3m = yields['3M'];
    const y30 = yields['30Y'];

    // 10Y-2Y spread (most watched)
    const spread10y2y = y10 !== null && y2 !== null ? y10 - y2 : null;
    // 10Y-3M spread (Fed preferred)
    const spread10y3m = y10 !== null && y3m !== null ? y10 - y3m : null;
    // Term premium (30Y-10Y)
    const termPremium = y30 !== null && y10 !== null ? y30 - y10 : null;

    const isInverted10y2y = spread10y2y !== null && spread10y2y < 0;
    const isInverted10y3m = spread10y3m !== null && spread10y3m < 0;

    // Curve shape classification
    let shape: string;
    if (isInverted10y2y || isInverted10y3m) {
      shape = 'INVERTED';
    } else if (spread10y2y !== null && spread10y2y < 0.25) {
      shape = 'FLAT';
    } else if (spread10y2y !== null && spread10y2y > 1.5) {
      shape = 'STEEP';
    } else {
      shape = 'NORMAL';
    }

    const currency = input.country === 'EU' ? 'EUR' : input.country === 'GB' ? 'GBP' : input.country === 'JP' ? 'JPY' : 'USD';

    return formatToolResult({
      country: input.country,
      yields: Object.fromEntries(Object.entries(yields).map(([k, v]) => [k, v !== null ? `${v.toFixed(3)}%` : 'N/A'])),
      spreads: {
        '10Y_2Y': spread10y2y !== null ? `${(spread10y2y * 100).toFixed(0)} bps` : 'N/A',
        '10Y_3M': spread10y3m !== null ? `${(spread10y3m * 100).toFixed(0)} bps` : 'N/A',
        termPremium30Y10Y: termPremium !== null ? `${(termPremium * 100).toFixed(0)} bps` : 'N/A',
      },
      curveShape: {
        classification: shape,
        isInverted: isInverted10y2y || isInverted10y3m,
        description: shape === 'INVERTED'
          ? 'RECESSION WARNING: Yield curve is inverted. Historically precedes recession by 6-18 months. Markets pricing in future rate cuts.'
          : shape === 'FLAT'
            ? 'Late-cycle signal. Flat curve indicates market uncertainty about growth trajectory. Watch for inversion.'
            : shape === 'STEEP'
              ? 'Early-cycle or recovery signal. Market expects higher growth/inflation ahead. Generally positive for risk assets.'
              : 'Normal upward sloping curve. No extreme signal.',
      },
      fxImplication: {
        currency,
        rationale: shape === 'INVERTED'
          ? `${currency} risk: Curve inversion signals rate cuts ahead → ${currency} bearish medium-term, but initial safe-haven flows may support temporarily`
          : shape === 'STEEP'
            ? `${currency} supportive: Steepening curve suggests economic optimism → supports ${currency} via rate expectations`
            : `${currency} neutral: Normal curve shape provides no directional signal for ${currency}`,
      },
    }, []);
  },
});

// ============================================================================
// Tool: Macro Divergence Score
// ============================================================================

const MacroDivergenceInputSchema = z.object({
  baseCurrency: z.string().describe('Base currency country (e.g., US, EU, JP, GB, AU, CA, CH, NZ)'),
  quoteCurrency: z.string().describe('Quote currency country'),
});

export const getMacroDivergence = new DynamicStructuredTool({
  name: 'get_macro_divergence',
  description: 'Compare macro regimes between two economies to assess FX directional bias. Combines GDP, PMI, CPI, employment, and rate differentials into a composite divergence score. Higher divergence = stronger directional FX signal.',
  schema: MacroDivergenceInputSchema,
  func: async (input, _runManager, config?: RunnableConfig) => {
    const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
    onProgress?.(`Comparing macro regimes: ${input.baseCurrency} vs ${input.quoteCurrency}...`);

    const countryNames: Record<string, string> = {
      US: 'United States', EU: 'Euro Area', JP: 'Japan', GB: 'United Kingdom',
      AU: 'Australia', CA: 'Canada', CH: 'Switzerland', NZ: 'New Zealand', CN: 'China',
    };

    const base = input.baseCurrency.toUpperCase();
    const quote = input.quoteCurrency.toUpperCase();
    const baseName = countryNames[base] || base;
    const quoteName = countryNames[quote] || quote;

    // Fetch indicators for both countries
    const indicators = ['real_gdp', 'cpi', 'unemployment_rate', 'pmi_manufacturing'] as const;

    const [baseData, quoteData] = await Promise.all([
      Promise.all(indicators.map(ind => fetchEconomicIndicator(ind, baseName, 6))),
      Promise.all(indicators.map(ind => fetchEconomicIndicator(ind, quoteName, 6))),
    ]);

    const indicatorLabels = ['GDP Growth', 'CPI Inflation', 'Unemployment', 'PMI Manufacturing'];
    const comparison: Array<{
      indicator: string;
      base: { latest: number | null; trend: string };
      quote: { latest: number | null; trend: string };
      divergence: number;
      favorsCurrency: string;
    }> = [];

    let compositeScore = 0;
    let validCount = 0;

    for (let i = 0; i < indicators.length; i++) {
      const bd = baseData[i];
      const qd = quoteData[i];

      const bLatest = bd.length > 0 ? bd[bd.length - 1].value : null;
      const qLatest = qd.length > 0 ? qd[qd.length - 1].value : null;
      const bPrev = bd.length > 1 ? bd[bd.length - 2].value : null;
      const qPrev = qd.length > 1 ? qd[qd.length - 2].value : null;

      const bTrend = bLatest !== null && bPrev !== null ? (bLatest > bPrev ? 'IMPROVING' : bLatest < bPrev ? 'DETERIORATING' : 'STABLE') : 'UNKNOWN';
      const qTrend = qLatest !== null && qPrev !== null ? (qLatest > qPrev ? 'IMPROVING' : qLatest < qPrev ? 'DETERIORATING' : 'STABLE') : 'UNKNOWN';

      let div = 0;
      let favors = 'NEUTRAL';
      if (bLatest !== null && qLatest !== null) {
        validCount++;
        const isInverted = indicators[i] === 'unemployment_rate';
        if (isInverted) {
          div = qLatest - bLatest; // Lower unemployment = better
        } else {
          div = bLatest - qLatest;
        }

        // GDP and PMI: higher = better for currency
        // CPI: moderate is good, too high or too low is bad
        // Unemployment: lower = better
        if (indicators[i] === 'cpi') {
          // CPI: closer to 2% target is better
          const bDistFromTarget = Math.abs(bLatest - 2.0);
          const qDistFromTarget = Math.abs(qLatest - 2.0);
          div = qDistFromTarget - bDistFromTarget; // positive = base closer to target
        }

        if (div > 0) favors = base;
        else if (div < 0) favors = quote;

        // Trend scoring
        const trendScore = (bTrend === 'IMPROVING' ? 1 : bTrend === 'DETERIORATING' ? -1 : 0)
          - (qTrend === 'IMPROVING' ? 1 : qTrend === 'DETERIORATING' ? -1 : 0);
        compositeScore += (div > 0 ? 1 : div < 0 ? -1 : 0) + trendScore * 0.5;
      }

      comparison.push({
        indicator: indicatorLabels[i],
        base: { latest: bLatest !== null ? Math.round(bLatest * 100) / 100 : null, trend: bTrend },
        quote: { latest: qLatest !== null ? Math.round(qLatest * 100) / 100 : null, trend: qTrend },
        divergence: Math.round(div * 100) / 100,
        favorsCurrency: favors,
      });
    }

    // Rate differential
    const baseRate = CENTRAL_BANK_RATES[base];
    const quoteRate = CENTRAL_BANK_RATES[quote];
    const rateDiff = baseRate && quoteRate ? baseRate.rate - quoteRate.rate : 0;
    if (baseRate && quoteRate) {
      compositeScore += rateDiff > 1 ? 1.5 : rateDiff > 0 ? 0.5 : rateDiff < -1 ? -1.5 : rateDiff < 0 ? -0.5 : 0;
      validCount++;
    }

    const normalizedScore = validCount > 0 ? compositeScore / validCount : 0;
    const pair = `${base}/${quote}`;

    return formatToolResult({
      pair,
      base: { country: base, name: baseName },
      quote: { country: quote, name: quoteName },
      indicators: comparison,
      rateDifferential: baseRate && quoteRate ? {
        base: `${baseRate.rate}% (${baseRate.direction})`,
        quote: `${quoteRate.rate}% (${quoteRate.direction})`,
        spread: `${rateDiff > 0 ? '+' : ''}${rateDiff.toFixed(2)}%`,
      } : null,
      compositeScore: {
        raw: Math.round(compositeScore * 100) / 100,
        normalized: Math.round(normalizedScore * 1000) / 1000,
        scale: '-2.0 (strong quote bias) to +2.0 (strong base bias)',
        validIndicators: validCount,
      },
      signal: normalizedScore > 0.5
        ? `BULLISH ${pair}: Macro fundamentals favor ${base} over ${quote}. Score: ${normalizedScore.toFixed(2)}`
        : normalizedScore < -0.5
          ? `BEARISH ${pair}: Macro fundamentals favor ${quote} over ${base}. Score: ${normalizedScore.toFixed(2)}`
          : `NEUTRAL: No strong macro divergence between ${base} and ${quote}. Score: ${normalizedScore.toFixed(2)}`,
      confidence: validCount >= 4 ? 'HIGH' : validCount >= 2 ? 'MODERATE' : 'LOW',
    }, []);
  },
});

// ============================================================================
// Tool: Seasonal Pattern Analysis
// ============================================================================

const SeasonalInputSchema = z.object({
  symbol: z.string().describe('Instrument symbol'),
  yearsBack: z.number().default(5).describe('Number of years of data to analyze (max 10)'),
});

export const getSeasonalPattern = new DynamicStructuredTool({
  name: 'get_seasonal_pattern',
  description: 'Analyze monthly/quarterly seasonal patterns in an instrument. Returns average return, win rate, and consistency for each month. Useful for timing entries and understanding calendar effects.',
  schema: SeasonalInputSchema,
  func: async (input) => {
    const resolved = resolveSymbol(input.symbol);
    if (!resolved) {
      return formatToolResult({ error: `Unknown instrument: ${input.symbol}` }, []);
    }

    // Fetch weekly data (more efficient for multi-year)
    const outputsize = Math.min(input.yearsBack * 52, 520);
    const { data } = await api.get('/time_series', {
      symbol: resolved.apiSymbol,
      interval: '1week',
      outputsize,
    });

    const values = (data.values || []) as Array<{ close: string; datetime: string }>;
    if (values.length < 52) {
      return formatToolResult({ error: 'Insufficient data for seasonal analysis (need at least 1 year)' }, []);
    }

    // Reverse to chronological
    const chronological = [...values].reverse();

    // Group by month
    const monthlyReturns: Record<number, number[]> = {};
    for (let m = 1; m <= 12; m++) monthlyReturns[m] = [];

    // Calculate monthly returns from weekly data
    let prevMonthClose: number | null = null;
    let prevMonth: number | null = null;

    for (const bar of chronological) {
      const date = new Date(bar.datetime);
      const month = date.getMonth() + 1;
      const close = parseFloat(bar.close);

      if (prevMonth !== null && prevMonth !== month && prevMonthClose !== null) {
        const ret = (close - prevMonthClose) / prevMonthClose;
        monthlyReturns[month].push(ret);
        prevMonthClose = close;
        prevMonth = month;
      } else if (prevMonth === null || prevMonth !== month) {
        prevMonthClose = close;
        prevMonth = month;
      }
    }

    const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const monthly = Object.entries(monthlyReturns).map(([m, rets]) => {
      const month = parseInt(m);
      if (rets.length === 0) return { month: monthNames[month], avgReturn: 0, winRate: 0, sampleSize: 0, consistency: 'NO_DATA' };
      const avg = rets.reduce((s, v) => s + v, 0) / rets.length;
      const wins = rets.filter(r => r > 0).length;
      const winRate = wins / rets.length;
      const consistency = winRate > 0.7 ? 'STRONG' : winRate > 0.6 ? 'MODERATE' : 'WEAK';
      return {
        month: monthNames[month],
        avgReturn: `${(avg * 100).toFixed(2)}%`,
        winRate: `${(winRate * 100).toFixed(0)}%`,
        sampleSize: rets.length,
        consistency,
      };
    });

    // Best and worst months
    const validMonths = monthly.filter(m => m.sampleSize > 0);
    const sorted = [...validMonths].sort((a, b) => parseFloat(String(b.avgReturn)) - parseFloat(String(a.avgReturn)));

    // Quarterly aggregation
    const quarters = [
      { name: 'Q1 (Jan-Mar)', months: [1, 2, 3] },
      { name: 'Q2 (Apr-Jun)', months: [4, 5, 6] },
      { name: 'Q3 (Jul-Sep)', months: [7, 8, 9] },
      { name: 'Q4 (Oct-Dec)', months: [10, 11, 12] },
    ].map(q => {
      const qRets = q.months.flatMap(m => monthlyReturns[m]);
      if (qRets.length === 0) return { quarter: q.name, avgReturn: 'N/A', winRate: 'N/A' };
      const avg = qRets.reduce((s, v) => s + v, 0) / qRets.length;
      const winRate = qRets.filter(r => r > 0).length / qRets.length;
      return { quarter: q.name, avgReturn: `${(avg * 100).toFixed(2)}%`, winRate: `${(winRate * 100).toFixed(0)}%` };
    });

    // Current month context
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentMonthData = monthly[currentMonth - 1];

    return formatToolResult({
      instrument: input.symbol.toUpperCase(),
      yearsAnalyzed: input.yearsBack,
      currentMonth: {
        name: monthNames[currentMonth],
        historicalPattern: currentMonthData,
      },
      monthlyPatterns: monthly,
      quarterlyPatterns: quarters,
      bestMonths: sorted.slice(0, 3).map(m => `${m.month}: ${m.avgReturn} (${m.winRate} win rate)`),
      worstMonths: sorted.slice(-3).reverse().map(m => `${m.month}: ${m.avgReturn} (${m.winRate} win rate)`),
    }, []);
  },
});
