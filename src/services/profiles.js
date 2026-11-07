import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const NAME_MAX_LENGTH = 50;

export function validateProfileName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > NAME_MAX_LENGTH) {
    throw new Error(`Profile name must be between 1 and ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

export function createProfileManager(store, dataDir) {
  const profilesRoot = path.resolve(dataDir, 'profiles');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  async function getProfile(id) {
    if (typeof id !== 'string' || !uuidPattern.test(id)) return null;
    const profile = await store.getProfile(id);
    if (!profile || !uuidPattern.test(profile.id) || typeof profile.home !== 'string' || path.resolve(profile.home) !== path.join(profilesRoot, profile.id)) return null;
    try { validateProfileName(profile.name); } catch { return null; }
    if (!Number.isFinite(Date.parse(profile.createdAt))) return null;
    return profile;
  }

  return {
    async list() {
      const profiles = await store.listProfiles();
      return Promise.all(profiles.map((profile) => getProfile(profile?.id))).then((items) => items.filter(Boolean));
    },
    get: getProfile,
    async selected(telegramUserId) {
      const id = await store.getSelectedProfileId(telegramUserId);
      return id ? getProfile(id) : null;
    },
    async create(nameValue) {
      const name = validateProfileName(nameValue);
      const id = randomUUID();
      const home = path.join(profilesRoot, id);
      await mkdir(profilesRoot, { recursive: true, mode: 0o700 });
      await chmod(profilesRoot, 0o700);
      await mkdir(home, { recursive: true, mode: 0o700 });
      await chmod(home, 0o700);
      const profile = { id, name, home, createdAt: new Date().toISOString() };
      try {
        await store.createProfile(profile);
      } catch (error) {
        await rm(home, { recursive: true, force: true });
        throw error;
      }
      return profile;
    },
    async select(telegramUserId, profileId) {
      if (!await getProfile(profileId)) throw new Error('Profile not found');
      return store.selectProfile(telegramUserId, profileId);
    },
    async rename(profileId, nameValue) {
      const name = validateProfileName(nameValue);
      if (!await getProfile(profileId)) throw new Error('Profile not found');
      await store.renameProfile(profileId, name);
    },
    async delete(profileId) {
      const profile = await getProfile(profileId);
      if (!profile) throw new Error('Profile not found');
      const expectedHome = path.join(profilesRoot, profile.id);
      if (path.resolve(profile.home) !== expectedHome || !uuidPattern.test(profile.id)) {
        throw new Error('Profile home path is invalid');
      }
      await rm(expectedHome, { recursive: true, force: true });
      await store.deleteProfile(profileId);
    }
  };
}
