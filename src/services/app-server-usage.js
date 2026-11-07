import { spawn as nodeSpawn } from 'node:child_process';

const TIMEOUT_MS = 20_000;

function unavailable(message) {
  return { available: false, source: 'codex-app-server', checkedAt: new Date().toISOString(), message };
}

function usageFromSnapshot(snapshot) {
  const windows = [snapshot?.primary, snapshot?.secondary].filter(Boolean).map((window, index) => {
    const usedPercent = Number(window.usedPercent);
    if (!Number.isFinite(usedPercent)) return null;
    const duration = Number(window.windowDurationMins);
    const label = duration === 300 ? '5-hour' : duration === 10080 ? 'Weekly' : index === 0 ? 'Primary' : 'Secondary';
    return {
      label,
      used: `${usedPercent}%`,
      remaining: `${Math.max(0, 100 - usedPercent)}%`,
      resetAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : undefined
    };
  }).filter(Boolean);
  if (!windows.length) return null;
  return {
    available: true,
    source: 'codex-app-server',
    checkedAt: new Date().toISOString(),
    windows,
    message: snapshot.planType ? `Plan: ${snapshot.planType}` : undefined
  };
}

export function createAppServerUsageProvider(bin, { spawn = nodeSpawn } = {}) {
  return function getUsage(profile) {
    if (!profile?.home) return Promise.resolve(unavailable('Pilih profil Codex terlebih dahulu.'));

    return new Promise((resolve) => {
      let child;
      let settled = false;
      let initialized = false;
      let stdout = '';
      let timeout;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child && child.exitCode === null) child.kill('SIGTERM');
        resolve(result);
      };
      const requestUsage = () => {
        if (initialized || settled) return;
        initialized = true;
        child.stdin.write('{"method":"initialized"}\n');
        child.stdin.write('{"method":"account/rateLimits/read","id":1,"params":{"supportsLunaReserve":false,"excludeResetCreditDetails":true}}\n');
      };

      try {
        child = spawn(bin, ['app-server', '--stdio'], {
          shell: false,
          cwd: profile.home,
          env: { ...process.env, CODEX_HOME: profile.home },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true
        });
      } catch {
        finish(unavailable('Codex app-server gagal dijalankan.'));
        return;
      }

      timeout = setTimeout(() => finish(unavailable('Codex app-server tidak merespons.')), TIMEOUT_MS);
      timeout.unref?.();
      child.once('error', () => finish(unavailable('Codex app-server gagal dijalankan.')));
      child.once('close', () => {
        if (!settled) finish(unavailable('Codex app-server menutup koneksi sebelum mengembalikan usage.'));
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 256 * 1024) return finish(unavailable('Respons usage Codex terlalu besar.'));
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          let packet;
          try { packet = JSON.parse(line); } catch { continue; }
          if (packet.id === 0 && packet.result) requestUsage();
          if (packet.id === 0 && packet.error) finish(unavailable('Codex app-server menolak inisialisasi.'));
          if (packet.id === 1) {
            if (packet.error) return finish(unavailable('Sumber usage belum tersedia untuk profil ini.'));
            const snapshot = packet.result?.rateLimitsByLimitId?.codex ?? packet.result?.rateLimits;
            finish(usageFromSnapshot(snapshot) ?? unavailable('Codex tidak mengembalikan jendela usage untuk profil ini.'));
          }
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({
        method: 'initialize', id: 0,
        params: { clientInfo: { name: 'codex-telegram-manager', title: 'Codex Telegram Manager', version: '1.0.0' }, capabilities: null }
      }) + '\n');
    });
  };
}

export function createAppServerAccountProvider(bin, { spawn = nodeSpawn } = {}) {
  return async function getAccountEmail(profile) {
    if (!profile?.home) return null;
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let initialized = false;
      let stdout = '';
      let timeout;
      const finish = (email = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child && child.exitCode === null) child.kill('SIGTERM');
        resolve(typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null);
      };
      const requestAccount = () => {
        if (initialized || settled) return;
        initialized = true;
        child.stdin.write('{"method":"initialized"}\n');
        child.stdin.write('{"method":"account/read","id":1,"params":{}}\n');
      };
      try {
        child = spawn(bin, ['app-server', '--stdio'], {
          shell: false,
          cwd: profile.home,
          env: { ...process.env, CODEX_HOME: profile.home },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true
        });
      } catch {
        finish();
        return;
      }
      timeout = setTimeout(() => finish(), TIMEOUT_MS);
      timeout.unref?.();
      child.once('error', () => finish());
      child.once('close', () => finish());
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 256 * 1024) return finish();
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          let packet;
          try { packet = JSON.parse(line); } catch { continue; }
          if (packet.id === 0 && packet.result) requestAccount();
          if (packet.id === 0 && packet.error) finish();
          if (packet.id === 1) finish(packet.result?.account?.email);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({
        method: 'initialize', id: 0,
        params: { clientInfo: { name: 'codex-telegram-manager', title: 'Codex Telegram Manager', version: '1.0.0' }, capabilities: null }
      }) + '\n');
    });
  };
}
