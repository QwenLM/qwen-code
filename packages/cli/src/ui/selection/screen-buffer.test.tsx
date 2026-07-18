/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { getScreenBuffer } from './screen-buffer.js';

/** The background escape the patched renderer appends to selected cells. */
const SELECTION_BG = '[48;5;240m';

type Rendered = ReturnType<typeof render>;

let current: Rendered | undefined;

afterEach(() => {
  current?.unmount();
  current = undefined;
});

describe('ScreenBuffer (Ink frame-controller M0)', () => {
  it('exposes the composited frame as addressable cells', () => {
    current = render(<Text>hello 中文</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    );

    expect(buffer).toBeDefined();
    expect(buffer!.dimensions.height).toBeGreaterThan(0);
    expect(buffer!.lineText(0)).toBe('hello 中文');
    expect(buffer!.getCellAt(0, 0)?.value).toBe('h');
  });

  it('handles wide characters with a leading cell and a spacer', () => {
    current = render(<Text>hello 中文</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;

    // "hello " occupies columns 0-5; the first wide glyph starts at column 6.
    const wide = buffer.getCellAt(6, 0);
    expect(wide?.value).toBe('中');
    expect(wide?.fullWidth).toBe(true);
    // The trailing half of a wide glyph is an empty spacer cell.
    expect(buffer.getCellAt(7, 0)?.value).toBe('');
  });

  it('highlights the selected range before serialization and clears it', () => {
    current = render(<Text>hello world</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;

    expect(current.lastFrame()).not.toContain(SELECTION_BG);

    buffer.setSelection({ sx: 0, sy: 0, ex: 4, ey: 0 });
    expect(current.lastFrame()).toContain(SELECTION_BG);

    buffer.setSelection(null);
    expect(current.lastFrame()).not.toContain(SELECTION_BG);
  });

  it('does not leak the highlight onto identical text elsewhere on screen', () => {
    // "abc" appears twice; selecting the first must not highlight the second.
    current = render(<Text>abc{'\n'}abc</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;

    buffer.setSelection({ sx: 0, sy: 0, ex: 2, ey: 0 });
    const frame = current.lastFrame() ?? '';
    const [firstLine, secondLine] = frame.split('\n');

    expect(firstLine).toContain(SELECTION_BG);
    expect(secondLine).not.toContain(SELECTION_BG);
  });

  it('publishes exactly one frame per distinct selection change (no loop, deduped)', () => {
    current = render(<Text>hello world</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;

    let publishes = 0;
    buffer.subscribe(() => {
      publishes++;
    });

    buffer.setSelection({ sx: 0, sy: 0, ex: 2, ey: 0 });
    expect(publishes).toBe(1);

    // Identical selection is deduplicated: no extra render.
    buffer.setSelection({ sx: 0, sy: 0, ex: 2, ey: 0 });
    expect(publishes).toBe(1);

    // A different selection renders once more.
    buffer.setSelection({ sx: 0, sy: 0, ex: 4, ey: 0 });
    expect(publishes).toBe(2);
  });
});
