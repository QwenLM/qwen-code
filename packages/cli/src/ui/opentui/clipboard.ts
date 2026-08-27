/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Clipboard write: OSC 52 (terminal-native) + platform fallback spawn. */
import { copyToClipboard } from '../utils/commandUtils.js';

/**
 * OSC 52 sequence for `text`, adapted to the surrounding multiplexer
 * (opencode writeOsc52 parity). Under tmux both the bare sequence and the
 * `\x1bPtmux;` DCS passthrough are emitted: tmux relays a bare app OSC 52
 * only with set-clipboard=on (the default external drops it) and relays
 * the passthrough only with allow-passthrough=on (default off), so each
 * form covers one opt-in (verified on tmux 3.6a). GNU screen swallows a
 * bare OSC 52 and its DCS passthrough forwards the payload verbatim
 * (verified on screen 4.00.03), so the OSC is wrapped raw in a plain DCS —
 * the tmux-only `tmux;` tag would reach the outer terminal as literal
 * text.
 */
export function osc52Sequence(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const sequence = `\x1b]52;c;${b64}\x07`;
  if (env['TMUX']) {
    return sequence + `\x1bPtmux;\x1b${sequence}\x1b\\`;
  }
  if (env['STY']) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
}

// Same cap as ink's writeOsc52: iTerm2 caps at ~100KB base64, xterm ~8KB;
// 75KB utf-8 is ~100KB base64. Larger payloads skip OSC 52 and rely on the
// platform command.
const MAX_OSC52_BYTES = 75_000;

/**
 * Write text to the system clipboard.
 * OSC 52 first (works inside alternate screen when the terminal honors it),
 * platform command as reliable fallback. Never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  // Warp blocks OSC 52 by default and shows a scary security banner; skip it there.
  const isWarp =
    /warp/i.test(process.env['TERM_PROGRAM'] ?? '') ||
    /warp/i.test(process.env['TERMINAL_EMULATOR'] ?? '');
  if (!isWarp && Buffer.byteLength(text, 'utf8') <= MAX_OSC52_BYTES) {
    try {
      process.stdout.write(osc52Sequence(text));
    } catch {
      /* ignore */
    }
  }
  try {
    await copyToClipboard(text);
    return true;
  } catch {
    return false;
  }
}
