import { spawn as nodeSpawn } from 'node:child_process';
import { redactSecrets } from '../utils/redact.js';

export const ALLOWED_CODEX_ACTIONS = Object.freeze({
  cliHelp: Object.freeze({ args: Object.freeze(['--help']), timeoutMs: 15_000 }),
  loginHelp: Object.freeze({ args: Object.freeze(['login', '--help']), timeoutMs: 15_000 }),
  loginOAuth: Object.freeze({ args: Object.freeze(['login']), timeoutMs: 10 * 60_000 }),
  loginDevice: Object.freeze({ args: Object.freeze(['login', '--device-auth']), timeoutMs: 10 * 60_000 }),
  loginApiKey: Object.freeze({ args: Object.freeze(['login', '--with-api-key']), timeoutMs: 30_000 }),
  loginStatus: Object.freeze({ args: Object.freeze(['login', 'status']), timeoutMs: 15_000 }),
  logout: Object.freeze({ args: Object.freeze(['logout']), timeoutMs: 15_000 })
});

const OUTPUT_LIMIT = 64 * 1024;

export function createProcessRunner(bin, { spawn = nodeSpawn } = {}) {
  function start(action, { home, stdinSecret, onOutput, timeoutMs } = {}) {
    const command = ALLOWED_CODEX_ACTIONS[action];
    if (!command) throw new Error('Unsupported local action');
    if (!home || typeof home !== 'string') throw new Error('A profile home is required');

    let child;
    try {
      child = spawn(bin, command.args, {
        shell: false,
        cwd: home,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      return {
        cancel() {},
        done: Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, cancelled: false, spawnError: true })
      };
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const outputSecrets = stdinSecret === undefined ? [] : [stdinSecret];
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer;
    let timeoutTimer;

    const appendLimited = (current, chunk) => {
      if (current.length >= OUTPUT_LIMIT) return current;
      const remaining = OUTPUT_LIMIT - current.length;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    const done = new Promise((resolve) => {
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        resolve({
          ...result,
          stdout: redactSecrets(stdout.toString('utf8'), outputSecrets),
          stderr: redactSecrets(stderr.toString('utf8'), outputSecrets),
          timedOut,
          cancelled
        });
        outputSecrets.length = 0;
      };

      child.stdout?.on('data', (chunk) => {
        stdout = appendLimited(stdout, chunk);
        try { onOutput?.(chunk.toString('utf8')); } catch { /* Output parsers must not disrupt the child process. */ }
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendLimited(stderr, chunk);
        try { onOutput?.(chunk.toString('utf8')); } catch { /* Output parsers must not disrupt the child process. */ }
      });
      child.once('error', () => finish({ code: null, signal: null, spawnError: true }));
      child.once('close', (code, signal) => finish({ code, signal }));
      child.stdin?.on('error', () => {});

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      }, timeoutMs ?? command.timeoutMs);
      timeoutTimer.unref?.();

      if (stdinSecret !== undefined) {
        const secretBuffer = Buffer.from(stdinSecret, 'utf8');
        try {
          child.stdin.write(secretBuffer, () => {
            secretBuffer.fill(0);
            child.stdin.end();
          });
        } catch {
          secretBuffer.fill(0);
          child.stdin.end();
        }
      } else {
        child.stdin.end();
      }
    });

    return {
      done,
      cancel() {
        if (settled || cancelled) return;
        cancelled = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        killTimer.unref?.();
      }
    };
  }

  return { start };
}
