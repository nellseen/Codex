import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProcessRunner, ALLOWED_CODEX_ACTIONS } from '../src/services/process-runner.js';
import { createCodexService, parseLoginHelp, parseLoginOutput } from '../src/services/codex.js';
import { getUsage } from '../src/services/usage.js';
import { createAppServerAccountProvider, createAppServerUsageProvider } from '../src/services/app-server-usage.js';
import { redactSecrets } from '../src/utils/redact.js';

test('login help capabilities are detected from installed CLI output', () => {
  const capabilities = parseLoginHelp('Usage: codex login [OPTIONS]\n--device-auth\n--with-api-key');
  assert.deepEqual(capabilities, { oauth: true, deviceAuth: true, apiKey: true });
  assert.equal(parseLoginHelp('Usage: codex login').deviceAuth, false);
});

test('login instructions are extracted only from CLI output', () => {
  assert.deepEqual(parseLoginOutput('Open https://auth.openai.com/codex/device\nEnter this code: ABCD-EFGH', 'device'), {
    url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH'
  });
  assert.deepEqual(parseLoginOutput('Waiting for browser authentication', 'chatgpt'), { url: undefined, code: undefined });
});

test('process runner uses only fixed command arguments and passes API key on stdin', async () => {
  let invocation;
  let received = '';
  const spawn = (bin, args, options) => {
    invocation = { bin, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => { received += chunk.toString('utf8'); });
    setImmediate(() => {
      child.stdout.end('done');
      child.stderr.end();
      child.emit('close', 0, null);
    });
    child.kill = () => true;
    return child;
  };

  const runner = createProcessRunner('/usr/bin/codex', { spawn });
  const result = await runner.start('loginApiKey', { home: '/tmp/profile-home', stdinSecret: 'sk-example-secret' }).done;
  assert.equal(result.code, 0);
  assert.equal(invocation.bin, '/usr/bin/codex');
  assert.deepEqual(invocation.args, ALLOWED_CODEX_ACTIONS.loginApiKey.args);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.CODEX_HOME, '/tmp/profile-home');
  assert.equal(received, 'sk-example-secret');
  assert.equal(invocation.args.includes('sk-example-secret'), false);
});

test('command allowlist is fixed, immutable, and contains no shell command', () => {
  assert.deepEqual(Object.keys(ALLOWED_CODEX_ACTIONS).sort(), ['cliHelp', 'loginApiKey', 'loginDevice', 'loginHelp', 'loginOAuth', 'loginStatus', 'logout'].sort());
  for (const command of Object.values(ALLOWED_CODEX_ACTIONS)) {
    assert.equal(Object.isFrozen(command.args), true);
    assert.equal(command.args.some((argument) => ['sh', 'bash', 'rm', 'curl', 'wget', 'sudo'].includes(argument)), false);
  }
  assert.equal(Object.isFrozen(ALLOWED_CODEX_ACTIONS), true);
});

test('redaction removes API keys, Telegram tokens, bearer tokens, and URLs', () => {
  const apiKey = 'sk-test-secret-value';
  const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
  const result = redactSecrets(`key=${apiKey}; BOT_TOKEN=${token}; CODEX_ACCESS_TOKEN=eyJanother-secret; Bearer eyJhbGciOiJlong-secret; https://auth.openai.com/path?secret=abc`, [apiKey]);
  assert.equal(result.includes(apiKey), false);
  assert.equal(result.includes(token), false);
  assert.equal(result.includes('eyJanother-secret'), false);
  assert.equal(result.includes('eyJhbGciOiJlong-secret'), false);
  assert.equal(result.includes('secret=abc'), false);
});

test('process output is redacted before returning to callers', async () => {
  const apiKey = 'sk-test-secret-value';
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`echo ${apiKey}`);
      child.stderr.end(`https://auth.openai.com/?client_secret=${apiKey}`);
      child.emit('close', 1, null);
    });
    return child;
  };
  const runner = createProcessRunner('codex', { spawn });
  const result = await runner.start('loginApiKey', { home: '/tmp/p', stdinSecret: apiKey }).done;
  assert.equal(result.stdout.includes(apiKey), false);
  assert.equal(result.stderr.includes(apiKey), false);
  assert.equal(result.stderr.includes('https://'), false);
});

test('process output is capped to the configured maximum size', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end('x'.repeat(100_000));
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  const runner = createProcessRunner('codex', { spawn });
  const result = await runner.start('loginStatus', { home: '/tmp/p' }).done;
  assert.equal(Buffer.byteLength(result.stdout), 64 * 1024);
});

test('process runner enforces a short timeout and terminates the child', async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    return child;
  };
  const runner = createProcessRunner('codex', { spawn });
  const result = await runner.start('loginStatus', { home: '/tmp/profile-home', timeoutMs: 5 }).done;
  assert.equal(killed, true);
  assert.equal(result.timedOut, true);
});

test('process runner cancellation kills the child process', async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    return child;
  };
  const runner = createProcessRunner('codex', { spawn });
  const process = runner.start('loginOAuth', { home: '/tmp/profile-home' });
  process.cancel();
  const result = await process.done;
  assert.equal(killed, true);
  assert.equal(result.cancelled, true);
});

test('successful login is reported only when login status verification succeeds', async () => {
  const actions = [];
  const runner = {
    start(action, options) {
      actions.push({ action, options });
      const result = action === 'loginHelp'
        ? { code: 0, stdout: 'Usage: codex login\n--device-auth\n--with-api-key', stderr: '' }
        : action === 'loginOAuth'
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: 'Not logged in', stderr: '' };
      return { done: Promise.resolve({ ...result, timedOut: false, cancelled: false }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  const session = await service.startLogin({ id: 'profile-id', home: '/profile/home' }, 'chatgpt');
  assert.deepEqual(await session.done, { success: false, verificationFailed: true });
  assert.deepEqual(actions.map(({ action }) => action), ['loginHelp', 'loginOAuth', 'loginStatus']);
  assert.equal(actions.every(({ options }) => options.home === '/profile/home'), true);
});

test('verified ChatGPT login returns success only after status exits zero', async () => {
  const actions = [];
  const runner = {
    start(action) {
      actions.push(action);
      return { done: Promise.resolve({ code: 0, stdout: action === 'loginHelp' ? 'Usage: codex login' : '', stderr: '', timedOut: false }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  const session = await service.startLogin({ id: 'p', home: '/p' }, 'chatgpt');
  assert.deepEqual(await session.done, { success: true, method: 'chatgpt' });
  assert.deepEqual(actions, ['loginHelp', 'loginOAuth', 'loginStatus']);
});

test('only one login can run for a profile at a time', async () => {
  let finishHelp;
  const runner = {
    start(action) {
      if (action === 'loginHelp') return { done: new Promise((resolve) => { finishHelp = resolve; }), cancel() {} };
      return { done: Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  const profile = { id: 'same-profile', home: '/same' };
  const first = service.startLogin(profile, 'chatgpt');
  await assert.rejects(service.startLogin(profile, 'device'), /already in progress/);
  finishHelp({ code: 0, stdout: 'Usage: codex login', stderr: '', timedOut: false });
  const session = await first;
  service.cancelLogin(profile.id);
  await session.done;
});

test('API key service passes the credential only as stdin and suppresses output parsing', async () => {
  let apiOptions;
  const runner = {
    start(action, options) {
      if (action === 'loginApiKey') apiOptions = options;
      const stdout = action === 'loginHelp' ? 'Usage: codex login\n--with-api-key' : 'sk-secret-echo';
      return { done: Promise.resolve({ code: 0, stdout, stderr: '', timedOut: false }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  const session = await service.startLogin({ id: 'p', home: '/p' }, 'apiKey', { secret: 'sk-test-secret' });
  assert.equal(apiOptions.stdinSecret, 'sk-test-secret');
  assert.equal(apiOptions.onOutput, undefined);
  assert.deepEqual(await session.done, { success: true, method: 'apiKey' });
});

test('login status maps only CLI exit status to authentication state', async () => {
  let code = 0;
  const runner = {
    start() {
      return { done: Promise.resolve({ code, stdout: 'Not a quota value', stderr: '', timedOut: false }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  const profile = { id: 'p', home: '/p' };
  assert.deepEqual(await service.checkLoginStatus(profile), { available: true, connected: true });
  code = 1;
  assert.deepEqual(await service.checkLoginStatus(profile), { available: true, connected: false });
});

test('logout is checked against CLI support, uses fixed logout action, and verifies credentials are gone', async () => {
  const actions = [];
  const runner = {
    start(action, options) {
      actions.push({ action, options });
      const result = action === 'cliHelp'
        ? { code: 0, stdout: '  logout  Remove stored authentication credentials', stderr: '' }
        : action === 'logout'
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: 'Not logged in', stderr: '' };
      return { done: Promise.resolve({ ...result, timedOut: false }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  assert.deepEqual(await service.logout({ id: 'p', home: '/p' }), { success: true });
  assert.deepEqual(actions.map(({ action }) => action), ['cliHelp', 'logout', 'loginStatus']);
  assert.deepEqual(actions[1].options.home, '/p');
});

test('usage provider remains unavailable regardless of authentication status', async () => {
  const result = await getUsage({ id: 'p', authentication: { connected: true } });
  assert.equal(result.available, false);
  assert.equal(result.source, 'supported-codex-cli');
  assert.equal(Number.isNaN(Date.parse(result.checkedAt)), false);
  assert.equal('windows' in result, false);
});

test('app-server usage provider reads real rate limit windows for the selected profile', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; };
  const provider = createAppServerUsageProvider('codex', { spawn: (_bin, args, options) => {
    assert.deepEqual(args, ['app-server', '--stdio']);
    assert.equal(options.shell, false);
    assert.equal(options.env.CODEX_HOME, '/profiles/selected');
    child.stdin.on('data', (data) => {
      const requests = data.toString().trim().split('\n').map((line) => JSON.parse(line));
      if (requests.some((request) => request.method === 'initialize')) {
        setImmediate(() => child.stdout.write('{"id":0,"result":{}}\n'));
      }
      if (requests.some((request) => request.method === 'account/rateLimits/read')) {
        setImmediate(() => child.stdout.write('{"id":1,"result":{"rateLimitsByLimitId":{"codex":{"planType":"plus","primary":{"usedPercent":25,"resetsAt":2000000000},"secondary":{"usedPercent":60,"resetsAt":2000003600}}}}}\n'));
      }
    });
    return child;
  } });
  const result = await provider({ home: '/profiles/selected' });
  assert.equal(result.available, true);
  assert.equal(result.source, 'codex-app-server');
  assert.equal(result.windows[0].used, '25%');
  assert.equal(result.windows[0].remaining, '75%');
  assert.equal(result.windows[1].used, '60%');
});

test('app-server account provider reads the email from the selected Codex profile', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; };
  const provider = createAppServerAccountProvider('codex', { spawn: (_bin, _args, options) => {
    assert.equal(options.shell, false);
    child.stdin.on('data', (data) => {
      const requests = data.toString().trim().split('\n').map((line) => JSON.parse(line));
      if (requests.some((request) => request.method === 'initialize')) setImmediate(() => child.stdout.write('{"id":0,"result":{}}\n'));
      if (requests.some((request) => request.method === 'account/read')) setImmediate(() => child.stdout.write('{"id":1,"result":{"account":{"type":"chatgpt","email":"person@example.com"}}}\n'));
    });
    return child;
  } });
  assert.equal(await provider({ home: '/profiles/selected' }), 'person@example.com');
});


test('unsupported device auth is not launched', async () => {
  const actions = [];
  const runner = {
    start(action) {
      actions.push(action);
      return { done: Promise.resolve({ code: 0, stdout: 'Usage: codex login', stderr: '' }), cancel() {} };
    }
  };
  const service = createCodexService('codex', { runner });
  const result = await service.startLogin({ id: 'profile-id', home: '/profile/home' }, 'device');
  assert.equal(result.supported, false);
  assert.deepEqual(actions, ['loginHelp']);
});

test('cancel stops the active profile login and prevents status verification', async () => {
  let finishLogin;
  let cancelled = false;
  const actions = [];
  const runner = {
    start(action) {
      actions.push(action);
      if (action === 'loginHelp') return { done: Promise.resolve({ code: 0, stdout: 'Usage: codex login', stderr: '' }), cancel() {} };
      return {
        done: new Promise((resolve) => { finishLogin = resolve; }),
        cancel() { cancelled = true; finishLogin({ code: null, stdout: '', stderr: '', timedOut: false, cancelled: true }); }
      };
    }
  };
  const service = createCodexService('codex', { runner });
  const session = await service.startLogin({ id: 'profile-id', home: '/profile/home' }, 'chatgpt');
  assert.equal(service.cancelLogin('profile-id'), true);
  assert.equal(cancelled, true);
  assert.deepEqual(await session.done, { success: false, cancelled: true, timedOut: false });
  assert.deepEqual(actions, ['loginHelp', 'loginOAuth']);
});
