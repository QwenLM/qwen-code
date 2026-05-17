/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HYPERLINK_ENV_KEYS,
  isSafeOscScheme,
  labelMayDeceive,
  osc8Close,
  osc8Hyperlink,
  osc8Open,
  sanitizeForOsc,
  supportsHyperlinks,
  trimTrailingUrlPunctuation,
} from './osc8.js';

const ESC = '\x1b';
const BEL = '\x07';

function clearHyperlinkEnv() {
  for (const key of HYPERLINK_ENV_KEYS) {
    delete process.env[key];
  }
}

describe('osc8 helpers', () => {
  const savedEnv = { ...process.env };
  const savedIsTTY = process.stdout.isTTY;
  const savedPlatform = process.platform;

  beforeEach(() => {
    // Start every test from a known baseline. supportsHyperlinks() has no
    // memoization so a fresh env is enough.
    process.env = { ...savedEnv };
    clearHyperlinkEnv();
    // Reset platform too so a prior test that flipped to win32 can't leak.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: savedPlatform,
    });
    // Symmetric isTTY reset — the early describes (sanitizer, scheme, trim)
    // don't call setTTY() themselves, so without this they would inherit
    // whatever the previous test left behind.
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: savedIsTTY,
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: savedIsTTY,
    });
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: savedPlatform,
    });
  });

  describe('sanitizeForOsc', () => {
    it('strips C0 control bytes and DEL', () => {
      expect(sanitizeForOsc('a\x00b\x07c\x1bd\x7fe')).toBe('abcde');
    });

    it('strips C1 control bytes (\\x80-\\x9f)', () => {
      // \x9c is 8-bit ST and \x9d is 8-bit OSC — terminals that honor C1
      // controls treat these as sequence boundaries, so they must not
      // survive inside an OSC 8 target.
      expect(sanitizeForOsc('a\x80b\x9cc\x9dd\x9fe')).toBe('abcde');
    });

    it('strips Unicode bidi controls (label spoofing)', () => {
      // U+202E (RLO) in a link label would visually reverse the trailing
      // bytes, letting `safe.com` render as a different host even though
      // the OSC target is sanitized.
      expect(sanitizeForOsc('safe.com\u202emoc.live')).toBe('safe.commoc.live');
      // Every bidi control covered by the regex.
      expect(
        sanitizeForOsc(
          'a\u200eb\u200fc\u202ad\u202be\u202cf\u202dg\u202eh\u2066i\u2067j\u2068k\u2069l',
        ),
      ).toBe('abcdefghijkl');
    });

    it('strips line / paragraph separators (envelope fracture)', () => {
      // U+2028 / U+2029 are treated as line breaks inside an OSC payload
      // by some terminals, fracturing the envelope.
      expect(sanitizeForOsc('a\u2028b\u2029c')).toBe('abc');
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
      // Exactly two ESC and two BEL bytes — the envelope's own terminators.
      // eslint-disable-next-line no-control-regex
      expect((out.match(/\x1b/g) ?? []).length).toBe(2);
      // eslint-disable-next-line no-control-regex
      expect((out.match(/\x07/g) ?? []).length).toBe(2);
      expect(out).toContain('https://example.com]8;;evil');
      expect(out).toContain('lbl[31m');
    });

    it('produces an envelope that composes from osc8Open + osc8Close', () => {
      expect(osc8Open('https://x.test') + 'label' + osc8Close()).toBe(
        osc8Hyperlink('https://x.test', 'label'),
      );
    });
  });

  describe('isSafeOscScheme', () => {
    it.each([
      'http://example.com',
      'https://example.com/path',
      'HTTPS://example.com', // case-insensitive scheme
      'mailto:user@example.com',
      'ftp://example.com/file',
      'ftps://example.com',
      'sftp://host/path',
      'ssh://host',
    ])('allows %s', (url) => {
      expect(isSafeOscScheme(url)).toBe(true);
    });

    it.each([
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'chrome://settings',
      'about:blank',
      // Relative / fragment / empty — no scheme at all.
      '',
      '#anchor',
      '/relative/path',
      './doc.html',
      'just text',
    ])('rejects %s', (url) => {
      expect(isSafeOscScheme(url)).toBe(false);
    });
  });

  describe('labelMayDeceive', () => {
    it('flags labels containing a different URL than the target', () => {
      // The classic spoof: label looks like one host, target is another.
      expect(
        labelMayDeceive('https://google.com', 'https://attacker.com'),
      ).toBe(true);
      expect(
        labelMayDeceive('Visit https://safe.com now', 'https://evil.com/x'),
      ).toBe(true);
      // Scheme-only label still trips the heuristic — defensively
      // permissive: a bare `mailto:` label that doesn't equal the URL is
      // suspicious enough to keep the `(url)` suffix visible.
      expect(labelMayDeceive('mailto:friend', 'mailto:other')).toBe(true);
    });

    it('does NOT flag when the label equals the target', () => {
      const url = 'https://example.com/x';
      expect(labelMayDeceive(url, url)).toBe(false);
    });

    it('flags bare-host labels whose host differs from the target', () => {
      // The single most common click-deception shape in markdown — and one
      // a careful attacker would prefer over a full `https://…` label,
      // since it looks more natural. Must NOT escape the heuristic.
      expect(labelMayDeceive('google.com', 'https://attacker.com')).toBe(true);
      expect(
        labelMayDeceive('paypal.com', 'https://phish.example.org/login'),
      ).toBe(true);
      // Punycode IDN attack — label `google.com`, target is the lookalike
      // punycode host. Label host does not equal target host → flag.
      expect(labelMayDeceive('google.com', 'https://xn--googl-fsa.com')).toBe(
        true,
      );
    });

    it('does NOT flag bare-host labels that match the target', () => {
      // Honest rendering: label is the same host the URL points to.
      expect(labelMayDeceive('google.com', 'https://google.com/page')).toBe(
        false,
      );
      expect(
        labelMayDeceive('docs.example.com', 'https://docs.example.com/x'),
      ).toBe(false);
    });

    it('flags IPv4 literal labels whose host differs from the target', () => {
      // `[1.1.1.1](https://attacker.com)` — common shape (Cloudflare DNS,
      // Google DNS) the model might emit. Same click-deception class as a
      // bare hostname but the alphabetic-TLD regex skips it, so a separate
      // dotted-quad rule has to catch it.
      expect(labelMayDeceive('1.1.1.1', 'https://attacker.com')).toBe(true);
      expect(labelMayDeceive('192.168.1.1', 'https://evil.com')).toBe(true);
      expect(labelMayDeceive('Click 8.8.8.8 here', 'https://evil.com')).toBe(
        true,
      );
    });

    it('does NOT flag IPv4 literal labels that match the target', () => {
      expect(labelMayDeceive('1.1.1.1', 'https://1.1.1.1/dns')).toBe(false);
    });

    it('does NOT flag email-style labels matching the mailto target', () => {
      // `new URL('mailto:x@y').hostname` is empty; the implementation has to
      // pull the host from after the `@` or every mailto link with a
      // bare-email label would be falsely flagged.
      expect(
        labelMayDeceive('support@example.com', 'mailto:support@example.com'),
      ).toBe(false);
      // …but a mismatched mailto domain IS deceptive.
      expect(
        labelMayDeceive('support@example.com', 'mailto:abuse@evil.com'),
      ).toBe(true);
    });

    it('flags same-host different-path labels', () => {
      // `[https://google.com/safe](https://google.com/evil)` — same host but
      // the label hides which path. The `://` pattern fires here and the
      // user sees the real path in the `(url)` suffix.
      expect(
        labelMayDeceive('https://google.com/safe', 'https://google.com/evil'),
      ).toBe(true);
    });

    it('does NOT flag plain-text or numeric labels', () => {
      expect(labelMayDeceive('click here', 'https://example.com')).toBe(false);
      expect(labelMayDeceive('docs', 'https://example.com')).toBe(false);
      expect(labelMayDeceive('', 'https://example.com')).toBe(false);
      // Version strings like `v1.2.3` are not host-like (last segment is
      // digits, not alphabetic) so they don't trip the heuristic.
      expect(labelMayDeceive('v1.2.3', 'https://example.com')).toBe(false);
    });
  });

  describe('trimTrailingUrlPunctuation', () => {
    it.each([
      ['https://example.com.', 'https://example.com'],
      ['https://example.com,', 'https://example.com'],
      ['https://example.com!', 'https://example.com'],
      ['https://example.com?q=1)', 'https://example.com?q=1'],
      ['https://example.com:::', 'https://example.com'],
      ['https://example.com).', 'https://example.com'],
    ])('trims sentence punctuation: %s -> %s', (input, expected) => {
      expect(trimTrailingUrlPunctuation(input)).toBe(expected);
    });

    it('preserves a trailing close-paren when balanced inside the URL', () => {
      const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
      expect(trimTrailingUrlPunctuation(url)).toBe(url);
    });

    it('trims a trailing `>` (CommonMark autolink delimiter)', () => {
      expect(trimTrailingUrlPunctuation('https://example.com>')).toBe(
        'https://example.com',
      );
    });

    it('trims an unbalanced trailing close-paren', () => {
      expect(trimTrailingUrlPunctuation('https://example.com/x)')).toBe(
        'https://example.com/x',
      );
    });

    it('returns the input unchanged when there is no trailing punctuation', () => {
      expect(trimTrailingUrlPunctuation('https://example.com/x')).toBe(
        'https://example.com/x',
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
    function setPlatform(value: NodeJS.Platform) {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value,
      });
    }

    it('returns false when stdout is not a TTY', () => {
      setTTY(false);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false when NO_COLOR is set', () => {
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
      process.env['NO_COLOR'] = '1';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false when FORCE_COLOR=0', () => {
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
      process.env['FORCE_COLOR'] = '0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false in CI', () => {
      setTTY(true);
      process.env['CI'] = 'true';
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false inside tmux even on a capable terminal', () => {
      setTTY(true);
      process.env['TMUX'] = '/tmp/tmux-1000/default,1,0';
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false inside GNU screen', () => {
      setTTY(true);
      process.env['STY'] = '1234.host';
      process.env['WT_SESSION'] = '00000000-0000-0000-0000-000000000000';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('lets a detected TERM_PROGRAM win even on win32', () => {
      setTTY(true);
      setPlatform('win32');
      process.env['TERM_PROGRAM'] = 'vscode';
      process.env['TERM_PROGRAM_VERSION'] = '1.80.0';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('returns false on bare win32 (no detected terminal)', () => {
      setTTY(true);
      setPlatform('win32');
      delete process.env['TERM_PROGRAM'];
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns true for Windows Terminal even on win32', () => {
      setTTY(true);
      setPlatform('win32');
      process.env['WT_SESSION'] = '00000000-0000-0000-0000-000000000000';
      expect(supportsHyperlinks()).toBe(true);
    });

    describe('version-gated TERM_PROGRAMs', () => {
      it('iTerm.app >= 3.1 is enabled, < 3.1 is not', () => {
        setTTY(true);
        process.env['TERM_PROGRAM'] = 'iTerm.app';
        process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
        expect(supportsHyperlinks()).toBe(true);
        process.env['TERM_PROGRAM_VERSION'] = '3.1.0';
        expect(supportsHyperlinks()).toBe(true);
        process.env['TERM_PROGRAM_VERSION'] = '3.0.15';
        expect(supportsHyperlinks()).toBe(false);
        process.env['TERM_PROGRAM_VERSION'] = '2.9.20140903';
        expect(supportsHyperlinks()).toBe(false);
      });

      it('vscode >= 1.72 is enabled, < 1.72 is not', () => {
        setTTY(true);
        process.env['TERM_PROGRAM'] = 'vscode';
        process.env['TERM_PROGRAM_VERSION'] = '1.72.0';
        expect(supportsHyperlinks()).toBe(true);
        process.env['TERM_PROGRAM_VERSION'] = '1.71.2';
        expect(supportsHyperlinks()).toBe(false);
      });

      it('WezTerm requires the dated build >= 20200620', () => {
        setTTY(true);
        process.env['TERM_PROGRAM'] = 'WezTerm';
        process.env['TERM_PROGRAM_VERSION'] = '20200620-000000';
        expect(supportsHyperlinks()).toBe(true);
        process.env['TERM_PROGRAM_VERSION'] = '20191123-000000';
        expect(supportsHyperlinks()).toBe(false);
      });
    });

    it('VTE 0.50.0 is blocked due to known segfault; >= 0.50 otherwise enabled', () => {
      setTTY(true);
      process.env['VTE_VERSION'] = '0.50.0';
      expect(supportsHyperlinks()).toBe(false);
      process.env['VTE_VERSION'] = '0.52.0';
      expect(supportsHyperlinks()).toBe(true);
      process.env['VTE_VERSION'] = '0.48.0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('VTE 0.50.0 reported in packed form (5000) is also blocked', () => {
      // VTE historically reports VTE_VERSION as a packed integer; the
      // string-compare path would miss this case and let the segfault fire.
      setTTY(true);
      process.env['VTE_VERSION'] = '5000';
      expect(supportsHyperlinks()).toBe(false);
      process.env['VTE_VERSION'] = '5002';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Kitty is enabled via KITTY_WINDOW_ID or TERM=xterm-kitty', () => {
      setTTY(true);
      process.env['KITTY_WINDOW_ID'] = '1';
      expect(supportsHyperlinks()).toBe(true);
      delete process.env['KITTY_WINDOW_ID'];
      process.env['TERM'] = 'xterm-kitty';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Ghostty is enabled via GHOSTTY_RESOURCES_DIR or TERM=xterm-ghostty', () => {
      setTTY(true);
      process.env['GHOSTTY_RESOURCES_DIR'] = '/path';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Konsole ≥ 21.04 is enabled via KONSOLE_VERSION', () => {
      setTTY(true);
      process.env['KONSOLE_VERSION'] = '230400';
      expect(supportsHyperlinks()).toBe(true);
      process.env['KONSOLE_VERSION'] = '210400';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Konsole < 21.04 falls through (no OSC 8 in 20.x)', () => {
      // KONSOLE_VERSION is set by every Konsole release, including ones
      // that pre-date OSC 8 support. Without a version gate those older
      // sessions would receive escape bytes they can't render.
      setTTY(true);
      process.env['KONSOLE_VERSION'] = '201200'; // Konsole 20.12
      expect(supportsHyperlinks()).toBe(false);
      process.env['KONSOLE_VERSION'] = '210399'; // one patch below the gate
      expect(supportsHyperlinks()).toBe(false);
    });

    it('Alacritty is enabled via TERM=alacritty', () => {
      setTTY(true);
      process.env['TERM'] = 'alacritty';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Alacritty fallback: ALACRITTY_LOG/WINDOW_ID/SOCKET when terminfo missing', () => {
      setTTY(true);
      // Simulate Alacritty falling back to TERM=xterm-256color because the
      // alacritty terminfo isn't installed on this host.
      process.env['TERM'] = 'xterm-256color';
      process.env['ALACRITTY_LOG'] = '/tmp/Alacritty-12345.log';
      expect(supportsHyperlinks()).toBe(true);
      delete process.env['ALACRITTY_LOG'];
      process.env['ALACRITTY_WINDOW_ID'] = '12345';
      expect(supportsHyperlinks()).toBe(true);
      delete process.env['ALACRITTY_WINDOW_ID'];
      process.env['ALACRITTY_SOCKET'] = '/tmp/alacritty.sock';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('JetBrains JediTerm is enabled via TERMINAL_EMULATOR', () => {
      setTTY(true);
      process.env['TERMINAL_EMULATOR'] = 'JetBrains-JediTerm';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Warp Terminal is intentionally NOT auto-detected (no OSC 8 support yet)', () => {
      // Warp's current rendering engine doesn't honor OSC 8 — it prints the
      // envelope as visible garbage. Falls through to the final return false
      // until Warp ships support. Users on a Warp build that does support
      // OSC 8 can opt in via FORCE_HYPERLINK=1.
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'WarpTerminal';
      expect(supportsHyperlinks()).toBe(false);
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('mintty is enabled via TERM_PROGRAM=mintty', () => {
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'mintty';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Hyper is intentionally not auto-detected (requires FORCE_HYPERLINK)', () => {
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'Hyper';
      expect(supportsHyperlinks()).toBe(false);
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('Apple Terminal is not auto-detected (no OSC 8 support)', () => {
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      process.env['TERM_PROGRAM_VERSION'] = '447';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('honors FORCE_HYPERLINK=1 inside tmux on a TTY', () => {
      setTTY(true);
      process.env['TMUX'] = '/tmp/x,1,0';
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks()).toBe(true);
    });

    it('FORCE_HYPERLINK=1 does NOT override non-TTY suppression', () => {
      // A user with `FORCE_HYPERLINK=1` in their shell profile (to enable
      // OSC 8 inside tmux interactively) must still get a clean pipe when
      // running `qwen | cat` — escape bytes never go into a file/pipe.
      setTTY(false);
      process.env['FORCE_HYPERLINK'] = '1';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('FORCE_HYPERLINK=0 disables even on capable terminals', () => {
      setTTY(true);
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
      process.env['FORCE_HYPERLINK'] = '0';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('hard opt-outs (NO_COLOR/QWEN_DISABLE_HYPERLINKS) win over FORCE_HYPERLINK', () => {
      setTTY(true);
      process.env['FORCE_HYPERLINK'] = '1';
      process.env['NO_COLOR'] = '1';
      expect(supportsHyperlinks()).toBe(false);
      delete process.env['NO_COLOR'];
      process.env['QWEN_DISABLE_HYPERLINKS'] = '1';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('returns false for an unknown terminal even on a TTY', () => {
      setTTY(true);
      process.env['TERM'] = 'dumb';
      expect(supportsHyperlinks()).toBe(false);
    });

    it('accepts a stream argument so non-stdout writers can be probed', () => {
      const fakeStream = { isTTY: true } as NodeJS.WriteStream;
      process.env['WT_SESSION'] = '00000000-0000-0000-0000-000000000000';
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: false,
      });
      expect(supportsHyperlinks(fakeStream)).toBe(true);
      expect(supportsHyperlinks(process.stdout)).toBe(false);
    });
  });
});
