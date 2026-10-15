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
  beforeEach(() => {
    copyToClipboardMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates the platform fallback to ink copyToClipboard', async () => {
    const { copyText } = await import('./clipboard.js');
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    expect(copyToClipboardMock).toHaveBeenCalledWith('snippet');
  });

  it('returns false when the platform fallback fails', async () => {
    const { copyText } = await import('./clipboard.js');
    copyToClipboardMock.mockRejectedValueOnce(new Error('exit 1'));
    await expect(copyText('snippet')).resolves.toBe(false);
  });

  it('does not write OSC 52 itself (R4-16: single emission)', async () => {
    // copyText must delegate OSC 52 to copyToClipboard's existing fallback
    // (writeOsc52 in clipboardUtils.ts), not emit its own — the old
    // self-write double-emitted on the no-xclip Linux path.
    const { copyText } = await import('./clipboard.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    copyToClipboardMock.mockResolvedValueOnce(undefined);
    await expect(copyText('snippet')).resolves.toBe(true);
    // No raw OSC 52 bytes from copyText itself.
    const osc = osc52Sequence('snippet');
    expect(stderrWrite).not.toHaveBeenCalledWith(osc);
    expect(stdoutWrite).not.toHaveBeenCalledWith(osc);
  });
});
