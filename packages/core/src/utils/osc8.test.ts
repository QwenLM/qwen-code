/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HYPERLINK_ENV_KEYS,
  osc8Hyperlink,
  sanitizeForOsc,
  supportsHyperlinks,
  wrapForMultiplexer,
} from './osc8.js';

const ttyStream = (isTTY: boolean) =>
  ({ isTTY }) as unknown as NodeJS.WriteStream;

describe('osc8 (core primitives)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Clear every env var the detector reads so a developer's terminal
    // session doesn't leak into these assertions.
    for (const key of HYPERLINK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of HYPERLINK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('sanitizeForOsc', () => {
    it('strips control characters that would break the OSC envelope', () => {
      expect(sanitizeForOsc('a\x07b\x1bc')).toBe('abc');
    });

    it('strips bidi overrides used for label spoofing', () => {
      expect(sanitizeForOsc('safe\u202ekcatta.com')).toBe('safekcatta.com');
    });

    it('leaves ordinary URL text untouched', () => {
      expect(sanitizeForOsc('https://example.com/a?b=c')).toBe(
        'https://example.com/a?b=c',
      );
    });
  });

  describe('osc8Hyperlink', () => {
    it('wraps a URL in an OSC 8 envelope, defaulting the label to the URL', () => {
      const url = 'https://example.com/x';
      expect(osc8Hyperlink(url)).toBe(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
    });

    it('supports a distinct visible label', () => {
      expect(osc8Hyperlink('https://example.com', 'click')).toBe(
        '\x1b]8;;https://example.com\x07click\x1b]8;;\x07',
      );
    });
  });

  describe('wrapForMultiplexer', () => {
    it('passes the sequence through unchanged outside a multiplexer', () => {
      const seq = '\x1b]8;;https://x\x07';
      expect(wrapForMultiplexer(seq)).toBe(seq);
    });

    it('DCS-wraps and doubles ESC under tmux', () => {
      process.env['TMUX'] = '/tmp/tmux-1000/default,1,0';
      expect(wrapForMultiplexer('\x1b]8;;u\x07')).toBe(
        '\x1bPtmux;\x1b\x1b]8;;u\x07\x1b\\',
      );
    });

    it('DCS-wraps under screen', () => {
      process.env['STY'] = '1234.pts-0.host';
      const seq = '\x1b]8;;u\x07';
      expect(wrapForMultiplexer(seq)).toBe(`\x1bP${seq}\x1b\\`);
    });
  });

  describe('supportsHyperlinks', () => {
    it('is false for a non-TTY stream even with FORCE_HYPERLINK', () => {
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks(ttyStream(false))).toBe(false);
    });

    it('honors FORCE_HYPERLINK=1 on a TTY', () => {
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks(ttyStream(true))).toBe(true);
    });

    it('is a hard opt-out under QWEN_DISABLE_HYPERLINKS=1', () => {
      process.env['QWEN_DISABLE_HYPERLINKS'] = '1';
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks(ttyStream(true))).toBe(false);
    });

    it('detects Windows Terminal via WT_SESSION', () => {
      process.env['WT_SESSION'] = 'abc';
      expect(supportsHyperlinks(ttyStream(true))).toBe(true);
    });

    it('refuses inside tmux unless the user opts in', () => {
      process.env['TMUX'] = '/tmp/tmux/default,1,0';
      process.env['WT_SESSION'] = 'abc';
      expect(supportsHyperlinks(ttyStream(true))).toBe(false);
    });
  });
});
