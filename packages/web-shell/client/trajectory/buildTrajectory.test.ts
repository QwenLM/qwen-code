/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptTimingMeta,
} from '@qwen-code/sdk/daemon';
import { buildTrajectory } from './buildTrajectory';
import type { TrajectoryEntry, TrajectoryRequestRow } from './types';

const SESSION = 'sess-1';
const mainPromptId = (n = 1) => `${SESSION}########${n}`;
const subagentPromptId = (id: string, round = 0) => `${SESSION}#${id}#${round}`;

let seq = 0;
const nextId = () => `b${(seq += 1)}`;

function textBlock(
  kind: 'user' | 'assistant' | 'thought',
  over: Partial<DaemonTextTranscriptBlock> = {},
): DaemonTextTranscriptBlock {
  const id = over.id ?? nextId();
  return {
    id,
    kind,
    text: `${kind} text`,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    segmentId: `${id}:0`,
    sourceRecordIds: [id],
    ...over,
  };
}

function toolBlock(
  toolCallId: string,
  over: Partial<DaemonToolTranscriptBlock> = {},
): DaemonToolTranscriptBlock {
  const id = over.id ?? nextId();
  return {
    id,
    kind: 'tool',
    toolCallId,
    title: `Tool ${toolCallId}`,
    status: 'completed',
    toolName: 'read_file',
    preview: { kind: 'file_read', path: 'note.txt' },
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    sourceRecordIds: [id],
    ...over,
  };
}

const block = (
  b: DaemonTextTranscriptBlock | DaemonToolTranscriptBlock,
): TrajectoryEntry => ({ kind: 'block', block: b });

function requestTiming(
  over: Partial<DaemonTranscriptTimingMeta> = {},
  recordId?: string,
): TrajectoryEntry {
  return {
    kind: 'timing',
    timing: {
      kind: 'request',
      durationMs: 1000,
      startedAt: 1_000_000,
      ttftMs: 400,
      status: 'ok',
      model: 'qwen3.8-max',
      promptId: mainPromptId(),
      ...over,
    },
    ...(recordId !== undefined ? { recordId } : {}),
  };
}

const usage = (inputTokens: number, outputTokens = 10): TrajectoryEntry => ({
  kind: 'usage',
  usage: { inputTokens, outputTokens },
});

function toolTiming(
  callId: string,
  over: Partial<DaemonTranscriptTimingMeta> = {},
): TrajectoryEntry {
  return {
    kind: 'timing',
    timing: {
      kind: 'tool',
      durationMs: 35,
      callId,
      toolName: 'read_file',
      toolStatus: 'success',
      promptId: mainPromptId(),
      ...over,
    },
  };
}

describe('buildTrajectory', () => {
  it('pairs a turn of requests, messages and tools', () => {
    const { turns, rows } = buildTrajectory([
      block(textBlock('user')),
      requestTiming({ durationMs: 7823, ttftMs: 3908 }),
      block(textBlock('thought')),
      block(textBlock('assistant')),
      usage(26578, 253),
      block(toolBlock('call_a')),
      block(toolBlock('call_b', { toolName: 'glob' })),
      toolTiming('call_a', { durationMs: 35 }),
      toolTiming('call_b', { durationMs: 20, toolName: 'glob' }),
      requestTiming({ durationMs: 2530, ttftMs: 1255 }),
      block(textBlock('assistant')),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      index: 1,
      partial: false,
      requestCount: 2,
      toolCount: 2,
      requestMs: 10353,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'request',
      'message',
      'message',
      'tool',
      'tool',
      'request',
      'message',
    ]);

    const [first, second] = rows.filter(
      (row): row is TrajectoryRequestRow => row.kind === 'request',
    );
    expect(first).toMatchObject({
      requestIndex: 1,
      status: 'ok',
      timing: { durationMs: 7823, ttftMs: 3908, startedAt: 1_000_000 },
      usage: { inputTokens: 26578, outputTokens: 253 },
    });
    expect(second?.requestIndex).toBe(2);
    expect(second?.usage).toBeUndefined();

    const tools = rows.filter((row) => row.kind === 'tool');
    expect(tools.map((row) => row.timing?.durationMs)).toEqual([35, 20]);
    expect(tools.every((row) => row.toolStatus === 'success')).toBe(true);
    // Rows produced before a request frame belong to no request; rows after it
    // belong to it until the next one.
    expect(rows.map((row) => row.requestIndex)).toEqual([
      undefined,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
    ]);
  });

  it('opens a partial turn when the window starts mid-turn', () => {
    const { turns, rows } = buildTrajectory([
      requestTiming(),
      block(textBlock('assistant')),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.partial).toBe(true);
    expect(turns[0]?.userRowKey).toBeUndefined();
    expect(turns[0]?.rowKeys).toEqual(rows.map((row) => row.key));
  });

  it('keeps a retried request as its own row', () => {
    const rows = buildTrajectory([
      block(textBlock('user')),
      requestTiming({ status: 'error', durationMs: 500 }, 'rec-err'),
      requestTiming({ status: 'ok', durationMs: 900 }, 'rec-ok'),
      block(textBlock('assistant')),
    ]).rows;

    const requests = rows.filter(
      (row): row is TrajectoryRequestRow => row.kind === 'request',
    );
    expect(requests.map((row) => [row.status, row.requestIndex])).toEqual([
      ['error', 1],
      ['ok', 2],
    ]);
    // The message follows the second request, so it belongs to it.
    expect(rows.at(-1)?.requestIndex).toBe(2);
  });

  it('keeps a request that produced no text and no usage', () => {
    const rows = buildTrajectory([
      block(textBlock('user')),
      requestTiming(),
      block(toolBlock('call_a')),
      toolTiming('call_a'),
    ]).rows;

    const request = rows.find(
      (row): row is TrajectoryRequestRow => row.kind === 'request',
    );
    expect(request).toBeDefined();
    expect(request?.usage).toBeUndefined();
  });

  it('keeps a textless round’s tokens off the round before it', () => {
    // The reducer folds a round with no assistant block onto the previous
    // round's block, so reading tokens off blocks would bill round 1 twice.
    const requests = buildTrajectory([
      block(textBlock('user')),
      requestTiming({ durationMs: 100 }, 'rec-1'),
      block(textBlock('assistant')),
      usage(100, 10),
      block(toolBlock('call_a')),
      toolTiming('call_a'),
      requestTiming({ durationMs: 200 }, 'rec-2'),
      block(textBlock('thought')),
      block(toolBlock('call_b')),
      usage(900, 90),
      requestTiming({ durationMs: 300 }, 'rec-3'),
      block(textBlock('assistant')),
      usage(50, 5),
    ]).rows.filter(
      (row): row is TrajectoryRequestRow => row.kind === 'request',
    );

    expect(requests.map((row) => row.usage?.inputTokens)).toEqual([
      100, 900, 50,
    ]);
  });

  it('keeps the first counts reported for a round', () => {
    // A second report with no round of its own to belong to is a fold of
    // something already counted, not a second round's spend.
    const rows = buildTrajectory([
      block(textBlock('user')),
      requestTiming(),
      block(textBlock('assistant')),
      usage(100, 10),
      usage(999, 99),
    ]).rows;

    const request = rows.find(
      (row): row is TrajectoryRequestRow => row.kind === 'request',
    );
    expect(request?.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  it('ignores tokens reported before any request frame', () => {
    const rows = buildTrajectory([
      block(textBlock('user')),
      usage(123),
      requestTiming(),
      block(textBlock('assistant')),
    ]).rows;

    const request = rows.find(
      (row): row is TrajectoryRequestRow => row.kind === 'request',
    );
    expect(request?.usage).toBeUndefined();
  });

  it('reads a turn with no timing frames at all', () => {
    const { turns, rows } = buildTrajectory([
      block(textBlock('user')),
      block(textBlock('assistant')),
      block(toolBlock('call_a')),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(['user', 'message', 'tool']);
    expect(rows.every((row) => row.requestIndex === undefined)).toBe(true);
    expect(rows.find((row) => row.kind === 'tool')?.timing).toBeUndefined();
    expect(turns[0]).toMatchObject({ requestCount: 0, requestMs: 0 });
  });

  describe('tool frame claims', () => {
    it('refuses a frame whose tool name disagrees with the block', () => {
      const rows = buildTrajectory([
        block(toolBlock('call_a', { toolName: 'read_file' })),
        toolTiming('call_a', { toolName: 'glob' }),
      ]).rows;

      expect(rows.find((row) => row.kind === 'tool')?.timing).toBeUndefined();
    });

    it('matches wrapper calls to the resolved tool while rejecting unrelated names', () => {
      for (const toolName of ['mcp__yuque__yuque_whoami', 'wrong_tool']) {
        const rows = buildTrajectory([
          block(
            toolBlock('call_a', {
              toolName: 'tool_call',
              rawInput: { name: 'mcp__yuque__yuque_whoami', arguments: {} },
            }),
          ),
          toolTiming('call_a', { toolName, durationMs: 515 }),
        ]).rows;
        expect(
          rows.find((row) => row.kind === 'tool')?.timing?.durationMs,
        ).toBe(toolName === 'wrong_tool' ? undefined : 515);
      }
    });

    it('refuses a main-session frame on a subagent block', () => {
      const rows = buildTrajectory([
        block(toolBlock('call_a', { parentToolCallId: 'call_parent' })),
        toolTiming('call_a', { promptId: mainPromptId() }),
      ]).rows;

      expect(rows.find((row) => row.kind === 'tool')?.timing).toBeUndefined();
    });

    it('refuses a subagent frame on a main-session block', () => {
      const rows = buildTrajectory([
        block(toolBlock('call_a')),
        toolTiming('call_a', {
          promptId: subagentPromptId('general-purpose-call_parent'),
        }),
      ]).rows;

      expect(rows.find((row) => row.kind === 'tool')?.timing).toBeUndefined();
    });

    it('drops a frame with no matching block', () => {
      const rows = buildTrajectory([
        block(textBlock('assistant')),
        toolTiming('call_missing'),
      ]).rows;

      expect(rows.map((row) => row.kind)).toEqual(['message']);
    });

    it('pairs only the first of two rows sharing a call id', () => {
      // Replay rewrites a colliding call id, but the tool result keeps the
      // original, so a window can carry the same id twice.
      const rows = buildTrajectory([
        block(toolBlock('call_a', { id: 'first' })),
        block(toolBlock('call_a', { id: 'second' })),
        toolTiming('call_a', { durationMs: 12 }),
        toolTiming('call_a', { durationMs: 99 }),
      ]).rows;

      const tools = rows.filter((row) => row.kind === 'tool');
      expect(tools).toHaveLength(2);
      expect(tools[0]?.timing?.durationMs).toBe(12);
      expect(tools[1]?.timing).toBeUndefined();
      expect(new Set(tools.map((row) => row.key)).size).toBe(2);
    });

    it('preserves an explicitly recorded tool start time', () => {
      const rows = buildTrajectory([
        block(toolBlock('call_a')),
        {
          kind: 'timing',
          timing: {
            kind: 'tool',
            durationMs: 35,
            callId: 'call_a',
            startedAt: 123,
          } as DaemonTranscriptTimingMeta,
        },
      ]).rows;

      expect(rows.find((row) => row.kind === 'tool')?.timing).toEqual({
        durationMs: 35,
        startedAt: 123,
      });
    });
  });

  describe('subagents', () => {
    const SUB = 'general-purpose-call_parent';

    it('rolls a subagent round up onto the tool that spawned it', () => {
      const { rows, turns } = buildTrajectory([
        block(textBlock('user')),
        requestTiming(),
        block(toolBlock('call_parent', { toolName: 'task' })),
        requestTiming({
          durationMs: 5619,
          promptId: subagentPromptId(SUB),
          subagentId: SUB,
        }),
        toolTiming('call_sub', { promptId: subagentPromptId(SUB) }),
        toolTiming('call_sub2', { promptId: subagentPromptId(SUB) }),
      ]);

      const parent = rows.find((row) => row.kind === 'tool');
      expect(parent?.subagentSummary).toEqual({
        requests: 1,
        tools: 2,
        requestMs: 5619,
      });

      const delegated = rows.filter(
        (row): row is TrajectoryRequestRow =>
          row.kind === 'request' && row.subagentId !== undefined,
      );
      expect(delegated).toHaveLength(1);
      expect(delegated[0]).toMatchObject({
        depth: 1,
        parentToolCallId: 'call_parent',
      });
      expect(delegated[0]?.requestIndex).toBeUndefined();
      // Only the main-session round is numbered and counted.
      expect(turns[0]).toMatchObject({ requestCount: 1, requestMs: 1000 });
    });

    it('does not let a delegated round renumber the main session', () => {
      const rows = buildTrajectory([
        block(textBlock('user')),
        requestTiming({}, 'rec-1'),
        block(toolBlock('call_parent', { toolName: 'task' })),
        requestTiming({ promptId: subagentPromptId(SUB), subagentId: SUB }),
        block(textBlock('assistant')),
        // The round after the delegated one is the session's second, not its
        // third: a subagent must not consume a main-session number.
        requestTiming({}, 'rec-2'),
        block(textBlock('assistant')),
      ]).rows;

      const numbered = rows
        .filter((row): row is TrajectoryRequestRow => row.kind === 'request')
        .map((row) => row.requestIndex);
      expect(numbered).toEqual([1, undefined, 2]);
      expect(rows.at(-1)).toMatchObject({ kind: 'message', requestIndex: 2 });
    });

    it('resolves a parent call id through an agent type containing a dash', () => {
      const rows = buildTrajectory([
        block(toolBlock('call_parent', { toolName: 'task' })),
        requestTiming({
          promptId: subagentPromptId('general-purpose-call_parent'),
          subagentId: 'general-purpose-call_parent',
        }),
      ]).rows;

      expect(rows.find((row) => row.kind === 'tool')?.subagentSummary).toEqual({
        requests: 1,
        tools: 0,
        requestMs: 1000,
      });
    });

    it('carries a subagent whose spawning tool is outside the window', () => {
      const rows = buildTrajectory([
        requestTiming({
          promptId: subagentPromptId('managed-auto-memory-extractor-3e254eae'),
          subagentId: 'managed-auto-memory-extractor-3e254eae',
        }),
      ]).rows;

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'request', depth: 1 });
      expect(
        rows[0]?.kind === 'request' ? rows[0].parentToolCallId : 'unset',
      ).toBeUndefined();
    });

    it('reads a subagent tool frame that carries only a prompt id', () => {
      const rows = buildTrajectory([
        block(toolBlock('call_parent', { toolName: 'task' })),
        block(toolBlock('call_sub', { parentToolCallId: 'call_parent' })),
        toolTiming('call_sub', {
          durationMs: 7,
          promptId: subagentPromptId(SUB),
        }),
      ]).rows;

      const sub = rows.find((row) => row.kind === 'tool' && row.depth === 1);
      expect(sub?.timing).toEqual({ durationMs: 7 });
      expect(rows[0]?.kind === 'tool' && rows[0].subagentSummary).toEqual({
        requests: 0,
        tools: 1,
        requestMs: 0,
      });
    });
  });

  describe('turn boundaries', () => {
    it('starts a turn on each ordinary user message', () => {
      const { turns } = buildTrajectory([
        block(textBlock('user')),
        block(textBlock('assistant')),
        block(textBlock('user')),
        block(textBlock('assistant')),
      ]);

      expect(turns.map((t) => [t.index, t.partial])).toEqual([
        [1, false],
        [2, false],
      ]);
    });

    it('keeps an injected user message inside the open turn', () => {
      for (const source of [
        'background_notification',
        'cron',
        'mid_turn_message_injected',
      ]) {
        const { turns, rows } = buildTrajectory([
          block(textBlock('user')),
          block(textBlock('user', { meta: { source } })),
        ]);

        expect(turns).toHaveLength(1);
        expect(rows.map((row) => row.kind)).toEqual(['user', 'user']);
        expect(turns[0]?.userRowKey).toBe(rows[0]?.key);
      }
    });

    it('resets request numbering context at a turn boundary', () => {
      const rows = buildTrajectory([
        block(textBlock('user')),
        requestTiming(),
        block(textBlock('assistant')),
        block(textBlock('user')),
        block(textBlock('assistant')),
      ]).rows;

      // The second turn has no request frame yet, so its message belongs to no
      // request rather than inheriting the first turn's.
      expect(rows.at(-1)?.requestIndex).toBeUndefined();
    });
  });

  describe('row identity', () => {
    const entries = (): TrajectoryEntry[] => [
      block(textBlock('user', { id: 'u1' })),
      requestTiming({}, 'rec-1'),
      block(textBlock('assistant', { id: 'a1' })),
      block(toolBlock('call_a', { id: 't1' })),
      toolTiming('call_a'),
    ];

    it('is stable across repeated projection', () => {
      const first = buildTrajectory(entries()).rows.map((row) => row.key);
      const second = buildTrajectory(entries()).rows.map((row) => row.key);
      expect(second).toEqual(first);
    });

    it('survives an older page being prepended', () => {
      const tail = entries();
      const before = buildTrajectory(tail).rows.map((row) => row.key);
      const after = buildTrajectory([
        block(textBlock('user', { id: 'older' })),
        requestTiming({}, 'rec-older'),
        ...tail,
      ]).rows.map((row) => row.key);

      expect(after.slice(-before.length)).toEqual(before);
    });

    it('indexes every row by its key', () => {
      const { rows, rowIndexByKey } = buildTrajectory(entries());
      expect(rowIndexByKey.size).toBe(rows.length);
      for (const [index, row] of rows.entries()) {
        expect(rowIndexByKey.get(row.key)).toBe(index);
      }
    });

    it('keeps keys unique when blocks share a source record', () => {
      const { rows, rowIndexByKey } = buildTrajectory([
        block(
          textBlock('assistant', {
            id: 'x',
            segmentId: undefined,
            sourceRecordIds: ['same'],
          }),
        ),
        block(
          textBlock('assistant', {
            id: 'y',
            segmentId: undefined,
            sourceRecordIds: ['same'],
          }),
        ),
      ]);

      expect(new Set(rows.map((row) => row.key)).size).toBe(2);
      expect(rowIndexByKey.size).toBe(2);
    });
  });

  it('folds a large window in one pass', () => {
    const entries: TrajectoryEntry[] = [block(textBlock('user'))];
    for (let i = 0; i < 250; i += 1) {
      entries.push(
        requestTiming({}, `rec-${i}`),
        block(textBlock('assistant')),
        block(toolBlock(`call_${i}`)),
        toolTiming(`call_${i}`),
      );
    }

    const { rows, turns } = buildTrajectory(entries);
    expect(rows).toHaveLength(1 + 250 * 3);
    expect(turns[0]).toMatchObject({ requestCount: 250, toolCount: 250 });
    expect(
      rows.filter((row) => row.kind === 'tool' && row.timing !== undefined),
    ).toHaveLength(250);
  });
});

it.each(['tool_call', 'mcp__server__lookup', 'wrong_tool'])(
  'matches wrapper timing name %s without accepting unrelated tools',
  (toolName) => {
    const { rows } = buildTrajectory([
      block(
        toolBlock('wrapped', {
          toolName: 'tool_call',
          rawInput: { name: 'mcp__server__lookup', arguments: {} },
        }),
      ),
      toolTiming('wrapped', { toolName, durationMs: 0 }),
    ]);
    expect(rows.find((row) => row.kind === 'tool')?.timing?.durationMs).toBe(
      toolName === 'wrong_tool' ? undefined : 0,
    );
  },
);

it.each(['goal_runtime', 'goal_control'])(
  'keeps %s within the existing turn',
  (source) => {
    const { rows, turns } = buildTrajectory([
      block(textBlock('user')),
      block(toolBlock('first')),
      block(textBlock('user', { meta: { source } })),
      block(toolBlock('second')),
    ]);
    expect(turns).toHaveLength(1);
    expect(
      rows.filter((row) => row.kind === 'tool').map((row) => row.turnIndex),
    ).toEqual([1, 1]);
  },
);
