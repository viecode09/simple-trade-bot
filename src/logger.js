import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

function write(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // ignore log write errors
  }
}

export const logger = {
  info: message => write('INFO', message),
  warn: message => write('WARN', message),
  error: message => write('ERROR', message)
};
