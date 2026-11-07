import 'dotenv/config';
import path from 'node:path';

const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseAllowedIds(value) {
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error('ALLOWED_TELEGRAM_IDS must be a comma-separated list of numeric Telegram user IDs');
  }
  return new Set(ids);
}

export function loadConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  const allowedIds = env.ALLOWED_TELEGRAM_IDS?.trim();
  const codexBin = env.CODEX_BIN?.trim() || 'codex';
  const dataDir = env.DATA_DIR?.trim() || './data';

  if (!token) throw new Error('Missing required environment variable: BOT_TOKEN');
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) throw new Error('BOT_TOKEN has an invalid format');
  if (!allowedIds) throw new Error('Missing required environment variable: ALLOWED_TELEGRAM_IDS');
  if (!/^[^\0]+$/.test(codexBin)) throw new Error('CODEX_BIN must be a non-empty executable name or path');

  return Object.freeze({
    token,
    allowedTelegramIds: parseAllowedIds(allowedIds),
    codexBin,
    dataDir: path.resolve(dataDir)
  });
}
