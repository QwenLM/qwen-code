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

describe('RemoteInputWatcher', () => {
  let tmpDir: string;
  let inputFile: string;
  let watcher: RemoteInputWatcher | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-remote-input-'));
    inputFile = path.join(tmpDir, 'input.jsonl');
    fs.writeFileSync(inputFile, '');
  });

  afterEach(async () => {
    watcher?.shutdown();
    watcher = null;
    // Give fs handles a tick to release (needed on Windows)
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows where file handles may linger
    }
  });

  it('forwards submit commands to the registered submit fn', async () => {
    watcher = new RemoteInputWatcher(inputFile);
    const submitted: string[] = [];
    watcher.setSubmitFn((text) => {
      submitted.push(text);
    });

    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'hello' }) + '\n',
    );

    await watcher.checkForNewInput();
    expect(submitted).toEqual(['hello']);
  });

  it('dispatches confirmation_response immediately, bypassing the queue', async () => {
    watcher = new RemoteInputWatcher(inputFile);
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

    await watcher.checkForNewInput();
    expect(handler).toHaveBeenCalledWith('req-7', true);
  });

  it('retries queued submits when the TUI signals it has become idle', async () => {
    watcher = new RemoteInputWatcher(inputFile);

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

    // Trigger read — command will be queued then submitted, but TUI rejects (busy)
    await watcher.checkForNewInput();
    // processQueue runs async; give it a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(accepted).toEqual([]);

    busy = false;
    watcher.notifyIdle();

    // processQueue runs async; give it a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(accepted).toEqual(['queued']);
  });

  it('skips malformed JSON lines without throwing', async () => {
    watcher = new RemoteInputWatcher(inputFile);
    const submitted: string[] = [];
    watcher.setSubmitFn((text) => {
      submitted.push(text);
    });

    fs.appendFileSync(inputFile, 'not-json\n');
    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'after-bad-line' }) + '\n',
    );

    await watcher.checkForNewInput();
    expect(submitted).toEqual(['after-bad-line']);
  });

  it('stops watching after shutdown', async () => {
    watcher = new RemoteInputWatcher(inputFile);
    const submitted: string[] = [];
    watcher.setSubmitFn((text) => {
      submitted.push(text);
    });
    watcher.shutdown();

    fs.appendFileSync(
      inputFile,
      JSON.stringify({ type: 'submit', text: 'too-late' }) + '\n',
    );

    // checkForNewInput should be a no-op after shutdown (active=false)
    await watcher.checkForNewInput();
    expect(submitted).toEqual([]);
  });
});
