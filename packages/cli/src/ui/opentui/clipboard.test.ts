/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { osc52Sequence } from './clipboard.js';

describe('osc52Sequence', () => {
  it('emits a bare OSC 52 outside multiplexers', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64');
    expect(osc52Sequence('hello', {})).toBe(`\x1b]52;c;${b64}\x07`);
  });

  it('wraps the sequence in a tmux DCS passthrough under TMUX', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64');
    expect(osc52Sequence('hello', { TMUX: '/tmp/tmux-0/default' })).toBe(
      `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`,
    );
  });

  it('wraps the sequence under GNU screen (STY) too', () => {
    const b64 = Buffer.from('hi', 'utf8').toString('base64');
    expect(osc52Sequence('hi', { STY: '12345.pts-0.host' })).toBe(
      `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`,
    );
  });
});
