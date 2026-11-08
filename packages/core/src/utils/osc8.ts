/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSC 8 hyperlink primitives (package-agnostic).
 *
 * These live in `core` so both the CLI renderers and core-side emitters — for
 * example the Qwen OAuth device-flow fallback message — can wrap a URL in a
 * single clickable link. `packages/cli/src/ui/utils/osc8.ts` re-exports them
 * so existing CLI imports keep resolving unchanged.
 *
 * Supported terminals (iTerm2 ≥ 3.1, WezTerm ≥ 20200620, Kitty, Ghostty,
 * Windows Terminal, VS Code ≥ 1.72, GNOME Terminal / VTE ≥ 0.50, …) render an
 * OSC 8 envelope as a clickable link that survives line wrapping. Terminals
 * without OSC 8 support ignore the escapes and print the visible label as-is.
 */

/**
 * Wrap an OSC sequence for tmux / screen passthrough.
 *
 * - tmux: DCS `\ePtmux;\e<seq>\e\\` with ESC doubling inside
 * - screen: DCS `\eP<seq>\e\\`
 *
 * BEL should NOT be wrapped — raw BEL triggers tmux's bell-action, whereas a
 * wrapped BEL becomes an opaque DCS payload and is ignored.
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env['TMUX']) {
    // tmux requires all ESC bytes inside the payload to be doubled
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b');
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  if (process.env['STY']) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
}

/**
 * Strip C0 + DEL + C1 control characters AND Unicode bidi / line-separator
 * controls so an untrusted string can be safely embedded inside an OSC
 * escape and rendered without spoofing the visible label.
 *
 * Bytes removed:
 * - C0 + DEL (`\x00-\x1f\x7f`): a stray BEL (`\x07`) or ESC (`\x1b`) would
 *   prematurely terminate the OSC sequence and leak the tail bytes as
 *   interpretable escape codes.
 * - C1 (`\x80-\x9f`): includes 8-bit ST and 8-bit OSC introducers, which
 *   terminals that honor C1 controls treat the same as their two-byte ESC
 *   counterparts.
 * - Bidi controls (`U+200E`, `U+200F`, `U+202A`-`U+202E`, `U+2066`-`U+2069`):
 *   a model-emitted `U+202E` (RLO) in a link label visually reverses the
 *   trailing text, letting a label like `safe.com` actually read as a
 *   different host after rendering. The scheme allowlist guards the *target*;
 *   stripping bidi controls guards the visible *label* from the same class
 *   of click-deception attack.
 * - Line / paragraph separators (`U+2028`, `U+2029`): some terminals treat
 *   these as line breaks inside an OSC payload, fracturing the envelope.
 */
export function sanitizeForOsc(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f\x80-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
    '',
  );
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

function shouldForceHyperlinks(value: string): boolean {
  if (value.length === 0) return true;

  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return false;

  return Number(trimmed) !== 0;
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

  // Embedded escapes must never end up in a file or another process. This
  // guard sits above `FORCE_HYPERLINK` on purpose: a user who has
  // `FORCE_HYPERLINK=1` in their shell profile (to enable OSC 8 inside
  // tmux/Hyper interactively) still shouldn't see escape bytes when they
  // run `qwen | cat` or `qwen > out.txt`.
  if (!stream || !stream.isTTY) return false;

  // Explicit force overrides every heuristic below — but not the opt-outs
  // above nor the non-TTY guard. Mirrors the `FORCE_HYPERLINK` contract
  // from supports-hyperlinks: any non-zero numeric value (or empty string)
  // enables, `0` disables.
  const force = env['FORCE_HYPERLINK'];
  if (force !== undefined) {
    return shouldForceHyperlinks(force);
  }

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
  // Konsole sets KONSOLE_VERSION on every session as a packed integer
  // (e.g. 21.04 → 210400, 23.08.5 → 230805). OSC 8 support landed in
  // Konsole 21.04, so version-gate against `>= 210400` and let older
  // releases fall through to the final `return false` so we don't emit
  // escapes on a host that won't render them.
  if (env['KONSOLE_VERSION']) {
    const konsoleVersion = parseInt(env['KONSOLE_VERSION'], 10);
    if (Number.isFinite(konsoleVersion) && konsoleVersion >= 210400) {
      return true;
    }
  }
  // Alacritty ≥ 0.11 supports OSC 8. Identify it via TERM=alacritty (set
  // when the alacritty terminfo is installed) or the ALACRITTY_LOG /
  // ALACRITTY_WINDOW_ID env vars that Alacritty 0.12+ sets unconditionally.
  // Note: on hosts without alacritty terminfo Alacritty falls back to
  // TERM=xterm-256color and the TERM heuristic alone won't fire — the
  // env-var fallbacks catch those cases.
  if (
    env['TERM'] === 'alacritty' ||
    env['ALACRITTY_LOG'] !== undefined ||
    env['ALACRITTY_WINDOW_ID'] !== undefined ||
    env['ALACRITTY_SOCKET'] !== undefined
  ) {
    return true;
  }
  // JetBrains IDEs set TERMINAL_EMULATOR on their integrated terminal; the
  // JediTerm backend has supported OSC 8 since 2022.3.
  if (env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm') return true;

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
      case 'mintty':
        // mintty added OSC 8 in 3.1, hardened in 3.3. Older builds (still
        // bundled with some Git-for-Windows distros and developer
        // environments like Laragon) print the raw `\x1b]8;;url\x07`
        // bytes as visible garbage instead of silently ignoring them,
        // so gate on TERM_PROGRAM_VERSION. mintty has set
        // TERM_PROGRAM_VERSION since 2.7 (2017), so a missing version
        // means a very old build — refuse rather than guess.
        if (!env['TERM_PROGRAM_VERSION']) return false;
        return version.major > 3 || (version.major === 3 && version.minor >= 3);
      // Warp (TERM_PROGRAM=WarpTerminal) does NOT yet support OSC 8 — its
      // rendering engine ignores the envelope and prints visible garbage,
      // so we deliberately fall through to the legacy `label (url)` path.
      // Re-enable when Warp ships OSC 8 support.
      //
      // Hyper exposes OSC 8 in recent versions but plugin chains have a
      // history of breaking escape passthrough — gate on FORCE_HYPERLINK
      // so users who know their setup works can opt in explicitly.
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
  'KONSOLE_VERSION',
  'TERMINAL_EMULATOR',
  'ALACRITTY_LOG',
  'ALACRITTY_WINDOW_ID',
  'ALACRITTY_SOCKET',
  'TERM',
  'TEAMCITY_VERSION',
  'FORCE_HYPERLINK',
  'QWEN_DISABLE_HYPERLINKS',
] as const;
