#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = process.argv.slice(2);
const isWin = platform() === 'win32';
const children = [];
let shuttingDown = false;

const optionNames = new Set([
  '--port',
  '--hostname',
  '--token',
  '--max-sessions',
  '--workspace',
  '--max-connections',
  '--require-auth',
  '--event-ring-size',
  '--web-port',
  '--web-host',
]);
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

function validateArgs() {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [name, inlineValue] = arg.split('=', 2);
    if (!optionNames.has(name)) {
      throw new Error(`Unsupported web-dev option: ${arg}`);
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

function serveArgsFromLauncherArgs(workspace, daemonPort, daemonHost) {
  const result = ['serve'];
  let hasPort = false;
  let hasHostname = false;
  let hasWorkspace = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.split('=', 1)[0];
    if (!serveOptionNames.has(name)) {
      if (!arg.includes('=')) i += 1;
      continue;
    }
    result.push(arg);
    if (name === '--port') hasPort = true;
    if (name === '--hostname') hasHostname = true;
    if (name === '--workspace') hasWorkspace = true;
    if (!arg.includes('=') && arg !== '--require-auth') {
      result.push(args[i + 1]);
      i += 1;
    }
  }
  if (!hasPort) result.push('--port', daemonPort);
  if (!hasHostname) result.push('--hostname', daemonHost);
  if (!hasWorkspace) result.push('--workspace', workspace);
  return result;
}

function urlFor(hostname, port) {
  const host =
    hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname;
  return `http://${host}:${port}`;
}

function spawnProcess(label, command, commandArgs, options) {
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
    if (code !== 0) console.error(`[${label}] exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function waitForDaemon(url) {
  const healthUrl = new URL('/health', url);
  const deadline = Date.now() + 30_000;
  return new Promise((resolveWait, reject) => {
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
          resolveWait();
          return;
        }
        retryOnce();
      });
      req.on('error', retryOnce);
      req.setTimeout(1000, () => {
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

function checkPortAvailable(hostname, port) {
  const host = hostname === '[::1]' ? '::1' : hostname;
  return new Promise((resolveCheck, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolveCheck(false);
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolveCheck(true));
    });
    server.listen(Number(port), host);
  });
}

function portOwnerHint(port) {
  if (isWin) return '';
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

async function assertPortAvailable({ label, hostname, port, url, retryFlag }) {
  if (await checkPortAvailable(hostname, port)) return;
  const owner = portOwnerHint(port);
  const details = owner ? `\n\nCurrent listener:\n${indent(owner)}` : '';
  throw new Error(
    `${label} port ${port} is already in use.${details}\n\n` +
      `Stop the stale process or choose another port:\n` +
      `  npm run dev:web -- --${retryFlag} <free-port>\n\n` +
      `Requested ${label} URL: ${url}`,
  );
}

function indent(value) {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
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
  setTimeout(() => process.exit(code), 5000).unref();
}

try {
  validateArgs();
} catch (err) {
  console.error(
    `[web-dev] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const daemonPort = readOption('--port') || '4171';
const daemonHost = readOption('--hostname') || '127.0.0.1';
const webPort = readOption('--web-port') || '5174';
const webHost = readOption('--web-host') || '127.0.0.1';
const workspace = resolve(readOption('--workspace') || process.cwd());
const token = readOption('--token') || process.env.QWEN_SERVER_TOKEN;

if (daemonPort === '0') {
  console.error(
    'web-dev: --port 0 is not supported; the launcher needs a fixed daemon port.',
  );
  process.exit(1);
}
if (webPort === '0') {
  console.error(
    'web-dev: --web-port 0 is not supported; use a fixed web port.',
  );
  process.exit(1);
}
if (args.includes('--require-auth') && !token) {
  console.error(
    'web-dev: --require-auth requires --token or QWEN_SERVER_TOKEN.',
  );
  process.exit(1);
}

const daemonUrl = urlFor(daemonHost, daemonPort);
const webUrl = urlFor(webHost, webPort);
const serveArgs = serveArgsFromLauncherArgs(workspace, daemonPort, daemonHost);
const serveEnv = {
  ...process.env,
  QWEN_CODE_NO_RELAUNCH: 'true',
  ...(token ? { QWEN_SERVER_TOKEN: token } : {}),
};
const webEnv = {
  ...process.env,
  QWEN_DAEMON_URL: daemonUrl,
  VITE_QWEN_WORKSPACE_CWD: workspace,
};
const browserUrl = token
  ? `${webUrl}/?token=${encodeURIComponent(token)}`
  : `${webUrl}/`;

console.log('qwen web dev');
console.log(`  daemon:   ${daemonUrl}`);
console.log(`  workspace: ${workspace}`);
console.log(`  web:      ${browserUrl}`);
console.log('');

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

Promise.all([
  assertPortAvailable({
    label: 'daemon',
    hostname: daemonHost,
    port: daemonPort,
    url: daemonUrl,
    retryFlag: 'port',
  }),
  assertPortAvailable({
    label: 'web',
    hostname: webHost,
    port: webPort,
    url: webUrl,
    retryFlag: 'web-port',
  }),
])
  .then(() => {
    spawnProcess('daemon', 'node', ['scripts/dev.js', ...serveArgs], {
      cwd: root,
      env: serveEnv,
    });
    return waitForDaemon(daemonUrl);
  })
  .then(() => {
    spawnProcess(
      'web',
      'npm',
      [
        'run',
        'dev',
        '--workspace=packages/web',
        '--',
        '--host',
        webHost,
        '--port',
        webPort,
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
    console.error(`[web-dev] ${err.message}`);
    shutdown(1);
  });
