import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { getExchange, getProfile, marketAllowed, normalizeMarket } from './exchange.js';
import { executeAction, resolveSymbol } from './trader.js';
import { describeError } from './errors.js';

export const MA_DEFAULTS = { fast: 7, slow: 25, trend: 99, timeframe: '15m', interval: 30, dipLookback: 3, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70 };

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

export function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) {
    return out;
  }
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function analyze(candles, options = {}) {
  const fast = options.fast ?? MA_DEFAULTS.fast;
  const slow = options.slow ?? MA_DEFAULTS.slow;
  const trend = options.trend ?? MA_DEFAULTS.trend;

  if (!Array.isArray(candles) || candles.length < trend + 2) {
    return {
      signal: 'none',
      reason: `Butuh minimal ${trend + 2} candle, hanya ada ${candles?.length ?? 0}`,
      fast,
      slow,
      trend
    };
  }

  const closed = candles.slice(0, -1);
  const closes = closed.map(candle => Number(candle[4]));
  const maFast = smaSeries(closes, fast);
  const maSlow = smaSeries(closes, slow);
  const maTrend = smaSeries(closes, trend);

  const i = closes.length - 1;
  const price = closes[i];
  const fastNow = maFast[i];
  const fastPrev = maFast[i - 1];
  const slowNow = maSlow[i];
  const slowPrev = maSlow[i - 1];
  const trendNow = maTrend[i];

  const crossUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossDown = fastPrev >= slowPrev && fastNow < slowNow;
  const trendUp = price > trendNow;

  const dip = options.dip === true || options.dip === 'true';
  const dipLookback = Number(options.dipLookback) > 0 ? Math.floor(Number(options.dipLookback)) : MA_DEFAULTS.dipLookback;

  let dipped = false;
  let reclaim = false;
  if (dip && slowNow != null && slowPrev != null) {
    for (let j = Math.max(0, i - dipLookback); j < i; j += 1) {
      if (maSlow[j] != null && closes[j] <= maSlow[j]) {
        dipped = true;
        break;
      }
    }
    reclaim = closes[i - 1] <= slowPrev && price > slowNow;
  }
  const dipLong = dip && dipped && reclaim && trendUp;

  const rsiEnabled = options.rsi === true || options.rsi === 'true';
  const rsiPeriod = Number(options.rsiPeriod) > 0 ? Math.floor(Number(options.rsiPeriod)) : MA_DEFAULTS.rsiPeriod;
  const rsiOversold = Number(options.rsiOversold) > 0 ? Number(options.rsiOversold) : MA_DEFAULTS.rsiOversold;
  const rsiOverbought = Number(options.rsiOverbought) > 0 ? Number(options.rsiOverbought) : MA_DEFAULTS.rsiOverbought;
  const rsiArr = rsiSeries(closes, rsiPeriod);
  const rsiNow = rsiArr[i] ?? null;
  const rsiPrev = rsiArr[i - 1] ?? null;

  let rsiLong = false;
  let rsiShort = false;
  if (rsiEnabled && rsiNow != null && rsiPrev != null) {
    rsiLong = rsiPrev <= rsiOversold && rsiNow > rsiOversold;
    rsiShort = rsiPrev >= rsiOverbought && rsiNow < rsiOverbought;
  }

  let signal = 'none';
  let reason = null;
  if (crossUp && trendUp) {
    signal = 'long';
  } else if (crossDown && !trendUp) {
    signal = 'short';
  } else if (dipLong) {
    signal = 'long';
    reason = `dip_catcher: pullback ke MA${slow} lalu reclaim di atas MA${slow} (tren > MA${trend})`;
  } else if (rsiLong) {
    signal = 'long';
    reason = `RSI${rsiPeriod}: rebound dari oversold (${rsiPrev.toFixed(1)} -> ${rsiNow.toFixed(1)})`;
  } else if (rsiShort) {
    signal = 'short';
    reason = `RSI${rsiPeriod}: turun dari overbought (${rsiPrev.toFixed(1)} -> ${rsiNow.toFixed(1)})`;
  } else {
    reason = dip && dipped && reclaim && !trendUp
      ? 'dip tapi tren di bawah MA99'
      : (crossUp || crossDown) ? 'cross tanpa konfirmasi MA99' : 'belum ada sinyal';
  }

  return {
    signal,
    reason,
    fast,
    slow,
    trend,
    candleTs: closed[i][0],
    candleTime: new Date(closed[i][0]).toISOString(),
    price,
    maFast: fastNow,
    maSlow: slowNow,
    maTrend: trendNow,
    crossUp,
    crossDown,
    dip,
    dipLookback,
    dipped,
    reclaim,
    dipLong,
    rsi: rsiNow,
    rsiPrev,
    rsiPeriod,
    rsiOversold,
    rsiOverbought,
    rsiEnabled,
    rsiLong,
    rsiShort
  };
}

export function buildChart(candles, options = {}) {
  const fast = options.fast ?? MA_DEFAULTS.fast;
  const slow = options.slow ?? MA_DEFAULTS.slow;
  const trend = options.trend ?? MA_DEFAULTS.trend;

  const closes = candles.map(candle => Number(candle[4]));
  const maFast = smaSeries(closes, fast);
  const maSlow = smaSeries(closes, slow);
  const maTrend = smaSeries(closes, trend);

  const line = series => series
    .map((value, i) => (value == null ? null : { time: Math.floor(candles[i][0] / 1000), value }))
    .filter(Boolean);

  const chartCandles = candles.map(candle => ({
    time: Math.floor(candle[0] / 1000),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4])
  }));

  const dip = options.dip === true || options.dip === 'true';
  const dipLookback = Number(options.dipLookback) > 0 ? Math.floor(Number(options.dipLookback)) : MA_DEFAULTS.dipLookback;

  const rsiEnabled = options.rsi === true || options.rsi === 'true';
  const rsiPeriod = Number(options.rsiPeriod) > 0 ? Math.floor(Number(options.rsiPeriod)) : MA_DEFAULTS.rsiPeriod;
  const rsiOversold = Number(options.rsiOversold) > 0 ? Number(options.rsiOversold) : MA_DEFAULTS.rsiOversold;
  const rsiOverbought = Number(options.rsiOverbought) > 0 ? Number(options.rsiOverbought) : MA_DEFAULTS.rsiOverbought;
  const rsiArr = rsiSeries(closes, rsiPeriod);

  const markers = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (maFast[i - 1] == null || maSlow[i - 1] == null) continue;
    const time = Math.floor(candles[i][0] / 1000);
    const crossUp = maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i];
    const crossDown = maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i];
    const trendOk = maTrend[i] != null;

    if (crossUp && trendOk && closes[i] > maTrend[i]) {
      markers.push({ time, position: 'belowBar', color: '#3fb950', shape: 'arrowUp', text: `L${fast}/${slow}` });
      continue;
    }
    if (crossDown && trendOk && closes[i] < maTrend[i]) {
      markers.push({ time, position: 'aboveBar', color: '#f85149', shape: 'arrowDown', text: `S${fast}/${slow}` });
      continue;
    }

    if (dip && trendOk) {
      let dipped = false;
      for (let j = Math.max(0, i - dipLookback); j < i; j += 1) {
        if (maSlow[j] != null && closes[j] <= maSlow[j]) {
          dipped = true;
          break;
        }
      }
      const reclaim = closes[i - 1] <= maSlow[i - 1] && closes[i] > maSlow[i];
      if (dipped && reclaim && closes[i] > maTrend[i]) {
        markers.push({ time, position: 'belowBar', color: '#d29922', shape: 'arrowUp', text: 'DIP' });
        continue;
      }
    }

    if (rsiEnabled && rsiArr[i] != null && rsiArr[i - 1] != null) {
      const up = rsiArr[i - 1] <= rsiOversold && rsiArr[i] > rsiOversold;
      const down = rsiArr[i - 1] >= rsiOverbought && rsiArr[i] < rsiOverbought;
      if (up) {
        markers.push({ time, position: 'belowBar', color: '#5b8def', shape: 'arrowUp', text: 'RSI' });
      } else if (down) {
        markers.push({ time, position: 'aboveBar', color: '#b06bff', shape: 'arrowDown', text: 'RSI' });
      }
    }
  }

  return {
    params: { fast, slow, trend, dip, dipLookback, rsi: rsiEnabled, rsiPeriod, rsiOversold, rsiOverbought },
    candles: chartCandles,
    ma: { fast: line(maFast), slow: line(maSlow), trend: line(maTrend) },
    rsi: line(rsiArr),
    markers,
    analysis: analyze(candles, { fast, slow, trend, dip, dipLookback, rsi: rsiEnabled, rsiPeriod, rsiOversold, rsiOverbought })
  };
}

export function decideAction(position, signal, market) {
  if (signal === 'long') {
    if (position === 'long') return 'hold';
    if (position === 'short') return 'reverse-long';
    return 'open-long';
  }
  if (signal === 'short') {
    if (market === 'spot') return 'hold';
    if (position === 'short') return 'hold';
    if (position === 'long') return 'reverse-short';
    return 'open-short';
  }
  return 'hold';
}

async function currentPosition(exchange, market, symbol) {
  if (market === 'future') {
    const positions = await exchange.fetchPositions([symbol]);
    const open = positions.find(entry => entry.symbol === symbol && entry.contracts && Math.abs(entry.contracts) > 0);
    if (!open) return 'flat';
    return open.side === 'long' ? 'long' : 'short';
  }

  const balance = await exchange.fetchBalance();
  const base = symbol.split('/')[0];
  return (balance[base]?.free ?? 0) > 0 ? 'long' : 'flat';
}

async function applyAction(action, request, dryRun) {
  if (action === 'hold') {
    return { action, executed: false };
  }

  const plan = [];
  if (action === 'reverse-long' || action === 'reverse-short') {
    plan.push({ ...request, action: 'close' });
  }
  plan.push({ ...request, action: action === 'open-long' || action === 'reverse-long' ? 'long' : 'short' });

  if (dryRun) {
    return { action, dryRun: true, plan: plan.map(entry => `${entry.action} ${entry.ticker}`) };
  }

  const orders = [];
  for (const step of plan) {
    const result = await executeAction(step);
    orders.push(result.order);
  }
  return { action, executed: true, orders };
}

async function evaluate(request) {
  const config = loadConfig();
  const profile = getProfile(request.profileId);
  const market = normalizeMarket(request.market);
  if (!marketAllowed(profile, market)) {
    throw new Error(`Market "${market}" is disabled for profile "${profile.id}"`);
  }

  const marketExchange = getExchange(profile, market, { public: true });
  await marketExchange.loadMarkets();

  const symbol = resolveSymbol(config, request.ticker, market);
  const timeframe = request.timeframe ?? MA_DEFAULTS.timeframe;
  const limit = (request.trend ?? MA_DEFAULTS.trend) + 5;
  const candles = await marketExchange.fetchOHLCV(symbol, timeframe, undefined, limit);

  const analysis = analyze(candles, request);

  let position = 'flat';
  try {
    position = await currentPosition(getExchange(profile, market), market, symbol);
  } catch (e) {
    if (!request.dryRun) {
      throw e;
    }
    position = 'unknown';
  }

  const action = decideAction(position, analysis.signal, market);

  return {
    profile: profile.id,
    market,
    symbol,
    timeframe,
    position,
    analysis,
    action,
    execRequest: {
      profileId: request.profileId,
      market,
      ticker: symbol,
      amount: request.amount,
      amountType: request.amountType
    }
  };
}

function logAnalysis(evaluated, execution) {
  const { analysis, position } = evaluated;
  const f = v => (typeof v === 'number' ? v.toFixed(4) : 'n/a');
  logger.info(`[${analysis.candleTime}] price=${analysis.price} ` +
    `MA${analysis.fast}=${f(analysis.maFast)} MA${analysis.slow}=${f(analysis.maSlow)} MA${analysis.trend}=${f(analysis.maTrend)} ` +
    `signal=${analysis.signal}${analysis.reason ? ` (${analysis.reason})` : ''} pos=${position} action=${execution.action}`);
}

export async function runStrategyOnce(request) {
  const evaluated = await evaluate(request);
  const execution = await applyAction(evaluated.action, evaluated.execRequest, request.dryRun);
  logAnalysis(evaluated, execution);
  if (execution.executed) {
    logger.info(`Order dieksekusi: ${JSON.stringify(execution.orders)}`);
  }
  return { ...evaluated, execution };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function watchStrategy(request) {
  const interval = Number(request.interval ?? MA_DEFAULTS.interval);
  logger.info(`Memantau MA${request.fast ?? MA_DEFAULTS.fast}/${request.slow ?? MA_DEFAULTS.slow}/${request.trend ?? MA_DEFAULTS.trend} ` +
    `(${request.timeframe ?? MA_DEFAULTS.timeframe}) tiap ${interval}s${request.dryRun ? ' — DRY-RUN' : ''}`);
  let lastActedTs = null;

  for (;;) {
    try {
      const evaluated = await evaluate(request);
      let execution = { action: 'hold', executed: false };

      if (evaluated.analysis.signal !== 'none' && evaluated.analysis.candleTs !== lastActedTs) {
        lastActedTs = evaluated.analysis.candleTs;
        execution = await applyAction(evaluated.action, evaluated.execRequest, request.dryRun);
        if (execution.executed) {
          logger.info(`Order dieksekusi: ${JSON.stringify(execution.orders)}`);
        }
      }

      logAnalysis(evaluated, execution);
    } catch (e) {
      logger.error(`Strategy error: ${describeError(e)}`);
    }
    await sleep(interval * 1000);
  }
}

export const TREND_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];

export function classifyTrend(analysis) {
  const { price, maFast, maSlow, maTrend, crossUp, crossDown } = analysis;
  if (maFast == null || maSlow == null || maTrend == null) {
    return 'Netral';
  }
  if (crossUp && price > maTrend) return 'Bullish kuat';
  if (crossDown && price < maTrend) return 'Bearish kuat';
  if (price > maTrend && maFast > maSlow) return 'Bullish';
  if (price < maTrend && maFast < maSlow) return 'Bearish';
  return 'Netral';
}

export function recommendAction(trend, market) {
  const bullish = trend.startsWith('Bullish');
  const bearish = trend.startsWith('Bearish');
  if (market === 'spot') {
    if (bullish) return 'BUY';
    if (bearish) return 'SELL';
    return 'HOLD';
  }
  if (bullish) return 'LONG';
  if (bearish) return 'SHORT';
  return 'HOLD';
}

export async function buildTrendReport(exchange, symbol, market, timeframes, options = {}) {
  const fast = options.fast ?? MA_DEFAULTS.fast;
  const slow = options.slow ?? MA_DEFAULTS.slow;
  const trend = options.trend ?? MA_DEFAULTS.trend;
  const limit = trend + 5;
  const list = timeframes && timeframes.length ? timeframes : TREND_TIMEFRAMES;

  const rows = [];
  for (const timeframe of list) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      const analysis = analyze(candles, { fast, slow, trend });
      const trendLabel = classifyTrend(analysis);
      rows.push({
        timeframe,
        trend: trendLabel,
        recommendation: recommendAction(trendLabel, market),
        price: analysis.price,
        maFast: analysis.maFast,
        maSlow: analysis.maSlow,
        maTrend: analysis.maTrend,
        signal: analysis.signal,
        crossUp: analysis.crossUp,
        crossDown: analysis.crossDown
      });
    } catch (e) {
      rows.push({ timeframe, error: e.message || String(e) });
    }
  }

  const score = rows.reduce((total, row) => {
    if (!row.trend) return total;
    if (row.trend.startsWith('Bullish')) return total + 1;
    if (row.trend.startsWith('Bearish')) return total - 1;
    return total;
  }, 0);

  const overallTrend = score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Netral';

  return {
    params: { fast, slow, trend },
    rows,
    score,
    overallTrend,
    overallRecommendation: recommendAction(overallTrend, market)
  };
}
