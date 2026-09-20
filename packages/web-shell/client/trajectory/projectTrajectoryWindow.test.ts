/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { buildTrajectory } from './buildTrajectory';
import { projectTrajectoryWindow } from './projectTrajectoryWindow';
import type { TrajectoryEntry, TrajectoryRequestRow } from './types';
import transcriptPage from './__fixtures__/transcript-page.json' with { type: 'json' };

/**
 * One page of a real session, fetched from `GET /session/:id/transcript` on a
 * `qwen serve` daemon: a prompt, two model rounds, two tool calls and the
 * managed memory extractor's delegated round.
 */
const REAL_PAGE = transcriptPage.events as unknown as DaemonEvent[];

function sessionUpdate(update: Record<string, unknown>): DaemonEvent {
  return { v: 1, type: 'session_update', data: update };
}

function text(
  role: 'user_message_chunk' | 'agent_message_chunk',
  value: string,
  recordId = 'rec-1',
): DaemonEvent {
  return sessionUpdate({
    sessionUpdate: role,
    content: { type: 'text', text: value },
    _meta: {
      qwenTranscript: {
        sourceRecordIds: [recordId],
        segmentId: `${recordId}:0`,
      },
      'qwen.session.recordId': recordId,
    },
  });
}

function timingFrame(
  timing: Record<string, unknown>,
  recordId = 'rec-timing',
): DaemonEvent {
  return sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '' },
    _meta: { timing, 'qwen.session.recordId': recordId },
  });
}

const timings = (entries: readonly TrajectoryEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'timing' ? [entry] : []));

const shapeOf = (entries: readonly TrajectoryEntry[]) =>
  entries.map((entry) =>
    entry.kind === 'timing'
      ? `timing:${entry.timing.kind}`
      : entry.kind === 'usage'
        ? 'usage'
        : `block:${entry.block.kind}`,
  );

describe('projectTrajectoryWindow', () => {
  it('reads a real transcript page', () => {
    const entries = projectTrajectoryWindow(REAL_PAGE);

    expect(timings(entries).map((entry) => entry.timing.kind)).toEqual([
      'request',
      'tool',
      'tool',
      'request',
      'request',
    ]);
    // Blocks the SDK reducer materialized: the prompt, two rounds of
    // thought + answer, and the two tool calls.
    expect(
      entries.flatMap((entry) =>
        entry.kind === 'block' ? [entry.block.kind] : [],
      ),
    ).toEqual([
      'user',
      'thought',
      'assistant',
      'tool',
      'tool',
      'thought',
      'assistant',
    ]);
  });

  it('places each frame where its telemetry record was written', () => {
    expect(shapeOf(projectTrajectoryWindow(REAL_PAGE))).toEqual([
      'block:user',
      // The round's frame precedes everything that round produced.
      'timing:request',
      'block:thought',
      'block:assistant',
      'usage',
      'block:tool',
      'block:tool',
      // Tool frames land after their calls and before the next round.
      'timing:tool',
      'timing:tool',
      'timing:request',
      'block:thought',
      'block:assistant',
      'usage',
      // The turn's delegated round, reported after the main session finished.
      'timing:request',
    ]);
  });

  it('drops the start time a tool frame may carry', () => {
    // The merged producer omits it, because tool calls are logged in one loop
    // after their batch settles and the timestamp is the batch's end for all of
    // them. This page was captured from a build that still sent it.
    const toolFrames = timings(projectTrajectoryWindow(REAL_PAGE)).filter(
      (entry) => entry.timing.kind === 'tool',
    );

    expect(toolFrames).not.toHaveLength(0);
    for (const frame of toolFrames) {
      expect(frame.timing.startedAt).toBeUndefined();
      expect(frame.timing.durationMs).toBeGreaterThan(0);
    }
  });

  it('carries the record id a frame was stamped with', () => {
    const [first] = timings(projectTrajectoryWindow(REAL_PAGE));
    expect(first?.recordId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a frame out of the block stream', () => {
    const entries = projectTrajectoryWindow([
      text('user_message_chunk', 'hi'),
      timingFrame({ kind: 'request', durationMs: 10, status: 'ok' }),
    ]);

    expect(entries.filter((entry) => entry.kind === 'block')).toHaveLength(1);
    expect(timings(entries)).toHaveLength(1);
  });

  it('ignores a frame with no recorded duration', () => {
    const entries = projectTrajectoryWindow([
      timingFrame({ kind: 'request', status: 'ok' }),
      timingFrame({ kind: 'request', durationMs: -1 }),
      timingFrame({ kind: 'request', durationMs: 'slow' }),
      timingFrame({ kind: 'nonsense', durationMs: 5 }),
      timingFrame({ kind: 'tool', durationMs: 5, callId: 'call_a' }),
    ]);

    // A duration is the one value a frame exists to carry, so a frame without
    // a usable one is not a measurement at all.
    expect(shapeOf(entries)).toEqual(['timing:tool']);
  });

  it('pairs nothing with a tool frame that names no call', () => {
    const entries = projectTrajectoryWindow([
      timingFrame({ kind: 'tool', durationMs: 5 }),
    ]);

    expect(buildTrajectory(entries).rows).toHaveLength(0);
  });

  it('keeps the window readable around an event it cannot parse', () => {
    const entries = projectTrajectoryWindow([
      text('user_message_chunk', 'first'),
      { v: 1, type: 'session_update', data: null } as unknown as DaemonEvent,
      { v: 1, type: 'session_update' } as unknown as DaemonEvent,
      text('agent_message_chunk', 'second', 'rec-2'),
    ]);

    // The normalizer surfaces an unreadable frame as its own diagnostic row
    // rather than throwing, so both real messages still arrive intact.
    const texts = entries.flatMap((entry) =>
      entry.kind === 'block' && 'text' in entry.block ? [entry.block.text] : [],
    );
    expect(texts[0]).toBe('first');
    expect(texts.at(-1)).toBe('second');
  });

  it('holds a daemon error out of the stream unless it ended the turn', () => {
    const errorData = { message: 'boom', recoverable: false };
    const quiet = projectTrajectoryWindow([
      { v: 1, type: 'error', data: errorData } as DaemonEvent,
    ]);
    const fatal = projectTrajectoryWindow([
      { v: 1, type: 'turn_error', data: errorData } as DaemonEvent,
    ]);

    expect(quiet).toHaveLength(0);
    expect(fatal.length).toBeGreaterThan(0);
  });

  it('projects a large window', () => {
    const events: DaemonEvent[] = [];
    for (let i = 0; i < 400; i += 1) {
      events.push(
        timingFrame({ kind: 'request', durationMs: 5, status: 'ok' }, `t-${i}`),
        text('agent_message_chunk', `round ${i}`, `rec-${i}`),
      );
    }

    const entries = projectTrajectoryWindow(events);
    expect(entries).toHaveLength(800);
    expect(timings(entries)).toHaveLength(400);
  });

  describe('page boundaries', () => {
    const splitAt = (index: number) => [
      REAL_PAGE.slice(0, index),
      REAL_PAGE.slice(index),
    ];

    it('sees the same run whether or not the page was split', () => {
      const whole = projectTrajectoryWindow(REAL_PAGE);

      // Index 2 is the assistant record whose request frame is the event
      // before it — the split this contract exists to survive.
      for (const index of [2, 5, 9]) {
        const [older, newer] = splitAt(index);
        expect(
          shapeOf(projectTrajectoryWindow([...older!, ...newer!])),
        ).toEqual(shapeOf(whole));
      }
    });
  });

  describe('with buildTrajectory', () => {
    it('folds the real page into turns, requests and tools', () => {
      const { turns, rows } = buildTrajectory(
        projectTrajectoryWindow(REAL_PAGE),
      );

      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        partial: false,
        requestCount: 2,
        toolCount: 2,
      });

      const requests = rows.filter(
        (row): row is TrajectoryRequestRow => row.kind === 'request',
      );
      expect(requests).toHaveLength(3);
      const [first, second, delegated] = requests;
      expect(first).toMatchObject({
        requestIndex: 1,
        status: 'ok',
        model: 'qwen3.8-max',
      });
      expect(first?.timing.ttftMs).toBeGreaterThan(0);
      expect(second?.requestIndex).toBe(2);
      // Each round keeps its own counts rather than the running total the
      // reducer folds onto the block.
      expect(first?.usage).toEqual({
        inputTokens: 26578,
        outputTokens: 253,
        cachedTokens: 3072,
      });
      expect(second?.usage).toEqual({
        inputTokens: 27010,
        outputTokens: 55,
        cachedTokens: 26112,
      });

      // The managed memory extractor runs as a subagent with no spawning tool
      // call, so it is a delegated row that belongs to no parent.
      expect(delegated?.subagentId).toBe(
        'managed-auto-memory-extractor-3e254eae',
      );
      expect(delegated?.depth).toBe(1);
      expect(delegated?.requestIndex).toBeUndefined();

      const tools = rows.filter((row) => row.kind === 'tool');
      expect(tools.map((row) => row.block.toolName)).toEqual([
        'read_file',
        'glob',
      ]);
      expect(
        tools.every(
          (row) =>
            (row.timing?.durationMs ?? 0) > 0 &&
            row.timing?.startedAt === undefined,
        ),
      ).toBe(true);
      expect(tools.map((row) => row.toolStatus)).toEqual([
        'success',
        'success',
      ]);
    });

    it('keeps row identity when an older page is prepended', () => {
      const tailKeys = buildTrajectory(
        projectTrajectoryWindow(REAL_PAGE.slice(4)),
      ).rows.map((row) => row.key);
      const wholeKeys = buildTrajectory(
        projectTrajectoryWindow(REAL_PAGE),
      ).rows.map((row) => row.key);

      expect(wholeKeys.slice(-tailKeys.length)).toEqual(tailKeys);
    });
  });
});
