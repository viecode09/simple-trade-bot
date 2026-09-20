import http from 'node:http';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { executeAction, getBalance, getPositions } from './trader.js';

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
    markets: ['spot', 'future']
  };
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
          price: payload.price
        });

        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      logger.error(`Webhook error: ${e.message || e}`);
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
  });

  server.listen(port, host, () => {
    logger.info(`Webhook listening on http://${host}:${port}/webhook (dashboard: /dashboard, health: /health)`);
  });

  const shutdown = () => {
    logger.info('Shutting down webhook server');
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
