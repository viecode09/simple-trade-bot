import WebSocket from 'ws';
import { logger } from './logger.js';

const STREAM_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const MAX_PER_SYMBOL = 5000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECONNECT_MS = 5000;

const store = new Map();
let socket = null;
let started = false;
let reconnectTimer = null;

function record(symbol, side, price, usd, ts) {
  let arr = store.get(symbol);
  if (!arr) {
    arr = [];
    store.set(symbol, arr);
  }
  arr.push({ ts, side, price, usd });
  if (arr.length > MAX_PER_SYMBOL) {
    arr.splice(0, arr.length - MAX_PER_SYMBOL);
  }
}

function connect() {
  try {
    socket = new WebSocket(STREAM_URL);
  } catch (e) {
    logger.warn(`Liquidation stream init failed: ${e.message || e}`);
    scheduleReconnect();
    return;
  }

  socket.on('open', () => logger.info('Liquidation stream (Binance !forceOrder@arr) connected'));

  socket.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const o = msg && msg.o;
      if (!o || !o.s) return;
      const price = Number(o.ap || o.p);
      const qty = Number(o.q);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
      const usd = price * qty;
      const side = o.S === 'SELL' ? 'long' : 'short';
      record(o.s, side, price, usd, Number(msg.E || Date.now()));
    } catch {
      // abaikan pesan yang tidak valid
    }
  });

  socket.on('close', () => {
    logger.warn('Liquidation stream closed, reconnecting...');
    scheduleReconnect();
  });

  socket.on('error', e => {
    logger.warn(`Liquidation stream error: ${e.message || e}`);
    try { socket.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

export function startLiquidationStream() {
  if (started) return;
  started = true;
  connect();
}

export function liquidationStatus() {
  return { connected: Boolean(socket && socket.readyState === 1), symbols: store.size };
}

function bucketStep(price) {
  if (price >= 10000) return 100;
  if (price >= 1000) return 10;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  return 0.001;
}

export function liquidationMap(symbol, rangeMs) {
  const arr = store.get(String(symbol || '').toUpperCase());
  const now = Date.now();
  if (!arr || !arr.length) {
    return { clusters: [], count: 0, totalUsd: 0 };
  }

  while (arr.length && now - arr[0].ts > MAX_AGE_MS) {
    arr.shift();
  }

  const since = now - rangeMs;
  const buckets = new Map();
  let count = 0;
  let totalUsd = 0;

  for (const event of arr) {
    if (event.ts < since) continue;
    count += 1;
    totalUsd += event.usd;
    const step = bucketStep(event.price);
    const key = Math.round(event.price / step) * step;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { price: key, longUsd: 0, shortUsd: 0 };
      buckets.set(key, bucket);
    }
    if (event.side === 'long') bucket.longUsd += event.usd;
    else bucket.shortUsd += event.usd;
  }

  const clusters = [...buckets.values()]
    .map(bucket => ({ ...bucket, usd: bucket.longUsd + bucket.shortUsd }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 15);

  return { clusters, count, totalUsd };
}
