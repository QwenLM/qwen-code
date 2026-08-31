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

/**
 * Write text to the system clipboard.
 * Never throws.
 *
 * copyText delegates to copyToClipboard — the existing utility already
 * has the TTY gate, the OSC 52 fallback (via writeOsc52 / wrapForMultiplexer),
 * and the platform command path. A self-written OSC 52 here would
 * double-emit on the no-xclip Linux/SSH path exactly this feature targets.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await copyToClipboard(text);
    return true;
  } catch {
    return false;
  }
}
