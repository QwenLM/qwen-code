/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Box, Text, Transform } from 'ink';
import { render } from 'ink-testing-library';
import xterm from '@xterm/headless';
import { getScreenBuffer } from './screen-buffer.js';
import { getSelectedText } from './selection-text.js';

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

  it.each([
    ['RGB', '\u001b[48;2;36;36;36m', 0x242424],
    ['palette', '\u001b[48;5;236m', 236],
    ['ANSI', '\u001b[44m', 4],
    ['default', '', -1],
  ])(
    'restores the %s background outside a serialized selection',
    async (_name, background, color) => {
      const link = '\u001b]8;;https://example.com\u0007';
      current = render(
        <Text>{`${background}\u001b[38;2;120;180;240m\u001b[2m\u001b[7m${link}ABCDEFGHIJ\u001b]8;;\u0007\u001b[27m\u001b[22m\u001b[39m\u001b[49m`}</Text>,
      );
      const buffer = getScreenBuffer(
        current.stdout as unknown as NodeJS.WriteStream,
      )!;
      buffer.setSelection({ sx: 2, sy: 0, ex: 4, ey: 0 });
      const output = current.lastFrame()!;
      const terminal = new xterm.Terminal({
        cols: 100,
        rows: 2,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => terminal.write(output, resolve));
        for (let x = 0; x < 10; x++) {
          const cell = terminal.buffer.active.getLine(0)!.getCell(x)!;
          expect(cell.getBgColor(), `background at column ${x}`).toBe(
            x >= 2 && x <= 4 ? 240 : color,
          );
          expect(cell.getFgColor()).toBe(0x78b4f0);
          expect(cell.isDim()).not.toBe(0);
          expect(cell.isInverse()).not.toBe(0);
        }
        expect(buffer.frame!.cells[0][2].styles).toContainEqual(
          expect.objectContaining({ code: link }),
        );
        expect(
          getSelectedText(buffer.frame!, { sx: 2, sy: 0, ex: 4, ey: 0 }),
        ).toBe('CDE');

        buffer.setSelection(null);
        await new Promise<void>((resolve) =>
          terminal.write(`\r${current!.lastFrame()!}`, resolve),
        );
        for (let x = 0; x < 10; x++) {
          expect(
            terminal.buffer.active.getLine(0)!.getCell(x)!.getBgColor(),
          ).toBe(color);
        }
      } finally {
        terminal.dispose();
      }
    },
  );

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

  it('does not copy or highlight box borders and background decoration', () => {
    current = render(
      <Box
        width={8}
        borderStyle="round"
        backgroundColor="blue"
        flexDirection="column"
      >
        <Text>{'AB│D\nEFGH'}</Text>
      </Box>,
    );
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;
    buffer.setSelection({ sx: 0, sy: 0, ex: 7, ey: 3 });
    const frame = buffer.frame!;

    expect(frame.cells[0].every((cell) => !cell.selectable)).toBe(true);
    expect(frame.cells[1][0].selectable).toBe(false);
    expect(frame.cells[1][7].selectable).toBe(false);
    expect(frame.cells[0][0].styles).not.toContainEqual(
      expect.objectContaining({ code: SELECTION_BG }),
    );
    expect(frame.cells[1][0].styles).not.toContainEqual(
      expect.objectContaining({ code: SELECTION_BG }),
    );
    expect(frame.cells[1][1].styles).toContainEqual(
      expect.objectContaining({ code: SELECTION_BG }),
    );
    expect(getSelectedText(frame, { sx: 0, sy: 1, ex: 7, ey: 2 })).toBe(
      'AB│D\nEFGH',
    );
  });

  it('clips multiline highlights to the selection owner bounds', () => {
    current = render(<Text>{'abcdefghij\nklmnopqrst\nuvwxyzABCD'}</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;
    const selection = {
      sx: 3,
      sy: 0,
      ex: 4,
      ey: 2,
      bounds: { x: 2, y: 0, width: 4, height: 3 },
    };
    buffer.setSelection(selection);
    const frame = buffer.frame!;

    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 10; x++) {
        const selected = x >= (y === 0 ? 3 : 2) && x <= (y === 2 ? 4 : 5);
        if (selected) {
          expect(frame.cells[y][x].styles).toContainEqual(
            expect.objectContaining({ code: SELECTION_BG }),
          );
        } else {
          expect(frame.cells[y][x].styles).not.toContainEqual(
            expect.objectContaining({ code: SELECTION_BG }),
          );
        }
      }
    }
    buffer.setSelection({
      ...selection,
      bounds: { ...selection.bounds, y: 1, height: 1 },
    });
    for (const y of [0, 2]) {
      expect(
        buffer.frame!.cells[y].flatMap((cell) => cell.styles),
      ).not.toContainEqual(expect.objectContaining({ code: SELECTION_BG }));
    }
  });

  it('repaints when only selection bounds change and deduplicates equal bounds', () => {
    current = render(<Text>{'abcdefghij\nklmnopqrst\nuvwxyzABCD'}</Text>);
    const buffer = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!;
    const selection = { sx: 0, sy: 0, ex: 9, ey: 2 };
    buffer.setSelection(selection);
    let publishes = 0;
    buffer.subscribe(() => publishes++);
    const bounds = { x: 1, y: 0, width: 2, height: 1 };
    buffer.setSelection({ ...selection, bounds });
    expect(publishes).toBe(1);
    buffer.setSelection({ ...selection, bounds: { ...bounds } });
    expect(publishes).toBe(1);
    for (const [index, changed] of [
      { x: 2, y: 0, width: 2, height: 1 },
      { x: 2, y: 1, width: 2, height: 1 },
      { x: 2, y: 1, width: 3, height: 1 },
      { x: 2, y: 1, width: 3, height: 2 },
    ].entries()) {
      buffer.setSelection({ ...selection, bounds: changed });
      expect(publishes).toBe(index + 2);
    }
    buffer.setSelection(selection);
    expect(publishes).toBe(6);
  });

  it('publishes soft boundaries and preserves omitted whitespace', () => {
    current = render(
      <Box width={5}>
        <Text>hello world</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      frame.cells.map((row) =>
        row
          .map((cell) => cell.value)
          .join('')
          .trimEnd(),
      ),
    ).toEqual(['hello', '', 'world']);
    expect(frame.cells[1].every((cell) => !cell.selectable)).toBe(true);
    expect(frame.boundaries[0].find(Boolean)).toMatchObject({
      kind: 'soft',
      joiner: ' ',
    });
    expect(frame.boundaries[1].find(Boolean)).toMatchObject({
      kind: 'soft',
      joiner: '',
    });
    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe('hello world');
  });

  it.each([
    ['multiple spaces', 'hello  world'],
    ['a tab', 'hello\tworld'],
  ])('preserves %s across a direct Ink word wrap', (_name, source) => {
    current = render(
      <Box width={5}>
        <Text>{source}</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe(source);
  });

  it.each([
    ['leading indentation', '   hello'],
    ['whitespace-only content', '   '],
  ])('preserves wrapped %s', (_name, source) => {
    current = render(
      <Box width={2}>
        <Text>{source}</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe(source);
  });

  it('keeps renderer background fill out of selected text', () => {
    current = render(
      <Box width={5} backgroundColor="blue">
        <Text>hi</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe('hi');
  });

  it('distinguishes explicit hard newlines from exact-width wraps', () => {
    current = render(
      <Box width={5}>
        <Text>{'hello\nworld'}</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(frame.boundaries[0].find(Boolean)).toMatchObject({
      kind: 'hard',
      joiner: '\n',
    });
    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe('hello\nworld');
  });

  it('preserves empty and whitespace-only hard lines', () => {
    const source = 'alpha\n\n   \nomega';
    current = render(<Text>{source}</Text>);
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe(source);
  });

  it('rejoins styled CJK and emoji text without duplicating wide cells', () => {
    const source = '你好 世界🙂';
    current = render(
      <Box width={5}>
        <Text color="cyan">{source}</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe(source);
  });

  it('keeps a newline when sibling flows make a boundary ambiguous', () => {
    current = render(
      <Box flexDirection="column">
        <Box>
          <Text selectionFlow="a" selectionBreakAfter="soft">
            A
          </Text>
          <Text selectionFlow="b" selectionBreakAfter="soft">
            B
          </Text>
        </Box>
        <Box>
          <Text selectionFlow="a">C</Text>
          <Text selectionFlow="b">D</Text>
        </Box>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe('AB\nCD');
  });

  it('clears a boundary claim when a later write overlaps it', () => {
    current = render(
      <Box width={3} height={1}>
        <Text selectionBreakAfter="soft">abc</Text>
        <Box position="absolute">
          <Text selectable={false}>xyz</Text>
        </Box>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      frame.cells[0]
        .map((cell) => cell.value)
        .join('')
        .trimEnd(),
    ).toBe('xyz');
    expect(frame.boundaries[0].every((claim) => claim === null)).toBe(true);
  });

  it('does not publish a boundary outside a clipping rectangle', () => {
    current = render(
      <Box width={3} height={1} overflow="hidden">
        <Box position="absolute" marginLeft={3}>
          <Text selectionBreakAfter="soft">abc</Text>
        </Box>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(frame.boundaries[0].every((claim) => claim === null)).toBe(true);
  });

  it('covers visible text after left clipping with boundary claims', () => {
    current = render(
      <Box width={3} height={2} flexDirection="column">
        <Box width={3} height={1} overflow="hidden">
          <Box position="absolute" marginLeft={-2}>
            <Text
              selectionFlow="flow"
              selectionBreakAfter="soft"
              selectionJoiner=" "
            >
              abcde
            </Text>
          </Box>
          <Box position="absolute">
            <Text selectable={false}>X</Text>
          </Box>
        </Box>
        <Text selectionFlow="flow">fgh</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(frame.boundaries[0].slice(0, 3).map(Boolean)).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      getSelectedText(frame, {
        sx: 0,
        sy: 0,
        ex: frame.width - 1,
        ey: frame.height - 1,
      }),
    ).toBe('de fgh');
  });

  it.each([
    ['ASCII', '01abcdef\n02uvwxyz', 'abcd\nuvwx'],
    ['CJK', '01甲乙丙丁\n02戊己庚辛', '甲乙\n戊己'],
    [
      'styled',
      '01\u001b[31mabcdef\u001b[39m\n02\u001b[32muvwxyz\u001b[39m',
      'abcd\nuvwx',
    ],
  ])('preserves %s cells when clipping all four edges', (name, rows, text) => {
    current = render(
      <Box width={4} height={2} overflow="hidden">
        <Box width={10} flexShrink={0} marginLeft={-2} marginTop={-1}>
          <Text>{`above\n${rows}\nbelow`}</Text>
        </Box>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(
      frame.cells.map((row) =>
        row
          .slice(0, 4)
          .map((cell) => cell.value)
          .join(''),
      ),
    ).toEqual(text.split('\n'));
    expect(getSelectedText(frame, { sx: 0, sy: 0, ex: 3, ey: 1 })).toBe(text);
    expect(frame.boundaries[0].find(Boolean)).toMatchObject({
      kind: 'hard',
      joiner: '\n',
      selectable: true,
    });
    if (name === 'CJK') {
      expect(frame.cells[0][0].fullWidth).toBe(true);
      expect(frame.cells[0][1].value).toBe('');
    }
    if (name === 'styled') {
      expect(frame.cells[0][0].styles).toContainEqual({
        type: 'ansi',
        code: '\u001b[31m',
        endCode: '\u001b[39m',
      });
      expect(frame.cells[1][0].styles).toContainEqual({
        type: 'ansi',
        code: '\u001b[32m',
        endCode: '\u001b[39m',
      });
    }
  });

  it('keeps source boundaries and selectable rows after vertical and horizontal clipping', () => {
    current = render(
      <Box width={3} height={3} overflow="hidden">
        <Box width={5} flexShrink={0} marginLeft={-1} marginTop={-1}>
          <Text>{'above\nhello world\nbelow'}</Text>
        </Box>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(frame.cells[1].every((cell) => !cell.selectable)).toBe(true);
    expect(frame.boundaries[0].find(Boolean)).toMatchObject({
      kind: 'soft',
      joiner: ' ',
    });
    expect(frame.boundaries[2].find(Boolean)).toMatchObject({
      kind: 'hard',
      joiner: '\n',
    });
    expect(getSelectedText(frame, { sx: 0, sy: 0, ex: 2, ey: 2 })).toBe(
      'ell orl',
    );
  });

  it('passes clipped lines and viewport-relative indexes to transformers', () => {
    const transform = vi.fn(
      (line: string, index: number) => `${index}${line.slice(1)}`,
    );
    current = render(
      <Box width={4} height={2} overflow="hidden">
        <Box width={10} flexShrink={0} marginLeft={-2} marginTop={-1}>
          <Transform transform={transform}>
            {'above\n01abcdef\n02uvwxyz\nbelow'}
          </Transform>
        </Box>
      </Box>,
    );

    expect(current.lastFrame()).toBe('0bcd\n1vwx');
    expect(transform.mock.calls).toEqual([
      ['abcd', 0],
      ['uvwx', 1],
    ]);
  });

  it('limits boundary claims to the rendered text width', () => {
    current = render(
      <Box width={5}>
        <Text selectionBreakAfter="soft">hi</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(frame.boundaries[0].filter(Boolean)).toHaveLength(2);
  });

  it('propagates selectability and producer-supplied boundaries', () => {
    current = render(
      <Box flexDirection="column">
        <Text
          selectionFlow="flow"
          selectionBreakAfter="soft"
          selectionJoiner=" "
        >
          hello
        </Text>
        <Text selectionFlow="flow">world</Text>
        <Text selectable={false}> gutter</Text>
      </Box>,
    );
    const frame = getScreenBuffer(
      current.stdout as unknown as NodeJS.WriteStream,
    )!.frame!;

    expect(frame.boundaries[0].find(Boolean)).toMatchObject({
      kind: 'soft',
      joiner: ' ',
    });
    expect(frame.cells[0][0].flowId).toBe(frame.cells[1][0].flowId);
    expect(frame.cells[2].every((cell) => !cell.selectable)).toBe(true);
  });
});
