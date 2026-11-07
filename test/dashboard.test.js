import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsageResult, registerDashboardHandlers, renderDashboard } from '../src/dashboard.js';
import { createStore } from '../src/store.js';
import { escapeHtml } from '../src/utils/escape-html.js';
import { withKeyLock } from '../src/utils/locks.js';
import { accountsKeyboard, DASHBOARD_KEYBOARD, LOGIN_KEYBOARD } from '../src/keyboards.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const keyboard = { reply_markup: { inline_keyboard: [] } };

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-manager-'));
  return { dir, store: createStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('dashboard edits the saved message ID', async () => {
  const f = await fixture();
  try {
    await f.store.saveDashboardMessage(10, 22);
    const calls = [];
    const ctx = { chat: { id: 10 }, telegram: { editMessageText: async (...args) => calls.push(args) }, reply: async () => assert.fail('unexpected fallback') };
    assert.equal(await renderDashboard(ctx, f.store, 'hello', keyboard), 22);
    assert.equal(calls[0][1], 22);
  } finally { await f.cleanup(); }
});

test('/start shows the bot explanation in a single dashboard message', async () => {
  let startHandler;
  let savedMessageId;
  const bot = {
    start(handler) { startHandler = handler; },
    hears() {}, on() {}, action() {}
  };
  const store = {
    async getDashboardMessage() { return null; },
    async saveDashboardMessage(_chatId, messageId) { savedMessageId = messageId; }
  };
  registerDashboardHandlers(bot, store, { list: async () => [], selected: async () => null }, {});
  const replies = [];
  const ctx = {
    from: { id: 5 }, chat: { id: 10 },
    async reply(text, options) { replies.push({ text, options }); return { message_id: replies.length }; },
    telegram: {}
  };
  await startHandler(ctx);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /mengelola profil login Codex CLI/);
  assert.equal(replies[0].options.reply_markup.inline_keyboard.length, 2);
  assert.equal(savedMessageId, 1);
});

test('/start includes usage from all profiles in that same dashboard message', async () => {
  let startHandler;
  const bot = { start(handler) { startHandler = handler; }, hears() {}, on() {}, action() {} };
  const store = { async getDashboardMessage() { return null; }, async saveDashboardMessage() {} };
  const profiles = { list: async () => [
    { id: 'one', name: 'one@example.com' },
    { id: 'two', name: 'two@example.com' }
  ] };
  let usageCalls = 0;
  let sent;
  registerDashboardHandlers(bot, store, profiles, {}, async () => {
    usageCalls += 1;
    return { available: true, windows: [{ label: 'Weekly', used: `${usageCalls * 10}%`, remaining: `${100 - usageCalls * 10}%` }] };
  });
  await startHandler({
    from: { id: 5 }, chat: { id: 10 },
    async reply(text, options) { sent = { text, options }; return { message_id: 1 }; },
    telegram: {}
  });
  assert.equal(usageCalls, 2);
  assert.match(sent.text, /Bot ini mengelola/);
  assert.match(sent.text, /one@example\.com/);
  assert.match(sent.text, /two@example\.com/);
  assert.match(sent.text, /10%/);
  assert.match(sent.text, /20%/);
});

test('refresh lives in all-account quotas; account management keeps delete and login methods stay simple', () => {
  const loginCallbacks = LOGIN_KEYBOARD.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  const accountCallbacks = accountsKeyboard([{ id: '123e4567-e89b-42d3-a456-426614174000', name: 'user@example.com' }])
    .reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(loginCallbacks.includes('login:start:chatgpt'));
  assert.equal(loginCallbacks.includes('profile:add'), false);
  assert.equal(accountCallbacks.includes('profile:add'), false);
  assert.ok(accountCallbacks.some((callback) => callback?.startsWith('profile:delete:')));
  assert.ok(accountCallbacks.includes('dashboard:quota'));
  const dashboardCallbacks = DASHBOARD_KEYBOARD.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(dashboardCallbacks.includes('dashboard:quota'), false);
});

test('/start edits the existing dashboard instead of sending a second message', async () => {
  let startHandler;
  let savedMessageId = 21;
  let cleanupDone = false;
  const bot = { start(handler) { startHandler = handler; }, hears() {}, on() {}, action() {} };
  const store = {
    async getDashboardMessage() { return { messageId: savedMessageId }; },
    async saveDashboardMessage(_chatId, messageId) { savedMessageId = messageId; },
    async isLegacyStartIntroCleanupDone() { return cleanupDone; },
    async markLegacyStartIntroCleanupDone() { cleanupDone = true; }
  };
  registerDashboardHandlers(bot, store, { list: async () => [], selected: async () => null }, {});
  const edits = [];
  const deleted = [];
  const ctx = {
    from: { id: 5 }, chat: { id: 10 },
    async reply() { assert.fail('unexpected second message'); },
    telegram: {
      async editMessageText(...args) { edits.push(args); },
      async deleteMessage(chatId, messageId) { deleted.push([chatId, messageId]); }
    }
  };
  await startHandler(ctx);
  assert.equal(edits.length, 1);
  assert.equal(edits[0][1], 21);
  assert.equal(savedMessageId, 21);
  assert.match(edits[0][3], /mengelola profil login Codex CLI/);
  assert.deepEqual(deleted, [[10, 20]]);
  await startHandler(ctx);
  assert.equal(deleted.length, 1);
  assert.equal(edits.length, 2);
});

test('/start recreates the dashboard if its saved message was cleared from the chat', async () => {
  let startHandler;
  let savedMessageId = 21;
  const bot = { start(handler) { startHandler = handler; }, hears() {}, on() {}, action() {} };
  const store = {
    async getDashboardMessage() { return { messageId: savedMessageId }; },
    async saveDashboardMessage(_chatId, messageId) { savedMessageId = messageId; },
    async isLegacyStartIntroCleanupDone() { return true; },
    async markLegacyStartIntroCleanupDone() {}
  };
  const profiles = { list: async () => [] };
  registerDashboardHandlers(bot, store, profiles, {});
  const sent = [];
  const ctx = {
    from: { id: 5 }, chat: { id: 10 },
    async reply(text, options) { sent.push({ text, options }); return { message_id: 42 }; },
    telegram: { async editMessageText() { throw new Error('message to edit not found'); } }
  };
  await startHandler(ctx);
  assert.equal(sent.length, 1);
  assert.equal(savedMessageId, 42);
  assert.match(sent[0].text, /Bot ini mengelola/);
});

test('new ChatGPT login stores Gmail but shows only a generic account label outside quota list', async () => {
  const actions = [];
  const bot = { start() {}, hears() {}, on() {}, action(trigger, handler) { actions.push({ trigger, handler }); } };
  let profile;
  const profiles = {
    async selected() { return profile ?? null; },
    async list() { return profile ? [profile] : []; },
    async create(name) { profile = { id: '123e4567-e89b-42d3-a456-426614174000', name, home: '/profiles/new' }; return profile; },
    async select() {},
    async rename(_id, name) { profile.name = name; }
  };
  const store = { async getDashboardMessage() { return null; }, async saveDashboardMessage() {} };
  const codex = {
    startLogin: async () => ({ supported: true, done: Promise.resolve({ success: true, method: 'chatgpt' }) }),
    getAccountEmail: async () => 'person@example.com',
    cancelLogin() {}, cancelAll() {}
  };
  registerDashboardHandlers(bot, store, profiles, codex);
  const handler = actions.find(({ trigger }) => String(trigger).includes('login:start:')).handler;
  const shownTexts = [];
  const ctx = {
    match: ['login:start:chatgpt', 'chatgpt'], from: { id: 5 }, chat: { id: 10, type: 'private' },
    async reply(text) { shownTexts.push(text); return { message_id: shownTexts.length }; },
    async answerCbQuery() {}, telegram: {}
  };
  await handler(ctx);
  await new Promise(setImmediate);
  assert.equal(profile.name, 'person@example.com');
  assert.ok(shownTexts.length >= 2);
  assert.equal(shownTexts.some((text) => text.includes('@')), false);
});

test('dashboard creates and saves a replacement when edit fails', async () => {
  const f = await fixture();
  try {
    await f.store.saveDashboardMessage(10, 22);
    const ctx = { chat: { id: 10 }, telegram: { editMessageText: async () => { throw new Error("message to edit not found"); } }, reply: async () => ({ message_id: 33 }) };
    assert.equal(await renderDashboard(ctx, f.store, 'hello', keyboard), 33);
    assert.deepEqual(await f.store.getDashboardMessage(10), { messageId: 33 });
  } finally { await f.cleanup(); }
});

test('message is not modified is success and sends no replacement', async () => {
  const f = await fixture();
  try {
    await f.store.saveDashboardMessage(10, 22);
    const ctx = { chat: { id: 10 }, telegram: { editMessageText: async () => { throw new Error('message is not modified'); } }, reply: async () => assert.fail('unexpected fallback') };
    assert.equal(await renderDashboard(ctx, f.store, 'hello', keyboard), 22);
  } finally { await f.cleanup(); }
});

test('HTML escaping covers dynamic markup characters', () => {
  assert.equal(escapeHtml(`<tag a="'&">`), '&lt;tag a=&quot;&#39;&amp;&quot;&gt;');
});

test('unavailable usage output displays source and last checked without quota values', () => {
  const rendered = formatUsageResult({
    available: false,
    source: 'supported-codex-cli',
    checkedAt: '2026-11-07T00:00:00.000Z',
    message: '<not available>'
  });
  assert.match(rendered, /Status: Unavailable/);
  assert.match(rendered, /Source: supported-codex-cli/);
  assert.match(rendered, /Last checked:/);
  assert.match(rendered, /&lt;not available&gt;/);
  assert.doesNotMatch(rendered, /remaining:|used:|limit:/);
});

test('available quota displays usage and remaining values in a compact table', () => {
  const rendered = formatUsageResult({
    available: true,
    source: 'codex-app-server',
    checkedAt: '2026-11-07T00:00:00.000Z',
    windows: [
      { label: '5-hour', used: '50%', remaining: '50%', resetAt: '2026-12-07T09:02:31.000Z' },
      { label: 'Weekly', used: '20%', remaining: '80%' }
    ]
  });
  assert.match(rendered, /<pre>WINDOW\s+USED\s+LEFT/);
  assert.match(rendered, /5-hour\s+50%\s+50%/);
  assert.match(rendered, /Weekly\s+20%\s+80%/);
  assert.match(rendered, /5-hour reset:/);
});

test('quota refresh edits the saved dashboard with all profiles and answers its callback', async () => {
  const actions = [];
  const bot = { start() {}, hears() {}, on() {}, action(trigger, handler) { actions.push({ trigger, handler }); } };
  let usageCalls = 0;
  const store = { getDashboardMessage: async () => ({ messageId: 44 }), saveDashboardMessage: async () => assert.fail('unexpected replacement') };
  registerDashboardHandlers(bot, store, { list: async () => [{ id: 'one', name: 'one@example.com' }, { id: 'two', name: 'two@example.com' }] }, {}, async () => {
    usageCalls += 1;
    return { available: false, source: 'supported-codex-cli', checkedAt: '2026-11-07T00:00:00Z', message: 'unavailable' };
  });
  const handler = actions.find(({ trigger }) => String(trigger).includes('quota')).handler;
  const edits = [];
  let answered = false;
  await handler({
    match: ['dashboard:quota', 'quota'],
    from: { id: 5 },
    chat: { id: 8 },
    telegram: { editMessageText: async (...args) => edits.push(args) },
    answerCbQuery: async () => { answered = true; }
  });
  assert.equal(usageCalls, 2);
  assert.equal(edits[0][1], 44);
  assert.match(edits[0][3], /All account quotas/);
  assert.equal(answered, true);
});

test('Accounts view shows quota for every profile and keeps delete actions available', async () => {
  const actions = [];
  const bot = { start() {}, hears() {}, on() {}, action(trigger, handler) { actions.push({ trigger, handler }); } };
  const items = [
    { id: 'profile-1', name: 'Account 1' },
    { id: 'profile-2', name: 'Account 2' }
  ];
  let usageCalls = 0;
  const store = { getDashboardMessage: async () => null, saveDashboardMessage: async () => {} };
  const profiles = { list: async () => items, selected: async () => items[0], async rename(id, name) { items.find((item) => item.id === id).name = name; } };
  const codex = {
    getAccountEmail: async (item) => item.id === 'profile-1' ? 'one@example.com' : 'two@example.com',
    getUsage: async () => {
      usageCalls += 1;
      return { available: true, windows: [{ label: 'Weekly', used: '30%', remaining: '70%', resetAt: '2026-12-07T09:02:31.000Z' }] };
    }
  };
  registerDashboardHandlers(bot, store, profiles, codex);
  const handler = actions.find(({ trigger }) => String(trigger).includes('dashboard:accounts')).handler;
  let rendered;
  await handler({
    from: { id: 5 }, chat: { id: 10 }, match: ['dashboard:accounts'],
    async reply(text, options) { rendered = { text, options }; return { message_id: 1 }; },
    async answerCbQuery() {}, telegram: {}
  });
  assert.equal(usageCalls, 2);
  assert.match(rendered.text, /one@example\.com/);
  assert.match(rendered.text, /two@example\.com/);
  assert.equal((rendered.text.match(/Weekly\s+30%\s+70%/g) ?? []).length, 2);
  const callbackData = rendered.options.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(callbackData.some((value) => value?.includes('profile:select:')), false);
  assert.ok(callbackData.some((value) => value?.includes('profile:delete:')));
});

test('API key-like messages in a group are deleted and rejected without echoing the key', async () => {
  const handlers = [];
  const bot = { start() {}, hears() {}, on(_type, handler) { handlers.push(handler); }, action() {} };
  registerDashboardHandlers(bot, {}, {}, {});
  let deleted = false;
  let reply;
  const ctx = {
    from: { id: 500 },
    chat: { id: -50, type: 'group' },
    message: { text: 'sk-test-secret-value' },
    async deleteMessage() { deleted = true; },
    async reply(text) { reply = text; }
  };
  let continued = false;
  await handlers[0](ctx, async () => { continued = true; });
  assert.equal(deleted, true);
  assert.match(reply, /private chat/);
  assert.equal(reply.includes('sk-test-secret-value'), false);
  assert.equal(ctx.message.text, '');
  assert.equal(continued, false);
});

test('per-chat lock serializes operations', async () => {
  const order = [];
  await Promise.all([
    withKeyLock('chat', async () => { order.push('first-start'); await new Promise((r) => setTimeout(r, 10)); order.push('first-end'); }),
    withKeyLock('chat', async () => { order.push('second'); })
  ]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('inline callback is answered even when dashboard rendering fails', async () => {
  const handlers = [];
  const bot = {
    start() {},
    hears() {},
    on() {},
    action(trigger, handler) { handlers.push({ trigger, handler }); }
  };
  registerDashboardHandlers(bot, {}, { list: async () => { throw new Error('storage unavailable'); } });
  const callback = handlers.find(({ trigger }) => String(trigger).includes('home'));
  const answers = [];
  const ctx = {
    match: ['dashboard:home', 'home'],
    from: { id: 5 },
    chat: { id: 10 },
    telegram: {},
    answerCbQuery: async () => answers.push('answered')
  };
  await assert.rejects(callback.handler(ctx), /storage unavailable/);
  assert.deepEqual(answers, ['answered']);
});
