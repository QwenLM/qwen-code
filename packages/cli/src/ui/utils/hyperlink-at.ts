/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReadonlyFrame } from 'ink';

/**
 * Extract the URI from an OSC 8 hyperlink escape carried in a frame cell's
 * styles. Handles the forms this codebase emits and their multiplexer
 * wrappers:
 *
 * - plain:        `\x1b]8;;URL\x07`            (BEL terminator)
 * - ST variant:   `\x1b]8;;URL\x1b\\`          (some terminals/libs)
 * - C1 ST:        `\x1b]8;;URL\x9c`
 * - tmux/screen:  `\x1bPtmux;\x1b\x1b]8;;URL\x07\x1b\\` (doubled ESC inside
 *                 DCS passthrough)
 *
 * The parser searches for the `]8;` marker rather than anchoring at the
 * string start so DCS wrappers and doubled ESCs don't matter, skips the OSC 8
 * parameter section (up to the first `;` after the marker), and reads the URI
 * up to any C0 control (BEL, ESC-start-of-ST, LF/CR/TAB, …) or C1 ST.
 * Terminating on every C0 control — not just the three legal terminators —
 * keeps a hostile or malformed envelope from smuggling control characters into
 * the extracted URL (legitimate URLs never contain C0, DEL, or C1 controls;
 * the in-house emitter strips them via `sanitizeForOsc` before wrapping).
 */
export function extractUrlFromOsc8Code(code: string): string | undefined {
  const marker = code.indexOf(']8;');
  if (marker === -1) return undefined;
  const paramsEnd = code.indexOf(';', marker + 3);
  if (paramsEnd === -1) return undefined;
  const urlStart = paramsEnd + 1;
  let end = urlStart;
  while (end < code.length) {
    const c = code.charCodeAt(end);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) break;
    end++;
  }
  const url = code.slice(urlStart, end);
  return url.length > 0 ? url : undefined;
}

/**
 * Return the hyperlink URL at a composited-frame cell, or `undefined` when
 * the cell is not inside an OSC 8 link.
 *
 * Ink preserves OSC 8 escapes in per-cell `styles` through compositing (each
 * character inside a link carries the link-open `AnsiCode`), so hit-testing
 * needs no knowledge of markdown, wrapping, or character widths — the frame
 * already resolved all of it. Wide characters are handled by snapping from
 * the trailing spacer half to the leading fullWidth cell, mirroring the
 * selection stack.
 */
export function hyperlinkAtCell(
  frame: ReadonlyFrame | null | undefined,
  x: number,
  y: number,
): string | undefined {
  const row = frame?.cells[y];
  if (!row) return undefined;
  let cell = row[x];
  if (cell && cell.value === '' && x > 0 && row[x - 1]?.fullWidth) {
    cell = row[x - 1];
  }
  if (!cell) return undefined;
  for (const style of cell.styles) {
    if (
      typeof style === 'object' &&
      style !== null &&
      typeof (style as { code?: unknown }).code === 'string'
    ) {
      const url = extractUrlFromOsc8Code((style as { code: string }).code);
      if (url) return url;
    }
  }
  return undefined;
}
