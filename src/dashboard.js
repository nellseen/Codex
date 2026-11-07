import {
  DASHBOARD_KEYBOARD, inlineKeyboardFor, accountsKeyboard,
  confirmDeleteKeyboard, confirmLogoutKeyboard, cancelInputKeyboard, loginCancelKeyboard, loginLinkKeyboard
} from './keyboards.js';
import { validateProfileName } from './services/profiles.js';
import { getUsage } from './services/usage.js';
import { escapeHtml } from './utils/escape-html.js';
import { withKeyLock } from './utils/locks.js';

export const DASHBOARD_HOME = '<b>🤖 CODEX MANAGER</b>\n\nBot ini mengelola profil login Codex CLI dan merangkum quota semua profil. Tekan Login untuk menambahkan akun baru. Data profil disimpan lokal di perangkat bot.';

const VIEWS = {
  login: '<b>Login Codex</b>\n\nPilih metode autentikasi. Metode login bergantung pada dukungan Codex CLI terpasang.',
  settings: '<b>Settings</b>\n\nPengaturan akan tersedia pada tahap berikutnya.'
};

const START_TEXT = DASHBOARD_HOME;

const pendingInputs = new Map();
const inputKey = (ctx) => `${ctx.chat?.id}:${ctx.from?.id}`;
function profileLabel(profile, index = 0) {
  const name = String(profile?.name ?? 'Codex account');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name) ? `Account ${index + 1}` : name;
}
const diagnostic = (message) => {
  if (process.env.CODEX_MANAGER_DIAGNOSTICS === '1') console.info(`Diagnostic: ${message}`);
};

function isNotModified(error) {
  return String(error?.description || error?.message || '').toLowerCase().includes('message is not modified');
}

function displayTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString();
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export function formatUsageResult(result) {
  const lines = [
    '<b>USAGE / QUOTA</b>',
    `Status: ${result.available ? 'Available' : 'Unavailable'}`,
    `Source: ${escapeHtml(result.source)}`,
    `Last checked: ${escapeHtml(displayTime(result.checkedAt))}`
  ];

  if (result.available && Array.isArray(result.windows) && result.windows.length) {
    const pad = (value, width) => {
      const text = String(value ?? '—');
      return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
    };
    const rows = [
      `${pad('WINDOW', 14)}${pad('USED', 8)}LEFT`,
      ...result.windows.map((window) => `${pad(window.label, 14)}${pad(window.used, 8)}${window.remaining ?? '—'}`)
    ];
    lines.push('', `<pre>${escapeHtml(rows.join('\n'))}</pre>`);
    for (const window of result.windows) {
      if (window.resetAt) lines.push(`${escapeHtml(window.label)} reset: ${escapeHtml(displayTime(window.resetAt))}`);
    }
  }
  if (result.message) lines.push('', escapeHtml(result.message));
  return lines.join('\n');
}

export async function renderDashboard(ctx, store, text = DASHBOARD_HOME, keyboard = DASHBOARD_KEYBOARD, { refreshPosition = false } = {}) {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || chatId === null) throw new Error('Dashboard requires a chat context');

  return withKeyLock(String(chatId), async () => {
    const saved = await store.getDashboardMessage(chatId);
    diagnostic(`dashboard render (saved=${Boolean(saved?.messageId)}, inline-buttons=${keyboard.reply_markup?.inline_keyboard?.flat().length ?? 0})`);
    if (refreshPosition && saved?.messageId) {
      try {
        await ctx.telegram.deleteMessage(chatId, saved.messageId);
        diagnostic('dashboard old message removed for /start refresh');
      } catch {
        diagnostic('dashboard old message could not be removed for /start refresh');
      }
    }
    if (saved?.messageId && !refreshPosition) {
      try {
        await ctx.telegram.editMessageText(chatId, saved.messageId, undefined, text, {
          parse_mode: 'HTML', reply_markup: keyboard.reply_markup
        });
        diagnostic('dashboard edit succeeded');
        return saved.messageId;
      } catch (error) {
        if (isNotModified(error)) {
          diagnostic('dashboard edit unchanged');
          return saved.messageId;
        }
        diagnostic(`dashboard edit failed (${error?.constructor?.name || 'Error'}); creating replacement`);
      }
    }

    const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    await store.saveDashboardMessage(chatId, sent.message_id);
    diagnostic('dashboard replacement sent and saved');
    return sent.message_id;
  });
}

export function registerDashboardHandlers(bot, store, profiles, codex, usageProvider = getUsage) {
  const loginSessions = new Map();
  const showHome = async (ctx) => accountList(ctx, '', { home: true });
  const show = (view) => async (ctx) => {
    diagnostic(`dashboard view handler (${view})`);
    await renderDashboard(ctx, store, VIEWS[view], inlineKeyboardFor(view));
  };
  const accountList = async (ctx, notice = '', { home = false } = {}) => {
    diagnostic('accounts handler');
    const items = await profiles.list();
    if (codex.getAccountEmail) {
      const emails = await mapConcurrent(items, 3, async (item) => {
        try { return await codex.getAccountEmail(item); }
        catch { return null; }
      });
      await Promise.all(items.map(async (item, index) => {
        const email = emails[index];
        if (!email) return;
        if (/^Account \d+$/.test(item.name) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.name)) {
          item.name = email.slice(0, 50);
          try { await profiles.rename(item.id, item.name); } catch { /* Keep displaying the verified local account identity. */ }
        }
      }));
    }
    const usageResults = await mapConcurrent(items, 3, async (item) => {
      try {
        return codex.getUsage ? await codex.getUsage(item) : await usageProvider(item);
      } catch {
        return { available: false, windows: [] };
      }
    });
    const pad = (value, width) => {
      const text = String(value ?? '—');
      return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
    };
    const rows = ['ACCOUNT                          WINDOW    USED   LEFT'];
    if (items.length) {
      items.forEach((item, index) => {
        const result = usageResults[index];
        const windows = result.available ? result.windows ?? [] : [];
        if (!windows.length) {
          rows.push(`${pad(item.name, 32)}Quota unavailable`);
          return;
        }
        windows.forEach((window, windowIndex) => {
          rows.push(`${pad(windowIndex === 0 ? item.name : '', 32)}${pad(window.label, 10)}${pad(window.used, 7)}${window.remaining ?? '—'}`);
          if (window.resetAt) rows.push(`${pad('', 32)}Reset: ${displayTime(window.resetAt)}`);
        });
      });
    } else {
      rows.push('Belum ada akun. Tambahkan akun untuk mulai login.');
    }
    const title = home ? START_TEXT : '<b>All account quotas</b>';
    const actions = home ? '' : '\nDelete, rename, dan logout tersedia untuk tiap akun.';
    const keyboard = home ? DASHBOARD_KEYBOARD : accountsKeyboard(items);
    const text = `${title}${notice ? `\n\n${escapeHtml(notice)}` : ''}\n\n<pre>${escapeHtml(rows.join('\n'))}</pre>${actions}`;
    await renderDashboard(ctx, store, text, keyboard);
  };

  const createAutoProfile = async (userId) => {
    const names = new Set((await profiles.list()).map((item) => item.name));
    let suffix = 1;
    while (names.has(`Account ${suffix}`)) suffix += 1;
    const name = `Account ${suffix}`;
    const profile = await profiles.create(name);
    await profiles.select(userId, profile.id);
    return profile;
  };

  const answerCallback = (trigger, handler) => bot.action(trigger, async (ctx) => {
    diagnostic('callback handler');
    try { await handler(ctx); }
    finally { await ctx.answerCbQuery(); }
  });

  const privateLoginOnly = async (ctx) => {
    if (ctx.chat?.type === 'private') return true;
    await renderDashboard(ctx, store, '<b>Login Codex</b>\n\nBuka private chat dengan bot untuk memulai autentikasi.', inlineKeyboardFor('login'));
    return false;
  };

  const beginLogin = async (ctx, profile, method, secret) => {
    const key = inputKey(ctx);
    if (loginSessions.has(key)) {
      secret = undefined;
      await renderDashboard(ctx, store, '<b>Login sedang berjalan</b>\n\nSelesaikan atau batalkan alur login yang sedang aktif terlebih dahulu.', loginCancelKeyboard());
      return;
    }
    loginSessions.set(key, profile.id);
    let url;
    let code;
    const request = codex.startLogin(profile, method, {
      secret,
      onOutput: (update) => {
        if (update.url) url = update.url;
        if (update.code) code = update.code;
        const detail = method === 'device' && code
          ? `\n\nKode perangkat: <code>${escapeHtml(code)}</code>\nBuka halaman verifikasi dan masukkan kode ini.`
          : '';
        const text = `<b>Login ${escapeHtml(profileLabel(profile))}</b>\n\nMenunggu autentikasi Codex.${detail}`;
        const keyboard = url ? loginLinkKeyboard(url) : loginCancelKeyboard();
        void renderDashboard(ctx, store, text, keyboard).catch(() => {});
      }
    });
    secret = undefined;
    try {
      await renderDashboard(ctx, store, `<b>Login ${escapeHtml(profileLabel(profile))}</b>\n\nMemulai alur autentikasi Codex. Tunggu instruksi dari CLI.`, loginCancelKeyboard());
    } catch (error) {
      codex.cancelLogin(profile.id);
      if (loginSessions.get(key) === profile.id) loginSessions.delete(key);
      throw error;
    }
    let session;
    try { session = await request; }
    catch {
      if (loginSessions.get(key) === profile.id) loginSessions.delete(key);
      await renderDashboard(ctx, store, '<b>Login gagal dimulai</b>\n\nTidak dapat memeriksa atau menjalankan opsi login Codex.', inlineKeyboardFor('login'));
      return;
    }
    if (!session.supported) {
      if (loginSessions.get(key) === profile.id) loginSessions.delete(key);
      await renderDashboard(ctx, store, '<b>Login tidak tersedia</b>\n\nFitur ini tidak didukung versi Codex CLI yang terpasang.', inlineKeyboardFor('login'));
      return;
    }

    session.done.then(async (result) => {
      if (loginSessions.get(key) === profile.id) loginSessions.delete(key);
      let text;
      if (result.success) {
        if (['chatgpt', 'device'].includes(result.method) && codex.getAccountEmail) {
          try {
            const email = await codex.getAccountEmail(profile);
            if (email) {
              await profiles.rename(profile.id, email.slice(0, 50));
              profile.name = email.slice(0, 50);
            }
          } catch { /* Keep the generic account label if CLI account metadata is unavailable. */ }
        }
        const methodName = result.method === 'chatgpt' ? 'ChatGPT' : result.method === 'device' ? 'Device Code' : 'API Key';
        text = `<b>🤖 CODEX MANAGER</b>\n\nAccount: ${escapeHtml(profileLabel(profile))}\nAuthentication: Connected (verified by codex login status)\nLogin method: ${methodName}`;
      } else if (result.cancelled) {
        text = `<b>Login dibatalkan</b>\n\nAutentikasi profil ${escapeHtml(profileLabel(profile))} dibatalkan.`;
      } else if (result.timedOut) {
        text = `<b>Login timeout</b>\n\nAlur autentikasi profil ${escapeHtml(profileLabel(profile))} melewati batas waktu.`;
      } else if (result.verificationFailed) {
        text = '<b>Login belum terverifikasi</b>\n\nCodex CLI tidak mengonfirmasi status login. Periksa profil dan coba lagi.';
      } else {
        text = '<b>Login gagal</b>\n\nCodex CLI tidak menyelesaikan autentikasi. Coba lagi.';
      }
      try { await renderDashboard(ctx, store, text, DASHBOARD_KEYBOARD); } catch { /* Do not expose process or Telegram errors. */ }
    }).catch(() => {
      if (loginSessions.get(key) === profile.id) loginSessions.delete(key);
      void renderDashboard(ctx, store, '<b>Login gagal</b>\n\nTerjadi kesalahan saat memverifikasi login.', DASHBOARD_KEYBOARD).catch(() => {});
    });
  };

  bot.start(async (ctx) => {
    diagnostic('/start handler');
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && chatId !== null && store.isLegacyStartIntroCleanupDone && store.markLegacyStartIntroCleanupDone) {
      if (!await store.isLegacyStartIntroCleanupDone(chatId)) {
        const saved = await store.getDashboardMessage(chatId);
        if (saved?.messageId > 1) {
          try { await ctx.telegram.deleteMessage(chatId, saved.messageId - 1); }
          catch { /* The adjacent message may already be gone. */ }
        }
        await store.markLegacyStartIntroCleanupDone(chatId);
      }
    }
    await showHome(ctx);
  });

  answerCallback(/^dashboard:(home|login|quota|settings)$/, async (ctx) => {
    if (ctx.match[1] === 'home') return showHome(ctx);
    if (ctx.match[1] === 'quota') return accountList(ctx);
    return show(ctx.match[1])(ctx);
  });
  answerCallback(/^dashboard:accounts$/, accountList);
  answerCallback(/^profile:list$/, accountList);
  answerCallback(/^profile:rename:([0-9a-f-]{36})$/i, async (ctx) => {
    const profile = await profiles.get(ctx.match[1]);
    if (!profile) return accountList(ctx, 'Profil tidak ditemukan.');
    pendingInputs.set(inputKey(ctx), { type: 'rename', profileId: profile.id });
    await renderDashboard(ctx, store, `<b>Rename profile</b>\n\nKirim nama baru untuk <b>${escapeHtml(profileLabel(profile))}</b>.`, cancelInputKeyboard());
  });
  answerCallback(/^profile:delete:([0-9a-f-]{36})$/i, async (ctx) => {
    const profile = await profiles.get(ctx.match[1]);
    if (!profile) return accountList(ctx, 'Profil tidak ditemukan.');
    const text = `<b>Hapus profil?</b>\n\nProfil <b>${escapeHtml(profileLabel(profile))}</b> beserta direktori CODEX_HOME dan kredensial di dalamnya akan dihapus. Konfirmasi untuk melanjutkan.`;
    await renderDashboard(ctx, store, text, confirmDeleteKeyboard(profile.id));
  });
  answerCallback(/^profile:logout:([0-9a-f-]{36})$/i, async (ctx) => {
    const profile = await profiles.get(ctx.match[1]);
    if (!profile) return accountList(ctx, 'Profil tidak ditemukan.');
    if (codex.isLoginRunning(profile.id)) return accountList(ctx, 'Batalkan login profil ini sebelum logout.');
    const text = `<b>Logout dari profil?</b>\n\nCodex akan menghapus kredensial tersimpan untuk <b>${escapeHtml(profileLabel(profile))}</b>. Direktori profil tetap ada. Konfirmasi untuk melanjutkan.`;
    await renderDashboard(ctx, store, text, confirmLogoutKeyboard(profile.id));
  });
  answerCallback(/^profile:confirm_logout:([0-9a-f-]{36})$/i, async (ctx) => {
    const profile = await profiles.get(ctx.match[1]);
    if (!profile) return accountList(ctx, 'Profil tidak ditemukan.');
    if (codex.isLoginRunning(profile.id)) return accountList(ctx, 'Batalkan login profil ini sebelum logout.');
    const result = await codex.logout(profile);
    const notice = result.success
      ? `Logout profil ${profileLabel(profile)} berhasil.`
      : result.busy
        ? 'Login sedang berlangsung; logout dibatalkan.'
        : result.supported === false
          ? 'Logout tidak didukung versi Codex CLI terpasang.'
          : result.verificationFailed
            ? 'CLI belum mengonfirmasi bahwa kredensial sudah dihapus.'
            : 'Logout gagal. Kredensial profil belum dinyatakan terhapus.';
    await accountList(ctx, notice);
  });
  answerCallback(/^profile:confirm:([0-9a-f-]{36})$/i, async (ctx) => {
    const profile = await profiles.get(ctx.match[1]);
    if (!profile) return accountList(ctx, 'Profil sudah tidak ditemukan.');
    const result = await codex.withProfileLock(profile.id, () => profiles.delete(profile.id));
    if (result.busy) {
      await accountList(ctx, 'Batalkan proses profil ini sebelum menghapusnya.');
      return;
    }
    await accountList(ctx, `Profil ${profileLabel(profile)} dihapus.`);
  });
  answerCallback(/^profile:cancel$/, async (ctx) => {
    pendingInputs.delete(inputKey(ctx));
    await accountList(ctx, 'Aksi dibatalkan.');
  });

  answerCallback(/^login:start:(chatgpt|device|apiKey)$/, async (ctx) => {
    if (!await privateLoginOnly(ctx)) return;
    const method = ctx.match[1];
    const profile = await createAutoProfile(ctx.from.id);
    if (method === 'apiKey') {
      let supported;
      try { supported = await codex.capabilities(profile.home); }
      catch {
        await renderDashboard(ctx, store, '<b>Codex CLI tidak tersedia</b>\n\nTidak dapat memeriksa opsi login CLI.', inlineKeyboardFor('login'));
        return;
      }
      if (!supported.apiKey) {
        await renderDashboard(ctx, store, '<b>API key login tidak didukung</b>\n\nVersi Codex CLI ini tidak menyediakan `--with-api-key`.', inlineKeyboardFor('login'));
        return;
      }
      pendingInputs.set(inputKey(ctx), { type: 'apiKey', profileId: profile.id });
      await renderDashboard(ctx, store, '<b>Sign in with API Key</b>\n\nKirim API key di private chat ini. Pesan akan segera dihapus dan key tidak ditampilkan kembali.', loginCancelKeyboard());
      return;
    }
    await beginLogin(ctx, profile, method === 'device' ? 'device' : 'chatgpt');
  });

  answerCallback(/^login:cancel$/, async (ctx) => {
    const key = inputKey(ctx);
    const hadPendingInput = pendingInputs.has(key);
    pendingInputs.delete(key);
    let profileId = loginSessions.get(key);
    if (!profileId) profileId = (await profiles.selected(ctx.from.id))?.id;
    const cancelled = profileId ? codex.cancelLogin(profileId) : false;
    const message = cancelled
      ? '<b>Login dibatalkan</b>\n\nPermintaan pembatalan dikirim ke Codex CLI.'
      : hadPendingInput
        ? '<b>Login dibatalkan</b>\n\nPermintaan API key dibatalkan.'
        : '<b>Login</b>\n\nTidak ada alur login yang sedang berjalan.';
    await renderDashboard(ctx, store, message, inlineKeyboardFor('login'));
  });

  bot.on('text', async (ctx, next) => {
    const key = inputKey(ctx);
    const pending = pendingInputs.get(key);
    if (!pending) {
      if (ctx.chat?.type !== 'private' && /\bsk-[A-Za-z0-9_-]{8,}\b/.test(ctx.message.text)) {
        ctx.message.text = '';
        try { await ctx.deleteMessage(); } catch { /* Best effort; Telegram may reject deletion. */ }
        await ctx.reply('API key ditolak di grup. Kirim kredensial hanya melalui private chat dengan bot.');
        return;
      }
      return next();
    }
    pendingInputs.delete(key);

    if (pending.type === 'apiKey') {
      let secret = ctx.message.text;
      ctx.message.text = '';
      try { await ctx.deleteMessage(); } catch { /* Best effort; Telegram may reject deletion. */ }
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('API key ditolak. Kirim kredensial hanya di private chat dengan bot.');
        return;
      }
      if (!secret) {
        await renderDashboard(ctx, store, '<b>API key kosong</b>\n\nMulai lagi dan kirim API key melalui private chat.', inlineKeyboardFor('login'));
        return;
      }
      const profile = await profiles.get(pending.profileId);
      if (!profile) {
        secret = undefined;
        await renderDashboard(ctx, store, '<b>Profil tidak ditemukan</b>\n\nPilih profil lagi sebelum login.', DASHBOARD_KEYBOARD);
        return;
      }
      await beginLogin(ctx, profile, 'apiKey', secret);
      secret = undefined;
      return;
    }

    let name;
    try {
      name = validateProfileName(ctx.message.text);
    } catch {
      await renderDashboard(ctx, store, '<b>Nama profil tidak valid</b>\n\nGunakan nama 1–50 karakter. Kirim nama lain atau batalkan.', cancelInputKeyboard());
      pendingInputs.set(key, pending);
      return;
    }

    try {
      await profiles.rename(pending.profileId, name);
      await accountList(ctx, `Nama profil diperbarui menjadi ${name}.`);
    } catch (error) {
      console.error(`Profile operation failed (${error?.constructor?.name || 'Error'}).`);
      await renderDashboard(ctx, store, '<b>Account</b>\n\nProfil gagal disimpan. Coba lagi atau batalkan.', cancelInputKeyboard());
      pendingInputs.set(key, pending);
    }
  });

  bot.action(/.*/, async (ctx) => {
    diagnostic('unmatched callback handler');
    await ctx.answerCbQuery('Aksi belum tersedia.');
  });

  return {
    cancelLogins() {
      codex.cancelAll();
      loginSessions.clear();
    }
  };
}
