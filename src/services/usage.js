export async function getUsage(_profile) {
  return {
    available: false,
    source: 'supported-codex-cli',
    checkedAt: new Date().toISOString(),
    message: "Quota isn't available through this bot's supported Codex CLI interface. Check the official ChatGPT usage dashboard, or /status inside an active Codex CLI session."
  };
}
