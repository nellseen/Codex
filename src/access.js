export function isAllowedTelegramUser(userId, allowedIds) {
  return userId !== undefined && userId !== null && allowedIds.has(String(userId));
}

export function accessControl(allowedIds) {
  return async (ctx, next) => {
    const allowed = isAllowedTelegramUser(ctx.from?.id, allowedIds);
    if (process.env.CODEX_MANAGER_DIAGNOSTICS === '1') {
      const kind = ctx.callbackQuery ? 'callback' : ctx.message ? 'message' : 'other';
      console.info(`Telegram update ${allowed ? 'authorized' : 'rejected'} (${kind}).`);
    }
    if (!allowed) {
      if (/\bsk-[A-Za-z0-9_-]{8,}\b/.test(ctx.message?.text ?? '')) {
        ctx.message.text = '';
        try { await ctx.deleteMessage(); } catch { /* Best effort; Telegram may reject deletion. */ }
        const response = ctx.chat?.type === 'private'
          ? 'Akses ditolak.'
          : 'API key dihapus best effort. Kirim kredensial hanya melalui private chat dengan bot.';
        if (ctx.chat) await ctx.reply(response);
        return;
      }
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Akses ditolak.');
      } else if (ctx.chat) {
        await ctx.reply('Akses ditolak.');
      }
      return;
    }
    return next();
  };
}
