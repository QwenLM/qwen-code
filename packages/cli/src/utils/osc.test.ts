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
  sanitizeOscPayload,
  encodeKittyPayload,
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

  it('TERM_PROGRAM takes priority over TERM', () => {
    process.env['TERM'] = 'xterm-ghostty';
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(detectTerminal()).toBe('iTerm.app');
  });

  it('falls back to TERM when TERM_PROGRAM is not a known terminal', () => {
    process.env['TERM'] = 'xterm-ghostty';
    process.env['TERM_PROGRAM'] = 'some-unknown-terminal';
    expect(detectTerminal()).toBe('ghostty');
  });

  it('KITTY_WINDOW_ID is last resort fallback', () => {
    process.env['TERM'] = 'xterm-256color';
    process.env['KITTY_WINDOW_ID'] = '1';
    expect(detectTerminal()).toBe('kitty');
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
    delete process.env['STY'];
    const result = osc(99, 'test');
    expect(result).toBe(`\x1b]99;test${ST}`);
  });

  it('falls back to BEL for kitty inside screen to avoid ST conflict with DCS wrapper', () => {
    process.env['TERM'] = 'xterm-kitty';
    delete process.env['TERM_PROGRAM'];
    process.env['STY'] = '12345.pts-0.host';
    const result = osc(99, 'test');
    expect(result).toBe(`\x1b]99;test${BEL}`);
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

describe('encodeKittyPayload', () => {
  it('base64-encodes ASCII text', () => {
    expect(encodeKittyPayload('Title')).toBe(
      Buffer.from('Title', 'utf8').toString('base64'),
    );
  });

  it('base64-encodes UTF-8 text', () => {
    expect(encodeKittyPayload('你好')).toBe(
      Buffer.from('你好', 'utf8').toString('base64'),
    );
  });
});

describe('oscKittyNotify', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns three-step protocol sequences with base64-encoded payloads', () => {
    process.env['TERM'] = 'xterm-kitty';
    delete process.env['TERM_PROGRAM'];
    delete process.env['STY'];
    const seqs = oscKittyNotify('Title', 'Body', 42);
    expect(seqs).toHaveLength(3);
    const b64Title = Buffer.from('Title', 'utf8').toString('base64');
    const b64Body = Buffer.from('Body', 'utf8').toString('base64');
    // Step 1: title with e=1 (base64)
    expect(seqs[0]).toContain('i=42:d=0:p=title:e=1');
    expect(seqs[0]).toContain(b64Title);
    expect(seqs[0]).not.toContain('Title');
    // Step 2: body with e=1 (base64)
    expect(seqs[1]).toContain('i=42:p=body:e=1');
    expect(seqs[1]).toContain(b64Body);
    expect(seqs[1]).not.toContain('Body');
    // Step 3: activate (no payload to encode)
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

describe('sanitizeOscPayload', () => {
  it('strips ESC character', () => {
    expect(sanitizeOscPayload('hello\x1bworld')).toBe('helloworld');
  });

  it('strips BEL character', () => {
    expect(sanitizeOscPayload('hello\x07world')).toBe('helloworld');
  });

  it('strips all C0 control characters', () => {
    expect(sanitizeOscPayload('a\x00b\x01c\x1fd')).toBe('abcd');
  });

  it('preserves normal text', () => {
    expect(sanitizeOscPayload('Hello World! 你好')).toBe('Hello World! 你好');
  });

  it('strips C1 control characters', () => {
    expect(sanitizeOscPayload('hello\x9cworld')).toBe('helloworld');
  });
});

describe('osc sanitizes payloads', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('strips control characters from string parts', () => {
    process.env['TERM_PROGRAM'] = 'ghostty';
    delete process.env['TERM'];
    const result = osc(OSC.GHOSTTY, 'notify', 'Title\x1b]hack', 'Body\x07end');
    expect(result).not.toContain('\x1b]hack');
    expect(result).toContain('Title]hack');
    expect(result).toContain('Bodyend');
  });
});
