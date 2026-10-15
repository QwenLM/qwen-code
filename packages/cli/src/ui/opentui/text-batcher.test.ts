/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text-event batching: consecutive `text` deltas coalesce into one event per
 * window; any other event (and stream end) flushes the pending text first,
 * so cross-kind ordering and turn-boundary semantics are unchanged.
 */

import { describe, expect, it } from 'vitest';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import { batchTextEvents } from './text-batcher.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(
  events: AsyncIterable<OpenTuiStreamEvent>,
  windowMs: number,
): Promise<OpenTuiStreamEvent[]> {
  const out: OpenTuiStreamEvent[] = [];
  for await (const ev of batchTextEvents(events, windowMs)) out.push(ev);
  return out;
}

const text = (delta: string): OpenTuiStreamEvent => ({ type: 'text', delta });
const segmentEnd = (): OpenTuiStreamEvent => ({ type: 'segment-end' });
const info = (t: string): OpenTuiStreamEvent => ({ type: 'info', text: t });

describe('batchTextEvents', () => {
  it('coalesces consecutive text deltas inside one window', async () => {
    async function* src() {
      yield text('a');
      yield text('b');
      yield text('c');
    }
    const out = await collect(src(), 20);
    expect(out).toEqual([text('abc')]);
  });

  it('opens a new window after the previous one closes', async () => {
    async function* src() {
      yield text('a');
      await sleep(50);
      yield text('b');
    }
    const out = await collect(src(), 20);
    expect(out).toEqual([text('a'), text('b')]);
  });

  it('flushes pending text before a non-text event', async () => {
    async function* src() {
      yield text('a');
      yield text('b');
      yield segmentEnd();
      yield text('c');
    }
    const out = await collect(src(), 20);
    expect(out).toEqual([text('ab'), segmentEnd(), text('c')]);
  });

  it('flushes pending text when the stream ends inside the window', async () => {
    async function* src() {
      yield text('a');
    }
    const out = await collect(src(), 20);
    expect(out).toEqual([text('a')]);
  });

  it('flushes text at the window deadline while the stream stalls', async () => {
    async function* src() {
      yield text('a');
      await sleep(200);
    }
    const started = Date.now();
    let firstEventAt: number | undefined;
    for await (const ev of batchTextEvents(src(), 20)) {
      if (firstEventAt === undefined) firstEventAt = Date.now();
      expect(ev).toEqual(text('a'));
    }
    // Flushed by the 20ms window deadline, not by the 200ms stream end.
    expect(firstEventAt! - started).toBeLessThan(150);
  });

  it('passes non-text events through when no text is pending', async () => {
    async function* src() {
      yield segmentEnd();
      yield info('notice');
    }
    const out = await collect(src(), 20);
    expect(out).toEqual([segmentEnd(), info('notice')]);
  });
});
