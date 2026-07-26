/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal-detection matrix for the OSC 8 primitives.
 *
 * Salvaged from PR #6433, whose test file was reverted when its merge commit
 * resolved in favour of #7255. The *implementation* on main covers every
 * terminal below, but nothing on main asserts any of it: a 28-mutant run
 * against the pre-existing suites left 21 alive. These cases target exactly
 * those survivors.
 *
 * Control characters are written as explicit `\uXXXX` / `\xXX` escapes
 * throughout. A literal U+009D or U+202E in the source is invisible in review
 * and some editors normalise it away on save, which would silently turn these
 * assertions into `expect('ab').toBe('ab')` — green against a sanitizer that
 * does nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HYPERLINK_ENV_KEYS,
  osc8Hyperlink,
  sanitizeForOsc,
  supportsHyperlinks,
} from './osc8.js';
import { showFallbackMessage } from '../qwen/qwenOAuth2.js';

const tty = { isTTY: true } as unknown as NodeJS.WriteStream;
const OSC8_OPEN = '\x1b]8;;';

/** Terminal env states and the verdict the detector must return on a TTY. */
const MATRIX: Array<[string, Record<string, string>, boolean]> = [
  // --- version-gated terminals -------------------------------------------
  [
    'iTerm2 3.1 (first OSC 8 release)',
    { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.1' },
    true,
  ],
  [
    'iTerm2 3.4.7',
    { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.7' },
    true,
  ],
  [
    'iTerm2 3.0 is too old',
    { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.0' },
    false,
  ],
  [
    'iTerm2 2.9 is too old',
    { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.9' },
    false,
  ],
  [
    'VS Code 1.72',
    { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.72.0' },
    true,
  ],
  [
    'VS Code 1.71 is too old',
    { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.71.2' },
    false,
  ],
  [
    'WezTerm 20230712',
    { TERM_PROGRAM: 'WezTerm', TERM_PROGRAM_VERSION: '20230712' },
    true,
  ],
  [
    'WezTerm 20190101 is too old',
    { TERM_PROGRAM: 'WezTerm', TERM_PROGRAM_VERSION: '20190101' },
    false,
  ],
  [
    'mintty 3.4.7',
    { TERM_PROGRAM: 'mintty', TERM_PROGRAM_VERSION: '3.4.7' },
    true,
  ],
  [
    'mintty 3.1 prints raw escapes',
    { TERM_PROGRAM: 'mintty', TERM_PROGRAM_VERSION: '3.1' },
    false,
  ],
  ['mintty without a version is refused', { TERM_PROGRAM: 'mintty' }, false],
  ['Konsole 21.04', { KONSOLE_VERSION: '210400' }, true],
  ['Konsole 23.08.5', { KONSOLE_VERSION: '230805' }, true],
  ['Konsole 21.03 is too old', { KONSOLE_VERSION: '210300' }, false],
  // --- VTE packed-integer parsing ----------------------------------------
  ['VTE packed 7800 = 0.78', { VTE_VERSION: '7800' }, true],
  ['VTE packed 6000 = 0.60', { VTE_VERSION: '6000' }, true],
  ['VTE packed 5000 = 0.50.0 segfaults', { VTE_VERSION: '5000' }, false],
  ['VTE packed 4900 = 0.49 predates OSC 8', { VTE_VERSION: '4900' }, false],
  ['VTE dot-format 0.60.0', { VTE_VERSION: '0.60.0' }, true],
  ['VTE dot-format 0.50.0 segfaults', { VTE_VERSION: '0.50.0' }, false],
  ['VTE dot-format 0.50.1 is patched', { VTE_VERSION: '0.50.1' }, true],
  ['VTE dot-format 0.49.0 predates OSC 8', { VTE_VERSION: '0.49.0' }, false],
  // --- env-var-identified terminals --------------------------------------
  ['Windows Terminal', { WT_SESSION: 'abc-123' }, true],
  ['Kitty via KITTY_WINDOW_ID', { KITTY_WINDOW_ID: '1' }, true],
  ['Kitty via TERM', { TERM: 'xterm-kitty' }, true],
  ['Ghostty via TERM', { TERM: 'xterm-ghostty' }, true],
  [
    'Ghostty via resources dir',
    { GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' },
    true,
  ],
  ['DomTerm', { DOMTERM: '2.0' }, true],
  ['Alacritty via TERM', { TERM: 'alacritty' }, true],
  ['Alacritty via ALACRITTY_LOG', { ALACRITTY_LOG: '/tmp/a.log' }, true],
  ['Alacritty via ALACRITTY_WINDOW_ID', { ALACRITTY_WINDOW_ID: '9' }, true],
  ['Alacritty via ALACRITTY_SOCKET', { ALACRITTY_SOCKET: '/tmp/a.sock' }, true],
  ['JetBrains JediTerm', { TERMINAL_EMULATOR: 'JetBrains-JediTerm' }, true],
  // --- terminals that must NOT get escapes -------------------------------
  [
    'Warp does not support OSC 8',
    { TERM_PROGRAM: 'WarpTerminal', TERM_PROGRAM_VERSION: '1.0' },
    false,
  ],
  [
    'Apple Terminal does not support OSC 8',
    { TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '447' },
    false,
  ],
  [
    'Hyper is gated behind FORCE_HYPERLINK',
    { TERM_PROGRAM: 'Hyper', TERM_PROGRAM_VERSION: '3.4.0' },
    false,
  ],
  ['unknown terminal', { TERM: 'xterm-256color' }, false],
  // --- non-interactive contexts ------------------------------------------
  ['CI', { CI: '1', TERM: 'xterm-kitty' }, false],
  ['TeamCity', { TEAMCITY_VERSION: '2023.1', TERM: 'xterm-kitty' }, false],
  // --- opt-outs -----------------------------------------------------------
  [
    'NO_COLOR beats terminal detection',
    { NO_COLOR: '1', TERM: 'xterm-kitty' },
    false,
  ],
  [
    'NO_COLOR="" is not an opt-out',
    { NO_COLOR: '', TERM: 'xterm-kitty' },
    true,
  ],
  ['FORCE_COLOR=0', { FORCE_COLOR: '0', TERM: 'xterm-kitty' }, false],
  ['FORCE_COLOR=false', { FORCE_COLOR: 'false', TERM: 'xterm-kitty' }, false],
  [
    'QWEN_DISABLE_HYPERLINKS beats FORCE_HYPERLINK',
    { QWEN_DISABLE_HYPERLINKS: '1', FORCE_HYPERLINK: '1' },
    false,
  ],
  // --- FORCE_HYPERLINK contract ------------------------------------------
  [
    'FORCE_HYPERLINK=1 overrides an unknown terminal',
    { FORCE_HYPERLINK: '1', TERM: 'dumb' },
    true,
  ],
  ['FORCE_HYPERLINK="" enables', { FORCE_HYPERLINK: '', TERM: 'dumb' }, true],
  ['FORCE_HYPERLINK=2 enables', { FORCE_HYPERLINK: '2', TERM: 'dumb' }, true],
  [
    'FORCE_HYPERLINK=-1 enables (non-zero)',
    { FORCE_HYPERLINK: '-1', TERM: 'dumb' },
    true,
  ],
  [
    'FORCE_HYPERLINK=0 disables a capable terminal',
    { FORCE_HYPERLINK: '0', TERM: 'xterm-kitty' },
    false,
  ],
  [
    'FORCE_HYPERLINK=false disables (non-numeric)',
    { FORCE_HYPERLINK: 'false', TERM: 'xterm-kitty' },
    false,
  ],
  [
    'FORCE_HYPERLINK=true disables (non-numeric)',
    { FORCE_HYPERLINK: 'true', TERM: 'xterm-kitty' },
    false,
  ],
  ['FORCE_HYPERLINK beats CI', { FORCE_HYPERLINK: '1', CI: '1' }, true],
];

function clearHyperlinkEnv(saved: Record<string, string | undefined>) {
  for (const key of HYPERLINK_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreHyperlinkEnv(saved: Record<string, string | undefined>) {
  for (const key of HYPERLINK_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('supportsHyperlinks terminal matrix', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => clearHyperlinkEnv(saved));
  afterEach(() => restoreHyperlinkEnv(saved));

  it.each(MATRIX)('%s', (_name, env, expected) => {
    Object.assign(process.env, env);
    expect(supportsHyperlinks(tty)).toBe(expected);
  });

  it('never emits escapes to a non-TTY, whatever the terminal claims', () => {
    const notTty = { isTTY: false } as unknown as NodeJS.WriteStream;
    for (const [, env] of MATRIX) {
      for (const key of HYPERLINK_ENV_KEYS) delete process.env[key];
      Object.assign(process.env, env);
      expect(supportsHyperlinks(notTty)).toBe(false);
    }
  });
});

describe('sanitizeForOsc control classes', () => {
  it('strips C1 controls, including the 8-bit OSC and ST introducers', () => {
    // U+009D is 8-bit OSC and U+009C is 8-bit ST: a terminal honouring C1
    // treats them exactly like the two-byte ESC forms, so leaving them in
    // reopens the envelope-escape hole that stripping ESC closes.
    expect(sanitizeForOsc('a\u009d0;pwn\u009cb')).toBe('a0;pwnb');
    expect(sanitizeForOsc('a\u0080\u008f\u009fb')).toBe('ab');
  });

  it('strips carriage return so a URL cannot overwrite its own rendered line', () => {
    expect(sanitizeForOsc('good.example\rEVIL')).toBe('good.exampleEVIL');
  });

  it('strips line and paragraph separators', () => {
    expect(sanitizeForOsc('a\u2028b\u2029c')).toBe('abc');
  });

  it('strips every bidi control used for label spoofing', () => {
    expect(
      sanitizeForOsc(
        'a\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069b',
      ),
    ).toBe('ab');
  });
});

describe('osc8Hyperlink label handling', () => {
  it('sanitizes the visible label, not just the target', () => {
    const seq = osc8Hyperlink(
      'https://ok.example',
      'https://ok.example\u202egnahp\u202c',
    );
    expect(seq).not.toContain('\u202e');
    expect(seq).not.toContain('\u202c');
    expect(seq).toBe(
      `${OSC8_OPEN}https://ok.example\x07https://ok.examplegnahp${OSC8_OPEN}\x07`,
    );
  });

  it('sanitizes control characters in the label that would close the envelope', () => {
    const seq = osc8Hyperlink('https://ok.example', 'lab\x07el\x1b]0;pwn\x07');
    // Exactly two BELs remain: the target terminator and the closing
    // terminator. A third would mean the label tore the envelope open.
    expect(seq.split('\x07')).toHaveLength(3);
    expect(seq).toBe(
      `${OSC8_OPEN}https://ok.example\x07label]0;pwn${OSC8_OPEN}\x07`,
    );
  });
});

describe('showFallbackMessage URL scheme allowlist', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    clearHyperlinkEnv(saved);
    process.env['TERM'] = 'xterm-kitty';
  });
  afterEach(() => restoreHyperlinkEnv(saved));

  const render = (url: string) => {
    const chunks: string[] = [];
    const out = {
      isTTY: true,
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    showFallbackMessage(url, out);
    return chunks.join('');
  };

  it.each([
    ['https', 'https://chat.qwen.ai/device?code=A'],
    ['http', 'http://localhost:8080/device?code=A'],
  ])('links an %s URL', (_scheme, url) => {
    expect(render(url)).toContain(OSC8_OPEN);
  });

  it.each([
    ['javascript', 'javascript:alert(document.domain)'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['vscode', 'vscode://ms-vscode.remote/attach'],
    ['scheme-less', 'chat.qwen.ai/device?code=A'],
  ])('refuses to make a %s URL clickable', (_scheme, url) => {
    const rendered = render(url);
    expect(rendered).not.toContain(OSC8_OPEN);
    // ...and still shows the URL so the user can act on it.
    expect(rendered).toContain(url);
  });
});
