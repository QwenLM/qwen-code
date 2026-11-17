/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useState } from 'react';
import { Box, render, Text, type Instance } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from '../utils/mouse.js';
import { TextSelectionController } from './use-text-selection.js';
import { BaseTextInput } from '../components/BaseTextInput.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { copyToClipboard } from '../utils/commandUtils.js';

const mocks = vi.hoisted(() => ({
  mouseHandler: undefined as ((event: MouseEvent) => void) | undefined,
}));

vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: (handler: (event: MouseEvent) => void) => {
    mocks.mouseHandler = handler;
  },
}));

vi.mock('../utils/commandUtils.js', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));

const SELECTION_BG = '\u001B[48;5;240m';
let current: Instance | undefined;

const createStdout = (writes: string[], columns = 80, rows = 24) =>
  Object.create(process.stdout, {
    columns: { value: columns },
    rows: { value: rows },
    isTTY: { value: true },
    write: {
      value(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ) {
        writes.push(String(chunk));
        const done =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : callback;
        done?.();
        return true;
      },
    },
  }) as NodeJS.WriteStream;

afterEach(async () => {
  if (current) {
    await act(async () => current!.unmount());
    current = undefined;
  }
  mocks.mouseHandler = undefined;
  vi.mocked(copyToClipboard).mockClear();
});

const mouseEvent = (
  name: MouseEvent['name'],
  col: number,
  row: number,
): MouseEvent => ({
  name,
  col,
  row,
  shift: false,
  meta: false,
  ctrl: false,
  button: 'left',
});

describe('TextSelectionController render invalidation', () => {
  it('publishes a repaint without stale highlight after footer content changes', async () => {
    const writes: string[] = [];
    const stdout = createStdout(writes);
    let updateFooter!: () => void;

    function Harness() {
      const [footer, setFooter] = useState('status');
      updateFooter = () => setFooter('footer');
      return (
        <Box flexDirection="column">
          <Text>hello</Text>
          <Text>{footer}</Text>
          <TextSelectionController
            isActive
            getViewportRect={() => ({ x: 0, y: 0, width: 5, height: 1 })}
            getAdditionalSelectableRects={() => [
              { x: 0, y: 1, width: 6, height: 1 },
            ]}
            getScrollState={() => ({
              scrollTop: 0,
              scrollHeight: 1,
              innerHeight: 1,
            })}
            hitTestScrollbar={() => false}
          />
        </Box>
      );
    }

    let app!: Instance;
    await act(async () => {
      app = render(<Harness />, {
        stdout,
        interactive: true,
        incrementalRendering: false,
        maxFps: 30,
        patchConsole: false,
      });
      current = app;
    });
    await app.waitUntilRenderFlush();

    await act(async () => {
      mocks.mouseHandler!(mouseEvent('left-press', 1, 2));
      mocks.mouseHandler!(mouseEvent('left-release', 6, 2));
    });
    await app.waitUntilRenderFlush();
    expect(writes.some((write) => write.includes(SELECTION_BG))).toBe(true);
    writes.length = 0;

    await act(async () => {
      updateFooter();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await app.waitUntilRenderFlush();

    const footerWrites = writes.filter((write) => write.includes('footer'));
    expect(footerWrites.length).toBeGreaterThan(0);
    expect(footerWrites.at(-1)).not.toContain(SELECTION_BG);
  });

  it('highlights and copies narrow CJK input across soft wraps and a real newline', async () => {
    const writes: string[] = [];
    const stdout = createStdout(writes, 10, 10);
    const moveToOffset = vi.fn();
    const buffer = {
      text: 'ab中文cd\nnext',
      lines: ['ab中文cd', 'next'],
      allVisualLines: ['ab中', '文cd', 'next'],
      viewportVisualLines: ['ab中', '文cd', 'next'],
      visualToLogicalMap: [
        [0, 0],
        [0, 3],
        [1, 0],
      ],
      visualCursor: [0, 0],
      visualScrollRow: 0,
      moveToOffset,
    } as unknown as TextBuffer;
    await act(async () => {
      current = render(
        <BaseTextInput
          buffer={buffer}
          onSubmit={vi.fn()}
          mouseEnabled
          showCursor={false}
        />,
        {
          stdout,
          interactive: true,
          incrementalRendering: false,
          maxFps: 30,
          patchConsole: false,
        },
      );
    });
    await current!.waitUntilRenderFlush();
    await act(async () => {
      mocks.mouseHandler!(mouseEvent('left-press', 7, 2));
      mocks.mouseHandler!(mouseEvent('move', 8, 4));
      mocks.mouseHandler!(mouseEvent('left-release', 8, 4));
    });
    await current!.waitUntilRenderFlush();
    expect(copyToClipboard).toHaveBeenLastCalledWith('中文cd\nnext');
    expect(writes.some((write) => write.includes(SELECTION_BG))).toBe(true);
    expect(moveToOffset).not.toHaveBeenCalled();
  });
});
