import ccxt from 'ccxt';
import { loadConfig } from './config.js';

const cache = new Map();

export function getProfile(profileId) {
  const config = loadConfig();
  const id = profileId || config.defaultProfile;
  const profile = (config.profiles || []).find(entry => entry.id === id);

  if (!profile) {
    throw new Error(`Profile "${id}" not found in config.json`);
  }

  return profile;
}

export function normalizeMarket(market) {
  return market === 'future' || market === 'futures' ? 'future' : 'spot';
}

export function marketAllowed(profile, market) {
  if (market === 'spot') {
    return profile.allowSpot !== false;
  }
  if (market === 'future') {
    return profile.allowFutures !== false;
  }
  return false;
}

export function getExchange(profile, market) {
  const key = `${profile.id}:${market}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const ExchangeClass = ccxt[profile.exchange];
  if (!ExchangeClass) {
    throw new Error(`Exchange "${profile.exchange}" is not supported by ccxt`);
  }

  const instance = new ExchangeClass({
    apiKey: profile.apiKey,
    secret: profile.secret,
    ...(profile.password ? { password: profile.password } : {}),
    enableRateLimit: true,
    options: {
      defaultType: market === 'future' ? 'future' : 'spot'
    }
  });

  cache.set(key, instance);
  return instance;
}
