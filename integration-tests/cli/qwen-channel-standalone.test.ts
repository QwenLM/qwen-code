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
    expect(existsSync(pidFile)).toBe(true);

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
