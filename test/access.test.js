import test from 'node:test';
import assert from 'node:assert/strict';
import { accessControl, isAllowedTelegramUser } from '../src/access.js';

test('allowlist accepts only configured Telegram user IDs', () => {
  const allowed = new Set(['101', '202']);
  assert.equal(isAllowedTelegramUser(101, allowed), true);
  assert.equal(isAllowedTelegramUser('202', allowed), true);
  assert.equal(isAllowedTelegramUser(303, allowed), false);
  assert.equal(isAllowedTelegramUser(undefined, allowed), false);
});

test('authorized updates continue to handlers', async () => {
  let called = false;
  await accessControl(new Set(['101']))({ from: { id: 101 } }, async () => { called = true; });
  assert.equal(called, true);
});

test('unlisted users are rejected for messages and callbacks', async () => {
  let reply;
  let callbackAnswer;
  let nextCalled = false;
  const middleware = accessControl(new Set(['101']));
  await middleware({ from: { id: 999 }, chat: { id: 5 }, reply: async (text) => { reply = text; } }, async () => { nextCalled = true; });
  await middleware({ from: { id: 999 }, callbackQuery: {}, answerCbQuery: async (text) => { callbackAnswer = text; } }, async () => { nextCalled = true; });
  assert.equal(reply, 'Akses ditolak.');
  assert.equal(callbackAnswer, 'Akses ditolak.');
  assert.equal(nextCalled, false);
});

test('unlisted API key-like group messages are deleted without echoing the key', async () => {
  let deleted = false;
  let reply = '';
  const ctx = {
    from: { id: 999 },
    chat: { id: -8, type: 'group' },
    message: { text: 'sk-private-secret-value' },
    async deleteMessage() { deleted = true; },
    async reply(text) { reply = text; }
  };
  await accessControl(new Set(['101']))(ctx, async () => assert.fail('unauthorized user reached handler'));
  assert.equal(deleted, true);
  assert.match(reply, /private chat/);
  assert.equal(reply.includes('sk-private-secret-value'), false);
  assert.equal(ctx.message.text, '');
});
