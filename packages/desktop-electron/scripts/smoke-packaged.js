#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  throw new Error('Usage: node scripts/smoke-packaged.js <app-or-executable>');
}
const resolvedTarget = path.resolve(target);
verifyPackageMetadata(resolvedTarget);
const executable = resolveExecutable(resolvedTarget);
if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Packaged executable is missing: ${executable}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-electron-smoke-'));
const workspace = path.join(root, 'workspace');
const stateRoot = path.join(root, 'state');
const logsRoot = path.join(stateRoot, 'logs');
const hostLog = path.join(logsRoot, 'desktop-host.log');
const runtimeLog = path.join(logsRoot, 'desktop-runtime.log');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(logsRoot, { recursive: true });

const child = spawn(executable, [], {
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE: '1',
    QWEN_DESKTOP_STATE_ROOT: stateRoot,
    QWEN_DESKTOP_WORKSPACE: workspace,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout?.on('data', (chunk) => capture('stdout', chunk));
child.stderr?.on('data', (chunk) => capture('stderr', chunk));

let baseUrl;
try {
  baseUrl = await waitForReady();
  await verifySecurityBoundary(baseUrl);
  console.log(`Packaged Electron desktop ready at ${baseUrl}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Smoke workspace retained at ${root}`);
  process.exitCode = 1;
} finally {
  await terminateApplication();
}

if (!process.exitCode) {
  await waitForDaemonExit(baseUrl);
  fs.rmSync(root, { recursive: true, force: true });
}

function resolveExecutable(input) {
  if (process.platform === 'darwin' && input.endsWith('.app')) {
    const executableRoot = path.join(input, 'Contents', 'MacOS');
    const candidates = fs.readdirSync(executableRoot, { withFileTypes: true });
    const executable = candidates.find((entry) => entry.isFile());
    if (!executable) {
      throw new Error(`macOS application has no executable: ${input}`);
    }
    return path.join(executableRoot, executable.name);
  }
  return input;
}

function verifyPackageMetadata(input) {
  if (process.platform !== 'darwin' || !input.endsWith('.app')) return;
  const infoPlist = execFileSync(
    '/usr/bin/plutil',
    ['-p', path.join(input, 'Contents', 'Info.plist')],
    { encoding: 'utf8' },
  );
  for (const permission of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    if (infoPlist.includes(permission)) {
      throw new Error(`Packaged app retained device permission: ${permission}`);
    }
  }
}

function capture(stream, chunk) {
  if (output.length >= 16 * 1024) return;
  output = `${output}[${stream}] ${chunk.toString('utf8')}`.slice(0, 16 * 1024);
}

async function waitForReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Electron exited before readiness (${child.exitCode}).\n${output}`,
      );
    }
    const runtime = readLog(runtimeLog);
    const host = readLog(hostLog);
    const match = runtime.match(
      /qwen serve listening on (http:\/\/127\.0\.0\.1:\d+)/,
    );
    if (match && host.includes(`web shell ready at ${match[1]}`)) {
      return match[1];
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for Electron renderer readiness.\n${readLog(hostLog)}\n${readLog(runtimeLog)}\n${output}`,
  );
}

async function verifySecurityBoundary(url) {
  const shell = await fetch(url, { headers: { Accept: 'text/html' } });
  const html = await shell.text();
  if (!shell.ok || !html.includes('<div id="root"></div>')) {
    throw new Error(`Packaged Web Shell is unavailable: ${shell.status}`);
  }
  const unauthenticated = await fetch(`${url}/capabilities`);
  if (unauthenticated.status !== 401) {
    throw new Error(
      `Packaged daemon is not bearer-gated: ${unauthenticated.status}`,
    );
  }
  const deniedOrigin = await fetch(`${url}/capabilities`, {
    headers: { Origin: 'https://example.com' },
  });
  if (deniedOrigin.status !== 403) {
    throw new Error(
      `Packaged daemon admitted an untrusted Origin: ${deniedOrigin.status}`,
    );
  }
}

async function terminateApplication() {
  if (child.exitCode !== null || !child.pid) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // The application may finish between the timeout and the fallback kill.
  }
}

async function waitForDaemonExit(url) {
  if (!url) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `Bundled daemon remained reachable after Electron exit: ${url}`,
  );
}

function readLog(file) {
  return fs.readFileSync(file, { encoding: 'utf8', flag: 'a+' });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
