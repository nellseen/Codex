import { Markup } from 'telegraf';

export const DASHBOARD_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback('🔐 Login', 'dashboard:login'), Markup.button.callback('👤 All account quotas', 'dashboard:accounts')],
  [Markup.button.callback('⚙️ Settings', 'dashboard:settings')]
]);

export const LOGIN_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback('Sign in with ChatGPT', 'login:start:chatgpt')],
  [Markup.button.callback('Sign in with Device Code', 'login:start:device')],
  [Markup.button.callback('Sign in another way (API Key)', 'login:start:apiKey')],
  [Markup.button.callback('Back', 'dashboard:home')]
]);

export function loginCancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('Cancel login', 'login:cancel')]]);
}

export function loginLinkKeyboard(url, cancellable = true) {
  const rows = [[Markup.button.url('Open login page', url)]];
  if (cancellable) rows.push([Markup.button.callback('Cancel login', 'login:cancel')]);
  return Markup.inlineKeyboard(rows);
}

export function inlineKeyboardFor(view) {
  return view === 'login' ? LOGIN_KEYBOARD : DASHBOARD_KEYBOARD;
}

export function accountsKeyboard(profiles) {
  const rows = profiles.flatMap((profile) => [
    [
      Markup.button.callback('✏️ Rename', `profile:rename:${profile.id}`),
      Markup.button.callback('🚪 Logout', `profile:logout:${profile.id}`),
      Markup.button.callback('🗑️ Delete', `profile:delete:${profile.id}`)
    ]
  ]);
  if (profiles.length) rows.push([Markup.button.callback('🔄 Refresh all quotas', 'dashboard:quota')]);
  rows.push([Markup.button.callback('Back', 'dashboard:home')]);
  return Markup.inlineKeyboard(rows);
}

export function confirmDeleteKeyboard(profileId) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('Delete profile', `profile:confirm:${profileId}`),
    Markup.button.callback('Cancel', 'profile:list')
  ]]);
}

export function confirmLogoutKeyboard(profileId) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('Confirm logout', `profile:confirm_logout:${profileId}`),
    Markup.button.callback('Cancel', 'profile:list')
  ]]);
}

export function cancelInputKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'profile:cancel')]]);
}
