import http from 'node:http';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { executeAction, getBalance, getPositions, resolveSymbol } from './trader.js';
import { getExchange, getProfile, marketAllowed, normalizeMarket } from './exchange.js';
import { buildChart, MA_DEFAULTS, buildTrendReport, TREND_TIMEFRAMES } from './strategy.js';
import { describeError } from './errors.js';

const MAX_BODY_BYTES = 64 * 1024;

const DASHBOARD_HTML = fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function ipAllowed(config, ip) {
  const allowlist = config.webhook?.ipAllowlist || [];
  return allowlist.length === 0 || allowlist.includes(ip);
}

function parsePayload(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function providedSecret(req, url, payload) {
  return payload?.secret || req.headers['x-webhook-secret'] || url.searchParams.get('secret');
}

function secretValid(config, req, url, payload) {
  const expected = config.webhook?.secret;
  if (!expected) {
    return true;
  }
  return providedSecret(req, url, payload) === expected;
}

function buildMeta(config) {
  return {
    defaultProfile: config.defaultProfile,
    profiles: (config.profiles || []).map(profile => profile.id),
    tickers: Object.keys(config.symbolMap || {}),
    markets: ['spot', 'future'],
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1d'],
    maDefaults: MA_DEFAULTS
  };
}

async function checkClock(config) {
  const profile = (config.profiles || [])[0];
  if (!profile) return;
  for (const market of ['spot', 'future']) {
    if (!marketAllowed(profile, market)) continue;
    try {
      const exchange = getExchange(profile, market, { public: true });
      await exchange.loadMarkets();
      const offset = exchange.timeDifference ?? 0;
      if (Math.abs(offset) > 1000) {
        logger.warn(`Jam server bergeser ${offset}ms dari ${profile.exchange} (${market}). Sinkronkan waktu: "sudo timedatectl set-ntp true" lalu restart service.`);
      } else {
        logger.info(`Waktu server sinkron dengan ${profile.exchange} (${market}), offset ${offset}ms`);
      }
    } catch {
      // exchange/jaringan tidak tersedia saat startup, abaikan
    }
  }
}

export function startWebhookServer() {
  const config = loadConfig();
  const host = config.server?.host || '0.0.0.0';
  const port = Number(process.env.PORT || config.server?.port || 8787);

  if (!config.webhook?.secret) {
    logger.warn('webhook.secret is empty — the endpoint will accept ANY request. Set it before exposing this server.');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    try {
      if (!ipAllowed(config, clientIp(req))) {
        sendJson(res, 403, { ok: false, error: 'ip not allowed' });
        return;
      }

      if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
        sendHtml(res, 200, DASHBOARD_HTML);
        return;
      }

      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && path === '/api/meta') {
        if (!secretValid(config, req, url, null)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }
        sendJson(res, 200, { ok: true, ...buildMeta(config) });
        return;
      }

      if (req.method === 'GET' && path === '/api/balance') {
        if (!secretValid(config, req, url, null)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }
        const balances = await getBalance(url.searchParams.get('profile'), url.searchParams.get('market') || 'spot');
        sendJson(res, 200, { ok: true, balances });
        return;
      }

      if (req.method === 'GET' && path === '/api/positions') {
        if (!secretValid(config, req, url, null)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }
        const positions = await getPositions(url.searchParams.get('profile'));
        sendJson(res, 200, { ok: true, positions });
        return;
      }

      if (req.method === 'GET' && path === '/api/candles') {
        if (!secretValid(config, req, url, null)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }
        const profile = getProfile(url.searchParams.get('profile'));
        const market = normalizeMarket(url.searchParams.get('market'));
        if (!marketAllowed(profile, market)) {
          throw new Error(`Market "${market}" is disabled for profile "${profile.id}"`);
        }
        const exchange = getExchange(profile, market, { public: true });
        await exchange.loadMarkets();
        const symbol = resolveSymbol(config, url.searchParams.get('symbol') || url.searchParams.get('ticker'), market);
        const timeframe = url.searchParams.get('timeframe') || MA_DEFAULTS.timeframe;
        const fast = Number(url.searchParams.get('fast')) || MA_DEFAULTS.fast;
        const slow = Number(url.searchParams.get('slow')) || MA_DEFAULTS.slow;
        const trend = Number(url.searchParams.get('trend')) || MA_DEFAULTS.trend;
        const limit = Math.max(Number(url.searchParams.get('limit')) || 300, trend + 2);
        const dip = url.searchParams.get('dip') === 'true' || url.searchParams.get('dip') === '1';
        const dipLookback = Number(url.searchParams.get('dipLookback')) || undefined;
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        const chart = buildChart(candles, { fast, slow, trend, dip, dipLookback });

        let position = null;
        if (market === 'future') {
          try {
            const positions = await getPositions(profile.id);
            position = positions.find(entry => entry.symbol === symbol) || null;
          } catch {
            position = null;
          }
        }

        sendJson(res, 200, { ok: true, profile: profile.id, market, symbol, timeframe, ...chart, position });
        return;
      }

      if (req.method === 'GET' && path === '/api/stream') {
        if (!secretValid(config, req, url, null)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }

        const profileId = url.searchParams.get('profile');
        const market = normalizeMarket(url.searchParams.get('market'));
        const scope = url.searchParams.get('scope') || 'both';
        const interval = Math.max(2, Number(url.searchParams.get('interval')) || 5) * 1000;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        let closed = false;
        const send = (event, data) => {
          if (!closed) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        };

        req.on('close', () => {
          closed = true;
        });

        const tick = async () => {
          if (closed) return;
          if (scope === 'balance' || scope === 'both') {
            try {
              send('balance', { market, balances: await getBalance(profileId, market) });
            } catch (e) {
              send('streamerror', { scope: 'balance', error: describeError(e) });
            }
          }
          if (scope === 'positions' || scope === 'both') {
            try {
              send('positions', { positions: await getPositions(profileId) });
            } catch (e) {
              send('streamerror', { scope: 'positions', error: describeError(e) });
            }
          }
          if (!closed) {
            setTimeout(tick, interval);
          }
        };

        tick();
        return;
      }

      if (req.method === 'GET' && path === '/api/trends') {
        if (!secretValid(config, req, url, null)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }
        const profile = getProfile(url.searchParams.get('profile'));
        const market = normalizeMarket(url.searchParams.get('market'));
        if (!marketAllowed(profile, market)) {
          throw new Error(`Market "${market}" is disabled for profile "${profile.id}"`);
        }
        const exchange = getExchange(profile, market, { public: true });
        await exchange.loadMarkets();
        const symbol = resolveSymbol(config, url.searchParams.get('symbol') || url.searchParams.get('ticker'), market);
        const requested = (url.searchParams.get('timeframes') || '').split(',').map(s => s.trim()).filter(Boolean);
        const fast = Number(url.searchParams.get('fast')) || MA_DEFAULTS.fast;
        const slow = Number(url.searchParams.get('slow')) || MA_DEFAULTS.slow;
        const trend = Number(url.searchParams.get('trend')) || MA_DEFAULTS.trend;

        const report = await buildTrendReport(exchange, symbol, market, requested.length ? requested : TREND_TIMEFRAMES, { fast, slow, trend });
        sendJson(res, 200, { ok: true, profile: profile.id, market, symbol, ...report });
        return;
      }

      const isOrderRoute = path === '/webhook' || path === '/api/order';
      if (req.method === 'POST' && isOrderRoute) {
        const payload = parsePayload(await readBody(req));
        if (!payload) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        if (!secretValid(config, req, url, payload)) {
          sendJson(res, 401, { ok: false, error: 'invalid secret' });
          return;
        }

        const result = await executeAction({
          profileId: payload.profile,
          market: payload.market,
          ticker: payload.ticker || payload.symbol,
          action: payload.action || payload.side,
          amount: payload.amount,
          amountType: payload.amountType,
          price: payload.price,
          stopPrice: payload.stopPrice ?? payload.stop_price ?? payload.triggerPrice
        });

        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      const message = describeError(e);
      logger.error(`Webhook error: ${message}`);
      sendJson(res, 400, { ok: false, error: message });
    }
  });

  server.listen(port, host, () => {
    logger.info(`Webhook listening on http://${host}:${port}/webhook (dashboard: /dashboard, health: /health)`);
    checkClock(config);
  });

  const shutdown = () => {
    logger.info('Shutting down webhook server');
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
