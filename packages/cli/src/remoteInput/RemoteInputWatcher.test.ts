/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RemoteInputWatcher } from './RemoteInputWatcher.js';

/**
 * Shorter poll interval for tests — 100 ms instead of the production 500 ms
 * to keep CI wall-clock time low while remaining reliable under load.
 */
const TEST_POLL_INTERVAL_MS = 100;

/**
 * Wait until `predicate` returns truthy or `timeoutMs` elapses. Polled at
 * `intervalMs`. Used to await filesystem-watcher driven side effects without
 * relying on watcher latency tuning in tests.
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('RemoteInputWatcher', () => {
  let tmpDir: string;
  let inputFile: string;
  let watcher: RemoteInputWatcher | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-remote-input-'));
    inputFile = path.join(tmpDir, 'input.jsonl');
    fs.writeFileSync(inputFile, '');
  });

  afterEach(() => {
    watcher?.shutdown();
    watcher = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwards submit commands to the registered submit fn', async () => {
    watcher = new RemoteInputWatcher(inputFile, {
      pollIntervalMs: TEST_POLL_INTERVAL_MS,
    });
    const submitted: string[] = [];
    watcher.setSubmitFn((text) => {
      submitted.push(text);
    });

    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'hello' }) + '\n',
    );

    await waitFor(() => submitted.length > 0);
    expect(submitted).toEqual(['hello']);
  }, 15_000);

  it('dispatches confirmation_response immediately, bypassing the queue', async () => {
    watcher = new RemoteInputWatcher(inputFile, {
      pollIntervalMs: TEST_POLL_INTERVAL_MS,
    });
    const handler = vi.fn();
    watcher.setConfirmationHandler(handler);

    fs.appendFileSync(
      inputFile,
      JSON.stringify({
        type: 'confirmation_response',
        request_id: 'req-7',
        allowed: true,
      }) + '\n',
    );

    await waitFor(() => handler.mock.calls.length > 0);
    expect(handler).toHaveBeenCalledWith('req-7', true);
  }, 15_000);

  it('retries queued submits when the TUI signals it has become idle', async () => {
    watcher = new RemoteInputWatcher(inputFile, {
      pollIntervalMs: TEST_POLL_INTERVAL_MS,
    });

    let busy = true;
    const accepted: string[] = [];
    watcher.setSubmitFn((text) => {
      if (busy) return false; // simulate TUI rejecting because it is responding
      accepted.push(text);
      return true;
    });

    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'queued' }) + '\n',
    );

    // Allow the watcher to read & try once (and fail because TUI is busy)
    await new Promise((r) => setTimeout(r, 1500));
    expect(accepted).toEqual([]);

    busy = false;
    watcher.notifyIdle();

    await waitFor(() => accepted.length > 0);
    expect(accepted).toEqual(['queued']);
  }, 15_000);

  it('skips malformed JSON lines without throwing', async () => {
    watcher = new RemoteInputWatcher(inputFile, {
      pollIntervalMs: TEST_POLL_INTERVAL_MS,
    });
    const submitted: string[] = [];
    watcher.setSubmitFn((text) => {
      submitted.push(text);
    });

    fs.appendFileSync(inputFile, 'not-json\n');
    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'after-bad-line' }) + '\n',
    );

    await waitFor(() => submitted.length > 0);
    expect(submitted).toEqual(['after-bad-line']);
  }, 15_000);

  it('stops watching after shutdown', async () => {
    watcher = new RemoteInputWatcher(inputFile, {
      pollIntervalMs: TEST_POLL_INTERVAL_MS,
    });
    const submitted: string[] = [];
    watcher.setSubmitFn((text) => {
      submitted.push(text);
    });
    watcher.shutdown();

    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'too-late' }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 800));
    expect(submitted).toEqual([]);
  }, 15_000);
});
