/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
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
});
