/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * - Any remaining C0/C1 control bytes plus DEL, flattened to a space. This
 *   backstop means a bare `\x1b` that wasn't part of a recognized sequence
 *   still can't execute — the terminal only interprets ESC followed by
 *   specific bytes.
 *
 * Used for LLM-returned text that ends up in the session picker (titles);
 * without this, a compromised or prompt-injected fast model could paint on
 * the user's terminal on every render.
 */
export function stripTerminalControlSequences(s: string): string {
  // These regexes deliberately match control characters; the whole point of
  // this module is to neutralize them. The no-control-regex rule is
  // suppressed per-line rather than file-wide so any future additions still
  // opt in explicitly.
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[NOP]/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ')
  );
}
