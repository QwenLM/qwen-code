/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSC 8 hyperlink helpers.
 *
 * Supported terminals (iTerm2, WezTerm, Kitty, Windows Terminal, VS Code,
 * GNOME Terminal/VTE, Alacritty ≥ 0.11, Ghostty, …) render an OSC 8 envelope
 * as a clickable link that survives line wrapping. Terminals without OSC 8
 * support ignore the escapes and print the visible label as-is.
 */

/**
 * Wrap an OSC sequence for terminal multiplexers so the host terminal
 * receives it. tmux requires a DCS passthrough with inner ESCs doubled;
 * GNU screen uses a plain DCS envelope. Note: tmux 3.3+ defaults
 * `allow-passthrough` to off — users on default configs will not see
 * the hyperlink until they set `set -g allow-passthrough on`.
 */
export function wrapForMultiplexer(osc: string): string {
  if (process.env['TMUX']) {
    return `\x1bPtmux;${osc.split('\x1b').join('\x1b\x1b')}\x1b\\`;
  }
  if (process.env['STY']) {
    return `\x1bP${osc}\x1b\\`;
  }
  return osc;
}

/**
 * Strip C0 control characters and DEL so an untrusted string can be safely
 * embedded inside an OSC escape. Without this a `\x07` (BEL) or `\x1b` (ESC)
 * in the input would prematurely terminate the OSC sequence and leak the
 * tail bytes to the terminal as interpretable escape codes.
 */
export function sanitizeForOsc(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Wrap a URL in an OSC 8 hyperlink escape sequence. BEL (\x07) terminates
 * the OSC — more broadly supported than ST (ESC \\). Inside tmux / screen
 * the sequence is wrapped in a DCS passthrough envelope so the multiplexer
 * forwards it to the host terminal instead of eating it.
 */
export function osc8Hyperlink(url: string, label = url): string {
  const safeUrl = sanitizeForOsc(url);
  const safeLabel = sanitizeForOsc(label);
  return wrapForMultiplexer(`\x1b]8;;${safeUrl}\x07${safeLabel}\x1b]8;;\x07`);
}

/**
 * Open half of an OSC 8 hyperlink envelope. Pair with `osc8Close()` to wrap
 * a styled label (e.g. an `<ink>` `<Text color=...>` element) without losing
 * the surrounding SGR resets — OSC 8 and SGR are orthogonal so nested color
 * styling is preserved by terminals that honor the hyperlink sequence.
 */
export function osc8Open(url: string): string {
  return wrapForMultiplexer(`\x1b]8;;${sanitizeForOsc(url)}\x07`);
}

/** Close half of an OSC 8 hyperlink envelope. */
export function osc8Close(): string {
  return wrapForMultiplexer(`\x1b]8;;\x07`);
}

/**
 * Cheap, dependency-free OSC 8 capability detection. Mirrors the env-var
 * checks used by the `supports-hyperlinks` npm package without adding a
 * direct dependency. The result is memoized after the first call because
 * env vars don't change over the lifetime of a CLI session.
 *
 * Honors `NO_COLOR` and `FORCE_COLOR=0` and bails on non-TTY stdout so
 * piping to a file or another process doesn't embed escape bytes.
 */
let cachedSupport: boolean | undefined;

export function supportsHyperlinks(): boolean {
  if (cachedSupport !== undefined) return cachedSupport;
  cachedSupport = detectSupportsHyperlinks();
  return cachedSupport;
}

/** Reset the cached capability check. Intended for tests only. */
export function resetSupportsHyperlinksCache(): void {
  cachedSupport = undefined;
}

function detectSupportsHyperlinks(): boolean {
  const env = process.env;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] === '0' || env['FORCE_COLOR'] === 'false') {
    return false;
  }
  if (env['QWEN_DISABLE_HYPERLINKS'] === '1') return false;

  // `FORCE_HYPERLINK=1` is the canonical override used by supports-hyperlinks.
  if (
    env['FORCE_HYPERLINK'] !== undefined &&
    env['FORCE_HYPERLINK'] !== '0' &&
    env['FORCE_HYPERLINK'] !== 'false'
  ) {
    return true;
  }

  // CI is detected as non-interactive; opt out by default to keep build logs
  // clean of escape sequences when piped to capture systems.
  if (env['CI']) return false;

  // stdout must be a real TTY; piping to a file/process must not embed escapes.
  const stdout = process.stdout as NodeJS.WriteStream | undefined;
  if (!stdout || !stdout.isTTY) return false;

  // Trust common modern terminals via their advertised env vars.
  const termProgram = env['TERM_PROGRAM'];
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'vscode' ||
    termProgram === 'ghostty' ||
    termProgram === 'Hyper' ||
    termProgram === 'Tabby' ||
    termProgram === 'mintty'
  ) {
    return true;
  }
  if (env['WT_SESSION']) return true; // Windows Terminal
  if (env['KITTY_WINDOW_ID']) return true; // Kitty
  if (env['VTE_VERSION']) return true; // GNOME Terminal, Tilix, …
  if (env['DOMTERM']) return true;
  if (env['JEDITERM_SOURCE_ARGS'] !== undefined) return true; // JetBrains
  if (env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm') return true;

  if (env['TERM'] === 'xterm-kitty') return true;
  if (env['TERM']?.startsWith('alacritty')) return true;
  if (env['COLORTERM'] === 'truecolor' && env['TERM']?.startsWith('xterm')) {
    // Heuristic for modern xterm-compatible emulators that don't advertise
    // themselves via TERM_PROGRAM. Conservative — only when truecolor too.
    return true;
  }

  return false;
}
