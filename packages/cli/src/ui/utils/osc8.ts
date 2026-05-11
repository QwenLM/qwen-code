/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSC 8 hyperlink helpers.
 *
 * Supported terminals (iTerm2 ≥ 3.1, WezTerm ≥ 20200620, Kitty, Ghostty,
 * Windows Terminal, VS Code ≥ 1.72, GNOME Terminal / VTE ≥ 0.50, …) render
 * an OSC 8 envelope as a clickable link that survives line wrapping.
 * Terminals without OSC 8 support ignore the escapes and print the visible
 * label as-is.
 */

import { wrapForMultiplexer } from '../../utils/osc.js';
export { wrapForMultiplexer } from '../../utils/osc.js';

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
 * the OSC — more broadly supported than ST (ESC \\).
 */
export function osc8Hyperlink(url: string, label = url): string {
  const safeUrl = sanitizeForOsc(url);
  const safeLabel = sanitizeForOsc(label);
  return wrapForMultiplexer(`\x1b]8;;${safeUrl}\x07${safeLabel}\x1b]8;;\x07`);
}

/**
 * Open half of an OSC 8 hyperlink envelope. Pair with `osc8Close()` to wrap
 * a styled label without losing the surrounding SGR resets — OSC 8 and SGR
 * are orthogonal so nested color styling is preserved by terminals that
 * honor the hyperlink sequence.
 */
export function osc8Open(url: string): string {
  return wrapForMultiplexer(`\x1b]8;;${sanitizeForOsc(url)}\x07`);
}

/** Close half of an OSC 8 hyperlink envelope. */
export function osc8Close(): string {
  return wrapForMultiplexer(`\x1b]8;;\x07`);
}

/**
 * Schemes safe to embed in an OSC 8 target. Restricting to network and mail
 * schemes prevents prompt-injection attacks from producing a one-click
 * `javascript:` / `data:` / `file:` trap whose target is hidden behind the
 * link label. Anything outside this set falls back to legacy rendering so
 * the user sees the suspicious URL before any click.
 */
const SAFE_OSC8_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'ftp:',
  'ftps:',
  'sftp:',
  'ssh:',
]);

/**
 * Return true if `url` carries an explicit allowlisted scheme. URLs without
 * a scheme (relative paths, `#anchor`, empty) are rejected — terminals can't
 * resolve them anyway, and rejecting them avoids creating un-clickable links.
 */
export function isSafeOscScheme(url: string): boolean {
  const match = url.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (!match) return false;
  return SAFE_OSC8_SCHEMES.has(match[1]!.toLowerCase());
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(versionString: string | undefined): ParsedVersion {
  if (!versionString) return { major: 0, minor: 0, patch: 0 };
  // VTE historically reports `VTE_VERSION` as a packed integer (e.g. `7800`
  // for 0.78.0, `5000` for 0.50.0) rather than dot-separated. Mirror the
  // `supports-hyperlinks` package's heuristic for this case so we extract
  // the right minor for the >=0.50 gate below.
  if (/^\d{3,4}$/.test(versionString)) {
    const m = /(\d{1,2})(\d{2})/.exec(versionString)!;
    return { major: 0, minor: parseInt(m[1]!, 10), patch: parseInt(m[2]!, 10) };
  }
  const parts = versionString.split('.').map((n) => parseInt(n, 10) || 0);
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

/**
 * Detect whether the given writable stream's host terminal can render OSC 8
 * hyperlinks. Mirrors the version-gated detection used by the
 * `supports-hyperlinks` npm package — see https://github.com/jamestalmage/node-supports-hyperlinks —
 * with two intentional deviations:
 *
 *   1. Inside `tmux` or GNU `screen` we refuse by default. The multiplexer
 *      hides the actual host terminal's capabilities, so even when we DCS-
 *      passthrough the sequence the host may print visible garbage on
 *      terminals that don't understand OSC 8. Power users who know their
 *      host supports OSC 8 and have `allow-passthrough on` (tmux 3.3+) can
 *      opt in with `FORCE_HYPERLINK=1`.
 *
 *   2. `QWEN_DISABLE_HYPERLINKS=1` is a hard opt-out (e.g. for users whose
 *      terminal advertises support but breaks on long URLs).
 *
 * The detector deliberately allocates nothing and reads env vars on every
 * call — env state can change at runtime (`/theme` toggles, NO_COLOR set
 * mid-session) and memoizing would freeze a stale answer.
 */
export function supportsHyperlinks(
  stream: NodeJS.WriteStream | undefined = process.stdout,
): boolean {
  const env = process.env;

  // Hard opt-outs win unconditionally.
  if (env['QWEN_DISABLE_HYPERLINKS'] === '1') return false;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] === '0' || env['FORCE_COLOR'] === 'false') {
    return false;
  }

  // Explicit force overrides every heuristic below — but not the opt-outs
  // above. Mirrors the `FORCE_HYPERLINK` contract from supports-hyperlinks:
  // any non-zero numeric value (or empty string) enables, `0` disables.
  const force = env['FORCE_HYPERLINK'];
  if (force !== undefined) {
    if (force.length === 0) return true;
    return parseInt(force, 10) !== 0;
  }

  // Embedded escapes must never end up in a file or another process.
  if (!stream || !stream.isTTY) return false;

  if (env['CI']) return false;
  if (env['TEAMCITY_VERSION']) return false;

  // Multiplexers hide the host terminal's identity — bail unless the user
  // opted in via FORCE_HYPERLINK above.
  if (env['TMUX'] || env['STY']) return false;

  // Modern terminals identified by their own env vars (no version probe
  // needed — these have shipped OSC 8 since their first OSC-8-aware release
  // and their env var is only set by versions new enough to support it).
  if (env['WT_SESSION']) return true; // Windows Terminal
  if (env['KITTY_WINDOW_ID'] || env['TERM'] === 'xterm-kitty') return true;
  if (env['DOMTERM']) return true;
  if (env['GHOSTTY_RESOURCES_DIR'] || env['TERM'] === 'xterm-ghostty') {
    return true;
  }

  if (env['TERM_PROGRAM']) {
    const version = parseVersion(env['TERM_PROGRAM_VERSION']);
    switch (env['TERM_PROGRAM']) {
      case 'iTerm.app':
        if (version.major === 3) return version.minor >= 1;
        return version.major > 3;
      case 'WezTerm':
        return version.major >= 20200620;
      case 'vscode':
        return (
          version.major > 1 || (version.major === 1 && version.minor >= 72)
        );
      case 'ghostty':
        return true;
      // Hyper historically advertised OSC 8 but rendered it inconsistently;
      // require an explicit FORCE_HYPERLINK opt-in.
      default:
        break;
    }
  }

  if (env['VTE_VERSION']) {
    // VTE 0.50.0 advertises OSC 8 but segfaults when it actually fires.
    // Compare against the parsed version so the packed form (`'5000'`) is
    // recognized too — the raw string compare against `'0.50.0'` would miss
    // it and let the segfault through.
    const version = parseVersion(env['VTE_VERSION']);
    if (version.major === 0 && version.minor === 50 && version.patch === 0) {
      return false;
    }
    if (version.major > 0 || version.minor >= 50) return true;
    return false;
  }

  // Legacy Windows console (cmd.exe, conhost) — no OSC support outside WT.
  if (process.platform === 'win32') return false;

  return false;
}

/**
 * Trim trailing sentence punctuation off a bare URL run before it becomes
 * an OSC 8 target. Models routinely produce `see https://example.com.` and
 * the inline regex greedily swallows the period; clicking the wrapped link
 * then opens a 404. The trailing characters stay in the visible text — only
 * the OSC 8 *target* is trimmed, so byte-output for unsupported terminals
 * is unchanged.
 *
 * The set of trimmable trailing characters matches GitHub / GitLab linkifier
 * behavior. We additionally rebalance a trailing `)` against opening `(` in
 * the URL so URLs that legitimately end with `)` (Wikipedia disambiguation,
 * MSDN) aren't truncated.
 */
export function trimTrailingUrlPunctuation(url: string): string {
  // Count `( [ {` opens once up-front; we then decrement running `)`/`]`/`}`
  // close counts as we trim, keeping the whole trim O(n) instead of O(n²)
  // for adversarial inputs like `https://x.com))))…`.
  let openParen = 0;
  let openBracket = 0;
  let openBrace = 0;
  let closeParen = 0;
  let closeBracket = 0;
  let closeBrace = 0;
  for (let i = 0; i < url.length; i++) {
    const cc = url.charCodeAt(i);
    if (cc === 0x28) openParen++;
    else if (cc === 0x5b) openBracket++;
    else if (cc === 0x7b) openBrace++;
    else if (cc === 0x29) closeParen++;
    else if (cc === 0x5d) closeBracket++;
    else if (cc === 0x7d) closeBrace++;
  }

  let end = url.length;
  while (end > 0) {
    const c = url.charCodeAt(end - 1);
    // .,;:!?'"`
    if (
      c === 0x2e ||
      c === 0x2c ||
      c === 0x3b ||
      c === 0x3a ||
      c === 0x21 ||
      c === 0x3f ||
      c === 0x27 ||
      c === 0x22 ||
      c === 0x60
    ) {
      end--;
      continue;
    }
    // Trailing `)`/`]`/`}` only when unbalanced against opens in the prefix.
    if (c === 0x29 && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (c === 0x5d && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (c === 0x7d && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

// ── Markdown link regex shared between the React and ANSI renderers ──────

/**
 * Inline link pattern allowing one level of balanced parens in the URL
 * group so `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))` isn't truncated
 * at the inner `)`. Mirrors CommonMark's cap. Exposed for both the React
 * markdown renderer and the ANSI table renderer to keep them in lockstep.
 */
export const MD_LINK_PATTERN = String.raw`\[.*?\]\((?:[^()]|\([^()]*\))*\)`;

/**
 * Capture the label and URL out of a single matched link token. Anchored
 * with `^...$` because callers pass the whole match string.
 */
export const MD_LINK_CAPTURE = /^\[(.*?)\]\(((?:[^()]|\([^()]*\))*)\)$/;

/**
 * Should the markdown renderers wrap a `[label](url)` token in an OSC 8
 * envelope? Returns true only when (a) the host terminal advertises OSC 8,
 * (b) the URL uses an allowlisted network/mail scheme, and (c) the URL
 * contains no whitespace — every terminal rejects or silently truncates a
 * whitespace-bearing OSC 8 target, which would turn the whole region into
 * an un-clickable trap on capable terminals.
 *
 * Centralizing the predicate keeps the React renderer and the ANSI table
 * renderer in lockstep; if a future scheme is allowlisted, both pick it up.
 */
export function shouldWrapMarkdownLink(
  url: string,
  canHyperlink: boolean,
): boolean {
  return canHyperlink && isSafeOscScheme(url) && !/\s/.test(url);
}

// ── Test helpers ─────────────────────────────────────────────────────────

/**
 * Every env var `supportsHyperlinks()` reads. Test files clear these in
 * `beforeEach` so a developer's iTerm2 session doesn't leak into snapshot
 * output. Exported so tests stay in lockstep with the detector.
 */
export const HYPERLINK_ENV_KEYS = [
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'TMUX',
  'STY',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
  'KITTY_WINDOW_ID',
  'VTE_VERSION',
  'DOMTERM',
  'GHOSTTY_RESOURCES_DIR',
  'TERM',
  'TEAMCITY_VERSION',
  'FORCE_HYPERLINK',
  'QWEN_DISABLE_HYPERLINKS',
] as const;
