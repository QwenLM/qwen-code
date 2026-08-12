/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ?? path.join(REPO_ROOT, 'dist', 'cli.js');

let child: ChildProcess | undefined;
let testRoot: string | undefined;

function waitForLine(
  proc: ChildProcess,
  needle: string,
  timeoutMs = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${needle}". Output: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Process exited (${String(code)}) before "${needle}". Output: ${buffer}`,
        ),
      );
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForListeningUrl(
  proc: ChildProcess,
  timeoutMs = 60000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for the listening URL. Output: ${buffer}`),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const match = buffer.match(/listening on (https?:\/\/[^\s)]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Process exited (${String(code)}) before the listening URL. Output: ${buffer}`,
        ),
      );
    });
  });
}

async function pollHttp(
  url: string,
  accept: (status: number, body: unknown) => boolean,
  timeoutMs = 30000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON; keep the raw text for the accept predicate.
      }
      if (accept(res.status, body)) return body;
      lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out polling ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

describe('qwen channel start standalone (#8975)', () => {
  it('keeps serving with 0 channels instead of exiting', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-channel-standalone-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspace = path.join(testRoot, 'workspace');
    mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    mkdirSync(runtimeDir);
    mkdirSync(qwenHome, { recursive: true });
    // Nothing configured: the effective channel set is empty.
    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({}),
      'utf-8',
    );
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeFileSync(
      trustedFoldersPath,
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
      'utf-8',
    );
    const pidFile = path.join(qwenHome, 'channels', 'service.pid');

    child = spawn(process.execPath, [CLI_BIN, 'channel', 'start'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QWEN_HOME: qwenHome,
        QWEN_RUNTIME_DIR: runtimeDir,
        QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      },
    });

    await waitForLine(child, 'serving with 0 channels');
    // The child emits the ready line BEFORE writing the pidfile, and the
    // parent's pipe-buffer wakeup gives no ordering guarantee for the child's
    // subsequent file syscalls — poll across the process boundary instead
    // of asserting immediately.
    const pidFileDeadline = Date.now() + 5000;
    while (!existsSync(pidFile)) {
      if (Date.now() > pidFileDeadline) {
        throw new Error(`Timed out waiting for pid file at ${pidFile}`);
      }
      await sleep(50);
    }

    // The pre-fix process exited on its own in under a second once the event
    // loop drained; give it ample time to do so and require it still alive.
    await sleep(2000);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
    child = undefined;
  }, 60000);
});

describe('qwen serve --channel all with an empty channel config (#8975)', () => {
  // End-to-end replay of the production shape from the issue: the ADA
  // sandbox restart where `qwen serve --channel all` boots with zero
  // configured channels. Serve must stay up, report the worker running and
  // shut down cleanly — a regression re-adding "at least one channel"
  // validation to the serve startup path fails here.
  it('keeps serving, reports the worker running, and shuts down cleanly', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-channel-serve-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspace = path.join(testRoot, 'workspace');
    mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    mkdirSync(runtimeDir);
    mkdirSync(qwenHome, { recursive: true });
    // Nothing configured: the effective channel set is empty.
    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({}),
      'utf-8',
    );
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeFileSync(
      trustedFoldersPath,
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
      'utf-8',
    );

    child = spawn(
      process.execPath,
      [CLI_BIN, 'serve', '--channel', 'all', '--port', '0'],
      {
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QWEN_HOME: qwenHome,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
        },
      },
    );

    const baseUrl = await waitForListeningUrl(child);

    await pollHttp(`${baseUrl}/health`, (status) => status === 200);

    interface ControlState {
      enabled?: boolean;
      transition?: string;
      workers?: Array<{ state?: string; channels?: string[] }>;
    }
    const control = (await pollHttp(
      `${baseUrl}/workspace/channel`,
      (_status, body) => {
        const state = body as ControlState;
        return (
          state.enabled === true &&
          state.transition === 'idle' &&
          Array.isArray(state.workers) &&
          state.workers.length > 0 &&
          state.workers[0]!.state === 'running'
        );
      },
    )) as ControlState;
    // Zero configured channels: the committed worker runs with no channels.
    expect(control.workers?.[0]?.channels).toEqual([]);

    // Liveness: the server process is still up after the checks.
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    child = undefined;
  }, 120000);
});
