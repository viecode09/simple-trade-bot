import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { getExchange, getProfile, marketAllowed, normalizeMarket } from './exchange.js';
import { getPair, deriveSymbols } from './watchlist.js';

function normalizeAction(action) {
  switch (String(action || '').toLowerCase()) {
    case 'buy':
    case 'long':
      return 'long';
    case 'sell':
    case 'short':
      return 'short';
    case 'close':
    case 'exit':
      return 'close';
    case 'stop':
    case 'stop_loss':
    case 'stoploss':
      return 'stop';
    default:
      throw new Error(`Unsupported action "${action}". Use long, short, close or stop.`);
  }
}

export function resolveSymbol(config, ticker, market) {
  if (!ticker) {
    throw new Error('Missing ticker/symbol');
  }

  const raw = String(ticker);
  if (raw.includes('/')) {
    return raw;
  }

  const key = raw.toUpperCase();
  const entry = config.symbolMap?.[key] || getPair(key);
  if (entry) {
    const symbol = market === 'future' ? entry.futureSymbol || entry.symbol : entry.symbol;
    if (symbol) {
      return symbol;
    }
  }

  const derived = deriveSymbols(key);
  if (derived) {
    return market === 'future' ? derived.futureSymbol : derived.symbol;
  }

  throw new Error(`No symbol mapping for "${ticker}". Tambahkan pair dari dashboard atau symbolMap di config.json.`);
}

async function fetchPrice(exchange, symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  const price = ticker.last ?? ticker.close ?? (ticker.ask && ticker.bid ? (ticker.ask + ticker.bid) / 2 : undefined);
  if (!price) {
    throw new Error(`Could not determine price for ${symbol}`);
  }
  return price;
}

async function toBaseAmount(exchange, symbol, amount, amountType) {
  const value = Number(amount);
  if (!value || value <= 0) {
    throw new Error('amount must be a positive number');
  }

  const base = amountType === 'quote' ? value / (await fetchPrice(exchange, symbol)) : value;
  const rounded = parseFloat(exchange.amountToPrecision(symbol, base));

  if (!rounded || rounded <= 0) {
    throw new Error(`Amount is too small for ${symbol}`);
  }

  return rounded;
}

async function placeOrder(exchange, symbol, side, amount, price, params = {}) {
  if (price) {
    return exchange.createOrder(symbol, 'limit', side, amount, price, params);
  }
  return exchange.createOrder(symbol, 'market', side, amount, undefined, params);
}

function orderSummary(order) {
  return {
    id: order.id,
    side: order.side,
    type: order.type,
    amount: order.amount,
    price: order.price ?? null,
    status: order.status ?? null
  };
}

async function spotClose(exchange, symbol) {
  const base = symbol.split('/')[0];
  const balance = await exchange.fetchBalance();
  const free = balance[base]?.free ?? 0;

  if (free <= 0) {
    throw new Error(`No free ${base} balance to sell for ${symbol}`);
  }

  const amount = parseFloat(exchange.amountToPrecision(symbol, free));
  return placeOrder(exchange, symbol, 'sell', amount);
}

async function futuresClose(exchange, symbol) {
  const positions = await exchange.fetchPositions([symbol]);
  const position = positions.find(entry => entry.symbol === symbol && entry.contracts && Math.abs(entry.contracts) > 0);

  if (!position) {
    throw new Error(`No open position for ${symbol}`);
  }

  const side = position.side === 'long' ? 'sell' : 'buy';
  const amount = Math.abs(position.contracts);

  return placeOrder(exchange, symbol, side, amount, undefined, { reduceOnly: true });
}

async function futuresStop(exchange, symbol, amount, stopPrice) {
  const trigger = Number(stopPrice);
  if (!trigger || trigger <= 0) {
    throw new Error('stopPrice is required for stop orders');
  }

  const positions = await exchange.fetchPositions([symbol]);
  const position = positions.find(entry => entry.symbol === symbol && entry.contracts && Math.abs(entry.contracts) > 0);

  if (!position) {
    throw new Error(`No open position for ${symbol}`);
  }

  const side = position.side === 'long' ? 'sell' : 'buy';
  const contracts = amount
    ? parseFloat(exchange.amountToPrecision(symbol, Math.abs(Number(amount))))
    : Math.abs(position.contracts);

  return exchange.createOrder(symbol, 'market', side, contracts, undefined, {
    stopPrice: trigger,
    reduceOnly: true
  });
}

async function futuresOpen(exchange, profile, symbol, side, amount, amountType) {
  if (profile.leverage) {
    try {
      await exchange.setLeverage(profile.leverage, symbol);
    } catch (e) {
      logger.warn(`Could not set leverage ${profile.leverage} for ${symbol}: ${e.message || e}`);
    }
  }

  if (profile.marginMode) {
    try {
      await exchange.setMarginMode(profile.marginMode, symbol);
    } catch (e) {
      logger.warn(`Could not set margin mode ${profile.marginMode} for ${symbol}: ${e.message || e}`);
    }
  }

  const base = await toBaseAmount(exchange, symbol, amount, amountType ?? 'quote');
  return placeOrder(exchange, symbol, side, base);
}

export async function executeAction(request) {
  const config = loadConfig();
  const profile = getProfile(request.profileId);
  const market = normalizeMarket(request.market);

  if (!marketAllowed(profile, market)) {
    throw new Error(`Market "${market}" is disabled for profile "${profile.id}"`);
  }

  const exchange = getExchange(profile, market);
  await exchange.loadMarkets();

  const symbol = resolveSymbol(config, request.ticker, market);
  const action = normalizeAction(request.action);
  const price = request.price ? Number(request.price) : undefined;

  let order;

  if (action === 'close') {
    order = market === 'future' ? await futuresClose(exchange, symbol) : await spotClose(exchange, symbol);
  } else if (action === 'stop') {
    if (market !== 'future') {
      throw new Error('Stop orders are only supported for futures');
    }
    order = await futuresStop(exchange, symbol, request.amount, request.stopPrice);
  } else if (market === 'future') {
    const side = action === 'long' ? 'buy' : 'sell';
    order = await futuresOpen(exchange, profile, symbol, side, request.amount, request.amountType);
  } else {
    const side = action === 'long' ? 'buy' : 'sell';
    const amountType = request.amountType ?? 'quote';
    const amount = await toBaseAmount(exchange, symbol, request.amount, amountType);
    order = await placeOrder(exchange, symbol, side, amount, price);
  }

  const result = { profile: profile.id, market, symbol, action, order: orderSummary(order) };
  logger.info(`${action} ${market} ${symbol} x${result.order.amount} -> order ${result.order.id}`);
  return result;
}

export async function getBalance(profileId, market) {
  const profile = getProfile(profileId);
  const normalized = normalizeMarket(market);
  const exchange = getExchange(profile, normalized);
  await exchange.loadMarkets();

  const balance = await exchange.fetchBalance();
  const skip = new Set(['info', 'timestamp', 'datetime', 'free', 'used', 'total']);

  return Object.entries(balance)
    .filter(([currency, entry]) => !skip.has(currency) && entry && typeof entry.total === 'number' && entry.total > 0)
    .map(([currency, entry]) => ({ currency, total: entry.total, free: entry.free, used: entry.used }))
    .sort((a, b) => b.total - a.total);
}

export async function getPositions(profileId) {
  const profile = getProfile(profileId);
  const exchange = getExchange(profile, 'future');
  await exchange.loadMarkets();

  if (!exchange.has['fetchPositions']) {
    throw new Error(`Exchange "${profile.exchange}" does not support fetchPositions`);
  }

  const positions = await exchange.fetchPositions();
  return positions
    .filter(entry => entry.contracts && Math.abs(entry.contracts) > 0)
    .map(entry => ({
      symbol: entry.symbol,
      side: entry.side,
      contracts: entry.contracts,
      entryPrice: entry.entryPrice,
      markPrice: entry.markPrice,
      unrealizedPnl: entry.unrealizedPnl,
      leverage: entry.leverage
    }));
}
