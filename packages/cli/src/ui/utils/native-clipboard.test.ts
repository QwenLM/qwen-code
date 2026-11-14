/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_BUSY_MESSAGE,
  CLIPBOARD_READ_MARKER,
  COPY_HELPER_SCRIPT,
  READ_HELPER_SCRIPT,
  createNativeClipboardBridge,
  runNodeHelper,
  type HelperResult,
  type NativeClipboardBridgeDeps,
} from './native-clipboard.js';

function bridge(
  module: Awaited<ReturnType<NativeClipboardBridgeDeps['loadModule']>>,
  helperResult: HelperResult | null = null,
) {
  const runHelper = vi.fn().mockResolvedValue(helperResult);
  return {
    value: createNativeClipboardBridge({
      loadModule: vi.fn().mockResolvedValue(module),
      runHelper,
    }),
    runHelper,
  };
}

describe('native clipboard bridge', () => {
  function copyBridge(readBack: HelperResult | null) {
    const setClipboardText = vi.fn();
    const runHelper = vi.fn(async (script: string) =>
      script === COPY_HELPER_SCRIPT
        ? {
            code: 0,
            stdout: 'Somebody else owns the clipboard now\n',
            stderr: '',
          }
        : readBack,
    );
    return {
      value: createNativeClipboardBridge({
        loadModule: vi.fn().mockResolvedValue({ setClipboardText }),
        runHelper,
      }),
      runHelper,
      setClipboardText,
    };
  }

  it('always writes through the Node helper', async () => {
    const { value, runHelper, setClipboardText } = copyBridge({
      code: 0,
      stdout: `${CLIPBOARD_READ_MARKER}hello`,
      stderr: '',
    });

    await expect(value.copyText('hello')).resolves.toBe(true);
    // clipboard-rs prints ownership diagnostics to stdout; the child's pipe
    // keeps them out of the TUI, so the in-process write must stay unused.
    expect(setClipboardText).not.toHaveBeenCalled();
    expect(runHelper).toHaveBeenCalledWith(COPY_HELPER_SCRIPT, 'hello');
  });

  it('reports a copy that did not persist so the caller can fall back', async () => {
    // X11 without a clipboard manager: the selection dies with the helper.
    const { value } = copyBridge({
      code: 0,
      stdout: CLIPBOARD_READ_MARKER,
      stderr: '',
    });
    await expect(value.copyText('hello')).resolves.toBe(false);
  });

  it('trusts the write when the read-back cannot run', async () => {
    const { value } = copyBridge(null);
    await expect(value.copyText('hello')).resolves.toBe(true);
  });

  it('keeps clipboard text that contains the read marker', async () => {
    const text = `before ${CLIPBOARD_READ_MARKER} after`;
    const { value } = bridge(null, {
      code: 0,
      stdout: `noise\n${CLIPBOARD_READ_MARKER}${text}`,
      stderr: '',
    });
    await expect(value.readText()).resolves.toBe(text);
  });

  it('returns false when the write helper is unavailable', async () => {
    const { value } = bridge(null, null);
    await expect(value.copyText('hello')).resolves.toBe(false);
  });

  it('reads through the Node helper even when the addon loads in process', async () => {
    const getClipboardText = vi.fn(() => 'in-process');
    const { value, runHelper } = bridge(
      { getClipboardText },
      { code: 0, stdout: `${CLIPBOARD_READ_MARKER}from child`, stderr: '' },
    );
    await expect(value.readText()).resolves.toBe('from child');
    // In-process the addon's stdout diagnostics would land on the TUI.
    expect(getClipboardText).not.toHaveBeenCalled();
    expect(runHelper).toHaveBeenCalledWith(expect.any(String), null);
  });

  it('does not fall back in process when the helper ran and failed', async () => {
    const getClipboardText = vi.fn(() => 'in-process');
    const { value } = bridge(
      { getClipboardText },
      { code: 1, stdout: '', stderr: 'nope' },
    );
    await expect(value.readText()).resolves.toBeNull();
    expect(getClipboardText).not.toHaveBeenCalled();
  });

  it('reads and normalizes text in process when no helper can run', async () => {
    const { value } = bridge({
      getClipboardText: () => 'one\r\ntwo\rthree',
    });
    await expect(value.readText()).resolves.toBe('one\ntwo\nthree');
  });

  it('reads the Node helper stdout when the addon is unavailable', async () => {
    const { value, runHelper } = bridge(null, {
      code: 0,
      stdout: `${CLIPBOARD_READ_MARKER}from\r\nnode`,
      stderr: '',
    });
    await expect(value.readText()).resolves.toBe('from\nnode');
    expect(runHelper).toHaveBeenCalledWith(expect.any(String), null);
  });

  it('discards addon noise printed before the read marker', async () => {
    const { value } = bridge(null, {
      code: 0,
      stdout: `Somebody else owns the clipboard now\n${CLIPBOARD_READ_MARKER}payload`,
      stderr: '',
    });
    await expect(value.readText()).resolves.toBe('payload');
  });

  it('returns null when the helper output overflows', async () => {
    const { value } = bridge(null, {
      code: 0,
      stdout: 'partial',
      stderr: '',
      overflow: true,
    });
    await expect(value.readText()).resolves.toBeNull();
  });

  it('returns null for an empty clipboard or a failed helper', async () => {
    await expect(
      bridge({ getClipboardText: () => '' }).value.readText(),
    ).resolves.toBeNull();
    await expect(
      bridge(null, { code: 1, stdout: '', stderr: 'nope' }).value.readText(),
    ).resolves.toBeNull();
  });

  it('never returns the clipboard-ownership error as content', async () => {
    await expect(
      bridge({
        getClipboardText: () => CLIPBOARD_BUSY_MESSAGE,
      }).value.readText(),
    ).resolves.toBeNull();
    await expect(
      bridge(null, {
        code: 0,
        stdout: CLIPBOARD_BUSY_MESSAGE,
        stderr: '',
      }).value.readText(),
    ).resolves.toBeNull();
  });
});

describe('native clipboard helper scripts', () => {
  // A fake addon that keeps the "clipboard" in a temp file, prints native
  // noise on reads, and can throw the ownership error a set number of times.
  const FAKE_ADDON = `
const fs = require('fs');
const file = process.env.FAKE_CLIPBOARD_FILE;
const busy = file + '.busy';
module.exports = {
  setClipboardText(text) { fs.writeFileSync(file, text); },
  getClipboardText() {
    const left = fs.existsSync(busy) ? Number(fs.readFileSync(busy, 'utf8')) : 0;
    if (left > 0) {
      fs.writeFileSync(busy, String(left - 1));
      throw new Error('Somebody else owns the clipboard now');
    }
    process.stdout.write('native noise ');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  },
};
`;
  let dir: string;
  let entry: string;
  const saved = {
    node: process.env['QWEN_NODE_BINARY'],
    file: process.env['FAKE_CLIPBOARD_FILE'],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-native-clipboard-'));
    entry = join(dir, 'fake-addon.cjs');
    writeFileSync(entry, FAKE_ADDON);
    process.env['QWEN_NODE_BINARY'] = process.execPath;
    process.env['FAKE_CLIPBOARD_FILE'] = join(dir, 'clipboard.txt');
  });

  afterEach(() => {
    for (const [key, value] of [
      ['QWEN_NODE_BINARY', saved.node],
      ['FAKE_CLIPBOARD_FILE', saved.file],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const realBridge = (module: { getClipboardText: () => string } | null) =>
    createNativeClipboardBridge({
      loadModule: async () => module,
      runHelper: (script, input) => runNodeHelper(script, input, entry),
    });

  it('copies and reads back through real Node children', async () => {
    const value = realBridge(null);
    await expect(value.copyText('one\r\ntwo')).resolves.toBe(true);
    // The read helper frames its payload, so the addon's noise is dropped.
    await expect(value.readText()).resolves.toBe('one\ntwo');
  });

  it('retries the transient ownership error while reading', async () => {
    writeFileSync(join(dir, 'clipboard.txt'), 'after retry');
    writeFileSync(join(dir, 'clipboard.txt.busy'), '2');
    const result = await runNodeHelper(READ_HELPER_SCRIPT, null, entry);
    expect(result?.code).toBe(0);
    expect(result?.stdout).toContain(`${CLIPBOARD_READ_MARKER}after retry`);
  });

  it('reports no child when Node cannot be spawned, so reads fall back in process', async () => {
    process.env['QWEN_NODE_BINARY'] = join(dir, 'missing-node');
    await expect(
      runNodeHelper(COPY_HELPER_SCRIPT, 'x', entry),
    ).resolves.toBeNull();
    await expect(
      realBridge({ getClipboardText: () => 'in-process' }).readText(),
    ).resolves.toBe('in-process');
  });
});
