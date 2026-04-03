import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { api, resolveSymbol, FINTOKEI_INSTRUMENTS } from './api.js';
import { formatToolResult } from '../types.js';

export const STATISTICAL_ANALYSIS_DESCRIPTION = `
Quantitative statistical analysis engine for FX, indices, and commodities. Computes rigorous statistical metrics from price data for evidence-based trading decisions.

## When to Use

- Z-score analysis: measure how far price/indicator deviates from mean (mean-reversion signals)
- Rolling correlation: measure co-movement between instruments (pair trading, hedging, exposure analysis)
- Volatility regime detection: classify current market state (low-vol, normal, high-vol, crisis)
- Distribution analysis: skewness, kurtosis, normality tests on returns
- Rolling statistics: moving mean, std dev, percentile rank of any metric
- Autocorrelation: test if returns have momentum or mean-reversion tendency
- Hurst exponent estimation: determine if series is trending, random-walk, or mean-reverting
- Drawdown distribution: statistical analysis of historical drawdown patterns
- Return distribution: histogram, VaR, CVaR (Expected Shortfall) calculations

## When NOT to Use

- Just need current price (use get_market_data)
- Economic event lookup (use economic_calendar)
- Fintokei rules (use fintokei_rules tools)
- Macro indicator analysis (use macro_analysis)
- Strategy backtesting (use quant_strategy tools)

## Usage Notes

- All calculations performed server-side on raw OHLCV data
- Z-scores >2.0 or <-2.0 indicate statistically significant deviation
- Correlation >0.7 or <-0.7 considered strong
- Hurst >0.5 = trending, =0.5 = random walk, <0.5 = mean-reverting
- Returns distribution helps determine if standard risk models (assuming normality) are appropriate
`.trim();

/**
 * Fetch historical close prices for an instrument.
 */
async function fetchCloses(symbol: string, interval: string, outputsize: number): Promise<{ closes: number[]; dates: string[] }> {
  const resolved = resolveSymbol(symbol);
  if (!resolved) throw new Error(`Unknown instrument: ${symbol}`);

  const { data } = await api.get('/time_series', {
    symbol: resolved.apiSymbol,
    interval,
    outputsize,
  });

  const values = (data.values || []) as Array<{ close: string; datetime: string }>;
  // Twelve Data returns newest first — reverse for chronological order
  const reversed = [...values].reverse();
  return {
    closes: reversed.map(v => parseFloat(v.close)),
    dates: reversed.map(v => v.datetime),
  };
}

/**
 * Compute log returns from a price series.
 */
function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  return returns;
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function skewness(arr: number[]): number {
  const n = arr.length;
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  const sum = arr.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

function kurtosis(arr: number[]): number {
  const n = arr.length;
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  const sum = arr.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0);
  const excess = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum
    - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return excess;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let cov = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    sa += da * da;
    sb += db * db;
  }
  const denom = Math.sqrt(sa * sb);
  return denom === 0 ? 0 : cov / denom;
}

/**
 * Autocorrelation at a given lag.
 */
function autocorrelation(arr: number[], lag: number): number {
  const n = arr.length;
  const m = mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    den += (arr[i] - m) ** 2;
    if (i >= lag) {
      num += (arr[i] - m) * (arr[i - lag] - m);
    }
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Estimate Hurst exponent using R/S analysis.
 */
function hurstExponent(arr: number[]): number {
  const n = arr.length;
  if (n < 20) return 0.5;

  const sizes = [10, 20, 40, 80, 160].filter(s => s <= n / 2);
  if (sizes.length < 2) return 0.5;

  const logRS: number[] = [];
  const logN: number[] = [];

  for (const size of sizes) {
    const numChunks = Math.floor(n / size);
    let totalRS = 0;

    for (let c = 0; c < numChunks; c++) {
      const chunk = arr.slice(c * size, (c + 1) * size);
      const m = mean(chunk);
      const cumDev: number[] = [];
      let cumSum = 0;
      for (const v of chunk) {
        cumSum += v - m;
        cumDev.push(cumSum);
      }
      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = stdDev(chunk);
      totalRS += S > 0 ? R / S : 0;
    }

    const avgRS = totalRS / numChunks;
    if (avgRS > 0) {
      logRS.push(Math.log(avgRS));
      logN.push(Math.log(size));
    }
  }

  if (logRS.length < 2) return 0.5;

  // Simple linear regression slope
  const mX = mean(logN);
  const mY = mean(logRS);
  let num = 0, den = 0;
  for (let i = 0; i < logN.length; i++) {
    num += (logN[i] - mX) * (logRS[i] - mY);
    den += (logN[i] - mX) ** 2;
  }
  return den === 0 ? 0.5 : num / den;
}

// ============================================================================
// Tool: Z-Score Analysis
// ============================================================================

const ZScoreInputSchema = z.object({
  symbol: z.string().describe('Instrument symbol (e.g., EUR/USD, XAUUSD, US30)'),
  interval: z.enum(['1h', '4h', '1day', '1week']).describe('Timeframe'),
  lookback: z.number().default(100).describe('Lookback period for mean/std calculation'),
  metric: z.enum(['price', 'returns', 'atr_normalized']).default('price').describe('Metric to compute z-score on'),
});

export const getZScore = new DynamicStructuredTool({
  name: 'get_zscore',
  description: 'Compute z-score of current price or returns relative to historical distribution. Z > 2.0 = overbought, Z < -2.0 = oversold in statistical terms. Includes percentile rank and mean-reversion probability.',
  schema: ZScoreInputSchema,
  func: async (input) => {
    const { closes, dates } = await fetchCloses(input.symbol, input.interval, input.lookback + 1);
    if (closes.length < 20) {
      return formatToolResult({ error: 'Insufficient data for z-score calculation' }, []);
    }

    let series: number[];
    let label: string;
    if (input.metric === 'returns') {
      series = logReturns(closes);
      label = 'log returns';
    } else {
      series = closes;
      label = 'price';
    }

    const m = mean(series);
    const s = stdDev(series);
    const current = series[series.length - 1];
    const zScore = s > 0 ? (current - m) / s : 0;

    // Percentile rank
    const rank = series.filter(v => v <= current).length / series.length * 100;

    // Rolling z-scores (last 10)
    const rollingZ: Array<{ date: string; zscore: number }> = [];
    for (let i = Math.max(0, series.length - 10); i < series.length; i++) {
      const windowEnd = i + 1;
      const windowStart = Math.max(0, windowEnd - input.lookback);
      const window = series.slice(windowStart, windowEnd);
      const wm = mean(window);
      const ws = stdDev(window);
      rollingZ.push({
        date: dates[input.metric === 'returns' ? i + 1 : i],
        zscore: Math.round((ws > 0 ? (series[i] - wm) / ws : 0) * 1000) / 1000,
      });
    }

    // Mean-reversion probability (based on historical z-score distribution)
    const historicalZScores = series.map((v, i) => {
      const window = series.slice(Math.max(0, i - input.lookback + 1), i + 1);
      const wm = mean(window);
      const ws = stdDev(window);
      return ws > 0 ? (v - wm) / ws : 0;
    });
    const extremeReversions = historicalZScores.filter((z, i) => {
      if (i >= historicalZScores.length - 1) return false;
      if (Math.abs(z) > 2.0) {
        return z > 0 ? historicalZScores[i + 1] < z : historicalZScores[i + 1] > z;
      }
      return false;
    });
    const extremeCount = historicalZScores.filter(z => Math.abs(z) > 2.0).length;
    const reversionRate = extremeCount > 0 ? extremeReversions.length / extremeCount : 0;

    return formatToolResult({
      instrument: input.symbol.toUpperCase(),
      metric: label,
      interval: input.interval,
      lookback: input.lookback,
      current: Math.round(current * 100000) / 100000,
      mean: Math.round(m * 100000) / 100000,
      stdDev: Math.round(s * 100000) / 100000,
      zScore: Math.round(zScore * 1000) / 1000,
      percentileRank: Math.round(rank * 10) / 10,
      interpretation: Math.abs(zScore) > 3 ? 'EXTREME' : Math.abs(zScore) > 2 ? 'SIGNIFICANT' : Math.abs(zScore) > 1 ? 'MODERATE' : 'NORMAL',
      meanReversionProbability: `${(reversionRate * 100).toFixed(1)}%`,
      rollingZScores: rollingZ,
    }, []);
  },
});

// ============================================================================
// Tool: Correlation Matrix
// ============================================================================

const CorrelationInputSchema = z.object({
  symbols: z.array(z.string()).min(2).max(8).describe('Array of instrument symbols to correlate'),
  interval: z.enum(['1h', '4h', '1day', '1week']).default('1day').describe('Timeframe'),
  lookback: z.number().default(60).describe('Number of periods for correlation calculation'),
});

export const getCorrelationMatrix = new DynamicStructuredTool({
  name: 'get_correlation_matrix',
  description: 'Compute pairwise return correlation matrix for multiple instruments. Essential for portfolio risk decomposition, identifying hidden USD/JPY/risk exposure, and avoiding over-concentrated positions in Fintokei challenges.',
  schema: CorrelationInputSchema,
  func: async (input, _runManager, config?: RunnableConfig) => {
    const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
    onProgress?.(`Computing correlations for ${input.symbols.length} instruments...`);

    // Fetch all price series in parallel
    const allData = await Promise.all(
      input.symbols.map(async (sym) => {
        try {
          const { closes } = await fetchCloses(sym, input.interval, input.lookback + 1);
          return { symbol: sym.toUpperCase(), returns: logReturns(closes), error: null };
        } catch (error) {
          return { symbol: sym.toUpperCase(), returns: [] as number[], error: error instanceof Error ? error.message : String(error) };
        }
      })
    );

    const valid = allData.filter(d => d.returns.length > 10);
    if (valid.length < 2) {
      return formatToolResult({ error: 'Need at least 2 instruments with sufficient data' }, []);
    }

    // Compute correlation matrix
    const matrix: Record<string, Record<string, number>> = {};
    for (const a of valid) {
      matrix[a.symbol] = {};
      for (const b of valid) {
        const corr = correlation(a.returns, b.returns);
        matrix[a.symbol][b.symbol] = Math.round(corr * 1000) / 1000;
      }
    }

    // Identify strongest correlations
    const pairs: Array<{ pair: string; correlation: number; type: string }> = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const corr = matrix[valid[i].symbol][valid[j].symbol];
        if (Math.abs(corr) > 0.5) {
          pairs.push({
            pair: `${valid[i].symbol} / ${valid[j].symbol}`,
            correlation: corr,
            type: corr > 0.7 ? 'STRONG_POSITIVE' : corr > 0.5 ? 'MODERATE_POSITIVE' : corr < -0.7 ? 'STRONG_NEGATIVE' : 'MODERATE_NEGATIVE',
          });
        }
      }
    }
    pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    // Risk warnings
    const warnings: string[] = [];
    const strongPositive = pairs.filter(p => p.correlation > 0.7);
    if (strongPositive.length > 0) {
      warnings.push(`High correlation risk: ${strongPositive.map(p => p.pair).join(', ')}. Trading these in the same direction multiplies exposure.`);
    }

    return formatToolResult({
      instruments: valid.map(v => v.symbol),
      interval: input.interval,
      lookback: input.lookback,
      matrix,
      significantPairs: pairs,
      warnings,
      errors: allData.filter(d => d.error).map(d => ({ symbol: d.symbol, error: d.error })),
    }, []);
  },
});

// ============================================================================
// Tool: Return Distribution Analysis
// ============================================================================

const DistributionInputSchema = z.object({
  symbol: z.string().describe('Instrument symbol'),
  interval: z.enum(['1h', '4h', '1day', '1week']).default('1day').describe('Timeframe'),
  lookback: z.number().default(252).describe('Number of periods (252 ≈ 1 year daily)'),
});

export const getReturnDistribution = new DynamicStructuredTool({
  name: 'get_return_distribution',
  description: 'Analyze the full statistical distribution of returns: mean, std dev, skewness, kurtosis, VaR, CVaR (Expected Shortfall), Jarque-Bera normality test, and Hurst exponent. Essential for understanding tail risk and whether standard models apply.',
  schema: DistributionInputSchema,
  func: async (input) => {
    const { closes } = await fetchCloses(input.symbol, input.interval, input.lookback + 1);
    if (closes.length < 30) {
      return formatToolResult({ error: 'Insufficient data (need at least 30 periods)' }, []);
    }

    const returns = logReturns(closes);
    const n = returns.length;
    const m = mean(returns);
    const s = stdDev(returns);
    const skew = skewness(returns);
    const kurt = kurtosis(returns);

    // Annualize (assuming trading intervals)
    const annualizationFactor = input.interval === '1day' ? 252 : input.interval === '1week' ? 52 : input.interval === '4h' ? 252 * 6 : 252 * 24;
    const annualizedReturn = m * annualizationFactor;
    const annualizedVol = s * Math.sqrt(annualizationFactor);

    // VaR and CVaR (Historical)
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const var95 = percentile(returns, 5);
    const var99 = percentile(returns, 1);
    const cvar95 = mean(sortedReturns.filter(r => r <= var95));
    const cvar99 = mean(sortedReturns.filter(r => r <= var99));

    // Jarque-Bera test for normality
    const jbStat = (n / 6) * (skew ** 2 + (kurt ** 2) / 4);
    const jbCritical5 = 5.99; // chi-squared df=2 at 5%
    const isNormal = jbStat < jbCritical5;

    // Hurst exponent
    const hurst = hurstExponent(returns);
    const hurstInterpretation = hurst > 0.6 ? 'TRENDING' : hurst < 0.4 ? 'MEAN_REVERTING' : 'RANDOM_WALK';

    // Autocorrelation at key lags
    const acf = [1, 2, 3, 5, 10, 20].map(lag => ({
      lag,
      autocorrelation: Math.round(autocorrelation(returns, lag) * 1000) / 1000,
      significant: Math.abs(autocorrelation(returns, lag)) > 1.96 / Math.sqrt(n),
    }));

    // Return histogram (10 bins)
    const min = Math.min(...returns);
    const max = Math.max(...returns);
    const binWidth = (max - min) / 10;
    const histogram = Array.from({ length: 10 }, (_, i) => {
      const lower = min + i * binWidth;
      const upper = lower + binWidth;
      const count = returns.filter(r => r >= lower && (i === 9 ? r <= upper : r < upper)).length;
      return {
        range: `${(lower * 100).toFixed(2)}% to ${(upper * 100).toFixed(2)}%`,
        count,
        frequency: Math.round((count / n) * 1000) / 1000,
      };
    });

    // Maximum drawdown from returns
    let peak = closes[0];
    let maxDD = 0;
    for (const price of closes) {
      if (price > peak) peak = price;
      const dd = (peak - price) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    return formatToolResult({
      instrument: input.symbol.toUpperCase(),
      interval: input.interval,
      sampleSize: n,
      returns: {
        mean: `${(m * 100).toFixed(4)}%`,
        stdDev: `${(s * 100).toFixed(4)}%`,
        annualizedReturn: `${(annualizedReturn * 100).toFixed(2)}%`,
        annualizedVolatility: `${(annualizedVol * 100).toFixed(2)}%`,
        sharpeProxy: annualizedVol > 0 ? Math.round((annualizedReturn / annualizedVol) * 100) / 100 : 0,
        skewness: Math.round(skew * 1000) / 1000,
        excessKurtosis: Math.round(kurt * 1000) / 1000,
        min: `${(Math.min(...returns) * 100).toFixed(4)}%`,
        max: `${(Math.max(...returns) * 100).toFixed(4)}%`,
      },
      riskMetrics: {
        VaR_95: `${(var95 * 100).toFixed(4)}%`,
        VaR_99: `${(var99 * 100).toFixed(4)}%`,
        CVaR_95: `${(cvar95 * 100).toFixed(4)}%`,
        CVaR_99: `${(cvar99 * 100).toFixed(4)}%`,
        maxDrawdown: `${(maxDD * 100).toFixed(2)}%`,
      },
      normalityTest: {
        jarqueBera: Math.round(jbStat * 100) / 100,
        critical5pct: jbCritical5,
        isNormal,
        interpretation: isNormal
          ? 'Returns are approximately normally distributed. Standard risk models apply.'
          : `Returns are NOT normal (JB=${jbStat.toFixed(1)} > ${jbCritical5}). Fat tails detected — standard VaR underestimates risk. Skew=${skew.toFixed(2)}, Kurtosis=${kurt.toFixed(2)}.`,
      },
      regimeAnalysis: {
        hurstExponent: Math.round(hurst * 1000) / 1000,
        interpretation: hurstInterpretation,
        description: hurst > 0.6
          ? `H=${hurst.toFixed(3)} > 0.6: Series shows persistent trending behavior. Momentum strategies statistically favored.`
          : hurst < 0.4
          ? `H=${hurst.toFixed(3)} < 0.4: Series shows mean-reverting behavior. Counter-trend strategies statistically favored.`
          : `H=${hurst.toFixed(3)} ≈ 0.5: Series behaves like a random walk. No statistical edge from trend or mean-reversion alone.`,
      },
      autocorrelation: acf,
      histogram,
    }, []);
  },
});

// ============================================================================
// Tool: Volatility Regime Detection
// ============================================================================

const VolRegimeInputSchema = z.object({
  symbol: z.string().describe('Instrument symbol'),
  interval: z.enum(['1h', '4h', '1day']).default('1day').describe('Timeframe'),
  lookback: z.number().default(252).describe('Lookback period'),
});

export const getVolatilityRegime = new DynamicStructuredTool({
  name: 'get_volatility_regime',
  description: 'Detect current volatility regime by comparing realized vol to historical percentiles. Classifies into LOW/NORMAL/HIGH/CRISIS regimes. Includes vol term structure (short vs long-term vol) and vol-of-vol for regime change detection.',
  schema: VolRegimeInputSchema,
  func: async (input) => {
    const { closes, dates } = await fetchCloses(input.symbol, input.interval, input.lookback + 1);
    if (closes.length < 60) {
      return formatToolResult({ error: 'Insufficient data (need at least 60 periods)' }, []);
    }

    const returns = logReturns(closes);

    // Compute rolling volatility at multiple windows
    function rollingVol(data: number[], window: number): number[] {
      const vols: number[] = [];
      for (let i = window; i <= data.length; i++) {
        vols.push(stdDev(data.slice(i - window, i)));
      }
      return vols;
    }

    const shortVol = rollingVol(returns, 10);
    const mediumVol = rollingVol(returns, 30);
    const longVol = rollingVol(returns, 60);

    const currentShort = shortVol[shortVol.length - 1] || 0;
    const currentMedium = mediumVol[mediumVol.length - 1] || 0;
    const currentLong = longVol[longVol.length - 1] || 0;

    // Percentile rank of current vol
    const allVol = mediumVol;
    const volPercentile = allVol.filter(v => v <= currentMedium).length / allVol.length * 100;

    // Vol regime classification
    const regime = volPercentile > 90 ? 'CRISIS' : volPercentile > 75 ? 'HIGH' : volPercentile > 25 ? 'NORMAL' : 'LOW';

    // Vol term structure (short vs long)
    const termStructure = currentShort > 0 && currentLong > 0 ? currentShort / currentLong : 1;
    const termStructureState = termStructure > 1.3 ? 'INVERTED (short > long — vol spike / event)' :
      termStructure < 0.7 ? 'STEEP (short < long — vol compression / calm)' : 'FLAT (normal)';

    // Vol-of-vol (second derivative — regime change indicator)
    const volOfVol = stdDev(mediumVol.slice(-30)) / mean(mediumVol.slice(-30));

    // Annualized current vol
    const annFactor = input.interval === '1day' ? Math.sqrt(252) : input.interval === '4h' ? Math.sqrt(252 * 6) : Math.sqrt(252 * 24);
    const annualizedVol = currentMedium * annFactor;

    // Vol history (last 10 data points)
    const volHistory = mediumVol.slice(-10).map((v, i) => ({
      date: dates[dates.length - 10 + i] || '',
      vol30d: Math.round(v * annFactor * 10000) / 100,
    }));

    return formatToolResult({
      instrument: input.symbol.toUpperCase(),
      interval: input.interval,
      regime: {
        current: regime,
        percentile: Math.round(volPercentile * 10) / 10,
        description: regime === 'CRISIS' ? 'Volatility at extreme levels (>90th pctl). Reduce position sizes, widen stops.'
          : regime === 'HIGH' ? 'Elevated volatility (75-90th pctl). Use ATR-based stops, consider smaller positions.'
          : regime === 'LOW' ? 'Low volatility (<25th pctl). Vol expansion likely ahead. Watch for breakouts.'
          : 'Normal volatility range. Standard position sizing applies.',
      },
      volatility: {
        realized10d: `${(currentShort * annFactor * 100).toFixed(2)}%`,
        realized30d: `${(currentMedium * annFactor * 100).toFixed(2)}%`,
        realized60d: `${(currentLong * annFactor * 100).toFixed(2)}%`,
        annualized: `${(annualizedVol * 100).toFixed(2)}%`,
      },
      termStructure: {
        ratio: Math.round(termStructure * 1000) / 1000,
        state: termStructureState,
      },
      volOfVol: {
        value: Math.round(volOfVol * 1000) / 1000,
        interpretation: volOfVol > 0.5 ? 'HIGH — regime change likely in progress' : volOfVol > 0.3 ? 'ELEVATED — vol becoming unstable' : 'STABLE — current regime likely to persist',
      },
      positionSizingImplication: {
        volAdjustedRisk: regime === 'CRISIS' ? '0.25-0.5%' : regime === 'HIGH' ? '0.5-1.0%' : regime === 'LOW' ? '1.0-2.0%' : '1.0-1.5%',
        stopLossMultiplier: regime === 'CRISIS' ? '2.0x ATR' : regime === 'HIGH' ? '1.5x ATR' : '1.0x ATR',
      },
      history: volHistory,
    }, []);
  },
});

// ============================================================================
// Tool: Cointegration Test (Engle-Granger)
// ============================================================================

const CointegrationInputSchema = z.object({
  symbolA: z.string().describe('First instrument symbol (e.g., EUR/USD)'),
  symbolB: z.string().describe('Second instrument symbol (e.g., GBP/USD)'),
  interval: z.enum(['1h', '4h', '1day', '1week']).default('1day').describe('Timeframe'),
  lookback: z.number().default(252).describe('Lookback period'),
});

/**
 * Simple OLS regression: y = alpha + beta * x
 */
function ols(x: number[], y: number[]): { alpha: number; beta: number; residuals: number[] } {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  const beta = den === 0 ? 0 : num / den;
  const alpha = my - beta * mx;
  const residuals = y.slice(0, n).map((yi, i) => yi - alpha - beta * x[i]);
  return { alpha, beta, residuals };
}

/**
 * Augmented Dickey-Fuller t-statistic (simplified).
 * Tests H0: unit root exists (non-stationary).
 */
function adfTStat(series: number[]): number {
  const n = series.length;
  if (n < 10) return 0;
  // First difference
  const dy: number[] = [];
  const yLag: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }
  // OLS: dy = gamma * yLag + error
  const m = dy.length;
  const myLag = mean(yLag);
  const mdy = mean(dy);
  let numGamma = 0, denGamma = 0;
  for (let i = 0; i < m; i++) {
    numGamma += (yLag[i] - myLag) * (dy[i] - mdy);
    denGamma += (yLag[i] - myLag) ** 2;
  }
  const gamma = denGamma === 0 ? 0 : numGamma / denGamma;
  // Standard error of gamma
  const resid = dy.map((d, i) => d - mdy - gamma * (yLag[i] - myLag));
  const sse = resid.reduce((s, r) => s + r * r, 0);
  const sigmaSquared = sse / (m - 2);
  const seGamma = denGamma === 0 ? 1 : Math.sqrt(sigmaSquared / denGamma);
  return seGamma === 0 ? 0 : gamma / seGamma;
}

export const getCointegration = new DynamicStructuredTool({
  name: 'get_cointegration',
  description: 'Engle-Granger cointegration test between two instruments. Tests whether a stable long-run equilibrium exists (useful for pairs trading / spread trading). Returns hedge ratio, spread z-score, half-life of mean reversion, and ADF test statistic.',
  schema: CointegrationInputSchema,
  func: async (input, _runManager, config?: RunnableConfig) => {
    const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
    onProgress?.(`Testing cointegration: ${input.symbolA} vs ${input.symbolB}...`);

    const [dataA, dataB] = await Promise.all([
      fetchCloses(input.symbolA, input.interval, input.lookback + 1),
      fetchCloses(input.symbolB, input.interval, input.lookback + 1),
    ]);

    const n = Math.min(dataA.closes.length, dataB.closes.length);
    if (n < 60) {
      return formatToolResult({ error: 'Insufficient data (need at least 60 periods)' }, []);
    }

    const x = dataA.closes.slice(-n);
    const y = dataB.closes.slice(-n);

    // Step 1: OLS regression to find hedge ratio
    const { alpha, beta, residuals } = ols(x, y);

    // Step 2: ADF test on residuals
    const adfStat = adfTStat(residuals);
    // Critical values for Engle-Granger (approximate, n > 100)
    const critical1 = -3.90;
    const critical5 = -3.34;
    const critical10 = -3.04;
    const isCointegrated = adfStat < critical5;

    // Step 3: Current spread z-score
    const spreadMean = mean(residuals);
    const spreadStd = stdDev(residuals);
    const currentSpread = residuals[residuals.length - 1];
    const spreadZScore = spreadStd > 0 ? (currentSpread - spreadMean) / spreadStd : 0;

    // Step 4: Half-life of mean reversion (from AR(1) on spread)
    const spreadLag: number[] = [];
    const spreadDiff: number[] = [];
    for (let i = 1; i < residuals.length; i++) {
      spreadLag.push(residuals[i - 1]);
      spreadDiff.push(residuals[i] - residuals[i - 1]);
    }
    const { beta: phi } = ols(spreadLag, spreadDiff);
    const halfLife = phi < 0 ? -Math.log(2) / Math.log(1 + phi) : Infinity;

    // Step 5: Rolling spread z-scores (last 20)
    const rollingSpreadZ: Array<{ date: string; zscore: number }> = [];
    const window = 60;
    for (let i = Math.max(window, residuals.length - 20); i < residuals.length; i++) {
      const w = residuals.slice(Math.max(0, i - window), i + 1);
      const wm = mean(w);
      const ws = stdDev(w);
      rollingSpreadZ.push({
        date: dataA.dates[dataA.dates.length - residuals.length + i] || '',
        zscore: Math.round((ws > 0 ? (residuals[i] - wm) / ws : 0) * 1000) / 1000,
      });
    }

    // Correlation for reference
    const corr = correlation(logReturns(x), logReturns(y));

    return formatToolResult({
      pairA: input.symbolA.toUpperCase(),
      pairB: input.symbolB.toUpperCase(),
      interval: input.interval,
      sampleSize: n,
      hedgeRatio: {
        beta: Math.round(beta * 10000) / 10000,
        alpha: Math.round(alpha * 10000) / 10000,
        interpretation: `1 unit of ${input.symbolB.toUpperCase()} ≈ ${beta.toFixed(4)} units of ${input.symbolA.toUpperCase()} + ${alpha.toFixed(4)}`,
      },
      adfTest: {
        statistic: Math.round(adfStat * 1000) / 1000,
        critical1pct: critical1,
        critical5pct: critical5,
        critical10pct: critical10,
        isCointegrated,
        significance: adfStat < critical1 ? '1%' : adfStat < critical5 ? '5%' : adfStat < critical10 ? '10%' : 'NOT_SIGNIFICANT',
      },
      spread: {
        currentZScore: Math.round(spreadZScore * 1000) / 1000,
        mean: Math.round(spreadMean * 100000) / 100000,
        stdDev: Math.round(spreadStd * 100000) / 100000,
        halfLifePeriods: halfLife === Infinity ? 'NO_MEAN_REVERSION' : Math.round(halfLife * 10) / 10,
        rollingZScores: rollingSpreadZ,
      },
      returnCorrelation: Math.round(corr * 1000) / 1000,
      tradingSignal: !isCointegrated
        ? 'NO_TRADE: Pair is NOT cointegrated. Spread trading is not statistically supported.'
        : Math.abs(spreadZScore) > 2.0
          ? `ENTRY: Spread z-score = ${spreadZScore.toFixed(2)}. ${spreadZScore > 0 ? `Short ${input.symbolB.toUpperCase()}, Long ${input.symbolA.toUpperCase()}` : `Long ${input.symbolB.toUpperCase()}, Short ${input.symbolA.toUpperCase()}`} (hedge ratio: ${beta.toFixed(4)})`
          : Math.abs(spreadZScore) < 0.5
            ? 'NEUTRAL: Spread near equilibrium. Wait for divergence.'
            : `WATCH: Spread z-score = ${spreadZScore.toFixed(2)}. Approaching entry zone.`,
    }, []);
  },
});

// ============================================================================
// Tool: Drawdown Analysis
// ============================================================================

const DrawdownInputSchema = z.object({
  symbol: z.string().describe('Instrument symbol'),
  interval: z.enum(['1h', '4h', '1day', '1week']).default('1day').describe('Timeframe'),
  lookback: z.number().default(504).describe('Lookback period (504 ≈ 2 years daily)'),
});

export const getDrawdownAnalysis = new DynamicStructuredTool({
  name: 'get_drawdown_analysis',
  description: 'Detailed drawdown analysis: max drawdown, average drawdown, recovery time distribution, underwater periods, drawdown frequency by severity, and current drawdown status. Critical for Fintokei DD limit management.',
  schema: DrawdownInputSchema,
  func: async (input) => {
    const { closes, dates } = await fetchCloses(input.symbol, input.interval, input.lookback + 1);
    if (closes.length < 60) {
      return formatToolResult({ error: 'Insufficient data (need at least 60 periods)' }, []);
    }

    // Compute drawdown series
    interface DrawdownEvent {
      startDate: string;
      troughDate: string;
      endDate: string | null;
      depth: number;
      duration: number;
      recoveryTime: number | null;
    }

    let peak = closes[0];
    let peakIdx = 0;
    const ddSeries: number[] = [];
    const events: DrawdownEvent[] = [];
    let currentEvent: { startIdx: number; troughIdx: number; troughDD: number } | null = null;

    for (let i = 0; i < closes.length; i++) {
      if (closes[i] >= peak) {
        peak = closes[i];
        peakIdx = i;
        if (currentEvent && currentEvent.troughDD > 0.01) {
          events.push({
            startDate: dates[currentEvent.startIdx],
            troughDate: dates[currentEvent.troughIdx],
            endDate: dates[i],
            depth: currentEvent.troughDD,
            duration: currentEvent.troughIdx - currentEvent.startIdx,
            recoveryTime: i - currentEvent.troughIdx,
          });
        }
        currentEvent = null;
      }
      const dd = (peak - closes[i]) / peak;
      ddSeries.push(dd);
      if (dd > 0.001) {
        if (!currentEvent) {
          currentEvent = { startIdx: peakIdx, troughIdx: i, troughDD: dd };
        } else if (dd > currentEvent.troughDD) {
          currentEvent.troughIdx = i;
          currentEvent.troughDD = dd;
        }
      }
    }

    // Current drawdown (if still in one)
    const currentDD = ddSeries[ddSeries.length - 1];
    const isInDrawdown = currentDD > 0.001;

    if (currentEvent && isInDrawdown) {
      events.push({
        startDate: dates[currentEvent.startIdx],
        troughDate: dates[currentEvent.troughIdx],
        endDate: null,
        depth: currentEvent.troughDD,
        duration: currentEvent.troughIdx - currentEvent.startIdx,
        recoveryTime: null,
      });
    }

    // Sort by depth
    const sortedEvents = [...events].sort((a, b) => b.depth - a.depth);

    // Drawdown statistics
    const allDepths = events.filter(e => e.depth > 0.01).map(e => e.depth);
    const allDurations = events.filter(e => e.duration > 0).map(e => e.duration);
    const allRecoveries = events.filter(e => e.recoveryTime !== null).map(e => e.recoveryTime!);

    // Frequency by severity
    const severity = {
      mild: allDepths.filter(d => d <= 0.03).length,       // < 3%
      moderate: allDepths.filter(d => d > 0.03 && d <= 0.05).length,  // 3-5%
      severe: allDepths.filter(d => d > 0.05 && d <= 0.10).length,   // 5-10%
      extreme: allDepths.filter(d => d > 0.10).length,     // > 10%
    };

    return formatToolResult({
      instrument: input.symbol.toUpperCase(),
      interval: input.interval,
      sampleSize: closes.length,
      currentStatus: {
        inDrawdown: isInDrawdown,
        currentDrawdown: `${(currentDD * 100).toFixed(2)}%`,
        periodsFromPeak: isInDrawdown ? closes.length - 1 - ddSeries.lastIndexOf(0) : 0,
      },
      summary: {
        maxDrawdown: allDepths.length > 0 ? `${(Math.max(...allDepths) * 100).toFixed(2)}%` : '0%',
        avgDrawdown: allDepths.length > 0 ? `${(mean(allDepths) * 100).toFixed(2)}%` : '0%',
        medianDrawdown: allDepths.length > 0 ? `${(percentile(allDepths, 50) * 100).toFixed(2)}%` : '0%',
        totalEvents: allDepths.length,
        avgDuration: allDurations.length > 0 ? `${mean(allDurations).toFixed(1)} periods` : 'N/A',
        avgRecoveryTime: allRecoveries.length > 0 ? `${mean(allRecoveries).toFixed(1)} periods` : 'N/A',
        medianRecoveryTime: allRecoveries.length > 0 ? `${percentile(allRecoveries, 50).toFixed(1)} periods` : 'N/A',
        longestRecovery: allRecoveries.length > 0 ? `${Math.max(...allRecoveries)} periods` : 'N/A',
      },
      frequencyBySeverity: {
        mild_under3pct: severity.mild,
        moderate_3to5pct: severity.moderate,
        severe_5to10pct: severity.severe,
        extreme_over10pct: severity.extreme,
      },
      worstDrawdowns: sortedEvents.slice(0, 5).map(e => ({
        depth: `${(e.depth * 100).toFixed(2)}%`,
        startDate: e.startDate,
        troughDate: e.troughDate,
        endDate: e.endDate ?? 'ONGOING',
        durationToPeak: `${e.duration} periods`,
        recoveryTime: e.recoveryTime !== null ? `${e.recoveryTime} periods` : 'ONGOING',
      })),
      fintokeiImplication: {
        dd5pctProb: allDepths.length > 0 ? `${(allDepths.filter(d => d >= 0.05).length / allDepths.length * 100).toFixed(1)}%` : 'N/A',
        dd10pctProb: allDepths.length > 0 ? `${(allDepths.filter(d => d >= 0.10).length / allDepths.length * 100).toFixed(1)}%` : 'N/A',
        recommendation: currentDD > 0.05 ? 'WARNING: Currently in significant drawdown. Consider reducing exposure.'
          : currentDD > 0.03 ? 'CAUTION: Moderate drawdown in progress. Monitor closely.'
          : 'Normal conditions for position entry.',
      },
    }, []);
  },
});

// ============================================================================
// Tool: Rolling Sharpe Ratio
// ============================================================================

const RollingSharpeInputSchema = z.object({
  symbol: z.string().describe('Instrument symbol'),
  interval: z.enum(['1h', '4h', '1day', '1week']).default('1day').describe('Timeframe'),
  lookback: z.number().default(504).describe('Total lookback period'),
  window: z.number().default(60).describe('Rolling window size for Sharpe calculation'),
});

export const getRollingSharpe = new DynamicStructuredTool({
  name: 'get_rolling_sharpe',
  description: 'Compute rolling Sharpe ratio over time for an instrument. Shows how risk-adjusted returns evolve, detects regime shifts, and identifies periods of strategy decay vs improvement. Includes Sharpe percentile rank and trend analysis.',
  schema: RollingSharpeInputSchema,
  func: async (input) => {
    const { closes, dates } = await fetchCloses(input.symbol, input.interval, input.lookback + 1);
    if (closes.length < input.window + 20) {
      return formatToolResult({ error: `Insufficient data (need at least ${input.window + 20} periods)` }, []);
    }

    const returns = logReturns(closes);

    // Annualization factor
    const annFactor = input.interval === '1day' ? 252 : input.interval === '1week' ? 52 : input.interval === '4h' ? 252 * 6 : 252 * 24;

    // Compute rolling Sharpe
    const rollingSharpe: Array<{ date: string; sharpe: number }> = [];
    const sharpeValues: number[] = [];

    for (let i = input.window; i <= returns.length; i++) {
      const window = returns.slice(i - input.window, i);
      const m = mean(window);
      const s = stdDev(window);
      const sharpe = s > 0 ? (m * Math.sqrt(annFactor)) / (s * Math.sqrt(annFactor / input.window * input.window)) : 0;
      // Simplified annualized Sharpe = mean / std * sqrt(annFactor)
      const annSharpe = s > 0 ? (m / s) * Math.sqrt(annFactor) : 0;
      sharpeValues.push(annSharpe);
      rollingSharpe.push({
        date: dates[i], // +1 offset because returns is 1 shorter
        sharpe: Math.round(annSharpe * 1000) / 1000,
      });
    }

    const currentSharpe = sharpeValues[sharpeValues.length - 1];
    const sharpePercentile = sharpeValues.filter(s => s <= currentSharpe).length / sharpeValues.length * 100;

    // Trend: compare recent vs older Sharpe
    const recentSharpes = sharpeValues.slice(-Math.floor(sharpeValues.length / 4));
    const olderSharpes = sharpeValues.slice(0, Math.floor(sharpeValues.length / 4));
    const recentAvg = mean(recentSharpes);
    const olderAvg = mean(olderSharpes);
    const trend = recentAvg > olderAvg + 0.2 ? 'IMPROVING' : recentAvg < olderAvg - 0.2 ? 'DETERIORATING' : 'STABLE';

    // Positive Sharpe periods
    const positivePeriods = sharpeValues.filter(s => s > 0).length;
    const positivePct = positivePeriods / sharpeValues.length * 100;

    // Max and min
    const maxSharpe = Math.max(...sharpeValues);
    const minSharpe = Math.min(...sharpeValues);
    const maxIdx = sharpeValues.indexOf(maxSharpe);
    const minIdx = sharpeValues.indexOf(minSharpe);

    return formatToolResult({
      instrument: input.symbol.toUpperCase(),
      interval: input.interval,
      window: input.window,
      current: {
        sharpe: Math.round(currentSharpe * 1000) / 1000,
        percentile: Math.round(sharpePercentile * 10) / 10,
        interpretation: currentSharpe > 2.0 ? 'EXCELLENT' : currentSharpe > 1.0 ? 'GOOD' : currentSharpe > 0.5 ? 'MODERATE' : currentSharpe > 0 ? 'WEAK' : 'NEGATIVE',
      },
      statistics: {
        mean: Math.round(mean(sharpeValues) * 1000) / 1000,
        stdDev: Math.round(stdDev(sharpeValues) * 1000) / 1000,
        max: { value: Math.round(maxSharpe * 1000) / 1000, date: rollingSharpe[maxIdx]?.date ?? '' },
        min: { value: Math.round(minSharpe * 1000) / 1000, date: rollingSharpe[minIdx]?.date ?? '' },
        positivePeriodsPercent: `${positivePct.toFixed(1)}%`,
      },
      trend: {
        direction: trend,
        recentAvg: Math.round(recentAvg * 1000) / 1000,
        olderAvg: Math.round(olderAvg * 1000) / 1000,
      },
      // Return last 20 data points for visualization
      history: rollingSharpe.slice(-20),
    }, []);
  },
});
