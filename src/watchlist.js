import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'watchlist.json');
const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY'];

let cache = null;

export function deriveSymbols(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;

  if (t.includes('/')) {
    const [base, quoteRaw] = t.split('/');
    if (!base || !quoteRaw) return null;
    const quote = quoteRaw.split(':')[0];
    return {
      symbol: `${base}/${quote}`,
      futureSymbol: `${base}/${quote}:${quote}`
    };
  }

  for (const quote of QUOTES) {
    if (t.endsWith(quote) && t.length > quote.length) {
      const base = t.slice(0, -quote.length);
      return {
        symbol: `${base}/${quote}`,
        futureSymbol: `${base}/${quote}:${quote}`
      };
    }
  }

  return null;
}

function normalize(ticker, options = {}) {
  const raw = String(ticker || '').trim();
  if (!raw) {
    throw new Error('Ticker/pair wajib diisi');
  }

  const derived = deriveSymbols(raw);
  const symbol = options.symbol || derived?.symbol;
  const futureSymbol = options.futureSymbol || derived?.futureSymbol;
  const key = raw.toUpperCase();

  if (!symbol) {
    throw new Error(`Tidak bisa mengenali pair "${raw}". Contoh: BTCUSDT, SOLUSDT, atau BTC/USDT.`);
  }

  return { ticker: key, symbol, futureSymbol };
}

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data.pairs || typeof data.pairs !== 'object') {
      data.pairs = {};
    }
    return data;
  } catch {
    return { pairs: {} };
  }
}

export function loadWatchlist() {
  if (!cache) {
    cache = readFile();
  }
  return cache;
}

export function listPairs() {
  return Object.entries(loadWatchlist().pairs)
    .map(([ticker, entry]) => ({ ticker, symbol: entry.symbol, futureSymbol: entry.futureSymbol }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function getPair(ticker) {
  if (!ticker) return null;
  return loadWatchlist().pairs[String(ticker).toUpperCase()] || null;
}

export function addPair(ticker, options = {}) {
  const entry = normalize(ticker, options);
  const store = loadWatchlist();
  store.pairs[entry.ticker] = { symbol: entry.symbol, futureSymbol: entry.futureSymbol };
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  return entry;
}

export function removePair(ticker) {
  const key = String(ticker || '').trim().toUpperCase();
  const store = loadWatchlist();
  if (!store.pairs[key]) {
    throw new Error(`Pair "${key}" tidak ada di watchlist`);
  }
  delete store.pairs[key];
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  return key;
}

export function previewPair(ticker, options = {}) {
  return normalize(ticker, options);
}
