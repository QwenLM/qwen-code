/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../../..');
const cli = resolve(repoRoot, 'packages/cli/dist/index.js');
const fixture = resolve(here, 'fixture-server.mjs');
const fullSmoke = resolve(here, 'full-tools-smoke.mjs');
const reconnectSmoke = resolve(here, 'cdp-mcp-smoke.mjs');
const adapter = process.env.QWEN_CDP_MCP_COMMAND;
const extensionId =
  process.env.QWEN_CHROME_EXTENSION_ID || 'idkijaaipeeinemigojbjkmfmabokbdk';
const port = Number(process.env.PORT || 4170);
const fixturePort = Number(process.env.FIXTURE_PORT || 4180);
const baseUrl = `http://127.0.0.1:${port}`;

if (!adapter) {
  console.error('Set QWEN_CDP_MCP_COMMAND to an external adapter binary.');
  process.exit(2);
}

const children = new Set();
const spawnChild = (command, args, options = {}) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};
const collect = (child) => {
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  return () => output;
};
const waitForExit = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
};
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    waitForExit(child),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
};
const assertPortFree = (portToCheck) =>
  new Promise((resolveCheck, reject) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: portToCheck,
    });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Port ${portToCheck} is already in use`));
    });
    socket.once('error', () => resolveCheck());
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolveCheck();
    });
  });
const waitForJson = async (url, predicate, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || ''}`);
};
const waitFor = async (predicate, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Timed out waiting for condition');
};
const runScript = async (script, env) => {
  const child = spawnChild(process.execPath, [script], { env });
  const getOutput = collect(child);
  const result = await waitForExit(child);
  process.stdout.write(getOutput());
  if (result.code !== 0) {
    throw new Error(`${script} exited with ${result.code ?? result.signal}`);
  }
};

const qwenHome = await mkdtemp(resolve(tmpdir(), 'qwen-chrome-e2e-'));
await writeFile(resolve(qwenHome, 'settings.json'), '{}\n');
let daemon;
let fixtureServer;
let getDaemonOutput = () => '';
try {
  await assertPortFree(port);
  await assertPortFree(fixturePort);
  fixtureServer = spawnChild(process.execPath, [fixture], {
    env: { ...process.env, FIXTURE_PORT: String(fixturePort) },
  });
  const fixtureOutput = collect(fixtureServer);
  await waitForJson(
    `http://127.0.0.1:${fixturePort}/health`,
    (value) => value.status === 'ok',
    10_000,
  ).catch((error) => {
    throw new Error(`${error.message}\n${fixtureOutput()}`);
  });

  const startDaemon = async ({ withAdapter, waitForBridge = false }) => {
    const daemonEnv = { ...process.env, QWEN_HOME: qwenHome };
    if (withAdapter) daemonEnv.QWEN_CDP_MCP_COMMAND = adapter;
    else delete daemonEnv.QWEN_CDP_MCP_COMMAND;
    const child = spawnChild(
      process.execPath,
      [
        cli,
        'serve',
        '--port',
        String(port),
        '--allow-origin',
        `chrome-extension://${extensionId}`,
      ],
      {
        cwd: repoRoot,
        env: daemonEnv,
      },
    );
    const getOutput = collect(child);
    getDaemonOutput = getOutput;
    await waitForJson(`${baseUrl}/health`, (value) => value.status === 'ok');
    if (waitForBridge) {
      await waitFor(() =>
        getOutput().includes('registered as CDP bridge'),
      ).catch((error) => {
        throw new Error(`${error.message}\n${getOutput()}`);
      });
    }
    if (withAdapter) {
      await waitForJson(`${baseUrl}/workspace/mcp`, (value) =>
        value.servers?.some(
          (server) =>
            server.name === 'chrome-devtools' &&
            server.mcpStatus === 'connected' &&
            server.config?.args?.some((arg) => /\/cdp(?:$|[?#])/.test(arg)),
        ),
      ).catch((error) => {
        throw new Error(`${error.message}\n${getOutput()}`);
      });
    }
    return child;
  };

  daemon = await startDaemon({ withAdapter: false, waitForBridge: true });
  await waitForJson(
    `${baseUrl}/capabilities`,
    (value) =>
      value.features?.includes('cdp_tunnel_over_ws') &&
      !value.features?.includes('browser_automation_mcp'),
  );
  await waitForJson(
    `${baseUrl}/workspace/mcp`,
    (value) => value.servers?.length === 0,
  );
  console.log('DEGRADED-MODE: PASS');
  await stop(daemon);

  daemon = await startDaemon({ withAdapter: true });
  console.log('RUNTIME-MCP: PASS');
  await stop(daemon);
  daemon = await startDaemon({ withAdapter: true });
  console.log('RUNTIME-MCP-RECONNECT: PASS');
  await stop(daemon);

  daemon = await startDaemon({ withAdapter: false, waitForBridge: true });
  const smokeEnv = {
    ...process.env,
    PORT: String(port),
    FIXTURE_URL: `http://127.0.0.1:${fixturePort}`,
    QWEN_CDP_MCP_COMMAND: adapter,
  };
  await runScript(fullSmoke, smokeEnv).catch((error) => {
    process.stderr.write(getDaemonOutput());
    throw error;
  });

  await stop(daemon);
  daemon = await startDaemon({ withAdapter: false, waitForBridge: true });
  await runScript(reconnectSmoke, smokeEnv);
  console.log('REAL-CHROME-E2E: PASS');
} finally {
  await stop(daemon);
  await stop(fixtureServer);
  for (const child of children) child.kill('SIGTERM');
  await rm(qwenHome, { recursive: true, force: true });
}
