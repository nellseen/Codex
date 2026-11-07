export function redactSecrets(value, knownSecrets = []) {
  let output = String(value ?? '');
  for (const secret of [...knownSecrets].filter((item) => typeof item === 'string' && item.length > 0).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:[A-Za-z0-9]+_)*(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|bot[_-]?token))\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/https:\/\/[^\s<>"']+/g, '[REDACTED_URL]');
}
