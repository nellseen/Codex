import { createProcessRunner } from './process-runner.js';
import { createAppServerAccountProvider, createAppServerUsageProvider } from './app-server-usage.js';

function extractUrl(text) {
  const matches = text.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const match of matches) {
    const candidate = match.replace(/[),.;]+$/g, '');
    try {
      if (new URL(candidate).protocol === 'https:') return candidate;
    } catch { /* Ignore malformed output. */ }
  }
  return undefined;
}

function extractDeviceCode(text) {
  const match = text.match(/(?:enter|user|device)(?:\s+(?:verification|this|the))*\s+code\s*[:：]\s*([A-Z0-9-]{4,})/i);
  return match?.[1];
}

export function parseLoginOutput(output, method) {
  const clean = String(output).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  return {
    url: extractUrl(clean),
    code: method === 'device' ? extractDeviceCode(clean) : undefined
  };
}

export function parseLoginHelp(output) {
  return Object.freeze({
    oauth: /Usage:\s*codex login/i.test(output),
    deviceAuth: /--device-auth\b/.test(output),
    apiKey: /--with-api-key\b/.test(output)
  });
}

export function createCodexService(bin, { runner = createProcessRunner(bin) } = {}) {
  const getUsage = createAppServerUsageProvider(bin);
  const getAccountEmail = createAppServerAccountProvider(bin);
  const active = new Map();
  const capabilityCache = new Map();

  async function capabilities(home) {
    if (!capabilityCache.has(home)) {
      const request = runner.start('loginHelp', { home }).done.then((result) => {
        if (result.code !== 0 || result.timedOut) throw new Error('Could not inspect Codex login options');
        return parseLoginHelp(`${result.stdout}\n${result.stderr}`);
      });
      capabilityCache.set(home, request);
    }
    try { return await capabilityCache.get(home); }
    catch (error) { capabilityCache.delete(home); throw error; }
  }

  async function startLogin(profile, method, { secret, onCredentials, onOutput } = {}) {
    if (!['chatgpt', 'device', 'apiKey'].includes(method)) throw new Error('Unsupported login method');
    if (active.has(profile.id)) throw new Error('A login is already in progress for this profile');
    const reservation = { cancelled: false, cancel: () => { reservation.cancelled = true; } };
    active.set(profile.id, reservation);
    let supported;
    try { supported = await capabilities(profile.home); }
    catch (error) {
      if (active.get(profile.id) === reservation) active.delete(profile.id);
      throw error;
    }
    if (reservation.cancelled) {
      if (active.get(profile.id) === reservation) active.delete(profile.id);
      return { supported: true, done: Promise.resolve({ success: false, cancelled: true }), cancel() {} };
    }
    if ((method === 'device' && !supported.deviceAuth) || (method === 'apiKey' && !supported.apiKey)) {
      if (active.get(profile.id) === reservation) active.delete(profile.id);
      return { supported: false, reason: method === 'device' ? 'device-auth' : 'api-key' };
    }

    const action = method === 'chatgpt' ? 'loginOAuth' : method === 'device' ? 'loginDevice' : 'loginApiKey';
    let observed = '';
    let lastNotice = '';
    const session = runner.start(action, {
      home: profile.home,
      stdinSecret: method === 'apiKey' ? secret : undefined,
      onOutput: method === 'apiKey' ? undefined : (chunk) => {
        observed = (observed + chunk).slice(-8192);
        const { url, code } = parseLoginOutput(observed, method);
        const notice = `${url ?? ''}\n${code ?? ''}`;
        if (notice !== lastNotice && (url || code)) {
          lastNotice = notice;
          onOutput?.({ url, code });
        }
      }
    });
    const activeSession = { ...session, method, cancelled: false };
    reservation.cancel = () => {
      reservation.cancelled = true;
      activeSession.cancel();
    };
    active.set(profile.id, activeSession);

    const done = (async () => {
      const loginResult = await session.done;
      if (loginResult.cancelled || loginResult.timedOut || loginResult.code !== 0) {
        return { success: false, cancelled: loginResult.cancelled, timedOut: loginResult.timedOut };
      }
      const status = await runner.start('loginStatus', { home: profile.home }).done;
      if (status.code !== 0 || status.timedOut) return { success: false, verificationFailed: true };
      onCredentials?.(method);
      return { success: true, method };
    })().finally(() => {
      if (active.get(profile.id) === activeSession) active.delete(profile.id);
    });

    return { supported: true, cancel: activeSession.cancel, done };
  }

  function cancelLogin(profileId) {
    const session = active.get(profileId);
    if (!session) return false;
    session.cancel();
    return true;
  }

  function isLoginRunning(profileId) { return active.has(profileId); }

  function cancelAll() {
    for (const session of active.values()) session.cancel();
  }

  async function checkLoginStatus(profile) {
    if (active.has(profile.id)) return { available: true, connected: false, checking: true };
    const result = await runner.start('loginStatus', { home: profile.home }).done;
    if (result.code === 0) return { available: true, connected: true };
    if (result.code !== null && !result.timedOut) return { available: true, connected: false };
    return { available: false, connected: false };
  }

  async function logout(profile) {
    return withProfileLock(profile.id, async (setCancel) => {
      const helpProcess = runner.start('cliHelp', { home: profile.home });
      setCancel(helpProcess.cancel);
      const help = await helpProcess.done;
      if (help.code !== 0 || help.timedOut || !/^\s*logout(?:\s|$)/m.test(`${help.stdout}\n${help.stderr}`)) {
        return { success: false, supported: false };
      }
      const logoutProcess = runner.start('logout', { home: profile.home });
      setCancel(logoutProcess.cancel);
      const result = await logoutProcess.done;
      if (result.code !== 0 || result.timedOut) return { success: false };
      const statusProcess = runner.start('loginStatus', { home: profile.home });
      setCancel(statusProcess.cancel);
      const status = await statusProcess.done;
      if (status.code !== null && !status.timedOut && status.code !== 0) return { success: true };
      return { success: false, verificationFailed: true };
    });
  }

  async function withProfileLock(profileId, operation) {
    if (active.has(profileId)) return { busy: true };
    let cancel = () => {};
    const reservation = { cancel: () => cancel() };
    active.set(profileId, reservation);
    try { return { busy: false, value: await operation((nextCancel) => { cancel = nextCancel ?? (() => {}); }) }; }
    finally { if (active.get(profileId) === reservation) active.delete(profileId); }
  }

  async function logoutWithBusy(profile) {
    const result = await logout(profile);
    if (result.busy) return { success: false, busy: true };
    return result.value;
  }

  return { capabilities, startLogin, cancelLogin, cancelAll, checkLoginStatus, getUsage, getAccountEmail, isLoginRunning, withProfileLock, logout: logoutWithBusy };
}
