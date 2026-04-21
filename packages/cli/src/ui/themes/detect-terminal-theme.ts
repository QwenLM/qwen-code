/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import process from 'node:process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('THEME_DETECT');

export type DetectedTheme = 'dark' | 'light';

// ---------------------------------------------------------------------------
// OSC 11 – query terminal background color
// ---------------------------------------------------------------------------

/** Timeout (ms) for the OSC 11 query. */
const OSC11_TIMEOUT_MS = 200;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Normalises a variable-length hex colour component (1–4 hex digits) to
 * the [0, 1] range.  For example "ff" → 1, "8000" → 0.5 (≈ 32768/65535).
 */
function hexComponent(hex: string): number {
  const max = 16 ** hex.length - 1; // 1-digit → 15, 4-digit → 65535
  return parseInt(hex, 16) / max;
}

/**
 * Parses an XParseColor RGB string returned by OSC 11.
 *
 * Accepted formats:
 *   - `rgb:RRRR/GGGG/BBBB` (1–4 hex digits per component)
 *   - `#RRGGBB` or `#RRRRGGGGBBBB` (equal-length triplets)
 */
export function parseOscRgb(data: string): Rgb | undefined {
  // rgb:R/G/B
  const rgbMatch =
    /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(data);
  if (rgbMatch) {
    return {
      r: hexComponent(rgbMatch[1]!),
      g: hexComponent(rgbMatch[2]!),
      b: hexComponent(rgbMatch[3]!),
    };
  }

  // #RRGGBB or #RRRRGGGGBBBB
  const hashMatch = /^#([0-9a-f]+)$/i.exec(data);
  if (hashMatch && hashMatch[1]!.length % 3 === 0) {
    const hex = hashMatch[1]!;
    const n = hex.length / 3;
    return {
      r: hexComponent(hex.slice(0, n)),
      g: hexComponent(hex.slice(n, 2 * n)),
      b: hexComponent(hex.slice(2 * n)),
    };
  }

  return undefined;
}

/**
 * Converts an OSC 11 colour response into a dark/light theme decision
 * using ITU-R BT.709 relative luminance.
 */
export function themeFromOscColor(data: string): DetectedTheme | undefined {
  const rgb = parseOscRgb(data);
  if (!rgb) return undefined;
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return luminance > 0.5 ? 'light' : 'dark';
}

/**
 * Sends an OSC 11 query (`ESC ] 11 ; ? BEL`) to the terminal and waits
 * for the response containing the background colour.
 *
 * The caller is responsible for having stdin in raw mode with an active
 * consumer (so the stream is in flowing mode). This probe only attaches
 * an extra listener to parse the OSC 11 response — it does NOT flip raw
 * mode or resume/pause stdin, because doing so interleaves with other
 * early-startup stdin consumers (kitty protocol detection, early input
 * capture) and causes terminal response bytes to leak into the TUI.
 *
 * Returns `undefined` when stdin/stdout is not a TTY or when no response
 * arrives within {@link OSC11_TIMEOUT_MS}.
 */
export function detectOsc11Theme(): Promise<DetectedTheme | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve(undefined);
  }

  return new Promise<DetectedTheme | undefined>((resolve) => {
    const stdin = process.stdin;
    let resolved = false;
    let buffer = '';

    const finish = (result: DetectedTheme | undefined) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      resolve(result);
    };

    const timer = setTimeout(() => finish(undefined), OSC11_TIMEOUT_MS);

    const onData = (data: Buffer) => {
      buffer += data.toString();
      // OSC response: ESC ] 11 ; <data> BEL  or  ESC ] 11 ; <data> ST
      // eslint-disable-next-line no-control-regex
      const match = /\x1b\]11;(.*?)(?:\x07|\x1b\\)/.exec(buffer);
      if (match) {
        finish(themeFromOscColor(match[1]!));
      }
    };

    stdin.on('data', onData);
    process.stdout.write('\x1b]11;?\x07');
  });
}

// ---------------------------------------------------------------------------
// Synchronous detection helpers
// ---------------------------------------------------------------------------

/**
 * Detects the macOS system appearance using `defaults read -g AppleInterfaceStyle`.
 * Returns 'dark' if Dark Mode is active, 'light' when `defaults` reports the key
 * is missing (the canonical macOS Light Mode signal), and undefined for any
 * other failure (timeout, `defaults` not on PATH, killed by signal, …) so the
 * caller can continue its fallback chain instead of pinning to Light.
 * Returns undefined on non-macOS platforms.
 */
export function detectMacOSTheme(): DetectedTheme | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }

  try {
    const result = execSync('defaults read -g AppleInterfaceStyle', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return result.toLowerCase() === 'dark' ? 'dark' : 'light';
  } catch (error) {
    const err = error as { stderr?: string | Buffer; message?: string };
    const stderr =
      typeof err.stderr === 'string'
        ? err.stderr
        : (err.stderr?.toString?.() ?? '');
    const message = err.message ?? '';
    // Only the explicit "… does not exist" error confirms Light Mode. Any
    // other failure is inconclusive — returning undefined lets the caller
    // fall through to the next detection layer (or the default-dark).
    if (/does not exist/i.test(stderr) || /does not exist/i.test(message)) {
      return 'light';
    }
    return undefined;
  }
}

/**
 * Detects theme from the COLORFGBG environment variable.
 *
 * COLORFGBG is set by some terminals (e.g., rxvt, xterm, iTerm2, Konsole)
 * in the format "foreground;background" where values are ANSI color indices (0-15).
 *
 * A dark background (0-6, 8) → dark theme.
 * A light background (7, 9-15) → light theme.
 */
export function detectFromColorFgBg(): DetectedTheme | undefined {
  const colorFgBg = process.env['COLORFGBG'];
  if (!colorFgBg) {
    return undefined;
  }

  const parts = colorFgBg.split(';');
  const bgStr = parts[parts.length - 1];
  if (bgStr === undefined) {
    return undefined;
  }

  const bg = parseInt(bgStr, 10);
  if (isNaN(bg)) {
    return undefined;
  }

  if (bg === 7 || (bg >= 9 && bg <= 15)) {
    return 'light';
  }

  return 'dark';
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Synchronous theme detection (for theme dialog live-preview).
 *
 * Order: COLORFGBG → macOS system appearance → default dark.
 */
export function detectTerminalTheme(): DetectedTheme {
  const colorFgBgResult = detectFromColorFgBg();
  if (colorFgBgResult) {
    debugLogger.info(`Detected theme from COLORFGBG: ${colorFgBgResult}`);
    return colorFgBgResult;
  }

  const macResult = detectMacOSTheme();
  if (macResult) {
    debugLogger.info(
      `Detected theme from macOS system appearance: ${macResult}`,
    );
    return macResult;
  }

  debugLogger.info('Could not detect terminal theme, defaulting to dark');
  return 'dark';
}

/**
 * Asynchronous theme detection (for startup).
 *
 * Checks cheap synchronous sources first (COLORFGBG) so we never pay the
 * ~200 ms OSC 11 timeout when a fast answer is already available.  OSC 11 is
 * tried only when no synchronous source provides an answer.
 *
 * Order: COLORFGBG → OSC 11 → macOS system appearance → default dark.
 */
export async function detectTerminalThemeAsync(): Promise<DetectedTheme> {
  // Fast path: COLORFGBG is instant and terminal-specific.
  const colorFgBgResult = detectFromColorFgBg();
  if (colorFgBgResult) {
    debugLogger.info(
      `Detected theme from COLORFGBG (async path): ${colorFgBgResult}`,
    );
    return colorFgBgResult;
  }

  // OSC 11 directly reads the terminal background colour.  It is the most
  // universal method but requires a TTY and may block up to OSC11_TIMEOUT_MS.
  const osc11Result = await detectOsc11Theme();
  if (osc11Result) {
    debugLogger.info(
      `Detected theme from OSC 11 background query: ${osc11Result}`,
    );
    return osc11Result;
  }

  // Remaining synchronous fallbacks (macOS → default dark).
  const macResult = detectMacOSTheme();
  if (macResult) {
    debugLogger.info(
      `Detected theme from macOS system appearance: ${macResult}`,
    );
    return macResult;
  }

  debugLogger.info('Could not detect terminal theme, defaulting to dark');
  return 'dark';
}
