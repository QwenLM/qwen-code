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

  it('gives tools no start time on a page recorded before starts were', () => {
    // A tool frame carries a start only when the session recorded one, and
    // this session predates that. Nothing downstream may invent one.
    const toolFrames = timings(projectTrajectoryWindow(REAL_PAGE)).filter(
      (entry) => entry.timing.kind === 'tool',
    );

    expect(toolFrames.map((frame) => frame.timing.startedAt)).toEqual([
      undefined,
      undefined,
    ]);
    for (const frame of toolFrames) {
      expect(frame.timing.durationMs).toBeGreaterThan(0);
    }
  });

  it('preserves a recorded start and measured zero duration through projection', () => {
    const timing = {
      kind: 'tool',
      callId: 'measured-call',
      startedAt: 1_760_000_000_000,
      durationMs: 0,
      toolStatus: 'cancelled',
    };
    expect(timings(projectTrajectoryWindow([timingFrame(timing)]))).toEqual([
      expect.objectContaining({ timing }),
    ]);
  });

  it('carries the record id a frame was stamped with', () => {
    const [first] = timings(projectTrajectoryWindow(REAL_PAGE));
    expect(first?.recordId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('leaves a delegated run’s token total out of the round entries', () => {
    // A subagent tool result reports the whole delegated run's tokens, tagged
    // with the tool call that spawned it. Taken as a round entry it would be
    // read as the next main-session request's counts.
    const delegated = sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        usage: { inputTokens: 900, outputTokens: 90, totalTokens: 990 },
        parentToolCallId: 'call-agent',
      },
    });
    const own = sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
    });

    const entries = projectTrajectoryWindow([
      text('user_message_chunk', 'go'),
      delegated,
      own,
    ]);

    expect(
      entries.flatMap((entry) =>
        entry.kind === 'usage' ? [entry.usage.inputTokens] : [],
      ),
    ).toEqual([10]);
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
    // Index 2 is the assistant record whose request frame is the event before
    // it: the split the in-place-frame contract exists to survive. Index 7
    // lands between a round's tool calls and the frames that measured them,
    // and index 11 between a round's frame and the text it produced.
    const SPLITS = [2, 7, 11];
    const identify = (entries: readonly TrajectoryEntry[]) =>
      entries.flatMap((entry) =>
        entry.kind === 'timing'
          ? [
              `${entry.timing.kind}:${entry.timing.responseId ?? entry.timing.callId}`,
            ]
          : [],
      );

    it('loses no frame to a split, and invents none', () => {
      const whole = identify(projectTrajectoryWindow(REAL_PAGE));
      expect(whole).toHaveLength(5);

      for (const index of SPLITS) {
        // Each half is projected on its own, the way two fetched pages are
        // before the panel has both. Their frames together must be the run's.
        const older = projectTrajectoryWindow(REAL_PAGE.slice(0, index));
        const newer = projectTrajectoryWindow(REAL_PAGE.slice(index));
        expect([...identify(older), ...identify(newer)]).toEqual(whole);
      }
    });

    it('reads a half that lost the frames for what it holds', () => {
      // The older half keeps the request frame; the newer half keeps the
      // records it measured. Neither half may mis-pair what it still has.
      const older = buildTrajectory(
        projectTrajectoryWindow(REAL_PAGE.slice(0, 2)),
      );
      const newer = buildTrajectory(
        projectTrajectoryWindow(REAL_PAGE.slice(2)),
      );

      expect(older.rows.map((row) => row.kind)).toEqual(['user', 'request']);
      expect(older.turns[0]?.requestCount).toBe(1);

      // Orphaned of its frame, the round's text is still a row — with no
      // request to belong to rather than the next round's.
      expect(newer.rows[0]).toMatchObject({ kind: 'message' });
      expect(newer.rows[0]?.requestIndex).toBeUndefined();
      expect(newer.turns[0]?.partial).toBe(true);
      // The tool frames are in this half with their calls, so they still pair.
      const tools = newer.rows.filter((row) => row.kind === 'tool');
      expect(tools.map((row) => row.timing?.durationMs)).toEqual([35, 20]);
    });

    it('leaves a tool row unmeasured when its frame is on the next page', () => {
      const cut = buildTrajectory(
        projectTrajectoryWindow(REAL_PAGE.slice(0, 7)),
      );
      const tools = cut.rows.filter((row) => row.kind === 'tool');

      expect(tools).toHaveLength(2);
      expect(tools.every((row) => row.timing === undefined)).toBe(true);
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
      expect(tools.map((row) => row.timing)).toEqual([
        { durationMs: 35 },
        { durationMs: 20 },
      ]);
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
