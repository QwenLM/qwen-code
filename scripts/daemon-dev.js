/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = process.argv.slice(2);
const isWin = platform() === 'win32';
const serveOptionNames = new Set([
  '--port',
  '--hostname',
  '--token',
  '--max-sessions',
  '--workspace',
  '--max-connections',
  '--require-auth',
  '--event-ring-size',
]);

function readOption(name) {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      const value = args[i + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
    if (arg.startsWith(prefix)) return arg.slice(prefix.length) || undefined;
  }
  return undefined;
}

function hasOption(name) {
  return readOption(name) !== undefined;
}

function validateLauncherArgs() {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [name, inlineValue] = arg.split('=', 2);
    if (!serveOptionNames.has(name)) {
      throw new Error(`Unsupported daemon-dev option: ${arg}`);
    }
    if (arg === '--require-auth') continue;
    if (arg.includes('=')) {
      if (!inlineValue) throw new Error(`${name} requires a value.`);
      continue;
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value.`);
    }
    i += 1;
  }
}

function serveArgsFromLauncherArgs() {
  const result = ['serve'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.split('=', 1)[0];
    if (!serveOptionNames.has(name)) continue;
    result.push(arg);
    if (!arg.includes('=') && arg !== '--require-auth') {
      result.push(args[i + 1]);
      i += 1;
    }
  }
  return result;
}

function daemonUrl(hostname, port) {
  const host =
    hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname;
  return `http://${host}:${port}`;
}

function spawnDevProcess(label, command, commandArgs, options) {
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    shell: options.shell ?? false,
    detached: !isWin,
    ...options,
  });

  child.on('error', (err) => {
    console.error(`[${label}] failed to start: ${err.message}`);
    shutdown(1);
  });

  child.on('close', (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      console.error(`[${label}] exited by signal ${signal}`);
      shutdown(1);
      return;
    }
    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
    shutdown(code ?? 0);
  });

  children.push(child);
  return child;
}

function killChild(child) {
  if (child.killed) return;
  try {
    if (!isWin && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill();
    }
  } catch {
    child.kill();
  }
}

function waitForDaemon(url) {
  const healthUrl = new URL('/health', url);
  const deadline = Date.now() + 30_000;

  return new Promise((resolve, reject) => {
    const check = () => {
      let retried = false;
      const retryOnce = () => {
        if (retried) return;
        retried = true;
        retry();
      };
      const req = http.get(healthUrl, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        retryOnce();
      });
      req.on('error', retryOnce);
      req.setTimeout(1_000, () => {
        req.destroy();
        retryOnce();
      });
    };

    const retry = () => {
      if (shuttingDown) return;
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${healthUrl.href}`));
        return;
      }
      setTimeout(check, 250);
    };

    check();
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  let pending = 0;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    pending += 1;
    child.on('close', () => {
      pending -= 1;
      if (pending <= 0) process.exit(code);
    });
    killChild(child);
  }
  if (pending === 0) process.exit(code);
  setTimeout(() => process.exit(code), 5_000).unref();
}

const children = [];
let shuttingDown = false;

try {
  validateLauncherArgs();
} catch (err) {
  console.error(
    `[daemon-dev] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const port = readOption('--port') || '4170';
if (port === '0') {
  console.error(
    'daemon-dev: --port 0 is not supported; the launcher needs a fixed port to poll for health.',
  );
  process.exit(1);
}

const hostname = readOption('--hostname') || '127.0.0.1';
const token =
  readOption('--token') ||
  process.env.QWEN_SERVER_TOKEN ||
  crypto.randomBytes(16).toString('hex');
const workspace = resolve(readOption('--workspace') || process.cwd());

const serveArgs = serveArgsFromLauncherArgs();
if (!hasOption('--workspace')) serveArgs.push('--workspace', workspace);

const tsxLoaderUrl = pathToFileURL(
  join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
).href;
const nodeOptions = [process.env.NODE_OPTIONS, `--import ${tsxLoaderUrl}`]
  .filter(Boolean)
  .join(' ');

const serveEnv = {
  ...process.env,
  QWEN_SERVER_TOKEN: token,
  QWEN_CODE_NO_RELAUNCH: 'true',
  NODE_OPTIONS: nodeOptions,
};

const webEnv = {
  ...process.env,
  QWEN_DAEMON_URL: daemonUrl(hostname, port),
};

console.log(`qwen daemon dev`);
console.log(`  daemon:   ${webEnv.QWEN_DAEMON_URL}`);
console.log(`  workspace: ${workspace}`);
console.log(
  `  web-shell: http://localhost:5173/ (token: ${token.slice(0, 4)}...)`,
);
console.log('');

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

spawnDevProcess('daemon', 'node', ['scripts/dev.js', ...serveArgs], {
  cwd: root,
  env: serveEnv,
});

waitForDaemon(webEnv.QWEN_DAEMON_URL)
  .then(() => {
    spawnDevProcess(
      'web-shell',
      'npm',
      [
        'run',
        'dev',
        '--workspace=packages/web-shell',
        '--',
        '--open',
        `/?token=${encodeURIComponent(token)}`,
        '--strictPort',
      ],
      {
        cwd: root,
        env: webEnv,
        shell: isWin,
      },
    );
  })
  .catch((err) => {
    console.error(`[daemon] ${err.message}`);
    shutdown(1);
  });
