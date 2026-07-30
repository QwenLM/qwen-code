#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const executable = process.argv[2];
if (!executable)
  throw new Error('Usage: node scripts/smoke-packaged.js <executable>');
if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Packaged executable is missing: ${executable}`);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-desktop-smoke-'));
const runtimeInfoPath = path.join(workspace, 'runtime-info.json');
const isolatedHome = path.join(workspace, 'home');
const isolatedState = path.join(workspace, 'state');
fs.mkdirSync(isolatedHome);
fs.mkdirSync(isolatedState);
const appId = 'com.qwen.code.desktop';
const logRoot =
  process.platform === 'darwin'
    ? path.join(isolatedHome, 'Library', 'Logs', appId)
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? isolatedState, appId, 'logs')
      : path.join(isolatedState, appId, 'logs');
const logPath = path.join(logRoot, 'desktop-runtime.log');
fs.mkdirSync(logRoot, { recursive: true });
const previousSize = 0;
const child = spawn(executable, [], {
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    QWEN_DESKTOP_WORKSPACE: workspace,
    QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    QWEN_DESKTOP_TEST_RUNTIME_INFO: runtimeInfoPath,
    HOME: isolatedHome,
    XDG_STATE_HOME: isolatedState,
    ...(process.platform === 'linux'
      ? { NO_AT_BRIDGE: '1', GTK_A11Y: 'none' }
      : {}),
    ...(process.platform === 'darwin'
      ? {}
      : {
          QWEN_DESKTOP_RUNTIME_DIR: path.join(
            packageDir,
            'runtime',
            'qwen-code',
          ),
        }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let processOutput = '';
let completed = false;
captureProcessOutput(child.stdout, 'stdout');
captureProcessOutput(child.stderr, 'stderr');
child.on('exit', (code, signal) => {
  processOutput += `[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`;
});
child.unref();

try {
  await waitForReady(previousSize);
  completed = true;
  console.log(`Packaged desktop runtime ready: ${executable}`);
} finally {
  terminate(child.pid);
  if (completed) fs.rmSync(workspace, { recursive: true, force: true });
}

function captureProcessOutput(stream, name) {
  stream?.on('data', (chunk) => {
    if (processOutput.length >= 16 * 1024) return;
    processOutput += `[${name}] ${chunk.toString('utf8')}`;
    processOutput = processOutput.slice(0, 16 * 1024);
  });
}

async function waitForReady(offset) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const contents = fs
      .readFileSync(logPath, {
        encoding: 'utf8',
        flag: 'a+',
      })
      .slice(offset);
    if (
      contents.includes('qwen serve listening on http://127.0.0.1:') &&
      fs.statSync(runtimeInfoPath, { throwIfNoEntry: false })?.isFile()
    ) {
      const runtime = JSON.parse(fs.readFileSync(runtimeInfoPath, 'utf8'));
      await verifyAuthenticatedShell(runtime, contents);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const contents = fs
    .readFileSync(logPath, {
      encoding: 'utf8',
      flag: 'a+',
    })
    .slice(offset);
  const runtimeInfo = fs
    .statSync(runtimeInfoPath, { throwIfNoEntry: false })
    ?.isFile()
    ? fs.readFileSync(runtimeInfoPath, 'utf8')
    : '<missing>';
  throw new Error(
    `Timed out waiting for packaged desktop runtime.\n${contents}${processOutput}\nRuntime info: ${runtimeInfo}\nSmoke workspace: ${workspace}`,
  );
}

async function verifyAuthenticatedShell({ url, token }, contents) {
  const headers = { Authorization: `Bearer ${token}` };
  const health = await fetch(new URL('/health', url), { headers });
  if (!health.ok || !(await health.text()).includes('"status":"ok"')) {
    throw smokeError(
      `Packaged desktop health check failed: ${health.status}`,
      contents,
    );
  }
  const bootstrapUrl = new URL('/', url);
  bootstrapUrl.searchParams.set('token', token);
  const shell = await fetch(bootstrapUrl, {
    redirect: 'manual',
    headers: {
      Accept: 'text/html',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
    },
  });
  if (shell.status !== 303 || shell.headers.get('location') !== '/') {
    throw smokeError(
      `Packaged desktop Web Shell bootstrap failed: ${shell.status}`,
      contents,
    );
  }
  const cookie = shell.headers
    .getSetCookie()
    .find((value) => value.startsWith('qwen-daemon-token='));
  if (!cookie?.includes('HttpOnly') || !cookie.includes('SameSite=Strict')) {
    throw smokeError(
      'Packaged desktop Web Shell bootstrap cookie is invalid',
      contents,
    );
  }
  const capabilities = await fetch(new URL('/capabilities', url), { headers });
  if (!capabilities.ok) {
    throw smokeError(
      `Packaged desktop authenticated API failed: ${capabilities.status}`,
      contents,
    );
  }
}

function smokeError(message, contents) {
  return new Error(
    `${message}\n${contents}${processOutput}\nSmoke workspace: ${workspace}`,
  );
}

function terminate(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    // The process may already have exited after the smoke succeeded or failed.
  }
}
