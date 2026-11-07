import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function emptyState() {
  return { profiles: [], selected: {}, dashboards: {}, migrations: {} };
}

export function createStore(dataDir) {
  const file = path.join(dataDir, 'profiles.json');
  const legacyDashboardFile = path.join(dataDir, 'dashboard.json');
  let writeQueue = Promise.resolve();

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return {
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        selected: parsed.selected && typeof parsed.selected === 'object' ? parsed.selected : {},
        dashboards: parsed.dashboards && typeof parsed.dashboards === 'object' ? parsed.dashboards : {},
        migrations: parsed.migrations && typeof parsed.migrations === 'object' ? parsed.migrations : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const state = emptyState();
      try {
        const legacy = JSON.parse(await readFile(legacyDashboardFile, 'utf8'));
        if (legacy.dashboards && typeof legacy.dashboards === 'object') state.dashboards = legacy.dashboards;
      } catch (legacyError) {
        if (legacyError.code !== 'ENOENT') throw legacyError;
      }
      return state;
    }
  }

  async function update(mutator) {
    const operation = writeQueue.then(async () => {
      const state = await read();
      const result = await mutator(state);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await chmod(dataDir, 0o700);
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      await chmod(file, 0o600);
      return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return {
    async getDashboardMessage(chatId) {
      const state = await read();
      const item = state.dashboards[String(chatId)];
      return item?.messageId ? { messageId: item.messageId } : null;
    },
    async saveDashboardMessage(chatId, messageId) {
      return update((state) => { state.dashboards[String(chatId)] = { messageId }; });
    },
    async isLegacyStartIntroCleanupDone(chatId) {
      return Boolean((await read()).migrations.legacyStartIntroCleanup?.[String(chatId)]);
    },
    async markLegacyStartIntroCleanupDone(chatId) {
      return update((state) => {
        state.migrations.legacyStartIntroCleanup ??= {};
        state.migrations.legacyStartIntroCleanup[String(chatId)] = true;
      });
    },
    async listProfiles() { return (await read()).profiles; },
    async getProfile(id) { return (await read()).profiles.find((profile) => profile.id === id) ?? null; },
    async getSelectedProfileId(telegramUserId) {
      return (await read()).selected[String(telegramUserId)] ?? null;
    },
    async createProfile(profile) {
      return update((state) => {
        if (state.profiles.some((item) => item.id === profile.id)) throw new Error('Profile ID already exists');
        state.profiles.push(profile);
      });
    },
    async selectProfile(telegramUserId, profileId) {
      return update((state) => {
        if (!state.profiles.some((profile) => profile.id === profileId)) throw new Error('Profile not found');
        state.selected[String(telegramUserId)] = profileId;
      });
    },
    async renameProfile(profileId, name) {
      return update((state) => {
        const profile = state.profiles.find((item) => item.id === profileId);
        if (!profile) throw new Error('Profile not found');
        profile.name = name;
      });
    },
    async deleteProfile(profileId) {
      return update((state) => {
        const index = state.profiles.findIndex((profile) => profile.id === profileId);
        if (index < 0) throw new Error('Profile not found');
        state.profiles.splice(index, 1);
        for (const [userId, selectedId] of Object.entries(state.selected)) {
          if (selectedId === profileId) delete state.selected[userId];
        }
      });
    }
  };
}
