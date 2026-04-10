/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

/**
 * Dark ANSI color indices (standard 0-15 palette).
 *
 * Indices 0-6 and 8 are classified as dark backgrounds following the
 * convention used by vim and other tools.  Indices 3 (yellow/brown) and
 * 6 (cyan) are borderline — their actual brightness depends on the
 * terminal's palette — but standard VGA/xterm defaults render them dark
 * enough to warrant dark-theme text.  7 (white/light-gray) and 9-15
 * (bright variants) are classified as light.
 */
const DARK_BG_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 8]);

export interface DetectOptions {
  timeoutMs?: number;
  stdin?: NodeJS.ReadStream & { fd: 0 };
  stdout?: NodeJS.WriteStream & { fd: 1 };
  env?: Record<string, string | undefined>;
}

/**
 * Determines whether the terminal background is dark or light.
 *
 * Strategy:
 * 1. OSC 11 query — asks the terminal for its background color.
 * 2. COLORFGBG env var — common fallback set by some terminals.
 * 3. Default to 'dark' (preserves existing behaviour).
 */
export async function detectTerminalBackground(
  options?: DetectOptions,
): Promise<'dark' | 'light'> {
  const stdin = options?.stdin ?? process.stdin;
  const stdout = options?.stdout ?? process.stdout;
  const env = options?.env ?? process.env;
  const timeoutMs = options?.timeoutMs ?? 300;

  // Try OSC 11 first (only when both stdin and stdout are TTYs).
  if (stdin.isTTY && stdout.isTTY) {
    const osc11Result = await queryOSC11(stdin, stdout, timeoutMs);
    if (osc11Result !== undefined) {
      return osc11Result;
    }
  }

  // Fallback: COLORFGBG environment variable.
  const colorfgbg = env['COLORFGBG'];
  if (colorfgbg) {
    const result = parseColorFGBG(colorfgbg);
    if (result !== undefined) {
      return result;
    }
  }

  // Default: dark (preserves current QwenDark default).
  return 'dark';
}

/**
 * Sends an OSC 11 query and parses the terminal response.
 * Returns undefined if the terminal does not respond within the timeout.
 */
async function queryOSC11(
  stdin: NodeJS.ReadStream & { fd: 0 },
  stdout: NodeJS.WriteStream & { fd: 1 },
  timeoutMs: number,
): Promise<'dark' | 'light' | undefined> {
  const wasRaw = stdin.isRaw;

  return new Promise<'dark' | 'light' | undefined>((resolve) => {
    let settled = false;
    let accumulated = '';

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      // Restore stdin to paused (non-flowing) mode — .on('data') switched it
      // to flowing, and leaving it flowing could cause data loss before ink
      // attaches its own listeners.
      stdin.pause();
      try {
        stdin.setRawMode(wasRaw ?? false);
      } catch {
        // stdin may have been destroyed
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, timeoutMs);

    const onData = (data: Buffer) => {
      accumulated += data.toString();

      // Response: \x1b]11;rgb:RRRR/GGGG/BBBB\x07  (or \x1b\\ as ST)
      const match = accumulated.match(
        // eslint-disable-next-line no-control-regex
        /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/,
      );
      if (match) {
        cleanup();
        const [, rHex, gHex, bHex] = match;
        resolve(isLightBackground(rHex!, gHex!, bHex!) ? 'light' : 'dark');
      }
    };

    try {
      stdin.setRawMode(true);
    } catch {
      // If we can't set raw mode, give up on OSC 11.
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
      return;
    }

    stdin.on('data', onData);

    // Send OSC 11 query: "\x1b]11;?\x07"
    stdout.write('\x1b]11;?\x07');
  });
}

/**
 * Determines if the background is light from hex color components.
 * X11 rgb: format allows 1–4 hex digits per channel; the max value
 * for N digits is (16^N - 1), e.g. 1-digit → 0xF, 4-digit → 0xFFFF.
 *
 * Per the X11 spec all three channels use the same precision, so we
 * derive maxVal from rHex.length. If a malformed response has mixed
 * lengths we use the longest channel to avoid division overflow.
 */
function isLightBackground(rHex: string, gHex: string, bHex: string): boolean {
  const hexLen = Math.max(rHex.length, gHex.length, bHex.length);
  const maxVal = (1 << (4 * hexLen)) - 1;
  const r = parseInt(rHex, 16);
  const g = parseInt(gHex, 16);
  const b = parseInt(bHex, 16);
  // Relative luminance (ITU-R BT.709).
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / maxVal;
  return luminance > 0.5;
}

/**
 * Parses the COLORFGBG environment variable.
 * Format: "fg;bg" where fg/bg are ANSI color indices (0-15).
 * Some terminals use "fg;extra;bg" — we always take the last component.
 */
export function parseColorFGBG(value: string): 'dark' | 'light' | undefined {
  const parts = value.split(';');
  const bgStr = parts[parts.length - 1];
  if (!bgStr) return undefined;
  const bg = parseInt(bgStr, 10);
  if (isNaN(bg) || bg < 0 || bg > 15) return undefined;
  return DARK_BG_INDICES.has(bg) ? 'dark' : 'light';
}
