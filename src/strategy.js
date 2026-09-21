import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { getExchange, getProfile, marketAllowed, normalizeMarket } from './exchange.js';
import { executeAction, resolveSymbol } from './trader.js';

export const MA_DEFAULTS = { fast: 7, slow: 25, trend: 99, timeframe: '15m', interval: 30 };

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

  let signal = 'none';
  if (crossUp && trendUp) {
    signal = 'long';
  } else if (crossDown && !trendUp) {
    signal = 'short';
  }

  return {
    signal,
    reason: signal === 'none'
      ? (crossUp || crossDown ? 'cross tanpa konfirmasi MA99' : 'belum ada cross')
      : null,
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
    crossDown
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

  const markers = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (maFast[i - 1] == null || maSlow[i - 1] == null) continue;
    const crossUp = maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i];
    const crossDown = maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i];
    if (!crossUp && !crossDown) continue;
    const trendOk = maTrend[i] != null;
    const time = Math.floor(candles[i][0] / 1000);
    if (crossUp && trendOk && closes[i] > maTrend[i]) {
      markers.push({ time, position: 'belowBar', color: '#3fb950', shape: 'arrowUp', text: `L${fast}/${slow}` });
    }
    if (crossDown && trendOk && closes[i] < maTrend[i]) {
      markers.push({ time, position: 'aboveBar', color: '#f85149', shape: 'arrowDown', text: `S${fast}/${slow}` });
    }
  }

  return {
    params: { fast, slow, trend },
    candles: chartCandles,
    ma: { fast: line(maFast), slow: line(maSlow), trend: line(maTrend) },
    markers,
    analysis: analyze(candles, { fast, slow, trend })
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

  const exchange = getExchange(profile, market);
  await exchange.loadMarkets();

  const symbol = resolveSymbol(config, request.ticker, market);
  const timeframe = request.timeframe ?? MA_DEFAULTS.timeframe;
  const limit = (request.trend ?? MA_DEFAULTS.trend) + 5;
  const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

  const analysis = analyze(candles, request);
  const position = await currentPosition(exchange, market, symbol);
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
      logger.error(`Strategy error: ${e.message || e}`);
    }
    await sleep(interval * 1000);
  }
}
