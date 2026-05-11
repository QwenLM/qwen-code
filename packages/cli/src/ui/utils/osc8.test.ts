/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  osc8Close,
  osc8Hyperlink,
  osc8Open,
  resetSupportsHyperlinksCache,
  sanitizeForOsc,
  supportsHyperlinks,
  wrapForMultiplexer,
} from './osc8.js';

const ESC = '\x1b';
const BEL = '\x07';

describe('osc8 helpers', () => {
  const savedEnv = { ...process.env };
  const savedIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    resetSupportsHyperlinksCache();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: savedIsTTY,
    });
    resetSupportsHyperlinksCache();
  });

  describe('sanitizeForOsc', () => {
    it('strips C0 control bytes and DEL', () => {
      expect(sanitizeForOsc('a\x00b\x07c\x1bd\x7fe')).toBe('abcde');
    });

    it('keeps printable ASCII and unicode intact', () => {
      expect(sanitizeForOsc('https://example.com/路径?q=v')).toBe(
        'https://example.com/路径?q=v',
      );
    });
  });

  describe('osc8Hyperlink', () => {
    it('emits the canonical OSC 8 envelope with BEL terminators', () => {
      expect(osc8Hyperlink('https://example.com', 'click me')).toBe(
        `${ESC}]8;;https://example.com${BEL}click me${ESC}]8;;${BEL}`,
      );
    });

    it('defaults the label to the url', () => {
      expect(osc8Hyperlink('https://example.com')).toBe(
        `${ESC}]8;;https://example.com${BEL}https://example.com${ESC}]8;;${BEL}`,
      );
    });

    it('strips embedded escapes so they cannot break out of the envelope', () => {
      const malicious = `https://example.com${BEL}${ESC}]8;;evil${BEL}`;
      const out = osc8Hyperlink(malicious, `lbl${ESC}[31m`);
      // The only ESC bytes in the output must be the two that introduce the
      // OSC 8 open and close sequences — no user-supplied ESC leaks through.
      // eslint-disable-next-line no-control-regex
      const escCount = (out.match(/\x1b/g) ?? []).length;
      expect(escCount).toBe(2);
      // Same idea for BEL — exactly two terminators, no extras from the
      // sanitized user input.
      // eslint-disable-next-line no-control-regex
      const belCount = (out.match(/\x07/g) ?? []).length;
      expect(belCount).toBe(2);
      // After sanitization the surviving textual fragments stay inline.
      expect(out).toContain('https://example.com]8;;evil');
      expect(out).toContain('lbl[31m');
    });

    it('produces an envelope that composes from osc8Open + osc8Close', () => {
      expect(osc8Open('https://x.test') + 'label' + osc8Close()).toBe(
        osc8Hyperlink('https://x.test', 'label'),
      );
    });
  });

  describe('wrapForMultiplexer', () => {
    it('returns the OSC unchanged when not inside tmux or screen', () => {
      delete process.env['TMUX'];
      delete process.env['STY'];
      const seq = `${ESC}]8;;https://x${BEL}`;
      expect(wrapForMultiplexer(seq)).toBe(seq);
    });

    it('wraps in a tmux DCS passthrough envelope with doubled ESCs', () => {
      process.env['TMUX'] = '/tmp/tmux-1000/default,1234,0';
      delete process.env['STY'];
      const seq = `${ESC}]8;;https://x${BEL}`;
      expect(wrapForMultiplexer(seq)).toBe(
        `${ESC}Ptmux;${ESC}${ESC}]8;;https://x${BEL}${ESC}\\`,
      );
    });

    it('wraps in a plain screen DCS envelope', () => {
      delete process.env['TMUX'];
      process.env['STY'] = '1234.host';
      const seq = `${ESC}]8;;https://x${BEL}`;
      expect(wrapForMultiplexer(seq)).toBe(
        `${ESC}P${ESC}]8;;https://x${BEL}${ESC}\\`,
      );
    });
  });

  describe('supportsHyperlinks', () => {
    function setTTY(value: boolean) {
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value,
      });
    }

    function clearTerminalHints() {
      for (const key of [
        'TERM_PROGRAM',
        'WT_SESSION',
        'KITTY_WINDOW_ID',
        'VTE_VERSION',
        'DOMTERM',
        'JEDITERM_SOURCE_ARGS',
        'TERMINAL_EMULATOR',
        'COLORTERM',
        'TERM',
        'FORCE_HYPERLINK',
        'FORCE_COLOR',
        'NO_COLOR',
        'CI',
        'TMUX',
        'STY',
        'QWEN_DISABLE_HYPERLINKS',
      ]) {
        delete process.env[key];
      }
    }

    it('returns false when stdout is not a TTY', () => {
      clearTerminalHints();
      setTTY(false);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false when NO_COLOR is set', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['NO_COLOR'] = '1';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false when FORCE_COLOR=0', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['FORCE_COLOR'] = '0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false in CI by default', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['CI'] = 'true';
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns true for iTerm2 on a TTY', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('returns true for Windows Terminal via WT_SESSION', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['WT_SESSION'] = '00000000-0000-0000-0000-000000000000';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('honors FORCE_HYPERLINK=1 even without TTY heuristics matching', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('respects QWEN_DISABLE_HYPERLINKS=1 as a hard opt-out', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['QWEN_DISABLE_HYPERLINKS'] = '1';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false for an unknown terminal even on a TTY', () => {
      clearTerminalHints();
      setTTY(true);
      process.env['TERM'] = 'dumb';
      expect(supportsHyperlinks()).toBe(false);
    });
  });
});
