/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure-logic coverage for the live-turn driver: composer attachment folding
 * (unsupported/unreadable images must surface as notices, never vanish), the
 * replay-batch fold (the transcript reset path for session switches), and the
 * mid-turn queue hand-off to the next turn.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  foldBatch,
  imagePathsToParts,
  useOpenTuiLiveTurn,
} from './live-turn.js';

// Stream-layer stub: records what each turn was handed and holds the first
// turn open until the test releases it, so a second submission lands mid-turn.
// `declines` marks 1-based turn numbers that end without yielding — the
// @-expansion decline path (an abort landing inside the read).
const live = vi.hoisted(() => ({
  turns: [] as Array<{ prompt: unknown; options: unknown }>,
  waiters: [] as Array<() => void>,
  declines: new Set<number>(),
}));

vi.mock('./live-session.js', () => ({
  nextLivePromptId: () => `session-1########${live.turns.length}`,
  async *livePromptEvents(
    _config: unknown,
    prompt: unknown,
    _signal: unknown,
    options: unknown,
  ) {
    live.turns.push({ prompt, options });
    if (live.turns.length === 1) {
      await new Promise<void>((resolve) => live.waiters.push(resolve));
    }
    if (live.declines.has(live.turns.length)) return;
    yield { type: 'done' };
  },
}));

describe('imagePathsToParts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opentui-live-turn-'));

  it('encodes a readable image as an inlineData part', () => {
    const path = join(dir, 'ok.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { parts, notices } = imagePathsToParts([path]);
    expect(notices).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.inlineData?.mimeType).toBe('image/png');
    expect(parts[0]?.inlineData?.data).toBe(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    );
  });

  it('reports unsupported extensions as notices instead of parts', () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'not an image');
    const { parts, notices } = imagePathsToParts([path]);
    expect(parts).toEqual([]);
    expect(notices).toEqual([`Unsupported image type: ${path}`]);
  });

  it('reports unreadable image paths as notices instead of parts', () => {
    const missing = join(dir, 'missing.jpg');
    const { parts, notices } = imagePathsToParts([missing]);
    expect(parts).toEqual([]);
    expect(notices).toEqual([`Could not read image: ${missing}`]);
  });
});

describe('foldBatch', () => {
  it('folds a replay batch into transcript items in order', () => {
    const items = foldBatch([
      { type: 'user', text: 'hello', sentToModel: true },
      { type: 'text', delta: 'hi ' },
      { type: 'text', delta: 'there' },
      { type: 'error', text: 'boom', hint: 'retry later' },
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'error',
    ]);
    const assistant = items[1];
    // Consecutive text deltas merge into one streaming assistant row.
    expect(assistant && 'text' in assistant ? assistant.text : '').toBe(
      'hi there',
    );
  });

  it('returns an empty transcript for an empty batch', () => {
    expect(foldBatch([])).toEqual([]);
  });
});

describe('useOpenTuiLiveTurn submit paths', () => {
  beforeEach(() => {
    live.turns.length = 0;
    live.waiters.length = 0;
    live.declines.clear();
  });

  it('forwards per-turn options through the idle submit hop (R1-4)', () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt', undefined, {
        submittedPrompt: 'first prompt',
        modelOverride: 'qwen3-max',
      });
    });

    // The idle path is the dominant one for submitted_prompt provenance; a
    // dropped `options` argument on the forwarding hop would silently lose it.
    expect(live.turns[0]?.options).toMatchObject({
      submittedPrompt: 'first prompt',
      modelOverride: 'qwen3-max',
    });
  });

  it('replays queued mid-turn text as the next turn, raw and with provenance', async () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt');
    });
    expect(result.current.streaming).toBe(true);

    act(() => {
      result.current.submit('look @notes.md');
    });
    expect(result.current.queueLength).toBe(1);

    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
      await vi.waitFor(() => expect(live.turns).toHaveLength(2));
    });

    // The queue holds what was typed, and the follow-on turn hands it over
    // unchanged: resolving `@path` mentions is the stream layer's job, so a
    // pre-expanded payload here would arrive with its provenance lost. The
    // rest of the options object is the driver's own plumbing.
    expect(live.turns[1]?.prompt).toBe('look @notes.md');
    expect(live.turns[1]?.options).toMatchObject({
      submittedPrompt: 'look @notes.md',
    });
    expect(result.current.queueLength).toBe(0);
  });

  it('consumes only its own submission when a replayed turn declines (R2-2)', async () => {
    // The one reachable decline of the expander — an abort landing inside the
    // @-mention read — ends the replayed turn without a send. Each queued
    // submission rides its own chained turn, so the sibling must survive the
    // decline instead of being swallowed with a joined payload.
    live.declines.add(2);
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt');
    });
    act(() => {
      result.current.submit('look @notes.md');
    });
    act(() => {
      result.current.submit('then do the other thing');
    });
    expect(result.current.queueLength).toBe(2);

    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
      await vi.waitFor(() => expect(live.turns).toHaveLength(3));
    });

    expect(live.turns[1]?.prompt).toBe('look @notes.md');
    expect(live.turns[2]?.prompt).toBe('then do the other thing');
    expect(result.current.queueLength).toBe(0);
  });
});
