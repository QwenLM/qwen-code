/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  bufferRowToMouseGridRow,
  MultiClickSelectionController,
  type MultiClickPointer,
  type SelectionHost,
} from './multi-click-select.js';
import type { CellGrid } from './link-click.js';

function gridFromRows(rows: string[]): CellGrid {
  const width = Math.max(...rows.map((r) => r.length), 1);
  const char = new Uint32Array(width * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      char[y * width + x] = row.codePointAt(x) ?? 0;
    }
  });
  return { buffers: { char }, width, height: rows.length };
}

/**
 * Native-buffer simulation (zig-backed OptimizedBuffer): `char` holds
 * flag-tagged sentinels (not code points) and text resolves through
 * `getRealCharBytes`. Regression: decoding sentinels directly crashed with
 * a code-point RangeError, silently killing double-click selection.
 */
function nativeGridFromLines(lines: string[]): CellGrid {
  const isWide = (cp: number) =>
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    cp > 0xffff;
  const width = Math.max(
    ...lines.map((l) =>
      [...l].reduce((w, ch) => w + (isWide(ch.codePointAt(0)!) ? 2 : 1), 0),
    ),
    1,
  );
  const char = new Uint32Array(width * lines.length).fill(0x800100ff);
  lines.forEach((line, y) => {
    let x = 0;
    for (const ch of line) {
      if (isWide(ch.codePointAt(0)!)) {
        char[y * width + x + 1] = 0xc0000001; // wide-char continuation
      }
      x += isWide(ch.codePointAt(0)!) ? 2 : 1;
    }
  });
  return {
    buffers: { char },
    width,
    height: lines.length,
    getRealCharBytes: (addLineBreaks = true) =>
      new TextEncoder().encode(
        addLineBreaks ? lines.join('\n') : lines.join(''),
      ),
  };
}

function down(
  x: number,
  y: number,
  opts?: { ctrl?: boolean; button?: number; target?: boolean },
): MultiClickPointer {
  return {
    x,
    y,
    button: opts?.button ?? 0,
    modifiers: { ctrl: opts?.ctrl ?? false },
    target: { selectable: opts?.target ?? true },
  };
}

/**
 * Host stub that mirrors the framework's selection semantics: `startSelection`
 * (re)anchors, `updateSelection` moves only the focus — so `bounds()` is what
 * the user actually sees selected.
 */
function makeHost(initial: { isDragging: boolean } | null) {
  const calls: string[] = [];
  let hasSelection = initial !== null;
  let isDragging = initial?.isDragging ?? false;
  let anchor: { x: number; y: number } | null = null;
  let focus: { x: number; y: number } | null = null;
  const host: SelectionHost = {
    getSelection: () => (hasSelection ? { isDragging } : null),
    startSelection: (_renderable, x, y) => {
      calls.push(`start:${x},${y}`);
      hasSelection = true;
      isDragging = true;
      anchor = { x, y };
      focus = { x, y };
    },
    updateSelection: (_renderable, x, y) => {
      calls.push(`update:${x},${y}`);
      focus = { x, y };
    },
  };
  const bounds = () =>
    anchor && focus
      ? {
          sx: Math.min(anchor.x, focus.x),
          ex: Math.max(anchor.x, focus.x),
          sy: Math.min(anchor.y, focus.y),
          ey: Math.max(anchor.y, focus.y),
        }
      : null;
  return { host, calls, bounds };
}

describe('bufferRowToMouseGridRow', () => {
  it('maps characters and zero cells (spacer semantics)', () => {
    // '文' base cell, spacer, untouched run, then 'h'.
    const grid: CellGrid = {
      buffers: { char: Uint32Array.from([0x6587, 0, 0, 0x68]) },
      width: 4,
      height: 1,
    };
    const row = bufferRowToMouseGridRow(grid, 0)!;
    expect(row.map((c) => c.value)).toEqual(['文', '', '', 'h']);
  });

  it('returns null for out-of-range rows', () => {
    const grid = gridFromRows(['ab']);
    expect(bufferRowToMouseGridRow(grid, -1)).toBeNull();
    expect(bufferRowToMouseGridRow(grid, 1)).toBeNull();
  });

  it('decodes native flag-tagged cells through getRealCharBytes', () => {
    // Row 0 '文 h' inside a 5-wide grid (row 1 is wider): '文' occupies
    // columns 0-1 (the continuation is a spacer cell), and the untouched
    // tail column decodes as a space on native grids.
    const grid = nativeGridFromLines(['文 h', 'abcde']);
    const row = bufferRowToMouseGridRow(grid, 0)!;
    expect(row.map((c) => c.value)).toEqual(['文', '', ' ', 'h', ' ']);
  });
});

describe('MultiClickSelectionController', () => {
  it('leaves single clicks to the framework', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar baz']),
      host,
    );
    c.handleMouseDown(down(5, 0), 0);
    expect(calls).toEqual([]);
  });

  it('rewrites the selection to the word span on a double click', () => {
    const { host, calls, bounds } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar baz']),
      host,
    );
    c.handleMouseDown(down(5, 0), 0);
    c.handleMouseDown(down(5, 0), 100);
    // 'bar' occupies columns 4-6; the press at column 5 is mid-word.
    expect(bounds()).toEqual({ sx: 4, ex: 6, sy: 0, ey: 0 });
    expect(calls).toEqual(['start:4,0', 'update:6,0']);
  });

  it('rewrites the word span on a native (flag-tagged) buffer', () => {
    const { host, bounds } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => nativeGridFromLines(['文 bar baz']),
      host,
    );
    // Double-click the trailing 'r' of 'bar' (the wide '文' shifts it to
    // columns 3-5); before the decode fix this threw a RangeError inside
    // the handler and the selection never changed.
    c.handleMouseDown(down(5, 0), 0);
    c.handleMouseDown(down(5, 0), 100);
    expect(bounds()).toEqual({ sx: 3, ex: 5, sy: 0, ey: 0 });
  });

  it('selects the whole word when the press is on the word end', () => {
    const { host, bounds } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar baz']),
      host,
    );
    // Pressing the last column of 'bar' must not clip to a single cell.
    c.handleMouseDown(down(6, 0), 0);
    c.handleMouseDown(down(6, 0), 100);
    expect(bounds()).toEqual({ sx: 4, ex: 6, sy: 0, ey: 0 });
  });

  it('upgrades the selection from word to line span across clicks', () => {
    const { host, bounds } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['  hello world  ']),
      host,
    );
    c.handleMouseDown(down(3, 0), 0);
    c.handleMouseDown(down(3, 0), 100);
    // 2nd click selects the word under the press ('hello', columns 2-6).
    expect(bounds()).toEqual({ sx: 2, ex: 6, sy: 0, ey: 0 });
    c.handleMouseDown(down(3, 0), 200);
    // 3rd click upgrades the same selection to the whole line (0 through the
    // last non-blank column), regardless of where the press landed.
    expect(bounds()).toEqual({ sx: 0, ex: 12, sy: 0, ey: 0 });
  });

  it('does nothing when the second click lands on whitespace', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows([' foo']),
      host,
    );
    c.handleMouseDown(down(0, 0), 0);
    c.handleMouseDown(down(0, 0), 100);
    expect(calls).toEqual([]);
  });

  it('does nothing without a framework selection (non-selectable area)', () => {
    const { host, calls } = makeHost(null);
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 0), 0);
    c.handleMouseDown(down(1, 0), 100);
    expect(calls).toEqual([]);
  });

  it('does nothing when a stale selection is not dragging', () => {
    const { host, calls } = makeHost({ isDragging: false });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 0), 0);
    c.handleMouseDown(down(1, 0), 100);
    expect(calls).toEqual([]);
  });

  it('keeps ctrl+down out of the multi-click sequence', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 0, { ctrl: true }), 0);
    c.handleMouseDown(down(1, 0), 100);
    expect(calls).toEqual([]);
  });

  it('ignores non-left buttons', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 0, { button: 1 }), 0);
    c.handleMouseDown(down(1, 0, { button: 1 }), 100);
    expect(calls).toEqual([]);
  });

  it('resets the click count after the 400 ms window', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 0), 0);
    c.handleMouseDown(down(1, 0), 401);
    expect(calls).toEqual([]);
  });

  it('resets the click count when the press moves more than one column', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 0), 0);
    c.handleMouseDown(down(4, 0), 100);
    expect(calls).toEqual([]);
  });

  it('snaps a press on a wide-character spacer onto the base cell', () => {
    // '文' + spacer + space + 'h': clicking the spacer (x=1) selects '文'.
    const grid: CellGrid = {
      buffers: { char: Uint32Array.from([0x6587, 0, 0x20, 0x68]) },
      width: 4,
      height: 1,
    };
    const { host, bounds } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(() => grid, host);
    c.handleMouseDown(down(1, 0), 0);
    c.handleMouseDown(down(1, 0), 100);
    expect(bounds()).toEqual({ sx: 0, ex: 1, sy: 0, ey: 0 });
  });

  it('does nothing when the event carries no target renderable', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown({ ...down(1, 0), target: null }, 0);
    c.handleMouseDown({ ...down(1, 0), target: null }, 100);
    expect(calls).toEqual([]);
  });

  it('does nothing when the rendered buffer is unavailable', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(() => null, host);
    c.handleMouseDown(down(1, 0), 0);
    c.handleMouseDown(down(1, 0), 100);
    expect(calls).toEqual([]);
  });

  it('does nothing when the clicked row is out of range', () => {
    const { host, calls } = makeHost({ isDragging: true });
    const c = new MultiClickSelectionController(
      () => gridFromRows(['foo bar']),
      host,
    );
    c.handleMouseDown(down(1, 5), 0);
    c.handleMouseDown(down(1, 5), 100);
    expect(calls).toEqual([]);
  });
});
