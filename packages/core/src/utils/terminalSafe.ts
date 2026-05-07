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
