/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { getFrameController, render, Text, type Instance } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mounted = new Set<Instance>();

afterEach(async () => {
  for (const app of mounted) {
    await act(async () => app.unmount());
    await app.waitUntilRenderFlush();
  }
  mounted.clear();
  vi.useRealTimers();
});

async function mount() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  });
  const writes: string[] = [];
  let closed = false;
  const stdout = Object.create(process.stdout, {
    columns: { value: 80 },
    rows: { value: 24 },
    isTTY: { value: true },
    destroyed: { get: () => closed },
    writableEnded: { get: () => closed },
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
  const frames: Array<{ at: number; text: string }> = [];
  let app!: Instance;
  await act(async () => {
    app = render(<Text>initial</Text>, {
      stdout,
      interactive: true,
      concurrent: false,
      maxFps: 60,
      patchConsole: false,
      exitOnCtrlC: false,
      onRender: () => {
        const frame = getFrameController(stdout)?.getFrame();
        frames.push({
          at: performance.now(),
          text:
            frame?.cells
              .map((row) =>
                row
                  .map((cell) => cell.value)
                  .join('')
                  .trimEnd(),
              )
              .join('\n') ?? '',
        });
      },
    });
  });
  mounted.add(app);
  await app.waitUntilRenderFlush();
  frames.length = 0;
  writes.length = 0;
  return { app, frames, writes, close: () => (closed = true) };
}

describe('Ink render cadence', () => {
  it('keeps the earliest deadline and paints the latest committed text', async () => {
    const { app, frames } = await mount();
    vi.advanceTimersByTime(1);
    act(() => app.rerender(<Text>first</Text>));
    vi.advanceTimersByTime(9);
    act(() => app.rerender(<Text>latest</Text>));
    vi.advanceTimersByTime(6);
    expect(frames).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(frames).toEqual([{ at: 17, text: 'latest' }]);

    vi.advanceTimersByTime(1);
    act(() => app.rerender(<Text>next frame</Text>));
    vi.advanceTimersByTime(16);
    expect(frames.at(-1)).toEqual({ at: 34, text: 'next frame' });
    expect(frames).toHaveLength(2);
  });

  it('flushes an explicitly awaited pending frame without leaving a timer', async () => {
    const { app, frames, writes } = await mount();
    vi.advanceTimersByTime(1);
    act(() => app.rerender(<Text>boundary tail</Text>));
    expect(frames).toHaveLength(0);
    await app.waitUntilRenderFlush();
    expect(frames.at(-1)?.text).toBe('boundary tail');
    expect(writes.join('')).toContain('boundary tail');
    const count = frames.length;
    vi.advanceTimersByTime(100);
    expect(frames).toHaveLength(count);
  });

  it('flushes the last text on unmount and stops subsequent output', async () => {
    const { app, writes } = await mount();
    vi.advanceTimersByTime(1);
    act(() => app.rerender(<Text>final tail</Text>));
    act(() => app.unmount());
    mounted.delete(app);
    expect(writes.join('')).toContain('final tail');
    const count = writes.length;
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending drawing when the output has already closed', async () => {
    const { app, writes, close } = await mount();
    vi.advanceTimersByTime(1);
    act(() => app.rerender(<Text>unwritable tail</Text>));
    close();
    act(() => app.unmount());
    mounted.delete(app);
    const count = writes.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(count);
    expect(writes.join('')).not.toContain('unwritable tail');
  });
});
