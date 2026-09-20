import http from 'node:http';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { executeAction } from './trader.js';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
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

export function startWebhookServer() {
  const config = loadConfig();
  const host = config.server?.host || '0.0.0.0';
  const port = Number(process.env.PORT || config.server?.port || 8787);

  if (!config.webhook?.secret) {
    logger.warn('webhook.secret is empty — the endpoint will accept ANY request. Set it before exposing this server.');
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== 'POST' || !(req.url || '').startsWith('/webhook')) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    try {
      if (!ipAllowed(config, clientIp(req))) {
        sendJson(res, 403, { ok: false, error: 'ip not allowed' });
        return;
      }

      const payload = parsePayload(await readBody(req));
      if (!payload) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }

      const expectedSecret = config.webhook?.secret;
      const secret = payload.secret || req.headers['x-webhook-secret'];
      if (expectedSecret && secret !== expectedSecret) {
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
    } catch (e) {
      logger.error(`Webhook error: ${e.message || e}`);
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
  });

  server.listen(port, host, () => {
    logger.info(`Webhook listening on http://${host}:${port}/webhook (health: /health)`);
  });

  const shutdown = () => {
    logger.info('Shutting down webhook server');
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
