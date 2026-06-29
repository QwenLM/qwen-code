/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regex constants shared with banner customization (`packages/cli/src/ui/
 * utils/customBanner.ts`) so the OSC / CSI / SS2 / SS3 patterns are
 * authored once and stay aligned across call sites. Exported via
 * `@qwen-code/qwen-code-core` so the CLI sanitizer can re-use them when
 * it has to preserve `\n` (which `stripTerminalControlSequences` strips).
 */
/* eslint-disable no-control-regex */
/** OSC: `ESC ]` followed by any non-BEL/non-ESC bytes terminated by BEL or `ESC \`. */
export const TERMINAL_OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** CSI: `ESC [` parameters then a final letter (cursor / color / erase family). */
export const TERMINAL_CSI_REGEX = /\x1b\[[\d;?]*[a-zA-Z]/g;
/** SS2 / SS3 / DCS leader bytes after ESC. */
export const TERMINAL_SHIFT_DCS_REGEX = /\x1b[NOP]/g;
/* eslint-enable no-control-regex */

/**
 * Strip the terminal control sequences from arbitrary text so the result can
 * safely render in a TTY without painting cursor moves, clearing the screen,
 * or injecting OSC-8 hyperlinks.
 *
 * Covers:
 * - OSC sequences (`\x1b]...\x07` or `\x1b]...\x1b\\`) — handled as whole
 *   units so the ST/BEL terminator is also stripped.
 * - CSI sequences (`\x1b[...<letter>`) — the common "cursor/color/erase"
 *   family.
 * - SS2/SS3 / DCS leaders (`\x1b[NOP]`).
 * - Any remaining C0 controls + DEL + C1 controls (`0x80-0x9F`, e.g.
 *   single-byte CSI `0x9B`, DCS `0x90`, ST `0x9C`), flattened to a space.
 *   This backstop means a bare `\x1b` that wasn't part of a recognized
 *   sequence still can't execute — and 8-bit terminals can't interpret
 *   the C1 codes that some legacy shells still honor.
 *
 * Used for LLM-returned text that ends up in the session picker (titles);
 * without this, a compromised or prompt-injected fast model could paint on
 * the user's terminal on every render.
 */
export function stripTerminalControlSequences(s: string): string {
  return (
    s
      .replace(TERMINAL_OSC_REGEX, ' ')
      .replace(TERMINAL_CSI_REGEX, ' ')
      .replace(TERMINAL_SHIFT_DCS_REGEX, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  );
}

/**
 * Strip C0 control characters (except TAB), C1 control characters, and
 * Unicode bidirectional override / isolate characters from a string
 * destined for terminal/UI display.
 *
 * Unlike {@link stripTerminalControlSequences}, this preserves TAB and
 * deletes (rather than substitutes with a space) the stripped bytes —
 * it is intended for compact, single-line notification surfaces (shell
 * status lines, monitor event lines) where the original whitespace
 * shape matters and substitutions would clutter the display.
 *
 * Stripped ranges:
 * - `\u0000-\u001f` C0 controls except `\u0009` TAB (NUL, BEL, BS, ESC,
 *   `\n`, `\r`, …).
 * - `\u007f` DEL is *kept* (it is not a control here).
 * - `\u0080-\u009f` C1 controls (single-byte CSI `0x9B`, DCS `0x90`,
 *   ST `0x9C`, NEL `0x85`, …).
 * - `\u202a-\u202e` LRE / RLE / PDF / LRO / RLO — embedding & override.
 * - `\u2066-\u2069` LRI / RLI / FSI / PDI — isolates.
 *
 * The bidi stripping defends against "Trojan Source"-style attacks
 * (CVE-2021-42574) where shell or monitor output containing bidi
 * controls reorders adjacent text in renderers that honor them — even
 * after C0/C1 escape codes have already been removed. Both background
 * notification surfaces (BackgroundShellRegistry and MonitorRegistry)
 * feed the same Session notification queue, so they must apply the
 * same defense.
 */
export function stripDisplayControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09) {
      out += text[i];
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += text[i];
  }
  return out;
}
