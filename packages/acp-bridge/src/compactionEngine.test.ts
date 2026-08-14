/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { TurnBoundaryCompactionEngine } from './compactionEngine.js';
import { EventBus } from './eventBus.js';
import type { BridgeEvent } from './eventBus.js';

function makeTextChunk(id: number, text: string): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  };
}

function makeDiscreteTextChunk(
  id: number,
  text: string,
  attempt: number,
): BridgeEvent {
  const event = makeTextChunk(id, text);
  (event.data as { update: Record<string, unknown> }).update['_meta'] = {
    source: 'todo_stop_guard',
    qwenDiscreteMessage: true,
    attempt,
    maxAttempts: 2,
  };
  return event;
}

function makeThoughtChunk(id: number, text: string): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
      },
    },
  };
}

function makeUserMessage(id: number, text: string): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
      },
    },
  };
}

function makeToolCall(
  id: number,
  toolCallId: string,
  status: string,
  extra: Record<string, unknown> = {},
): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        status,
        ...extra,
      },
    },
  };
}

function makeToolCallUpdate(
  id: number,
  toolCallId: string,
  status: string,
  extra: Record<string, unknown> = {},
): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status,
        ...extra,
      },
    },
  };
}

function makeTurnComplete(id: number): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'turn_complete',
    data: { stopReason: 'end_turn' },
  };
}

function makeTurnError(id: number): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'turn_error',
    data: { error: 'cancelled' },
  };
}

function makePermissionRequest(id: number, requestId: string): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'permission_request',
    data: { requestId, request: { tool: 'Bash', command: 'ls' } },
  };
}

function makePermissionResolved(id: number, requestId: string): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'permission_resolved',
    data: { requestId, outcome: 'approved' },
  };
}

function makeModelSwitched(id: number, modelId: string): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'model_switched',
    data: { modelId },
  };
}

function makeAvailableCommandsUpdate(id: number): BridgeEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'available_commands_update',
        commands: ['/help'],
      },
    },
  };
}

function makeTextChunkWithParent(
  id: number,
  text: string,
  parentToolCallId: string,
): BridgeEvent {
  const event = makeTextChunk(id, text);
  (event.data as { update: Record<string, unknown> }).update['_meta'] = {
    parentToolCallId,
    subagentType: 'general-purpose',
  };
  return event;
}

function makeThoughtChunkWithParent(
  id: number,
  text: string,
  parentToolCallId: string,
): BridgeEvent {
  const event = makeThoughtChunk(id, text);
  (event.data as { update: Record<string, unknown> }).update['_meta'] = {
    parentToolCallId,
    subagentType: 'general-purpose',
  };
  return event;
}

function extractTexts(events: BridgeEvent[]): string[] {
  return events
    .filter((e) => e.type === 'session_update')
    .map((e) => {
      const data = e.data as { update?: { content?: { text?: string } } };
      return data?.update?.content?.text ?? '';
    })
    .filter((t) => t !== '');
}

type ChunkIdentity = {
  parentToolCallId?: string;
  subagentType?: string;
  sourceRecordIds?: string[];
  promptId?: string;
  originatorClientId?: string;
  sessionId?: string;
};

function withIdentity(
  event: BridgeEvent,
  identity: ChunkIdentity,
): BridgeEvent {
  const update = (event.data as { update: Record<string, unknown> }).update;
  if (
    identity.parentToolCallId !== undefined ||
    identity.subagentType !== undefined ||
    identity.sourceRecordIds !== undefined
  ) {
    update['_meta'] = {
      ...(identity.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: identity.parentToolCallId }),
      ...(identity.subagentType === undefined
        ? {}
        : { subagentType: identity.subagentType }),
      ...(identity.sourceRecordIds === undefined
        ? {}
        : {
            qwenTranscript: {
              sourceRecordIds: identity.sourceRecordIds,
            },
          }),
    };
  }
  event.promptId = identity.promptId;
  event.originatorClientId = identity.originatorClientId;
  if (identity.sessionId !== undefined) {
    event.data = {
      sessionId: identity.sessionId,
      ...(event.data as Record<string, unknown>),
    };
  }
  return event;
}

describe('TurnBoundaryCompactionEngine', () => {
  describe('basic compaction', () => {
    it('merges consecutive text chunks into a single event on turn_complete', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Hello'));
      engine.ingest(makeTextChunk(2, ' '));
      engine.ingest(makeTextChunk(3, 'world'));
      engine.ingest(makeTurnComplete(4));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(2); // merged text + turn_complete
      expect(snap.liveJournal).toHaveLength(0);
      expect(snap.lastEventId).toBe(4);

      const textEvent = snap.compactedTurns[0]!;
      expect(textEvent.id).toBe(3); // last chunk's id
      expect(textEvent.type).toBe('session_update');
      const data = textEvent.data as {
        update: { sessionUpdate: string; content: { text: string } };
      };
      expect(data.update.sessionUpdate).toBe('agent_message_chunk');
      expect(data.update.content.text).toBe('Hello world');
    });

    it('merges consecutive thought chunks', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeThoughtChunk(1, 'Let me '));
      engine.ingest(makeThoughtChunk(2, 'think...'));
      engine.ingest(makeTextChunk(3, 'Answer'));
      engine.ingest(makeTurnComplete(4));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(3); // thought + text + turn_complete

      const thoughtEvent = snap.compactedTurns[0]!;
      const data = thoughtEvent.data as {
        update: { sessionUpdate: string; content: { text: string } };
      };
      expect(data.update.sessionUpdate).toBe('agent_thought_chunk');
      expect(data.update.content.text).toBe('Let me think...');
    });

    it('preserves discrete agent messages and their metadata', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Before'));
      engine.ingest(makeDiscreteTextChunk(2, 'Guard one', 1));
      engine.ingest(makeDiscreteTextChunk(3, 'Guard two', 2));
      engine.ingest(makeDiscreteTextChunk(4, 'Guard exhausted', 2));
      engine.ingest(makeTextChunk(5, 'After'));
      engine.ingest(makeTurnComplete(6));

      const events = engine.snapshot().compactedTurns;
      expect(extractTexts(events)).toEqual([
        'Before',
        'Guard one',
        'Guard two',
        'Guard exhausted',
        'After',
      ]);
      const guardEvents = events.filter((event) => {
        const data = event.data as {
          update?: { _meta?: Record<string, unknown> };
        };
        return data.update?._meta?.['source'] === 'todo_stop_guard';
      });
      expect(guardEvents).toHaveLength(3);
      expect(
        guardEvents.map((event) => {
          const data = event.data as {
            update: { _meta: Record<string, unknown> };
          };
          return data.update._meta['attempt'];
        }),
      ).toEqual([1, 2, 2]);
      expect(guardEvents.map((event) => event.id)).toEqual([2, 3, 4]);
    });

    it('keeps generic discrete message and thought chunks separate at turn boundaries', () => {
      const makeDiscrete = (
        makeChunk: (id: number, text: string) => BridgeEvent,
        id: number,
        text: string,
        taskId: string,
      ): BridgeEvent => {
        const event = makeChunk(id, text);
        (event.data as { update: Record<string, unknown> }).update['_meta'] = {
          qwenDiscreteMessage: true,
          backgroundTask: { taskId },
        };
        return event;
      };
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Before'));
      engine.ingest(makeDiscrete(makeTextChunk, 2, 'notify-a', 'task-a'));
      engine.ingest(makeDiscrete(makeTextChunk, 3, 'notify-b', 'task-b'));
      engine.ingest(makeDiscrete(makeThoughtChunk, 4, 'thought-a', 'task-a'));
      engine.ingest(makeDiscrete(makeThoughtChunk, 5, 'thought-b', 'task-b'));
      engine.ingest(makeThoughtChunk(6, 'ordinary'));
      engine.ingest(makeTextChunk(7, 'After'));
      engine.ingest(makeTurnComplete(8));

      const events = engine.snapshot().compactedTurns;
      expect(extractTexts(events)).toEqual([
        'Before',
        'notify-a',
        'notify-b',
        'thought-a',
        'thought-b',
        'ordinary',
        'After',
      ]);
      const discrete = events.filter((event) => {
        const data = event.data as {
          update?: { _meta?: { qwenDiscreteMessage?: boolean } };
        };
        return data.update?._meta?.qwenDiscreteMessage === true;
      });
      expect(discrete.map((event) => event.id)).toEqual([2, 3, 4, 5]);
      expect(
        discrete.map(
          (event) =>
            (
              event.data as {
                update: { _meta: { backgroundTask: { taskId: string } } };
              }
            ).update._meta.backgroundTask.taskId,
        ),
      ).toEqual(['task-a', 'task-b', 'task-a', 'task-b']);
    });

    it('keeps user messages as-is', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeUserMessage(1, 'How are you?'));
      engine.ingest(makeTextChunk(2, 'I am fine'));
      engine.ingest(makeTurnComplete(3));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(3);
      const data = snap.compactedTurns[0]!.data as {
        update: { sessionUpdate: string; content: { text: string } };
      };
      expect(data.update.sessionUpdate).toBe('user_message_chunk');
      expect(data.update.content.text).toBe('How are you?');
      expect(snap.compactedTurns[0]!.id).toBe(1);
    });
  });

  describe('tool call folding', () => {
    it('folds tool_call + tool_call_updates into single final-state event', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Let me check'));
      engine.ingest({
        ...makeToolCall(2, 'tc1', 'running', { title: 'Read file' }),
        _meta: { serverTimestamp: 100, source: 'initial' },
      });
      engine.ingest({
        ...makeToolCallUpdate(3, 'tc1', 'running', {
          content: 'reading...',
        }),
        _meta: { serverTimestamp: 150 },
      });
      engine.ingest({
        ...makeToolCallUpdate(4, 'tc1', 'done', {
          rawOutput: 'file contents',
        }),
        _meta: { serverTimestamp: 200 },
      });
      engine.ingest(makeTextChunk(5, 'Done'));
      engine.ingest(makeTurnComplete(6));

      const snap = engine.snapshot();
      // text("Let me check") + tool(tc1 final) + text("Done") + turn_complete
      expect(snap.compactedTurns).toHaveLength(4);

      const toolEvent = snap.compactedTurns[1]!;
      const data = toolEvent.data as {
        update: {
          toolCallId: string;
          status: string;
          title: string;
          rawOutput: string;
        };
      };
      expect(data.update.toolCallId).toBe('tc1');
      expect(data.update.status).toBe('done');
      expect(data.update.title).toBe('Read file');
      expect(data.update.rawOutput).toBe('file contents');
      expect(toolEvent.id).toBe(4); // last update's id
      expect(toolEvent._meta).toEqual({
        serverTimestamp: 200,
        source: 'initial',
      });
    });

    it('preserves tool call order when multiple tools run', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeToolCall(1, 'tc1', 'running', { title: 'Tool A' }));
      engine.ingest(makeToolCall(2, 'tc2', 'running', { title: 'Tool B' }));
      engine.ingest(makeToolCallUpdate(3, 'tc1', 'done'));
      engine.ingest(makeToolCallUpdate(4, 'tc2', 'done'));
      engine.ingest(makeTurnComplete(5));

      const snap = engine.snapshot();
      const toolEvents = snap.compactedTurns.filter(
        (e) =>
          e.type === 'session_update' &&
          (e.data as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === 'tool_call',
      );
      expect(toolEvents).toHaveLength(2);
      expect(
        (toolEvents[0]!.data as { update: { title: string } }).update.title,
      ).toBe('Tool A');
      expect(
        (toolEvents[1]!.data as { update: { title: string } }).update.title,
      ).toBe('Tool B');
    });
  });

  describe('text segmentation across tool calls', () => {
    it('preserves separate text segments before and after tool calls', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Before'));
      engine.ingest(makeTextChunk(2, ' tool'));
      engine.ingest(makeToolCall(3, 'tc1', 'running'));
      engine.ingest(makeToolCallUpdate(4, 'tc1', 'done'));
      engine.ingest(makeTextChunk(5, 'After'));
      engine.ingest(makeTextChunk(6, ' tool'));
      engine.ingest(makeTurnComplete(7));

      const texts = extractTexts(engine.snapshot().compactedTurns);
      expect(texts).toEqual(['Before tool', 'After tool']);
    });
  });

  describe('transient event filtering', () => {
    it('drops transient events (slow_client_warning, replay_complete, etc.)', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Hello'));
      engine.ingest({
        v: 1,
        type: 'slow_client_warning',
        data: { queueSize: 200 },
      });
      engine.ingest({
        id: 2,
        v: 1,
        type: 'replay_complete',
        data: { replayedCount: 5 },
      });
      engine.ingest(makeTurnComplete(3));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(2); // text + turn_complete
      expect(snap.liveJournal).toHaveLength(0);
    });

    it('does not persist history_truncated markers through ingest or seed', () => {
      const marker: BridgeEvent = {
        v: 1,
        type: 'history_truncated',
        data: {
          reason: 'replay_window_exceeded',
          truncatedEvents: 2,
          retainedEvents: 1,
          maxBytes: 128,
          fullTranscriptAvailable: true,
        },
      };
      const engine = new TurnBoundaryCompactionEngine();

      engine.ingest(marker);
      engine.ingest(makeTextChunk(1, 'Hello'));
      engine.ingest(makeTurnComplete(2));

      expect(engine.snapshot().compactedTurns.map((e) => e.type)).toEqual([
        'session_update',
        'turn_complete',
      ]);

      const seeded = new TurnBoundaryCompactionEngine();
      seeded.seed({
        compactedTurns: [
          marker,
          makeTextChunk(1, 'Loaded'),
          makeTurnComplete(2),
        ],
        lastEventId: 2,
      });

      expect(seeded.snapshot().compactedTurns.map((e) => e.type)).toEqual([
        'session_update',
        'turn_complete',
      ]);
    });
  });

  describe('bounded replay window', () => {
    it('drops oldest completed live turn segments when max replay bytes is exceeded', () => {
      const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });

      engine.ingest(makeTextChunk(1, `first-${'x'.repeat(600)}`));
      engine.ingest(makeTurnComplete(2));
      engine.ingest(makeTextChunk(3, `second-${'y'.repeat(600)}`));
      engine.ingest(makeTurnComplete(4));
      engine.ingest(makeTextChunk(5, `third-${'z'.repeat(600)}`));
      engine.ingest(makeTurnComplete(6));

      const snap = engine.snapshot();
      expect(snap.compactedTurns[0]?.type).toBe('history_truncated');
      expect(extractTexts(snap.compactedTurns)).toEqual([
        `third-${'z'.repeat(600)}`,
      ]);
      expect(snap.compactedTurns.at(-1)?.id).toBe(6);
      expect(snap.liveJournal).toHaveLength(0);

      expect(snap.compactedTurns[0]?.data).toMatchObject({
        reason: 'replay_window_exceeded',
        truncatedEvents: 4,
        truncatedTurns: 2,
        retainedEvents: 2,
        maxBytes: 512,
        fullTranscriptAvailable: true,
      });
    });

    it('retains the newest oversized live turn without a truncation marker', () => {
      const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 128 });

      engine.ingest(makeTextChunk(1, `oversized-${'x'.repeat(600)}`));
      engine.ingest(makeTurnComplete(2));

      const snap = engine.snapshot();
      expect(snap.compactedTurns[0]?.type).not.toBe('history_truncated');
      expect(extractTexts(snap.compactedTurns)).toEqual([
        `oversized-${'x'.repeat(600)}`,
      ]);
      expect(snap.compactedTurns.at(-1)?.id).toBe(2);
    });

    it('notifies the eviction diagnostic hook when replay is dropped', () => {
      const onReplayWindowEviction = vi.fn();
      const engine = new TurnBoundaryCompactionEngine({
        maxReplayBytes: 512,
        onReplayWindowEviction,
      });

      engine.ingest(makeTextChunk(1, `first-${'x'.repeat(600)}`));
      engine.ingest(makeTurnComplete(2));
      engine.ingest(makeTextChunk(3, `second-${'y'.repeat(600)}`));
      engine.ingest(makeTurnComplete(4));

      expect(onReplayWindowEviction).toHaveBeenCalledWith(
        expect.objectContaining({
          droppedEvents: 2,
          droppedSegments: 1,
          droppedTurns: 1,
          maxBytes: 512,
          retainedEvents: 2,
        }),
      );
    });

    it('keeps replay working when the eviction diagnostic hook throws', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxReplayBytes: 512,
        onReplayWindowEviction: () => {
          throw new Error('diagnostic failed');
        },
      });

      expect(() => {
        engine.ingest(makeTextChunk(1, `first-${'x'.repeat(600)}`));
        engine.ingest(makeTurnComplete(2));
        engine.ingest(makeTextChunk(3, `second-${'y'.repeat(600)}`));
        engine.ingest(makeTurnComplete(4));
      }).not.toThrow();

      const snap = engine.snapshot();
      expect(snap.compactedTurns[0]?.type).toBe('history_truncated');
      expect(extractTexts(snap.compactedTurns)).toEqual([
        `second-${'y'.repeat(600)}`,
      ]);
    });
  });

  describe('latest-wins events', () => {
    it('keeps only the most recent available_commands_update per turn', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeAvailableCommandsUpdate(1));
      engine.ingest(makeAvailableCommandsUpdate(2));
      engine.ingest(makeAvailableCommandsUpdate(3));
      engine.ingest(makeTurnComplete(4));

      const snap = engine.snapshot();
      const cmdUpdates = snap.compactedTurns.filter(
        (e) =>
          (e.data as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === 'available_commands_update',
      );
      expect(cmdUpdates).toHaveLength(1);
      expect(cmdUpdates[0]!.id).toBe(3);
    });
  });

  describe('permission events', () => {
    it('preserves permission_request and permission_resolved', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'I need permission'));
      engine.ingest(makePermissionRequest(2, 'perm-1'));
      engine.ingest(makePermissionResolved(3, 'perm-1'));
      engine.ingest(makeTextChunk(4, 'Done'));
      engine.ingest(makeTurnComplete(5));

      const snap = engine.snapshot();
      const permEvents = snap.compactedTurns.filter(
        (e) =>
          e.type === 'permission_request' || e.type === 'permission_resolved',
      );
      expect(permEvents).toHaveLength(2);
    });
  });

  describe('model_switched events', () => {
    it('preserves model_switched events', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeModelSwitched(1, 'opus-4'));
      engine.ingest(makeTextChunk(2, 'Response'));
      engine.ingest(makeTurnComplete(3));

      const snap = engine.snapshot();
      const modelEvents = snap.compactedTurns.filter(
        (e) => e.type === 'model_switched',
      );
      expect(modelEvents).toHaveLength(1);
      expect((modelEvents[0]!.data as { modelId: string }).modelId).toBe(
        'opus-4',
      );
    });
  });

  describe('liveJournal (incomplete turn)', () => {
    it('merges consecutive text chunks for live replay', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeThoughtChunk(1, 'Let me '));
      engine.ingest(makeThoughtChunk(2, 'think'));
      engine.ingest(makeTextChunk(3, 'The '));
      engine.ingest(makeTextChunk(4, 'answer'));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(0);
      expect(snap.liveJournal).toHaveLength(2);
      expect(extractTexts(snap.liveJournal)).toEqual([
        'Let me think',
        'The answer',
      ]);
      expect(snap.liveJournal.map((event) => event.id)).toEqual([2, 4]);
      expect(snap.lastEventId).toBe(4);
    });

    it('preserves tool boundaries in live replay', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Before'));
      engine.ingest(makeToolCall(2, 'tc1', 'running'));
      engine.ingest(makeTextChunk(3, 'After'));

      const snap = engine.snapshot();
      expect(snap.liveJournal).toHaveLength(3);
      expect(extractTexts(snap.liveJournal)).toEqual(['Before', 'After']);
      expect(snap.liveJournal.map((event) => event.id)).toEqual([1, 2, 3]);
    });

    it.each([
      {
        name: 'parentToolCallId',
        first: { parentToolCallId: 'tool-a', subagentType: 'explore' },
        second: { parentToolCallId: 'tool-b', subagentType: 'explore' },
      },
      {
        name: 'sourceRecordIds',
        first: { sourceRecordIds: ['record-a'] },
        second: { sourceRecordIds: ['record-b'] },
      },
      {
        name: 'promptId',
        first: { promptId: 'prompt-a' },
        second: { promptId: 'prompt-b' },
      },
      {
        name: 'originatorClientId',
        first: { originatorClientId: 'client-a' },
        second: { originatorClientId: 'client-b' },
      },
      {
        name: 'sessionId',
        first: { sessionId: 'session-a' },
        second: { sessionId: 'session-b' },
      },
    ])('does not merge across $name boundaries', ({ first, second }) => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(withIdentity(makeTextChunk(1, 'first'), first));
      engine.ingest(withIdentity(makeTextChunk(2, 'second'), second));

      const snap = engine.snapshot();
      expect(snap.liveJournal).toHaveLength(2);
      expect(extractTexts(snap.liveJournal)).toEqual(['first', 'second']);
      expect(snap.liveJournal.map((event) => event.id)).toEqual([1, 2]);
      expect(snap.liveJournal[0]).toMatchObject(
        withIdentity(makeTextChunk(1, 'first'), first),
      );
      expect(snap.liveJournal[1]).toMatchObject(
        withIdentity(makeTextChunk(2, 'second'), second),
      );
    });

    it.each([
      {
        name: 'parentToolCallId',
        identity: { parentToolCallId: 'tool-a', subagentType: 'explore' },
      },
      {
        name: 'sourceRecordIds',
        identity: { sourceRecordIds: ['record-a'] },
      },
      { name: 'promptId', identity: { promptId: 'prompt-a' } },
      {
        name: 'originatorClientId',
        identity: { originatorClientId: 'client-a' },
      },
      { name: 'sessionId', identity: { sessionId: 'session-a' } },
    ])('merges consecutive chunks sharing a defined $name', ({ identity }) => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(withIdentity(makeTextChunk(1, 'first'), identity));
      engine.ingest(withIdentity(makeTextChunk(2, 'second'), identity));

      const snap = engine.snapshot();
      expect(snap.liveJournal).toHaveLength(1);
      expect(extractTexts(snap.liveJournal)).toEqual(['firstsecond']);
      expect(snap.liveJournal.map((event) => event.id)).toEqual([2]);
    });

    it.each([
      [
        'ordinary then guard',
        makeTextChunk(1, 'ordinary'),
        makeDiscreteTextChunk(2, 'guard', 1),
      ],
      [
        'guard then ordinary',
        makeDiscreteTextChunk(1, 'guard', 1),
        makeTextChunk(2, 'ordinary'),
      ],
    ])('keeps todo-stop-guard text discrete: %s', (_name, first, second) => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(first);
      engine.ingest(second);

      const snap = engine.snapshot();
      expect(snap.liveJournal).toHaveLength(2);
      expect(snap.liveJournal.map((event) => event.id)).toEqual([1, 2]);
      expect(
        snap.liveJournal.map(
          (event) =>
            (event.data as { update: { content: { text: string } } }).update
              .content.text,
        ),
      ).toEqual(
        [first, second].map(
          (event) =>
            (event.data as { update: { content: { text: string } } }).update
              .content.text,
        ),
      );
      const guard = snap.liveJournal.find(
        (event) =>
          (event.data as { update: { _meta?: { source?: string } } }).update
            ._meta?.source === 'todo_stop_guard',
      );
      expect(
        (guard?.data as { update: { _meta: Record<string, unknown> } }).update
          ._meta,
      ).toMatchObject({
        source: 'todo_stop_guard',
        qwenDiscreteMessage: true,
        attempt: 1,
        maxAttempts: 2,
      });
    });

    it.each([
      ['message', makeTextChunk],
      ['thought', makeThoughtChunk],
    ] as const)(
      'keeps generic discrete %s chunks separate in live replay',
      (_name, makeChunk) => {
        const makeBackgroundMessage = (
          id: number,
          text: string,
          taskId: string,
        ): BridgeEvent => {
          const event = makeChunk(id, text);
          (event.data as { update: Record<string, unknown> }).update['_meta'] =
            {
              qwenDiscreteMessage: true,
              backgroundTask: { taskId },
            };
          return event;
        };
        const first = makeBackgroundMessage(1, 'first', 'task-a');
        const second = makeBackgroundMessage(2, 'second', 'task-b');
        const engine = new TurnBoundaryCompactionEngine();
        engine.ingest(first);
        engine.ingest(second);

        const live = engine.snapshot().liveJournal;
        expect(live).toHaveLength(2);
        expect(extractTexts(live)).toEqual(['first', 'second']);
        expect(
          live.map(
            (event) =>
              (
                event.data as {
                  update: { _meta: { backgroundTask: { taskId: string } } };
                }
              ).update._meta.backgroundTask.taskId,
          ),
        ).toEqual(['task-a', 'task-b']);
      },
    );

    it('preserves semantic envelope metadata event boundaries', () => {
      const withEnvelopeMeta = (
        event: BridgeEvent,
        meta: Record<string, unknown>,
      ): BridgeEvent => ({ ...event, _meta: meta });
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(
        withEnvelopeMeta(makeTextChunk(1, 'before'), { serverTimestamp: 1 }),
      );
      engine.ingest(
        withEnvelopeMeta(makeTextChunk(2, 'middle'), {
          serverTimestamp: 2,
          semantic: { kind: 'middle' },
        }),
      );
      engine.ingest(
        withEnvelopeMeta(makeTextChunk(3, 'after'), { serverTimestamp: 3 }),
      );

      const live = engine.snapshot().liveJournal;
      expect(live).toHaveLength(3);
      expect(live.map((event) => event.id)).toEqual([1, 2, 3]);
      expect(live[1]?._meta).toEqual({
        serverTimestamp: 2,
        semantic: { kind: 'middle' },
      });
    });

    it('preserves semantic metadata event boundaries', () => {
      const withMeta = (
        event: BridgeEvent,
        meta: Record<string, unknown>,
      ): BridgeEvent => {
        (event.data as { update: Record<string, unknown> }).update['_meta'] =
          meta;
        return event;
      };
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'before'));
      engine.ingest(
        withMeta(makeTextChunk(2, ''), { usage: { totalTokens: 3 } }),
      );
      engine.ingest(
        withMeta(makeTextChunk(3, 'command'), { source: 'slash_command' }),
      );
      engine.ingest(makeTextChunk(4, 'after'));

      const live = engine.snapshot().liveJournal;
      expect(live).toHaveLength(4);
      expect(live.map((event) => event.id)).toEqual([1, 2, 3, 4]);
      expect(
        live.map(
          (event) =>
            (event.data as { update: { content: { text: string } } }).update
              .content.text,
        ),
      ).toEqual(['before', '', 'command', 'after']);
      expect(
        (live[1]!.data as { update: { _meta: Record<string, unknown> } }).update
          ._meta,
      ).toEqual({ usage: { totalTokens: 3 } });
      expect(
        (live[2]!.data as { update: { _meta: Record<string, unknown> } }).update
          ._meta,
      ).toEqual({ source: 'slash_command' });
    });

    it.each([
      [
        'an unmodeled update key',
        (event: BridgeEvent) => {
          (event.data as { update: Record<string, unknown> }).update[
            'annotations'
          ] = [];
          return event;
        },
      ],
      [
        'an unmodeled data key',
        (event: BridgeEvent) => {
          (event.data as Record<string, unknown>)['attachments'] = [];
          return event;
        },
      ],
    ] as const)(
      'keeps text chunks carrying %s out of merged live entries',
      (_name, decorate) => {
        const engine = new TurnBoundaryCompactionEngine();
        engine.ingest(makeTextChunk(1, 'first'));
        engine.ingest(decorate(makeTextChunk(2, 'second')));
        engine.ingest(makeTextChunk(3, 'third'));

        const live = engine.snapshot().liveJournal;
        expect(live).toHaveLength(3);
        expect(extractTexts(live)).toEqual(['first', 'second', 'third']);
        expect(live.map((event) => event.id)).toEqual([1, 2, 3]);
      },
    );

    it('keeps ACP TextContent annotations and _meta out of merged live entries', () => {
      // ACP TextContent permits `annotations` and `_meta` beside
      // `type`/`text`; the merged-entry rebuild models only `{ type,
      // text }`, so such chunks must replay exactly as SSE delivered them.
      const withContentFields = (event: BridgeEvent): BridgeEvent => {
        const content = (
          event.data as { update: { content: Record<string, unknown> } }
        ).update.content;
        content['annotations'] = { audience: ['assistant'] };
        content['_meta'] = { vendor: 'keep' };
        return event;
      };
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'first'));
      engine.ingest(withContentFields(makeTextChunk(2, 'hello')));
      engine.ingest(makeTextChunk(3, 'third'));

      const live = engine.snapshot().liveJournal;
      expect(live).toHaveLength(3);
      expect(extractTexts(live)).toEqual(['first', 'hello', 'third']);
      expect(live.map((event) => event.id)).toEqual([1, 2, 3]);
      expect(
        (live[1]!.data as { update: { content: unknown } }).update.content,
      ).toEqual({
        type: 'text',
        text: 'hello',
        annotations: { audience: ['assistant'] },
        _meta: { vendor: 'keep' },
      });
    });

    it('merges live chunks whose empty-string parentToolCallId the extractor ignores', () => {
      const withEmptyParent = (event: BridgeEvent): BridgeEvent => {
        (event.data as { update: Record<string, unknown> }).update['_meta'] = {
          parentToolCallId: '',
        };
        return event;
      };
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(withEmptyParent(makeTextChunk(1, 'first')));
      engine.ingest(withEmptyParent(makeTextChunk(2, 'second')));

      const live = engine.snapshot().liveJournal;
      expect(live).toHaveLength(1);
      expect(extractTexts(live)).toEqual(['firstsecond']);

      engine.ingest(makeTurnComplete(3));
      expect(extractTexts(engine.snapshot().compactedTurns)).toEqual([
        'firstsecond',
      ]);
    });

    it('merges live subagent chunks carrying the producer-stamped meta pair', () => {
      // SubAgentTracker stamps streamed subagent fragments with both keys.
      const withSubagentMeta = (event: BridgeEvent): BridgeEvent => {
        (event.data as { update: Record<string, unknown> }).update['_meta'] = {
          parentToolCallId: 'tool-a',
          subagentType: 'explore',
        };
        return event;
      };
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(withSubagentMeta(makeTextChunk(1, 'first')));
      engine.ingest(withSubagentMeta(makeTextChunk(2, 'second')));

      const live = engine.snapshot().liveJournal;
      expect(live).toHaveLength(1);
      expect(extractTexts(live)).toEqual(['firstsecond']);
      expect(
        (live[0]!.data as { update: { _meta?: Record<string, unknown> } })
          .update._meta,
      ).toEqual({ parentToolCallId: 'tool-a', subagentType: 'explore' });

      engine.ingest(makeTurnComplete(3));
      const compacted = engine.snapshot().compactedTurns;
      expect(extractTexts(compacted)).toEqual(['firstsecond']);
      expect(
        (compacted[0]!.data as { update: { _meta?: Record<string, unknown> } })
          .update._meta,
      ).toEqual({ parentToolCallId: 'tool-a', subagentType: 'explore' });
    });

    it('merges chunks carrying buildUpdateMeta timestamp and plan shapes', () => {
      const withTranscriptMeta = (
        event: BridgeEvent,
        meta: Record<string, unknown>,
      ): BridgeEvent => {
        (event.data as { update: Record<string, unknown> }).update['_meta'] =
          meta;
        return event;
      };
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(
        withTranscriptMeta(makeTextChunk(1, 'first'), {
          timestamp: 1700000000000,
          qwenTranscript: {
            sourceRecordIds: ['record-a'],
            planToolCallId: 'plan-1',
          },
        }),
      );
      engine.ingest(
        withTranscriptMeta(makeTextChunk(2, 'second'), {
          timestamp: 1700000000001,
          serverTimestamp: 1700000000002,
          qwenTranscript: {
            sourceRecordIds: ['record-a'],
            planToolCallId: 'plan-2',
          },
        }),
      );

      const live = engine.snapshot().liveJournal;
      expect(live).toHaveLength(1);
      expect(extractTexts(live)).toEqual(['firstsecond']);
      expect(live.map((event) => event.id)).toEqual([2]);
    });

    it('does not let snapshot frequency change journal eviction', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
      });
      engine.ingest(makeTextChunk(1, 'first'));
      expect(engine.snapshot().liveJournal).toHaveLength(1);
      engine.ingest(makeTextChunk(2, ' second'));

      const snap = engine.snapshot();
      expect(snap.liveJournal).toHaveLength(1);
      expect(extractTexts(snap.liveJournal)).toEqual(['first second']);
      expect(
        snap.liveJournal.find((event) => event.type === 'history_truncated'),
      ).toBeUndefined();
    });

    it('clears liveJournal on turn completion', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'Hello'));
      engine.ingest(makeTurnComplete(2));
      engine.ingest(makeTextChunk(3, 'New turn'));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(2);
      expect(snap.liveJournal).toHaveLength(1);
      expect(snap.liveJournal[0]!.id).toBe(3);
    });
  });

  describe('liveJournal caps (DAEMON-009)', () => {
    const markerOf = (snap: { liveJournal: BridgeEvent[] }) =>
      snap.liveJournal.find((e) => e.type === 'history_truncated');

    it('keeps an independent summary journal without nested subagent updates', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 512,
      });
      engine.ingest(makeToolCall(1, 'agent-1', 'running'));
      for (let i = 2; i <= 100; i++) {
        engine.ingest(
          makeTextChunkWithParent(i, `nested-${i}`, 'agent-1'),
          1024 * 1024,
        );
      }
      engine.ingest(makeToolCallUpdate(101, 'agent-1', 'completed'));

      const full = engine.snapshot();
      expect(markerOf(full)).toBeDefined();
      expect(full.lastEventId).toBe(101);

      const summary = engine.snapshot('summary');
      expect(markerOf(summary)).toBeUndefined();
      expect(summary.liveJournal.map((event) => event.id)).toEqual([1, 101]);
      expect(summary.lastEventId).toBe(101);

      engine.ingest(makeTurnComplete(102));
      expect(engine.snapshot('summary').liveJournal).toEqual([]);
      expect(extractTexts(engine.snapshot().compactedTurns).join('')).toBe(
        Array.from({ length: 99 }, (_, index) => `nested-${index + 2}`).join(
          '',
        ),
      );
    });

    it('retains nested usage frames in the summary journal', () => {
      const engine = new TurnBoundaryCompactionEngine();
      const usage = makeTextChunkWithParent(1, '', 'agent-1');
      (
        usage.data as { update: { _meta: Record<string, unknown> } }
      ).update._meta['usage'] = { inputTokens: 10, outputTokens: 2 };
      engine.ingest(usage);
      engine.ingest(makeTextChunkWithParent(2, 'nested detail', 'agent-1'));

      expect(
        engine.snapshot('summary').liveJournal.map((event) => event.id),
      ).toEqual([1]);
    });

    it('excludes parented tool frames from the summary journal under cap pressure', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
      });
      engine.ingest(makeToolCall(1, 'agent-1', 'pending'));
      for (let i = 2; i <= 5; i++) {
        engine.ingest(
          makeToolCallUpdate(i, `sub-tool-${i}`, 'in_progress', {
            _meta: { parentToolCallId: 'agent-1' },
          }),
        );
      }
      engine.ingest(makeToolCallUpdate(6, 'agent-1', 'completed'));

      const full = engine.snapshot();
      expect(markerOf(full)).toBeDefined();
      expect(
        full.liveJournal
          .filter((event) => event.type !== 'history_truncated')
          .map((event) => event.id),
      ).toEqual([5, 6]);

      const summary = engine.snapshot('summary');
      expect(markerOf(summary)).toBeUndefined();
      expect(summary.liveJournal.map((event) => event.id)).toEqual([1, 6]);
    });

    it('keeps self-parented tool frames in the summary journal like the UI normalizer', () => {
      // normalizeToolUpdate drops parentToolCallId === toolCallId, so the
      // main transcript renders such a frame as a ROOT tool block; the
      // summary journal must agree or a mid-turn refresh drops the block.
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(
        makeToolCall(1, 'self-tool', 'pending', {
          _meta: { parentToolCallId: 'self-tool' },
        }),
      );
      engine.ingest(
        makeToolCallUpdate(2, 'self-tool', 'completed', {
          _meta: { parentToolCallId: 'self-tool' },
        }),
      );

      expect(
        engine.snapshot('summary').liveJournal.map((event) => event.id),
      ).toEqual([1, 2]);
    });

    it('keeps a long compatible text stream below the event cap', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 3,
      });
      for (let i = 1; i <= 512; i++) {
        engine.ingest(makeTextChunk(i, `chunk-${i}`));
      }

      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeUndefined();
      expect(snap.liveJournal).toHaveLength(2);
      expect(extractTexts(snap.liveJournal).join('')).toBe(
        Array.from({ length: 512 }, (_, index) => `chunk-${index + 1}`).join(
          '',
        ),
      );
      expect(snap.liveJournal.map((event) => event.id)).toEqual([256, 512]);
    });

    it('drops the oldest non-mergeable entries past maxJournalEvents and prepends a marker', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 3,
      });
      for (let i = 1; i <= 5; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      const snap = engine.snapshot();
      expect(snap.liveJournal).toHaveLength(4);
      const marker = markerOf(snap);
      expect(marker?.data).toEqual({
        reason: 'replay_window_exceeded',
        scope: 'live_journal',
        truncatedEvents: 2,
        retainedEvents: 3,
        maxBytes: 8 * 1024 * 1024,
        maxEvents: 3,
        fullTranscriptAvailable: true,
      });
      expect(snap.liveJournal[0]).toBe(marker);
      expect(snap.liveJournal.slice(1).map((e) => e.id)).toEqual([3, 4, 5]);
    });

    it('drops the oldest non-mergeable entries past maxJournalBytes but keeps at least one', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalBytes: 300,
      });
      engine.ingest(makeUserMessage(1, 'x'.repeat(200)));
      engine.ingest(makeUserMessage(2, 'y'.repeat(200)));

      const snap = engine.snapshot();
      const marker = markerOf(snap);
      expect(marker).toBeDefined();
      expect(
        (marker?.data as { truncatedEvents: number }).truncatedEvents,
      ).toBe(1);
      expect(snap.liveJournal.filter((e) => e.id !== undefined)).toHaveLength(
        1,
      );
      expect(snap.liveJournal.at(-1)?.id).toBe(2);
    });

    it('starts a new segment before a merged entry exceeds maxJournalBytes', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalBytes: 600,
      });
      engine.ingest(makeTextChunk(1, 'x'.repeat(400)));
      engine.ingest(makeTextChunk(2, 'y'.repeat(400)));

      const snap = engine.snapshot();
      expect(markerOf(snap)?.data).toMatchObject({
        truncatedEvents: 1,
        retainedEvents: 1,
      });
      expect(extractTexts(snap.liveJournal)).toEqual(['y'.repeat(400)]);
      expect(snap.liveJournal.at(-1)?.id).toBe(2);
    });

    it('reports raw event counts when an aggregated segment is dropped', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
      });
      for (let i = 1; i <= 512; i++) {
        engine.ingest(makeTextChunk(i, 'x'));
      }
      engine.ingest(makeUserMessage(513, 'later'));

      const marker = markerOf(engine.snapshot());
      expect(marker?.data).toMatchObject({
        truncatedEvents: 256,
        retainedEvents: 257,
      });
    });

    it('does not let journal truncation corrupt the compacted turn', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
      });
      engine.ingest(makeTextChunk(1, 'Hello'));
      engine.ingest(makeTextChunk(2, ' world'));
      engine.ingest(makeUserMessage(3, 'later'));
      engine.ingest(makeTurnComplete(4));

      const snap = engine.snapshot();
      expect(extractTexts(snap.compactedTurns)).toContain('Hello world');
      expect(snap.liveJournal).toHaveLength(0);
      expect(markerOf(snap)).toBeUndefined();
    });

    it('emits no marker while the journal stays within its caps', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'H'));
      engine.ingest(makeTextChunk(2, 'i'));

      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeUndefined();
      expect(snap.liveJournal).toHaveLength(1);
      expect(extractTexts(snap.liveJournal)).toEqual(['Hi']);
    });

    it('marker carries the last-seen recordId as a pagination anchor when the journal overflows', () => {
      // Regression coverage: a single long in-flight turn can push the
      // liveJournal past its caps with only streaming `session_update`s
      // (no recordId). The marker must still carry the recordId of the
      // most recent prior turn-boundary event so the client can anchor
      // transcript pagination at `beforeRecordId`.
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 3,
      });
      const turnBounded: BridgeEvent = {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'prior-turn' },
            _meta: { 'qwen.session.recordId': 'record-anchor' },
          },
        },
      };
      engine.ingest(turnBounded);
      engine.ingest(makeUserMessage(2, 'a'));
      engine.ingest(makeUserMessage(3, 'b'));
      engine.ingest(makeUserMessage(4, 'c'));
      engine.ingest(makeUserMessage(5, 'd'));

      const snap = engine.snapshot();
      const marker = markerOf(snap);
      expect(marker).toBeDefined();
      expect(marker?.data).toMatchObject({
        reason: 'replay_window_exceeded',
        scope: 'live_journal',
        truncatedEvents: 2,
        retainedEvents: 3,
        recordId: 'record-anchor',
      });
    });

    it('summary marker ignores recordIds from excluded nested events', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
      });
      const root = makeTextChunk(1, 'root');
      (root.data as { update: Record<string, unknown> }).update['_meta'] = {
        'qwen.session.recordId': 'root-record',
      };
      const nested = makeTextChunkWithParent(2, 'nested', 'agent-1');
      (
        nested.data as { update: { _meta: Record<string, unknown> } }
      ).update._meta['qwen.session.recordId'] = 'nested-record';
      engine.ingest(root);
      engine.ingest(nested);
      engine.ingest(makeUserMessage(3, 'a'));
      engine.ingest(makeUserMessage(4, 'b'));

      expect(markerOf(engine.snapshot())?.data).toMatchObject({
        recordId: 'nested-record',
      });
      expect(markerOf(engine.snapshot('summary'))?.data).toMatchObject({
        recordId: 'root-record',
      });
    });

    it.each(['seed', 'seedReplayEvents'] as const)(
      '%s derives the summary marker anchor from root events',
      (method) => {
        const engine = new TurnBoundaryCompactionEngine({
          maxJournalEvents: 2,
        });
        const root = makeTextChunk(1, 'root');
        (root.data as { update: Record<string, unknown> }).update['_meta'] = {
          'qwen.session.recordId': 'root-record',
        };
        const nested = makeTextChunkWithParent(2, 'nested', 'agent-1');
        (
          nested.data as { update: { _meta: Record<string, unknown> } }
        ).update._meta['qwen.session.recordId'] = 'nested-record';

        if (method === 'seed') {
          engine.seed({ compactedTurns: [root, nested], lastEventId: 2 });
        } else {
          engine.seedReplayEvents([root, nested]);
        }
        engine.ingest(makeUserMessage(3, 'a'));
        engine.ingest(makeUserMessage(4, 'b'));
        engine.ingest(makeUserMessage(5, 'c'));

        expect(markerOf(engine.snapshot())?.data).toMatchObject({
          recordId: 'nested-record',
        });
        expect(markerOf(engine.snapshot('summary'))?.data).toMatchObject({
          recordId: 'root-record',
        });
      },
    );

    it('seeded engine stamps marker with recordId observed on post-seed ingest', () => {
      // A seed resets activeRecordId; subsequent ingest must rebuild it.
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
      });
      engine.seed({
        compactedTurns: [makeTextChunk(1, 'seeded')],
        lastEventId: 1,
      });
      const bounded: BridgeEvent = {
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'post-seed' },
            _meta: { 'qwen.session.recordId': 'record-post-seed' },
          },
        },
      };
      engine.ingest(bounded);
      engine.ingest(makeUserMessage(3, 'x'));
      engine.ingest(makeUserMessage(4, 'y'));

      const snap = engine.snapshot();
      const marker = markerOf(snap);
      expect(marker?.data).toMatchObject({
        recordId: 'record-post-seed',
      });
    });
  });

  describe('adaptive live-journal growth', () => {
    const markerOf = (snap: { liveJournal: BridgeEvent[] }) =>
      snap.liveJournal.find((e) => e.type === 'history_truncated');
    // Pinned entry baseline: advisor fixtures and grown-cap assertions in
    // this block encode it, so constructors pin it instead of mirroring
    // the unpinned DEFAULT_MAX_JOURNAL_EVENTS.
    const ENTRY_BASELINE = 10_000;

    it('grows the caps instead of evicting when the advisor grants headroom', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 8 * 1024 * 1024,
        onJournalGrowth: (current) => ({
          maxEvents: current.maxEvents * 2,
          maxBytes: current.maxBytes * 2,
        }),
      });
      for (let i = 1; i <= 5; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeUndefined();
      expect(snap.liveJournal.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
      // Two breaches (entries 3 and 5), each doubling the caps.
      expect(engine.journalLimits()).toEqual({
        maxEvents: 8,
        maxBytes: 32 * 1024 * 1024,
      });
    });

    it('passes the current (already grown) caps to the advisor', () => {
      const seen: Array<{ maxEvents: number; maxBytes: number }> = [];
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
        maxJournalBytes: 8 * 1024 * 1024,
        onJournalGrowth: (current) => {
          seen.push({ ...current });
          return seen.length < 3
            ? {
                maxEvents: current.maxEvents * 2,
                maxBytes: current.maxBytes * 2,
              }
            : undefined;
        },
      });
      for (let i = 1; i <= 6; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      // Each ask reports the caps as grown by the previous grant; the third
      // ask (which refuses) still observes the grown caps.
      expect(seen).toEqual([
        { maxEvents: 1, maxBytes: 8 * 1024 * 1024 },
        { maxEvents: 2, maxBytes: 16 * 1024 * 1024 },
        { maxEvents: 4, maxBytes: 32 * 1024 * 1024 },
      ]);
    });

    it('falls back to eviction when the advisor refuses', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        onJournalGrowth: () => undefined,
      });
      for (let i = 1; i <= 4; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      const snap = engine.snapshot();
      expect(markerOf(snap)?.data).toMatchObject({
        truncatedEvents: 2,
        retainedEvents: 2,
        maxEvents: 2,
      });
      expect(
        snap.liveJournal.filter((e) => e.id !== undefined).map((e) => e.id),
      ).toEqual([3, 4]);
    });

    it('degrades to eviction when the advisor throws', () => {
      const advisor = vi.fn(() => {
        throw new Error('advisor exploded');
      });
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        onJournalGrowth: advisor,
      });
      for (let i = 1; i <= 4; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeDefined();
      expect(snap.liveJournal.filter((e) => e.id !== undefined)).toHaveLength(
        2,
      );
      // A thrown advisor is recorded as a refusal: the second breach must
      // be swallowed by the throttle, not re-ask on the hot ingest path.
      expect(advisor).toHaveBeenCalledTimes(1);
    });

    it('treats a non-growing or malformed grant as a refusal', () => {
      // The clock advances between breaches so the refusal throttle does
      // not swallow the second ask — both fixtures must actually be
      // consumed. Infinity (not NaN) is the malformed value: it passes the
      // `>` size comparisons, so only the safe-integer guard can refuse it.
      let clockMs = 1_000_000;
      const grants: Array<{ maxEvents: number; maxBytes: number } | undefined> =
        [
          // bytes not larger than current
          { maxEvents: 10, maxBytes: 8 * 1024 * 1024 },
          // not a safe integer
          { maxEvents: 10, maxBytes: Number.POSITIVE_INFINITY },
          // maxEvents not a safe integer; the bytes side here is valid and
          // growing, so only the maxEvents safe-integer conjunct refuses it.
          { maxEvents: Number.POSITIVE_INFINITY, maxBytes: 16 * 1024 * 1024 },
        ];
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 8 * 1024 * 1024,
        now: () => clockMs,
        onJournalGrowth: () => grants.shift(),
      });
      engine.ingest(makeUserMessage(1, 'message-1'));
      engine.ingest(makeUserMessage(2, 'message-2'));
      engine.ingest(makeUserMessage(3, 'message-3'));
      clockMs += 10_000;
      engine.ingest(makeUserMessage(4, 'message-4'));
      clockMs += 10_000;
      engine.ingest(makeUserMessage(5, 'message-5'));

      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeDefined();
      expect(engine.journalLimits()).toEqual({
        maxEvents: 2,
        maxBytes: 8 * 1024 * 1024,
      });
      expect(grants).toHaveLength(0);
    });

    it('refuses a grant that grows bytes but shrinks the entry cap', () => {
      // A misbehaving advisor must never lower a cap mid-turn; only the
      // `maxEvents >= current` acceptance clause guards that.
      const advisor = vi.fn(() => ({
        maxEvents: 1,
        maxBytes: 16 * 1024 * 1024,
      }));
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 8 * 1024 * 1024,
        onJournalGrowth: advisor,
      });
      for (let i = 1; i <= 3; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      expect(advisor).toHaveBeenCalledTimes(1);
      expect(engine.journalLimits()).toEqual({
        maxEvents: 2,
        maxBytes: 8 * 1024 * 1024,
      });
      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeDefined();
      expect(snap.liveJournal.filter((e) => e.id !== undefined)).toHaveLength(
        2,
      );
    });

    it('grows the caps on a byte-cap breach while under the entry cap', () => {
      // The canonical trigger: a few very large events cross the byte cap
      // while the entry count stays low. Explicit byte lengths keep the
      // breach independent of envelope serialization size.
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: ENTRY_BASELINE,
        maxJournalBytes: 300,
        onJournalGrowth: (current) => ({
          maxEvents: current.maxEvents * 2,
          maxBytes: current.maxBytes * 2,
        }),
      });
      engine.ingest(makeUserMessage(1, 'first large event'), 200);
      engine.ingest(makeUserMessage(2, 'second large event'), 200);

      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeUndefined();
      expect(snap.liveJournal.filter((e) => e.id !== undefined)).toHaveLength(
        2,
      );
      expect(engine.journalLimits()).toEqual({
        maxEvents: ENTRY_BASELINE * 2,
        maxBytes: 600,
      });
    });

    it('evicts down to the raised cap when a partial grant does not resolve the breach', () => {
      // A partial grant leaves the journal over the raised cap; the
      // eviction loop must still trim the excess and stamp the marker.
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: ENTRY_BASELINE,
        maxJournalBytes: 300,
        onJournalGrowth: () => ({ maxEvents: ENTRY_BASELINE, maxBytes: 450 }),
      });
      engine.ingest(makeUserMessage(1, 'first large event'), 150);
      engine.ingest(makeUserMessage(2, 'second large event'), 150);
      engine.ingest(makeUserMessage(3, 'third large event'), 300);

      expect(engine.journalLimits()).toEqual({
        maxEvents: ENTRY_BASELINE,
        maxBytes: 450,
      });
      const snap = engine.snapshot();
      expect(markerOf(snap)?.data).toMatchObject({
        scope: 'live_journal',
        truncatedEvents: 1,
        maxBytes: 450,
      });
      expect(
        snap.liveJournal.filter((e) => e.id !== undefined).map((e) => e.id),
      ).toEqual([2, 3]);
    });

    it('refuses a grant that cannot retain more than eviction already keeps', () => {
      // The newest entry alone exceeds the granted cap, so eviction retains
      // exactly one entry with or without the grant. The walk applies the
      // flat 400-byte grant tentatively, sees no retention gain, asks again
      // from 400, receives no further growth, and rolls back — the caps
      // must stay at the baseline and eviction still keeps the oversized
      // survivor, with the pool never charged.
      const advisor = vi.fn(() => ({
        maxEvents: ENTRY_BASELINE,
        maxBytes: 400,
      }));
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: ENTRY_BASELINE,
        maxJournalBytes: 300,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'first large event'), 150);
      engine.ingest(makeUserMessage(2, 'second large event'), 150);
      engine.ingest(makeUserMessage(3, 'third large event'), 300);

      expect(advisor).toHaveBeenCalledTimes(2);
      expect(engine.journalLimits()).toEqual({
        maxEvents: ENTRY_BASELINE,
        maxBytes: 300,
      });
      const snap = engine.snapshot();
      expect(markerOf(snap)?.data).toMatchObject({
        scope: 'live_journal',
        truncatedEvents: 2,
        maxBytes: 300,
      });
      expect(
        snap.liveJournal.filter((e) => e.id !== undefined).map((e) => e.id),
      ).toEqual([3]);
    });

    it('walks through intermediate grants to reach a later grant that retains more', () => {
      // An 8 MiB baseline facing a ~6 MiB event followed by a ~20 MiB
      // event needs 32 MiB to retain both. The first doubling to 16 MiB
      // still retains only the newest event; refusing it there evicts the
      // older event forever even though headroom exists. The walk must
      // keep going through reachable intermediate grants until retention
      // improves.
      const MiB = 1024 * 1024;
      const advisor = vi.fn(
        (current: { maxEvents: number; maxBytes: number }) =>
          current.maxBytes >= 32 * MiB
            ? undefined
            : {
                maxEvents: current.maxEvents * 2,
                maxBytes: current.maxBytes * 2,
              },
      );
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: ENTRY_BASELINE,
        maxJournalBytes: 8 * MiB,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'older event'), 6 * MiB);
      engine.ingest(makeUserMessage(2, 'newer event'), 20 * MiB);

      expect(advisor).toHaveBeenCalledTimes(2);
      expect(engine.journalLimits()).toEqual({
        maxEvents: ENTRY_BASELINE * 4,
        maxBytes: 32 * MiB,
      });
      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeUndefined();
      expect(
        snap.liveJournal.filter((e) => e.id !== undefined).map((e) => e.id),
      ).toEqual([1, 2]);
    });

    it('never charges growth when no reachable cap can retain more', () => {
      // Each oversized event survives alone at every cap the advisor can
      // reach: retaining two of them needs 3000 bytes, but the advisor
      // stops granting at 1200. The walk must run to that refusal and roll
      // back — repeated breaches may not ratchet the caps upward while
      // preserving nothing extra.
      let clockMs = 0;
      const advisor = vi.fn((current: { maxBytes: number }) =>
        current.maxBytes >= 1200
          ? undefined
          : { maxEvents: ENTRY_BASELINE, maxBytes: current.maxBytes * 2 },
      );
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: ENTRY_BASELINE,
        maxJournalBytes: 300,
        now: () => clockMs,
        onJournalGrowth: advisor,
      });
      for (let i = 1; i <= 3; i++) {
        clockMs += 10_000; // clear the refusal throttle between breaches
        engine.ingest(makeUserMessage(i, `oversized-${i}`), 1500);
      }

      // The first breach is a length-1 journal (no ask: the survivor is
      // kept regardless); each of the next two breaches walks two
      // intermediate grants and then hits the refusal.
      expect(advisor).toHaveBeenCalledTimes(6);
      expect(engine.journalLimits()).toEqual({
        maxEvents: ENTRY_BASELINE,
        maxBytes: 300,
      });
      const snap = engine.snapshot();
      expect(
        snap.liveJournal.filter((e) => e.id !== undefined).map((e) => e.id),
      ).toEqual([3]);
    });

    it('rolls back and records a refusal when the walk exhausts its step budget', () => {
      // A misbehaving advisor granting strictly-growing-but-non-retaining
      // caps drives the walk to its step budget; the engine must roll the
      // caps back, charge nothing, and throttle re-asks like any other
      // refusal.
      const advisor = vi.fn(
        (current: { maxEvents: number; maxBytes: number }) => ({
          maxEvents: current.maxEvents + 100,
          maxBytes: current.maxBytes + 1,
        }),
      );
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 300,
        now: () => 0,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'first large event'), 250);
      engine.ingest(makeUserMessage(2, 'second large event'), 250);

      // 64 non-improving grants exhaust the per-breach walk budget; the
      // caps roll back to the baseline.
      expect(advisor).toHaveBeenCalledTimes(64);
      expect(engine.journalLimits()).toEqual({
        maxEvents: 2,
        maxBytes: 300,
      });

      // Exhaustion counts as a refusal: a breach inside the throttle
      // window must not re-ask on the hot ingest path.
      engine.ingest(makeUserMessage(3, 'third large event'), 250);
      expect(advisor).toHaveBeenCalledTimes(64);
      const snap = engine.snapshot();
      expect(markerOf(snap)).toBeDefined();
      expect(
        snap.liveJournal.filter((e) => e.id !== undefined).map((e) => e.id),
      ).toEqual([3]);
    });

    it('does not ask for growth when the breaching append is a turn boundary', () => {
      // compactCurrentTurn() discards the journal immediately after the
      // boundary append, so a grant would charge the shared pool while
      // buying zero eviction.
      const advisor = vi.fn(() => ({
        maxEvents: 10_000,
        maxBytes: 16 * 1024 * 1024,
      }));
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 8 * 1024 * 1024,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'message-1'));
      engine.ingest(makeUserMessage(2, 'message-2'));
      engine.ingest(makeTurnComplete(3));

      expect(advisor).not.toHaveBeenCalled();
      expect(engine.journalLimits()).toEqual({
        maxEvents: 2,
        maxBytes: 8 * 1024 * 1024,
      });
    });

    it('stamps the truncation marker with the grown caps after growth then eviction', () => {
      // The marker contract: maxBytes / maxEvents reflect the caps in
      // force, which may already have grown when the pool later refuses.
      let granted = false;
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 8 * 1024 * 1024,
        onJournalGrowth: (current) => {
          if (granted) return undefined;
          granted = true;
          return {
            maxEvents: current.maxEvents * 2,
            maxBytes: current.maxBytes * 2,
          };
        },
      });
      for (let i = 1; i <= 6; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }

      expect(engine.journalLimits()).toEqual({
        maxEvents: 4,
        maxBytes: 16 * 1024 * 1024,
      });
      const snap = engine.snapshot();
      expect(markerOf(snap)?.data).toMatchObject({
        scope: 'live_journal',
        maxEvents: 4,
        maxBytes: 16 * 1024 * 1024,
      });
    });

    it('throttles re-asks after a refusal until the interval elapses', () => {
      let clockMs = 0;
      const advisor = vi.fn(() => undefined);
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
        now: () => clockMs,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'a'));
      engine.ingest(makeUserMessage(2, 'b'));
      expect(advisor).toHaveBeenCalledTimes(1);

      // Still over the cap, but inside the refusal throttle window.
      engine.ingest(makeUserMessage(3, 'c'));
      engine.ingest(makeUserMessage(4, 'd'));
      expect(advisor).toHaveBeenCalledTimes(1);

      clockMs += 10_000;
      engine.ingest(makeUserMessage(5, 'e'));
      expect(advisor).toHaveBeenCalledTimes(2);
    });

    it('re-asks after a refusal when the clock source jumps backward', () => {
      // A wall-clock source can move backward (NTP correction, manual set);
      // the throttle window must expire rather than suppress asks until the
      // old reading is reached again.
      let clockMs = 100_000;
      const advisor = vi.fn(() => undefined);
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
        now: () => clockMs,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'a'));
      engine.ingest(makeUserMessage(2, 'b'));
      expect(advisor).toHaveBeenCalledTimes(1);

      clockMs = 50_000;
      engine.ingest(makeUserMessage(3, 'c'));
      expect(advisor).toHaveBeenCalledTimes(2);
    });

    it('resets the refusal throttle at a turn boundary', () => {
      const clockMs = 0;
      const advisor = vi.fn(() => undefined);
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
        now: () => clockMs,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'a'));
      engine.ingest(makeUserMessage(2, 'b'));
      expect(advisor).toHaveBeenCalledTimes(1);

      engine.ingest(makeTurnComplete(3));
      engine.ingest(makeUserMessage(4, 'c'));
      engine.ingest(makeUserMessage(5, 'd'));
      expect(advisor).toHaveBeenCalledTimes(2);
    });

    it('clears the refusal throttle when a re-ask is granted', () => {
      // A refusal at t0, a backward clock jump that lets a re-ask grant,
      // then a breach back inside [t0, t0+10s): the grant must have
      // cleared the stale refusal, or the engine throttles asks the pool
      // is willing to grant.
      let clockMs = 100_000;
      let calls = 0;
      const advisor = vi.fn(() => {
        calls += 1;
        return calls === 2
          ? { maxEvents: 2, maxBytes: 16 * 1024 * 1024 }
          : undefined;
      });
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 1,
        maxJournalBytes: 8 * 1024 * 1024,
        now: () => clockMs,
        onJournalGrowth: advisor,
      });
      engine.ingest(makeUserMessage(1, 'a'));
      engine.ingest(makeUserMessage(2, 'b'));
      expect(advisor).toHaveBeenCalledTimes(1);

      clockMs = 50_000;
      engine.ingest(makeUserMessage(3, 'c'));
      expect(advisor).toHaveBeenCalledTimes(2);
      expect(engine.journalLimits().maxEvents).toBe(2);

      clockMs = 105_000;
      engine.ingest(makeUserMessage(4, 'd'));
      expect(advisor).toHaveBeenCalledTimes(3);
    });

    it('keeps grown caps across turn boundaries', () => {
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 2,
        maxJournalBytes: 8 * 1024 * 1024,
        onJournalGrowth: (current) => ({
          maxEvents: current.maxEvents * 4,
          maxBytes: current.maxBytes * 4,
        }),
      });
      for (let i = 1; i <= 5; i++) {
        engine.ingest(makeUserMessage(i, `message-${i}`));
      }
      engine.ingest(makeTurnComplete(6));
      expect(engine.journalLimits()).toEqual({
        maxEvents: 8,
        maxBytes: 32 * 1024 * 1024,
      });
    });

    it('accepts growth from the summary journal once it breaches alone', () => {
      // Nested frames pressure only the full journal, so an early refusal
      // evicts a root frame from the full journal while the summary journal
      // retains it. The journals then diverge, and a later root append that
      // breaches the summary journal must compute its growth decision from
      // the summary journal's own tail — not the full journal's.
      let clockMs = 1_000_000;
      const asks: Array<{ maxEvents: number; maxBytes: number }> = [];
      const grants: Array<{ maxEvents: number; maxBytes: number } | undefined> =
        [
          undefined, // first breach (full journal): refuse
          { maxEvents: 100, maxBytes: 120 }, // second breach (full): accept
          { maxEvents: 100, maxBytes: 140 }, // third breach (summary): accept
        ];
      const engine = new TurnBoundaryCompactionEngine({
        maxJournalEvents: 100,
        maxJournalBytes: 100,
        now: () => clockMs,
        onJournalGrowth: (current) => {
          asks.push({ ...current });
          return grants.shift();
        },
      });
      engine.ingest(makeUserMessage(1, 'root-1'), 70);
      engine.ingest(makeTextChunkWithParent(2, 'nested', 'agent-1'), 60);
      // Past the refusal throttle: the new breach gets a fresh ask.
      clockMs += 10_000;
      engine.ingest(makeUserMessage(3, 'root-2'), 60);

      // The third ask reports the caps grown by the full journal's grant,
      // proving the summary breach was consulted separately after it.
      expect(asks).toEqual([
        { maxEvents: 100, maxBytes: 100 },
        { maxEvents: 100, maxBytes: 100 },
        { maxEvents: 100, maxBytes: 120 },
      ]);
      expect(engine.journalLimits()).toEqual({
        maxEvents: 100,
        maxBytes: 140,
      });
      const summary = engine.snapshot('summary');
      expect(markerOf(summary)).toBeUndefined();
      expect(summary.liveJournal.map((event) => event.id)).toEqual([1, 3]);
    });
  });

  describe('multi-turn sessions', () => {
    it('compacts multiple turns independently', () => {
      const engine = new TurnBoundaryCompactionEngine();
      // Turn 1
      engine.ingest(makeUserMessage(1, 'Hello'));
      engine.ingest(makeTextChunk(2, 'Hi'));
      engine.ingest(makeTextChunk(3, ' there'));
      engine.ingest(makeTurnComplete(4));
      // Turn 2
      engine.ingest(makeUserMessage(5, 'Bye'));
      engine.ingest(makeTextChunk(6, 'Good'));
      engine.ingest(makeTextChunk(7, 'bye'));
      engine.ingest(makeTurnComplete(8));

      const snap = engine.snapshot();
      expect(snap.lastEventId).toBe(8);
      // Turn 1: user + merged_text + turn_complete
      // Turn 2: user + merged_text + turn_complete
      expect(snap.compactedTurns).toHaveLength(6);
      const texts = extractTexts(snap.compactedTurns);
      expect(texts).toContain('Hello');
      expect(texts).toContain('Hi there');
      expect(texts).toContain('Bye');
      expect(texts).toContain('Goodbye');
    });
  });

  describe('turn_error compaction', () => {
    it('compacts on turn_error the same as turn_complete', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'partial'));
      engine.ingest(makeTextChunk(2, ' response'));
      engine.ingest(makeTurnError(3));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(2); // merged text + turn_error
      expect(snap.liveJournal).toHaveLength(0);
      const texts = extractTexts(snap.compactedTurns);
      expect(texts).toEqual(['partial response']);
    });
  });

  describe('snapshot consistency', () => {
    it('returns defensive copies', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'test'));
      engine.ingest(makeTurnComplete(2));

      const a = engine.snapshot();
      const b = engine.snapshot();
      expect(a.compactedTurns).not.toBe(b.compactedTurns);
      expect(a.compactedTurns).toEqual(b.compactedTurns);
      expect(a.liveJournal).not.toBe(b.liveJournal);
    });

    it('lastEventId is always consistent with content', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'a'));
      expect(engine.snapshot().lastEventId).toBe(1);

      engine.ingest(makeTextChunk(2, 'b'));
      expect(engine.snapshot().lastEventId).toBe(2);

      engine.ingest(makeTurnComplete(3));
      expect(engine.snapshot().lastEventId).toBe(3);
    });
  });

  describe('seed', () => {
    it('seeds the engine from a persisted snapshot', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.seed({
        compactedTurns: [makeTextChunk(10, 'from disk'), makeTurnComplete(11)],
        lastEventId: 11,
      });

      // New events build on top of the seeded state
      engine.ingest(makeTextChunk(12, 'live'));
      engine.ingest(makeTurnComplete(13));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(4); // 2 seeded + 2 new
      expect(snap.lastEventId).toBe(13);
    });

    it('seed clears in-flight slots so stale data does not corrupt post-seed output', () => {
      const engine = new TurnBoundaryCompactionEngine();
      // Populate in-flight state (no turn_complete to compact them)
      engine.ingest(makeTextChunkWithParent(1, 'stale-sub', 'old-task'));
      engine.ingest(makeTextChunk(2, 'stale-top'));
      engine.ingest(makeToolCall(3, 'tc-stale', 'running'));

      // Seed replaces history — should also clear in-flight slots
      engine.seed({
        compactedTurns: [makeTextChunk(100, 'seeded'), makeTurnComplete(101)],
        lastEventId: 101,
      });

      // Ingest fresh events and complete the turn
      engine.ingest(makeTextChunk(102, 'fresh'));
      engine.ingest(makeTurnComplete(103));

      const snap = engine.snapshot();
      const texts = extractTexts(snap.compactedTurns);
      // Should contain only seeded + fresh, not the stale pre-seed events
      expect(texts).toEqual(['seeded', 'fresh']);
      expect(snap.compactedTurns).toHaveLength(4); // seeded text + seeded tc + fresh text + fresh tc
    });

    it('applies the replay byte cap to seeded compacted turns', () => {
      const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });

      engine.seed({
        compactedTurns: [
          makeTextChunk(10, `old-${'x'.repeat(600)}`),
          makeTextChunk(11, `new-${'y'.repeat(600)}`),
        ],
        lastEventId: 11,
      });

      const snap = engine.snapshot();
      expect(snap.lastEventId).toBe(11);
      expect(snap.liveJournal).toHaveLength(0);
      expect(snap.compactedTurns[0]?.type).toBe('history_truncated');
      expect(extractTexts(snap.compactedTurns)).toEqual([
        `new-${'y'.repeat(600)}`,
      ]);
      expect(snap.compactedTurns[0]?.data).toMatchObject({
        reason: 'replay_window_exceeded',
        truncatedEvents: 1,
        retainedEvents: 1,
        maxBytes: 512,
        fullTranscriptAvailable: true,
      });
    });

    it('evicts seeded replay segments when later live turns exceed the byte cap', () => {
      const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });

      engine.seed({
        compactedTurns: [makeTextChunk(10, `seed-${'x'.repeat(600)}`)],
        lastEventId: 10,
      });
      engine.ingest(makeTextChunk(11, `live-${'y'.repeat(600)}`));
      engine.ingest(makeTurnComplete(12));

      const snap = engine.snapshot();
      expect(snap.lastEventId).toBe(12);
      expect(snap.liveJournal).toHaveLength(0);
      expect(snap.compactedTurns[0]?.type).toBe('history_truncated');
      expect(extractTexts(snap.compactedTurns)).toEqual([
        `live-${'y'.repeat(600)}`,
      ]);
      expect(snap.compactedTurns.at(-1)?.id).toBe(12);
      expect(snap.compactedTurns[0]?.data).toMatchObject({
        reason: 'replay_window_exceeded',
        truncatedEvents: 1,
        retainedEvents: 2,
        maxBytes: 512,
        fullTranscriptAvailable: true,
      });
      expect(
        (snap.compactedTurns[0]?.data as Record<string, unknown>)[
          'truncatedTurns'
        ],
      ).toBeUndefined();
    });
  });

  describe('close', () => {
    it('ignores events after close', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'before'));
      engine.close();
      engine.ingest(makeTextChunk(2, 'after'));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(0);
      expect(snap.liveJournal).toHaveLength(0);
    });
  });

  describe('_meta preservation', () => {
    it('preserves _meta from the last text chunk', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' },
            _meta: { usage: { input: 10 } },
          },
        },
      });
      engine.ingest({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' world' },
            _meta: { usage: { input: 10, output: 50 }, durationMs: 1200 },
          },
        },
      });
      engine.ingest(makeTurnComplete(3));

      const snap = engine.snapshot();
      const textEvent = snap.compactedTurns[0]!;
      const data = textEvent.data as { update: { _meta: unknown } };
      expect(data.update._meta).toEqual({
        usage: { input: 10, output: 50 },
        durationMs: 1200,
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty turn (turn_complete with no preceding events)', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTurnComplete(1));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(1); // just turn_complete
      expect(snap.compactedTurns[0]!.type).toBe('turn_complete');
    });

    it('handles events without id (synthetic frames)', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest({
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'no id' },
          },
        },
      });
      engine.ingest(makeTurnComplete(1));

      const snap = engine.snapshot();
      expect(snap.lastEventId).toBe(1);
      const texts = extractTexts(snap.compactedTurns);
      expect(texts).toEqual(['no id']);
    });

    it('handles thought then text interleaved with tool calls', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeThoughtChunk(1, 'thinking'));
      engine.ingest(makeThoughtChunk(2, '...'));
      engine.ingest(makeTextChunk(3, 'answer'));
      engine.ingest(makeToolCall(4, 'tc1', 'running'));
      engine.ingest(makeToolCallUpdate(5, 'tc1', 'done'));
      engine.ingest(makeTextChunk(6, 'after tool'));
      engine.ingest(makeTurnComplete(7));

      const snap = engine.snapshot();
      // thought + text("answer") + tool + text("after tool") + turn_complete
      expect(snap.compactedTurns).toHaveLength(5);

      const thoughtData = snap.compactedTurns[0]!.data as {
        update: { sessionUpdate: string; content: { text: string } };
      };
      expect(thoughtData.update.sessionUpdate).toBe('agent_thought_chunk');
      expect(thoughtData.update.content.text).toBe('thinking...');
    });
  });
});

describe('transcript record provenance compaction', () => {
  function updateOf(event: BridgeEvent): Record<string, unknown> {
    return (event.data as { update: Record<string, unknown> }).update;
  }

  function withSources(
    event: BridgeEvent,
    sourceRecordIds: string[],
  ): BridgeEvent {
    const update = (event.data as { update: Record<string, unknown> }).update;
    update['_meta'] = { qwenTranscript: { sourceRecordIds } };
    return event;
  }

  it('merges text within one record but not across record boundaries', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(withSources(makeTextChunk(1, 'one '), ['record-a']));
    engine.ingest(withSources(makeTextChunk(2, 'two'), ['record-a']));
    engine.ingest(withSources(makeTextChunk(3, 'three'), ['record-b']));
    engine.ingest(makeTurnComplete(4));

    const textEvents = engine
      .snapshot()
      .compactedTurns.filter(
        (event) =>
          event.type === 'session_update' &&
          updateOf(event)['sessionUpdate'] === 'agent_message_chunk',
      );
    expect(
      textEvents.map(
        (event) => (updateOf(event)['content'] as { text: string }).text,
      ),
    ).toEqual(['one two', 'three']);
  });

  it('uses structured source identity for interleaved subagent chunks', () => {
    const engine = new TurnBoundaryCompactionEngine();
    const first = makeTextChunkWithParent(1, 'first', 'task::x');
    const second = makeTextChunkWithParent(2, 'second', 'task::x');
    engine.ingest(withSources(first, ['a::b', 'c']));
    engine.ingest(withSources(second, ['a', 'b::c']));
    engine.ingest(makeTurnComplete(3));

    const textEvents = engine
      .snapshot()
      .compactedTurns.filter(
        (event) =>
          event.type === 'session_update' &&
          updateOf(event)['sessionUpdate'] === 'agent_message_chunk',
      );
    expect(textEvents).toHaveLength(2);
  });

  it('unions tool start and result source ids in event order', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withSources(makeToolCall(1, '__proto__', 'running'), ['start-record']),
    );
    engine.ingest(
      withSources(makeToolCallUpdate(2, '__proto__', 'completed'), [
        'result-record',
        'start-record',
      ]),
    );
    engine.ingest(makeTurnComplete(3));

    const toolEvent = engine
      .snapshot()
      .compactedTurns.find(
        (event) =>
          event.type === 'session_update' &&
          updateOf(event)['toolCallId'] === '__proto__',
      );
    expect(updateOf(toolEvent!)['_meta']).toMatchObject({
      qwenTranscript: {
        sourceRecordIds: ['start-record', 'result-record'],
      },
    });
  });
});

describe('EventBus + CompactionEngine integration', () => {
  it('seedReplayEvents advances replay state without populating the ring or liveJournal', async () => {
    const engine = new TurnBoundaryCompactionEngine();
    const bus = new EventBus(100, undefined, engine);

    bus.seedReplayEvents([
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'loaded' },
          },
        },
        _meta: { serverTimestamp: 1_700_000_000_000 },
      },
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'history' },
          },
        },
      },
    ]);

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.lastEventId).toBe(2);
    expect(snapshot.compactedTurns).toHaveLength(2);
    expect(snapshot.liveJournal).toHaveLength(0);
    expect(snapshot.compactedTurns[0]!._meta?.['serverTimestamp']).toBe(
      1_700_000_000_000,
    );

    const iterator = bus.subscribe({ lastEventId: 0 })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({
      type: 'state_resync_required',
      data: {
        reason: 'seeded_replay_not_in_ring',
        lastDeliveredId: 0,
        earliestAvailableId: 3,
      },
    });
    await iterator.return?.();
  });

  it('seedReplayEvents emits a bounded compacted replay window with a truncation marker', () => {
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });
    const bus = new EventBus(100, undefined, engine);

    bus.seedReplayEvents([
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: `old-${'x'.repeat(600)}` },
          },
        },
      },
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `new-${'y'.repeat(600)}` },
          },
        },
      },
    ]);

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.lastEventId).toBe(2);
    expect(snapshot.liveJournal).toHaveLength(0);
    expect(snapshot.compactedTurns[0]?.type).toBe('history_truncated');
    expect(extractTexts(snapshot.compactedTurns)).toEqual([
      `new-${'y'.repeat(600)}`,
    ]);
    expect(snapshot.compactedTurns[0]?.data).toMatchObject({
      reason: 'replay_window_exceeded',
      truncatedEvents: 1,
      retainedEvents: 1,
      maxBytes: 512,
      fullTranscriptAvailable: true,
    });
    expect(
      (snapshot.compactedTurns[0]?.data as Record<string, unknown>)[
        'truncatedTurns'
      ],
    ).toBeUndefined();
  });

  it('seedReplayEvents evicts whole persisted records', () => {
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });
    const bus = new EventBus(100, undefined, engine);
    const update = (recordId: string, text: string) => ({
      type: 'session_update' as const,
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${text}-${'x'.repeat(600)}` },
          _meta: { 'qwen.session.recordId': recordId },
        },
      },
    });

    bus.seedReplayEvents([
      update('old-record', 'old-1'),
      update('old-record', 'old-2'),
      update('new-record', 'new-1'),
      update('new-record', 'new-2'),
    ]);

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.compactedTurns[0]?.type).toBe('history_truncated');
    expect(extractTexts(snapshot.compactedTurns)).toEqual([
      `new-1-${'x'.repeat(600)}`,
      `new-2-${'x'.repeat(600)}`,
    ]);
    expect(snapshot.compactedTurns[0]?.data).toMatchObject({
      truncatedEvents: 2,
      retainedEvents: 2,
      // Last-seen recordId before the retained window — `new-record`
      // lives inside the retained window, so it's also the last-seen
      // value across the whole seed. Stamped as a pagination anchor so
      // the client can issue `beforeRecordId: 'new-record'` even when
      // no session_update on the retained suffix carries one.
      recordId: 'new-record',
    });
  });

  it('seedReplayEvents marker carries recordId from evicted head when retained records lack one', () => {
    // Critical regression case: only the EVICTED records carry a
    // recordId. The retained suffix has no recordId-bearing events. The
    // pre-scan must still capture the evicted recordId so the marker
    // ships with a pagination anchor — otherwise the client has no way
    // to page the transcript backward.
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });
    const bus = new EventBus(100, undefined, engine);
    bus.seedReplayEvents([
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `old-${'x'.repeat(600)}` },
            _meta: { 'qwen.session.recordId': 'evicted-record' },
          },
        },
      },
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `new-${'y'.repeat(600)}` },
          },
        },
      },
    ]);
    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.compactedTurns[0]?.type).toBe('history_truncated');
    expect(snapshot.compactedTurns[0]?.data).toMatchObject({
      truncatedEvents: 1,
      recordId: 'evicted-record',
    });
  });

  it('replay marker anchor is not advanced by post-seed ingest', () => {
    // Critical regression: seed with evicted + retained events carrying
    // distinct recordIds, then ingest a new turn boundary. The replay
    // marker must carry the eviction-time anchor (the retained window's
    // earliest recordId), NOT the post-ingest activeRecordId — otherwise
    // the client's `beforeRecordId` re-fetches records already displayed.
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });
    const bus = new EventBus(100, undefined, engine);
    bus.seedReplayEvents([
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `old-${'x'.repeat(600)}` },
            _meta: { 'qwen.session.recordId': 'record-evicted' },
          },
        },
      },
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `new-${'y'.repeat(600)}` },
            _meta: { 'qwen.session.recordId': 'record-retained' },
          },
        },
      },
    ]);
    // Post-seed ingest advances activeRecordId past the eviction boundary.
    engine.ingest({
      id: 10,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'post-seed' },
          _meta: { 'qwen.session.recordId': 'record-post-seed' },
        },
      },
    });
    engine.ingest({
      id: 11,
      v: 1,
      type: 'turn_complete',
      data: {},
    });

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.compactedTurns[0]?.type).toBe('history_truncated');
    // The replay marker carries the eviction-time anchor, not the
    // post-ingest 'record-post-seed'.
    expect(snapshot.compactedTurns[0]?.data).toMatchObject({
      recordId: 'record-retained',
    });
  });

  it('replay marker anchor is the first retained recordId, not the last overall', () => {
    // Critical regression (review): when the retained window holds
    // MULTIPLE recordIds, the anchor must be the FIRST retained one (the
    // eviction boundary). Anchoring on the last recordId across all seed
    // events — which a retained segment may carry — puts `beforeRecordId`
    // inside the retained window and re-fetches records the client
    // already displays, duplicating transcript blocks (prepend has no
    // dedup at the daemon boundary).
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 900 });
    const bus = new EventBus(100, undefined, engine);
    const segment = (recordId: string, pad: string) => ({
      type: 'session_update' as const,
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${pad}-${'z'.repeat(300)}` },
          _meta: { 'qwen.session.recordId': recordId },
        },
      },
    });
    // Three ~330B segments (total ~990 > 900): the first evicts, leaving
    // rec-B (first retained) and rec-C (last overall) in the window.
    bus.seedReplayEvents([
      segment('rec-A', 'a'),
      segment('rec-B', 'b'),
      segment('rec-C', 'c'),
    ]);

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.compactedTurns[0]?.type).toBe('history_truncated');
    expect(snapshot.compactedTurns[0]?.data).toMatchObject({
      recordId: 'rec-B',
    });
  });

  it('seed pre-scans compactedTurns for recordId anchor', () => {
    // Suggestion regression: seed() must pre-scan compactedTurns for
    // recordIds (mirroring seedReplayEvents) so eviction doesn't lose
    // the only anchor.
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });
    engine.seed({
      compactedTurns: [
        {
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `old-${'x'.repeat(600)}` },
              _meta: { 'qwen.session.recordId': 'seed-anchor' },
            },
          },
        },
        {
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `new-${'y'.repeat(600)}` },
            },
          },
        },
      ],
      lastEventId: 2,
    });

    const snap = engine.snapshot();
    expect(snap.compactedTurns[0]?.type).toBe('history_truncated');
    expect(snap.compactedTurns[0]?.data).toMatchObject({
      truncatedEvents: 1,
      recordId: 'seed-anchor',
    });
  });

  it('seedReplayEvents replaces prior replay and truncation state', () => {
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 512 });
    const bus = new EventBus(100, undefined, engine);

    bus.seedReplayEvents([
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `old-${'x'.repeat(600)}` },
          },
        },
      },
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `drop-${'y'.repeat(600)}` },
          },
        },
      },
    ]);
    expect(bus.snapshotReplay()!.compactedTurns[0]?.type).toBe(
      'history_truncated',
    );

    bus.seedReplayEvents([
      {
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fresh' },
          },
        },
      },
    ]);

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.lastEventId).toBe(3);
    expect(snapshot.liveJournal).toHaveLength(0);
    expect(snapshot.compactedTurns).toHaveLength(1);
    expect(snapshot.compactedTurns[0]?.type).toBe('session_update');
    expect(snapshot.compactedTurns[0]?.id).toBe(3);
    expect(extractTexts(snapshot.compactedTurns)).toEqual(['fresh']);
  });

  it('seedReplayEvents treats event sizing failures as zero bytes', () => {
    const engine = new TurnBoundaryCompactionEngine({ maxReplayBytes: 1 });
    const bus = new EventBus(100, undefined, engine);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      expect(() =>
        bus.seedReplayEvents([
          { type: 'seeded_misc', data: circular },
          {
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'tail' },
              },
            },
          },
        ]),
      ).not.toThrow();

      const snapshot = bus.snapshotReplay()!;
      expect(snapshot.compactedTurns[0]?.type).toBe('history_truncated');
      expect(extractTexts(snapshot.compactedTurns)).toEqual(['tail']);
      expect(snapshot.compactedTurns[0]?.data).toMatchObject({
        truncatedEvents: 1,
        retainedEvents: 1,
        maxBytes: 1,
      });
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'qwen serve: EventBus event sizing failed {"type":"seeded_misc"}',
        ),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('seedReplayEvents keeps its never-throws contract when the compaction seed path fails', () => {
    const engine = {
      ingest: vi.fn(),
      seedReplayEvents: vi.fn(() => {
        throw new Error('seed boom');
      }),
      snapshot: vi.fn(() => ({
        compactedTurns: [],
        liveJournal: [],
        lastEventId: 0,
      })),
      close: vi.fn(),
    };
    const bus = new EventBus(100, undefined, engine);

    expect(() =>
      bus.seedReplayEvents([{ type: 'session_update', data: {} }]),
    ).not.toThrow();
    expect(bus.lastEventId).toBe(1);
  });

  it('snapshotReplay returns compacted state after publish + turn_complete', () => {
    const engine = new TurnBoundaryCompactionEngine();
    const bus = new EventBus(100, undefined, engine);

    bus.publish({
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    });
    bus.publish({
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });
    bus.publish({
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' there' },
        },
      },
    });
    bus.publish({ type: 'turn_complete', data: { stopReason: 'end_turn' } });

    const snapshot = bus.snapshotReplay();
    expect(snapshot).toBeDefined();
    expect(snapshot!.lastEventId).toBe(4);
    expect(snapshot!.compactedTurns).toHaveLength(3);
    expect(snapshot!.liveJournal).toHaveLength(0);

    const mergedText = snapshot!.compactedTurns[1]!.data as {
      update: { content: { text: string } };
    };
    expect(mergedText.update.content.text).toBe('Hi there');
    expect(snapshot!.compactedTurns[1]!._meta?.['serverTimestamp']).toEqual(
      expect.any(Number),
    );
  });

  it('snapshotReplay returns undefined when no engine is configured', () => {
    const bus = new EventBus(100);
    bus.publish({ type: 'session_update', data: {} });
    expect(bus.snapshotReplay()).toBeUndefined();
  });

  it('liveJournal contains bounded replay events for incomplete turn', () => {
    const engine = new TurnBoundaryCompactionEngine();
    const bus = new EventBus(100, undefined, engine);

    bus.publish({
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'streaming' },
        },
      },
    });
    bus.publish({
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '...' },
        },
      },
    });

    const snapshot = bus.snapshotReplay()!;
    expect(snapshot.compactedTurns).toHaveLength(0);
    expect(snapshot.liveJournal).toHaveLength(1);
    expect(extractTexts(snapshot.liveJournal)).toEqual(['streaming...']);
    expect(snapshot.liveJournal[0]?.id).toBe(2);
    expect(snapshot.lastEventId).toBe(2);
  });

  it('compaction engine is closed when bus closes', () => {
    const engine = new TurnBoundaryCompactionEngine();
    const bus = new EventBus(100, undefined, engine);

    bus.publish({
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'test' },
        },
      },
    });
    bus.close();

    const snapshot = engine.snapshot();
    expect(snapshot.compactedTurns).toHaveLength(0);
    expect(snapshot.liveJournal).toHaveLength(0);
  });
});

describe('parentToolCallId-aware text merging', () => {
  type UpdatePayload = {
    update: {
      sessionUpdate: string;
      content: { text: string };
      _meta?: Record<string, unknown>;
    };
  };

  function getUpdate(event: BridgeEvent): UpdatePayload['update'] {
    return (event.data as UpdatePayload).update;
  }

  it('separates text chunks with different parentToolCallIds', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'Agent A says ', 'task-A'));
    engine.ingest(makeTextChunkWithParent(2, 'Agent B says ', 'task-B'));
    engine.ingest(makeTextChunkWithParent(3, 'hello', 'task-A'));
    engine.ingest(makeTextChunkWithParent(4, 'world', 'task-B'));
    engine.ingest(makeTurnComplete(5));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(2);
    expect(getUpdate(textEvents[0]!).content.text).toBe('Agent A says hello');
    expect(getUpdate(textEvents[1]!).content.text).toBe('Agent B says world');
    expect(getUpdate(textEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
    expect(getUpdate(textEvents[1]!)._meta?.['parentToolCallId']).toBe(
      'task-B',
    );
  });

  it('merges interleaved thought chunks with the same parentToolCallId', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeThoughtChunkWithParent(1, 'A thinks ', 'task-A'));
    engine.ingest(makeThoughtChunkWithParent(2, 'B thinks ', 'task-B'));
    engine.ingest(makeThoughtChunkWithParent(3, 'more', 'task-A'));
    engine.ingest(makeThoughtChunkWithParent(4, 'more', 'task-B'));
    engine.ingest(makeTurnComplete(5));

    const snap = engine.snapshot();
    const thoughtEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_thought_chunk',
    );
    expect(thoughtEvents).toHaveLength(2);
    expect(getUpdate(thoughtEvents[0]!).content.text).toBe('A thinks more');
    expect(getUpdate(thoughtEvents[1]!).content.text).toBe('B thinks more');
    expect(getUpdate(thoughtEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
    expect(getUpdate(thoughtEvents[1]!)._meta?.['parentToolCallId']).toBe(
      'task-B',
    );
  });

  it('does not merge top-level text with subagent text', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunk(1, 'Top-level '));
    engine.ingest(makeTextChunkWithParent(2, 'subagent ', 'task-A'));
    engine.ingest(makeTextChunk(3, 'more top'));
    engine.ingest(makeTurnComplete(4));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(3);
    expect(getUpdate(textEvents[0]!).content.text).toBe('Top-level ');
    expect(getUpdate(textEvents[1]!).content.text).toBe('subagent ');
    expect(getUpdate(textEvents[2]!).content.text).toBe('more top');
    expect(getUpdate(textEvents[0]!)._meta).toBeUndefined();
    expect(getUpdate(textEvents[1]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
    expect(getUpdate(textEvents[2]!)._meta).toBeUndefined();
  });

  it('same subagent thought + text produce separate slots', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeThoughtChunkWithParent(1, 'thinking...', 'task-A'));
    engine.ingest(makeThoughtChunkWithParent(2, ' deeply', 'task-A'));
    engine.ingest(makeTextChunkWithParent(3, 'Answer: ', 'task-A'));
    engine.ingest(makeTextChunkWithParent(4, 'yes', 'task-A'));
    engine.ingest(makeTurnComplete(5));

    const snap = engine.snapshot();
    const sessionUpdates = snap.compactedTurns.filter(
      (e) => e.type === 'session_update',
    );
    expect(sessionUpdates).toHaveLength(2);

    const thought = sessionUpdates.find(
      (e) => getUpdate(e).sessionUpdate === 'agent_thought_chunk',
    )!;
    const text = sessionUpdates.find(
      (e) => getUpdate(e).sessionUpdate === 'agent_message_chunk',
    )!;
    expect(getUpdate(thought).content.text).toBe('thinking... deeply');
    expect(getUpdate(text).content.text).toBe('Answer: yes');
    expect(getUpdate(thought)._meta?.['parentToolCallId']).toBe('task-A');
    expect(getUpdate(text)._meta?.['parentToolCallId']).toBe('task-A');
  });

  it('same-parent tool call segments subagent text into separate slots', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunk(1, 'Before'));
    engine.ingest(makeTextChunkWithParent(2, 'sub-A part1', 'task-A'));
    // tool_call with parentToolCallId=task-A evicts task-A's text slot
    engine.ingest({
      id: 3,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc1',
          status: 'running',
          _meta: { parentToolCallId: 'task-A' },
        },
      },
    });
    engine.ingest(makeTextChunkWithParent(4, 'sub-A part2', 'task-A'));
    engine.ingest(makeTextChunk(5, 'After'));
    engine.ingest(makeTurnComplete(6));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(4);
    expect(getUpdate(textEvents[0]!).content.text).toBe('Before');
    expect(getUpdate(textEvents[1]!).content.text).toBe('sub-A part1');
    expect(getUpdate(textEvents[2]!).content.text).toBe('sub-A part2');
    expect(getUpdate(textEvents[3]!).content.text).toBe('After');
    expect(getUpdate(textEvents[1]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
    expect(getUpdate(textEvents[2]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
  });

  it('non-parent tool call does not evict subagent text slots', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'sub-A', 'task-A'));
    // tool_call WITHOUT parentToolCallId should not evict task-A
    engine.ingest(makeToolCall(2, 'tc1', 'running'));
    engine.ingest(makeTextChunkWithParent(3, ' more', 'task-A'));
    engine.ingest(makeTurnComplete(4));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(1);
    expect(getUpdate(textEvents[0]!).content.text).toBe('sub-A more');
    expect(getUpdate(textEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
  });

  it('same-parent tool call evicts thought slots too', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeThoughtChunkWithParent(1, 'thought-before', 'task-A'));
    engine.ingest({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc1',
          status: 'running',
          _meta: { parentToolCallId: 'task-A' },
        },
      },
    });
    engine.ingest(makeThoughtChunkWithParent(3, 'thought-after', 'task-A'));
    engine.ingest(makeTurnComplete(4));

    const snap = engine.snapshot();
    const thoughtEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_thought_chunk',
    );
    expect(thoughtEvents).toHaveLength(2);
    expect(getUpdate(thoughtEvents[0]!).content.text).toBe('thought-before');
    expect(getUpdate(thoughtEvents[1]!).content.text).toBe('thought-after');
  });

  it('[subA, main, main, subA] produces two merged events', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'A-start ', 'task-A'));
    engine.ingest(makeTextChunk(2, 'main-1 '));
    engine.ingest(makeTextChunk(3, 'main-2'));
    engine.ingest(makeTextChunkWithParent(4, 'A-end', 'task-A'));
    engine.ingest(makeTurnComplete(5));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(2);
    expect(getUpdate(textEvents[0]!).content.text).toBe('A-start A-end');
    expect(getUpdate(textEvents[1]!).content.text).toBe('main-1 main-2');
    expect(getUpdate(textEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
    expect(getUpdate(textEvents[1]!)._meta).toBeUndefined();
  });

  it('handles 9 parallel subagent thought streams without garbling', () => {
    const engine = new TurnBoundaryCompactionEngine();
    const subagents = Array.from({ length: 9 }, (_, i) => `task-${i}`);
    let eventId = 1;

    for (let round = 0; round < 3; round++) {
      for (const taskId of subagents) {
        engine.ingest(
          makeThoughtChunkWithParent(eventId++, `[${taskId}:${round}]`, taskId),
        );
      }
    }
    engine.ingest(makeTurnComplete(eventId));

    const snap = engine.snapshot();
    const thoughtEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_thought_chunk',
    );
    expect(thoughtEvents).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      const taskId = `task-${i}`;
      const update = getUpdate(thoughtEvents[i]!);
      expect(update.content.text).toBe(
        `[${taskId}:0][${taskId}:1][${taskId}:2]`,
      );
      expect(update._meta?.['parentToolCallId']).toBe(taskId);
    }
  });

  it('chunk without parentToolCallId separates from subagent chunk into top-level path', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'hello ', 'task-A'));
    engine.ingest({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
          _meta: { usage: { inputTokens: 100 } },
        },
      },
    });
    engine.ingest(makeTurnComplete(3));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    // The chunk without parentToolCallId goes to the top-level path,
    // so we get two separate events
    expect(textEvents).toHaveLength(2);
    expect(getUpdate(textEvents[0]!).content.text).toBe('hello ');
    expect(getUpdate(textEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
    expect(getUpdate(textEvents[1]!).content.text).toBe('world');
  });

  it('tool_call_update does not evict subagent text slots', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'part1', 'task-A'));
    // First tool_call creates the tool block — evicts task-A
    engine.ingest({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc1',
          status: 'running',
          _meta: { parentToolCallId: 'task-A' },
        },
      },
    });
    engine.ingest(makeTextChunkWithParent(3, 'part2', 'task-A'));
    // tool_call_update is a status update, not a new tool — should NOT evict
    engine.ingest({
      id: 4,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc1',
          status: 'completed',
          _meta: { parentToolCallId: 'task-A' },
        },
      },
    });
    engine.ingest(makeTextChunkWithParent(5, ' part3', 'task-A'));
    engine.ingest(makeTurnComplete(6));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    // part1 (evicted by tool_call), part2+part3 (merged, not evicted by update)
    expect(textEvents).toHaveLength(2);
    expect(getUpdate(textEvents[0]!).content.text).toBe('part1');
    expect(getUpdate(textEvents[1]!).content.text).toBe('part2 part3');
  });

  it('parentToolCallId survives in lastMeta through multi-chunk merge', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'hello ', 'task-A'));
    engine.ingest({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
          _meta: { parentToolCallId: 'task-A', usage: { inputTokens: 100 } },
        },
      },
    });
    engine.ingest(makeTurnComplete(3));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(1);
    expect(getUpdate(textEvents[0]!).content.text).toBe('hello world');
    expect(getUpdate(textEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
  });

  it('single subagent chunk preserves parentToolCallId in output', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunkWithParent(1, 'hello', 'task-A'));
    engine.ingest(makeTurnComplete(2));

    const snap = engine.snapshot();
    const textEvents = snap.compactedTurns.filter(
      (e) =>
        e.type === 'session_update' &&
        getUpdate(e).sessionUpdate === 'agent_message_chunk',
    );
    expect(textEvents).toHaveLength(1);
    expect(getUpdate(textEvents[0]!)._meta?.['parentToolCallId']).toBe(
      'task-A',
    );
  });
});

describe('turn attribution preservation (DAEMON-007)', () => {
  /**
   * Stamp top-level prompt/originator attribution and/or a `data.sessionId`
   * onto a factory-built event, mirroring what the bridge publishes.
   */
  function withAttribution(
    event: BridgeEvent,
    attrs: {
      promptId?: string;
      originatorClientId?: string;
      sessionId?: string;
    },
  ): BridgeEvent {
    const out: BridgeEvent = { ...event };
    if (attrs.promptId !== undefined) out.promptId = attrs.promptId;
    if (attrs.originatorClientId !== undefined) {
      out.originatorClientId = attrs.originatorClientId;
    }
    if (attrs.sessionId !== undefined) {
      out.data = {
        sessionId: attrs.sessionId,
        ...(event.data as Record<string, unknown>),
      };
    }
    return out;
  }

  function compactedUpdates(
    engine: TurnBoundaryCompactionEngine,
    sessionUpdate: string,
  ): BridgeEvent[] {
    return engine
      .snapshot()
      .compactedTurns.filter(
        (e) =>
          e.type === 'session_update' &&
          (e.data as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === sessionUpdate,
      );
  }

  it('merged text event keeps top-level promptId/originatorClientId and data.sessionId', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeTextChunk(1, 'hello '), {
        promptId: 'p1',
        originatorClientId: 'client-a',
        sessionId: 's-1',
      }),
    );
    engine.ingest(
      withAttribution(makeTextChunk(2, 'world'), {
        promptId: 'p1',
        originatorClientId: 'client-a',
        sessionId: 's-1',
      }),
    );
    engine.ingest(makeTurnComplete(3));

    const [merged] = compactedUpdates(engine, 'agent_message_chunk');
    expect(merged).toBeDefined();
    expect(merged!.promptId).toBe('p1');
    expect(merged!.originatorClientId).toBe('client-a');
    expect((merged!.data as { sessionId?: string }).sessionId).toBe('s-1');
    expect(
      (merged!.data as { update: { content: { text: string } } }).update.content
        .text,
    ).toBe('hello world');
  });

  it('merged thought event keeps attribution, latest chunk wins', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeThoughtChunk(1, 'thinking '), {
        promptId: 'p1',
        sessionId: 's-1',
      }),
    );
    // Later chunk carries a fresher stamp — the merged event must carry it.
    engine.ingest(
      withAttribution(makeThoughtChunk(2, 'harder'), {
        promptId: 'p2',
        originatorClientId: 'client-b',
        sessionId: 's-1',
      }),
    );
    engine.ingest(makeTurnComplete(3));

    const [merged] = compactedUpdates(engine, 'agent_thought_chunk');
    expect(merged!.promptId).toBe('p2');
    expect(merged!.originatorClientId).toBe('client-b');
    expect((merged!.data as { sessionId?: string }).sessionId).toBe('s-1');
  });

  it('keeps an earlier attribution when a later chunk carries none', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeTextChunk(1, 'a'), {
        promptId: 'p1',
        originatorClientId: 'client-a',
        sessionId: 's-1',
      }),
    );
    engine.ingest(makeTextChunk(2, 'b'));
    engine.ingest(makeTurnComplete(3));

    const [merged] = compactedUpdates(engine, 'agent_message_chunk');
    expect(merged!.promptId).toBe('p1');
    expect(merged!.originatorClientId).toBe('client-a');
    expect((merged!.data as { sessionId?: string }).sessionId).toBe('s-1');
  });

  it('merges turn fields independently when a later chunk carries only one', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeTextChunk(1, 'a'), {
        promptId: 'p1',
        originatorClientId: 'client-a',
      }),
    );
    // Second chunk carries only promptId — originatorClientId must survive
    // from the earlier capture (field-level merge, not atomic replacement).
    engine.ingest(withAttribution(makeTextChunk(2, 'b'), { promptId: 'p2' }));
    engine.ingest(makeTurnComplete(3));

    const [merged] = compactedUpdates(engine, 'agent_message_chunk');
    expect(merged!.promptId).toBe('p2');
    expect(merged!.originatorClientId).toBe('client-a');
  });

  it('merges turn fields independently in the subagent path', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeTextChunkWithParent(1, 'sub ', 'task-A'), {
        promptId: 'p1',
        originatorClientId: 'client-a',
      }),
    );
    engine.ingest(
      withAttribution(makeTextChunkWithParent(2, 'agent', 'task-A'), {
        originatorClientId: 'client-b',
      }),
    );
    engine.ingest(makeTurnComplete(3));

    const [merged] = compactedUpdates(engine, 'agent_message_chunk');
    expect(merged!.promptId).toBe('p1');
    expect(merged!.originatorClientId).toBe('client-b');
  });

  it('subagent (parentToolCallId) merge path also preserves attribution', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeTextChunkWithParent(1, 'sub ', 'task-A'), {
        promptId: 'p1',
        sessionId: 's-1',
      }),
    );
    engine.ingest(
      withAttribution(makeTextChunkWithParent(2, 'agent', 'task-A'), {
        promptId: 'p1',
        sessionId: 's-1',
      }),
    );
    engine.ingest(makeTurnComplete(3));

    const [merged] = compactedUpdates(engine, 'agent_message_chunk');
    expect(merged!.promptId).toBe('p1');
    expect((merged!.data as { sessionId?: string }).sessionId).toBe('s-1');
  });

  it('folded tool_call keeps latest promptId/originatorClientId and data.sessionId', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeToolCall(1, 'tc1', 'running', { title: 'Read' }), {
        promptId: 'p1',
        originatorClientId: 'client-a',
        sessionId: 's-1',
      }),
    );
    engine.ingest(
      withAttribution(makeToolCallUpdate(2, 'tc1', 'done'), {
        promptId: 'p1',
        originatorClientId: 'client-a',
        sessionId: 's-1',
      }),
    );
    engine.ingest(makeTurnComplete(3));

    const [folded] = compactedUpdates(engine, 'tool_call');
    expect(folded!.promptId).toBe('p1');
    expect(folded!.originatorClientId).toBe('client-a');
    expect((folded!.data as { sessionId?: string }).sessionId).toBe('s-1');
    expect((folded!.data as { update: { status: string } }).update.status).toBe(
      'done',
    );
  });

  it('folded tool_call falls back to the existing stamp when the update carries none', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(
      withAttribution(makeToolCall(1, 'tc1', 'running'), {
        promptId: 'p1',
        originatorClientId: 'client-a',
      }),
    );
    engine.ingest(makeToolCallUpdate(2, 'tc1', 'done'));
    engine.ingest(makeTurnComplete(3));

    const [folded] = compactedUpdates(engine, 'tool_call');
    expect(folded!.promptId).toBe('p1');
    expect(folded!.originatorClientId).toBe('client-a');
  });

  it('does not invent attribution fields when source events carry none', () => {
    const engine = new TurnBoundaryCompactionEngine();
    engine.ingest(makeTextChunk(1, 'hello '));
    engine.ingest(makeTextChunk(2, 'world'));
    engine.ingest(makeToolCall(3, 'tc1', 'running'));
    engine.ingest(makeToolCallUpdate(4, 'tc1', 'done'));
    engine.ingest(makeTurnComplete(5));

    const [mergedText] = compactedUpdates(engine, 'agent_message_chunk');
    expect('promptId' in mergedText!).toBe(false);
    expect('originatorClientId' in mergedText!).toBe(false);
    expect('sessionId' in (mergedText!.data as object)).toBe(false);

    const [folded] = compactedUpdates(engine, 'tool_call');
    expect('promptId' in folded!).toBe(false);
    expect('originatorClientId' in folded!).toBe(false);
    expect('sessionId' in (folded!.data as object)).toBe(false);
  });
});
