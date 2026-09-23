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

const SELECTION_BG = '\u001B[48;5;240m';
let current: Instance | undefined;

afterEach(async () => {
  if (current) {
    await act(async () => current!.unmount());
    current = undefined;
  }
  mocks.mouseHandler = undefined;
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
    const stdout = Object.create(process.stdout, {
      columns: { value: 80 },
      rows: { value: 24 },
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
});
