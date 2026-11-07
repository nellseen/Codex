import { Telegraf } from 'telegraf';
import { accessControl } from './access.js';
import { loadConfig } from './config.js';
import { registerDashboardHandlers } from './dashboard.js';
import { createStore } from './store.js';
import { createProfileManager } from './services/profiles.js';
import { createCodexService } from './services/codex.js';

const config = loadConfig();

const bot = new Telegraf(config.token);
const store = createStore(config.dataDir);
const profiles = createProfileManager(store, config.dataDir);
const codex = createCodexService(config.codexBin);

bot.use(accessControl(config.allowedTelegramIds));
const dashboardHandlers = registerDashboardHandlers(bot, store, profiles, codex);

bot.catch((error) => {
  // Never print Telegram token, update payloads, or exception details that may contain secrets.
  console.error(`Bot handler failed (${error?.constructor?.name || 'Error'}).`);
});

const stop = (signal) => {
  console.info(`Received ${signal}; stopping bot.`);
  dashboardHandlers.cancelLogins();
  bot.stop(signal);
};

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

try {
  await bot.launch({ allowedUpdates: ['message', 'callback_query'] }, () => {
    console.info('Telegram bot identity verified; starting long polling.');
  });
} catch (error) {
  console.error(`Bot failed to start (${error?.constructor?.name || 'Error'}). Check configuration and Telegram connectivity.`);
  process.exitCode = 1;
}
