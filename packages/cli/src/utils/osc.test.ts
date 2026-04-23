/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectTerminal,
  osc,
  wrapForMultiplexer,
  oscITerm2Notify,
  oscKittyNotify,
  oscGhosttyNotify,
  OSC,
  BEL,
  ST,
} from './osc.js';

describe('detectTerminal', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['TERM_PROGRAM'];
    delete process.env['TERM'];
    delete process.env['KITTY_WINDOW_ID'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('detects iTerm.app via TERM_PROGRAM', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(detectTerminal()).toBe('iTerm.app');
  });

  it('detects kitty via TERM_PROGRAM', () => {
    process.env['TERM_PROGRAM'] = 'kitty';
    expect(detectTerminal()).toBe('kitty');
  });

  it('detects ghostty via TERM_PROGRAM', () => {
    process.env['TERM_PROGRAM'] = 'ghostty';
    expect(detectTerminal()).toBe('ghostty');
  });

  it('detects Apple_Terminal via TERM_PROGRAM', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    expect(detectTerminal()).toBe('Apple_Terminal');
  });

  it('detects kitty via TERM=xterm-kitty when TERM_PROGRAM is absent', () => {
    process.env['TERM'] = 'xterm-kitty';
    expect(detectTerminal()).toBe('kitty');
  });

  it('detects ghostty via TERM=xterm-ghostty when TERM_PROGRAM is absent', () => {
    process.env['TERM'] = 'xterm-ghostty';
    expect(detectTerminal()).toBe('ghostty');
  });

  it('detects kitty via KITTY_WINDOW_ID as fallback', () => {
    process.env['KITTY_WINDOW_ID'] = '1';
    expect(detectTerminal()).toBe('kitty');
  });

  it('returns unknown when no terminal is detected', () => {
    expect(detectTerminal()).toBe('unknown');
  });

  it('TERM takes priority over KITTY_WINDOW_ID', () => {
    process.env['TERM'] = 'xterm-kitty';
    process.env['KITTY_WINDOW_ID'] = '1';
    expect(detectTerminal()).toBe('kitty');
  });

  it('TERM takes priority over TERM_PROGRAM when TERM matches a known terminal', () => {
    process.env['TERM'] = 'xterm-ghostty';
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(detectTerminal()).toBe('ghostty');
  });

  it('falls back to TERM_PROGRAM when TERM does not match a known terminal', () => {
    process.env['TERM'] = 'xterm-256color';
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(detectTerminal()).toBe('iTerm.app');
  });
});

describe('osc', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds OSC sequence with BEL terminator for non-kitty', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    delete process.env['TERM'];
    const result = osc(9, 'hello');
    expect(result).toBe(`\x1b]9;hello${BEL}`);
  });

  it('builds OSC sequence with ST terminator for kitty', () => {
    process.env['TERM'] = 'xterm-kitty';
    delete process.env['TERM_PROGRAM'];
    const result = osc(99, 'test');
    expect(result).toBe(`\x1b]99;test${ST}`);
  });

  it('joins multiple parts with semicolons', () => {
    process.env['TERM_PROGRAM'] = 'ghostty';
    delete process.env['TERM'];
    const result = osc(777, 'notify', 'Title', 'Body');
    expect(result).toBe(`\x1b]777;notify;Title;Body${BEL}`);
  });
});

describe('wrapForMultiplexer', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns sequence unchanged outside multiplexer', () => {
    delete process.env['TMUX'];
    delete process.env['STY'];
    const seq = `\x1b]9;hello${BEL}`;
    expect(wrapForMultiplexer(seq)).toBe(seq);
  });

  it('wraps in DCS passthrough for tmux with ESC doubling', () => {
    process.env['TMUX'] = '/tmp/tmux-1000/default,12345,0';
    delete process.env['STY'];
    const seq = `\x1b]9;hello${BEL}`;
    // ESC bytes in payload should be doubled
    expect(wrapForMultiplexer(seq)).toBe(
      `\x1bPtmux;\x1b\x1b]9;hello${BEL}\x1b\\`,
    );
  });

  it('wraps in DCS passthrough for screen', () => {
    delete process.env['TMUX'];
    process.env['STY'] = '12345.pts-0.host';
    const seq = `\x1b]9;hello${BEL}`;
    expect(wrapForMultiplexer(seq)).toBe(`\x1bP${seq}\x1b\\`);
  });
});

describe('oscITerm2Notify', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('formats notification with title and message', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    delete process.env['TERM'];
    const result = oscITerm2Notify('Qwen Code', 'Hello');
    expect(result).toContain('Qwen Code:\nHello');
  });

  it('formats notification without title', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    delete process.env['TERM'];
    const result = oscITerm2Notify('', 'Hello');
    expect(result).toContain('Hello');
    expect(result).not.toContain(':');
  });
});

describe('oscKittyNotify', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns three-step protocol sequences', () => {
    process.env['TERM'] = 'xterm-kitty';
    delete process.env['TERM_PROGRAM'];
    const seqs = oscKittyNotify('Title', 'Body', 42);
    expect(seqs).toHaveLength(3);
    // Step 1: title
    expect(seqs[0]).toContain('i=42:d=0:p=title');
    expect(seqs[0]).toContain('Title');
    // Step 2: body
    expect(seqs[1]).toContain('i=42:p=body');
    expect(seqs[1]).toContain('Body');
    // Step 3: activate
    expect(seqs[2]).toContain('i=42:d=1:a=focus');
  });
});

describe('oscGhosttyNotify', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('formats OSC 777 notification', () => {
    process.env['TERM_PROGRAM'] = 'ghostty';
    delete process.env['TERM'];
    const result = oscGhosttyNotify('Title', 'Body');
    expect(result).toBe(`\x1b]${OSC.GHOSTTY};notify;Title;Body${BEL}`);
  });
});
