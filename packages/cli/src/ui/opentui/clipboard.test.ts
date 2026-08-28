/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { osc52Sequence } from './clipboard.js';

const copyToClipboardMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/commandUtils.js', () => ({
  copyToClipboard: copyToClipboardMock,
}));

describe('osc52Sequence', () => {
  it('emits a bare OSC 52 outside multiplexers', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64');
    expect(osc52Sequence('hello', {})).toBe(`\x1b]52;c;${b64}\x07`);
  });

  it('emits both the bare sequence and the tmux DCS passthrough under TMUX', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64');
    const bare = `\x1b]52;c;${b64}\x07`;
    expect(osc52Sequence('hello', { TMUX: '/tmp/tmux-0/default' })).toBe(
      bare + `\x1bPtmux;\x1b${bare}\x1b\\`,
    );
  });

  it('wraps the sequence raw in a plain DCS passthrough under GNU screen (STY)', () => {
    const b64 = Buffer.from('hi', 'utf8').toString('base64');
    expect(osc52Sequence('hi', { STY: '12345.pts-0.host' })).toBe(
      `\x1bP\x1b]52;c;${b64}\x07\x1b\\`,
    );
  });
});

describe('copyText', () => {
  const originalStdoutTty = process.stdout.isTTY;
  const originalStderrTty = process.stderr.isTTY;
  const originalTermProgram = process.env['TERM_PROGRAM'];
  const originalTerminalEmulator = process.env['TERMINAL_EMULATOR'];

  const setTty = (stdout: boolean, stderr: boolean) => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: stdout,
      configurable: true,
    });
    Object.defineProperty(process.stderr, 'isTTY', {
      value: stderr,
      configurable: true,
    });
  };

  beforeEach(() => {
    // Deterministic TTY state regardless of the runner's terminal — the
    // assertions pin the branch under test instead of leaking real OSC 52
    // bytes into whoever runs the suite.
    setTty(false, true);
    delete process.env['TERM_PROGRAM'];
    delete process.env['TERMINAL_EMULATOR'];
    copyToClipboardMock.mockReset();
  });

  afterEach(() => {
    setTty(originalStdoutTty ?? false, originalStderrTty ?? false);
    if (originalTermProgram === undefined) {
      delete process.env['TERM_PROGRAM'];
    } else {
      process.env['TERM_PROGRAM'] = originalTermProgram;
    }
    if (originalTerminalEmulator === undefined) {
      delete process.env['TERMINAL_EMULATOR'];
    } else {
      process.env['TERMINAL_EMULATOR'] = originalTerminalEmulator;
    }
    vi.restoreAllMocks();
  });

  it('writes the OSC 52 sequence to the TTY stream (stderr preferred)', async () => {
    const { copyText } = await import('./clipboard.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    expect(stderrWrite).toHaveBeenCalledWith(osc52Sequence('snippet'));
  });

  it('falls back to stdout when only stdout is a TTY', async () => {
    setTty(true, false);
    const { copyText } = await import('./clipboard.js');
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    expect(stdoutWrite).toHaveBeenCalledWith(osc52Sequence('snippet'));
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('skips OSC 52 when no stream is a TTY', async () => {
    setTty(false, false);
    const { copyText } = await import('./clipboard.js');
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('skips OSC 52 on Warp (security banner) but keeps the platform fallback', async () => {
    process.env['TERM_PROGRAM'] = 'WarpTerminal';
    const { copyText } = await import('./clipboard.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(copyToClipboardMock).toHaveBeenCalledWith('snippet');
  });

  it('skips OSC 52 above the 75KB cap', async () => {
    const { copyText } = await import('./clipboard.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('x'.repeat(75_001))).resolves.toBe(true);
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('delegates the platform fallback to ink copyToClipboard', async () => {
    const { copyText } = await import('./clipboard.js');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    expect(copyToClipboardMock).toHaveBeenCalledWith('snippet');
  });

  it('returns false when the platform fallback fails', async () => {
    const { copyText } = await import('./clipboard.js');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    copyToClipboardMock.mockRejectedValueOnce(new Error('exit 1'));
    await expect(copyText('snippet')).resolves.toBe(false);
  });
});
