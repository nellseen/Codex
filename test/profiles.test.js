import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createProfileManager } from '../src/services/profiles.js';
import { registerDashboardHandlers } from '../src/dashboard.js';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-profile-test-'));
  const store = createStore(dir);
  return { dir, store, profiles: createProfileManager(store, dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('profiles get isolated CODEX_HOME directories and strict permissions', async () => {
  const f = await fixture();
  try {
    const first = await f.profiles.create('Personal');
    const second = await f.profiles.create('Work');
    assert.notEqual(first.home, second.home);
    assert.equal((await stat(first.home)).mode & 0o777, 0o700);
    assert.equal((await stat(second.home)).mode & 0o777, 0o700);
    const metadata = JSON.parse(await readFile(path.join(f.dir, 'profiles.json'), 'utf8'));
    assert.deepEqual(metadata.profiles.map(({ name }) => name), ['Personal', 'Work']);
    assert.equal((await stat(path.join(f.dir, 'profiles.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(metadata).includes('token'), false);
  } finally { await f.cleanup(); }
});

test('selection is stored per Telegram user and rename updates metadata only', async () => {
  const f = await fixture();
  try {
    const first = await f.profiles.create('Personal');
    const second = await f.profiles.create('Work');
    await f.profiles.select(100, first.id);
    await f.profiles.select(200, second.id);
    await f.profiles.rename(first.id, 'Home');
    assert.equal((await f.profiles.selected(100)).name, 'Home');
    assert.equal((await f.profiles.selected(200)).id, second.id);
    assert.equal((await f.profiles.get(first.id)).home, first.home);
  } finally { await f.cleanup(); }
});

test('delete action asks for confirmation before removing profile data', async () => {
  const f = await fixture();
  try {
    const profile = await f.profiles.create('Personal');
    const actions = [];
    const bot = { start() {}, hears() {}, on() {}, action(trigger, handler) { actions.push({ trigger, handler }); } };
    registerDashboardHandlers(bot, f.store, f.profiles, {
      isLoginRunning: () => false,
      async withProfileLock(_id, operation) { return { busy: false, value: await operation() }; }
    });
    const findAction = (trigger) => actions.find(({ trigger: pattern }) => pattern.test(trigger)).handler;
    const invoke = async (pattern, match) => {
      const ctx = {
        match,
        from: { id: 5 },
        chat: { id: 9 },
        message: { text: '' },
        reply: async (_text, options) => { invoke.lastOptions = options; return { message_id: 50 }; },
        telegram: { editMessageText: async () => {} },
        answerCbQuery: async () => {}
      };
      await findAction(pattern)(ctx);
    };
    await invoke(`profile:delete:${profile.id}`, [`profile:delete:${profile.id}`, profile.id]);
    assert.ok(await f.profiles.get(profile.id));
    assert.deepEqual(invoke.lastOptions.reply_markup.inline_keyboard[0].map((button) => button.text), ['Delete profile', 'Cancel']);
    await invoke(`profile:confirm:${profile.id}`, [`profile:confirm:${profile.id}`, profile.id]);
    assert.equal(await f.profiles.get(profile.id), null);
    await assert.rejects(stat(profile.home), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('tampered profile home metadata cannot redirect Codex operations outside profiles root', async () => {
  const f = await fixture();
  try {
    const profile = await f.profiles.create('Personal');
    const metadataPath = path.join(f.dir, 'profiles.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.profiles[0].home = os.tmpdir();
    await writeFile(metadataPath, JSON.stringify(metadata));
    const refreshed = createProfileManager(f.store, f.dir);
    assert.equal(await refreshed.get(profile.id), null);
    await assert.rejects(refreshed.delete(profile.id), /not found/);
    assert.equal((await stat(profile.home)).isDirectory(), true);
  } finally { await f.cleanup(); }
});

test('logout asks for confirmation before invoking the CLI logout action', async () => {
  const f = await fixture();
  try {
    const profile = await f.profiles.create('Personal');
    let logoutCalls = 0;
    const actions = [];
    const bot = { start() {}, hears() {}, on() {}, action(trigger, handler) { actions.push({ trigger, handler }); } };
    registerDashboardHandlers(bot, f.store, f.profiles, {
      isLoginRunning: () => false,
      async logout() { logoutCalls += 1; return { success: true }; }
    });
    const invoke = async (pattern, match) => {
      const ctx = {
        match, from: { id: 5 }, chat: { id: 9 },
        reply: async (_text, options) => { invoke.lastOptions = options; return { message_id: 50 }; },
        telegram: { editMessageText: async () => {} }, answerCbQuery: async () => {}
      };
      await actions.find(({ trigger }) => trigger.test(pattern)).handler(ctx);
    };
    await invoke(`profile:logout:${profile.id}`, [`profile:logout:${profile.id}`, profile.id]);
    assert.equal(logoutCalls, 0);
    assert.deepEqual(invoke.lastOptions.reply_markup.inline_keyboard[0].map((button) => button.text), ['Confirm logout', 'Cancel']);
    await invoke(`profile:confirm_logout:${profile.id}`, [`profile:confirm_logout:${profile.id}`, profile.id]);
    assert.equal(logoutCalls, 1);
  } finally { await f.cleanup(); }
});
