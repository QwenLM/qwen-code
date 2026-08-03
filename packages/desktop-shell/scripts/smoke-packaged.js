#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLogRoot, sliceNewLog } from './resolve-log-root.js';

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
const isolatedHome = path.join(workspace, 'home');
const isolatedState = path.join(workspace, 'state');
fs.mkdirSync(isolatedHome);
fs.mkdirSync(isolatedState);
const appId = JSON.parse(
  fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'tauri.conf.json'),
    'utf8',
  ),
).identifier;
// On Windows the log lives under the real %LOCALAPPDATA% (a machine-global
// path shared with any running desktop app), not the smoke workspace. The
// packaged app also uses a Windows-known config directory, so opt this smoke
// out of desktop-state writes before deleting its temporary workspace.
const logRoot = resolveLogRoot(process.platform, process.env, {
  isolatedHome,
  isolatedState,
  appId,
});
const logPath = path.join(logRoot, 'desktop-runtime.log');
fs.mkdirSync(logRoot, { recursive: true });
let previousLog = fs.readFileSync(logPath, {
  encoding: 'utf8',
  flag: 'a+',
});
// The packaged app opens the log append-only and never rotates it, so every
// read extends this pre-spawn snapshot. A broken prefix means a foreign
// writer rewrote the file; readNewLog then warns and rebases the baseline.
const child = spawn(executable, [], {
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    QWEN_DESKTOP_WORKSPACE: workspace,
    QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    HOME: isolatedHome,
    XDG_STATE_HOME: isolatedState,
    XDG_DATA_HOME: isolatedState,
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
    ...(process.platform === 'win32'
      ? { QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE: '1' }
      : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let processOutput = '';
let completed = false;
let exitFailure;
captureProcessOutput(child.stdout, 'stdout');
captureProcessOutput(child.stderr, 'stderr');
child.on('exit', (code, signal) => {
  processOutput += `[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`;
  exitFailure = new Error(
    `Packaged desktop runtime exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
  );
});
child.unref();

try {
  await waitForReady();
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

async function waitForReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exitFailure) throw exitFailure;
    const contents = readNewLog();
    const match = contents.match(
      /qwen serve listening on (http:\/\/127\.0\.0\.1:\d+)/,
    );
    if (match) {
      await verifyPackagedShell(match[1], contents);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const contents = fs.readFileSync(logPath, {
    encoding: 'utf8',
    flag: 'a+',
  });
  throw smokeError('Timed out waiting for packaged desktop runtime.', contents);
}

function readNewLog() {
  const contents = fs.readFileSync(logPath, {
    encoding: 'utf8',
    flag: 'a+',
  });
  const result = sliceNewLog(contents, previousLog);
  if (!contents.startsWith(previousLog)) {
    console.warn(`smoke: log was rewritten, resetting baseline: ${logPath}`);
    previousLog = contents;
  }
  return result.text;
}

// The packaged smoke verifies the unauthenticated navigation boundary: the
// shell HTML is served without a token (the token travels in the URL fragment,
// which never reaches the server), while API routes stay bearer-gated. The
// authenticated path is covered by smoke:runtime on the same bundle.
async function verifyPackagedShell(baseUrl, contents) {
  // The daemon starts in deferred-runtime mode; the delegating app 401s
  // unauthenticated non-bootstrap requests until the runtime is mounted.
  // Retry until the fallback timer starts the runtime and the build finishes.
  const deadline = Date.now() + 30_000;
  let shell;
  do {
    if (exitFailure) throw exitFailure;
    shell = await fetch(new URL('/', baseUrl), {
      redirect: 'manual',
      headers: {
        Accept: 'text/html',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      },
    });
    if (shell.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  if (shell.status !== 200) {
    throw smokeError(
      `Packaged desktop Web Shell navigation failed: ${shell.status}`,
      contents,
    );
  }
  if (shell.headers.getSetCookie().length > 0) {
    throw smokeError(
      'Packaged desktop Web Shell must not mint auth cookies',
      contents,
    );
  }
  if (!(await shell.text()).includes('<!doctype html>')) {
    throw smokeError(
      'Packaged desktop Web Shell navigation did not return the HTML shell',
      contents,
    );
  }
  const unauthenticated = await fetch(new URL('/capabilities', baseUrl));
  if (unauthenticated.status !== 401) {
    throw smokeError(
      `Packaged desktop API is not token-gated: ${unauthenticated.status}`,
      contents,
    );
  }
}

function smokeError(message, contents) {
  return new Error(
    `${message}\nLog: ${logPath}\n${contents}${processOutput}\nSmoke workspace: ${workspace}`,
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
