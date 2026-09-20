import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

let cached = null;

function interpolate(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? '';
  }
  return value;
}

function interpolateDeep(value) {
  if (Array.isArray(value)) {
    return value.map(interpolateDeep);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolateDeep(entry)]));
  }
  return interpolate(value);
}

export function loadConfig() {
  if (cached) {
    return cached;
  }

  const file = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error('config.json not found. Copy config.example.json to config.json and fill it in.');
  }

  cached = interpolateDeep(JSON.parse(fs.readFileSync(file, 'utf8')));
  return cached;
}
