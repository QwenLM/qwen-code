/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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
  (event.data as { update: Record<string, unknown> }).update._meta = {
    parentToolCallId,
  };
  return event;
}

function makeThoughtChunkWithParent(
  id: number,
  text: string,
  parentToolCallId: string,
): BridgeEvent {
  const event = makeThoughtChunk(id, text);
  (event.data as { update: Record<string, unknown> }).update._meta = {
    parentToolCallId,
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
      engine.ingest(makeToolCall(2, 'tc1', 'running', { title: 'Read file' }));
      engine.ingest(
        makeToolCallUpdate(3, 'tc1', 'running', {
          content: 'reading...',
        }),
      );
      engine.ingest(
        makeToolCallUpdate(4, 'tc1', 'done', {
          rawOutput: 'file contents',
        }),
      );
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
    it('accumulates raw events in liveJournal before turn completes', () => {
      const engine = new TurnBoundaryCompactionEngine();
      engine.ingest(makeTextChunk(1, 'H'));
      engine.ingest(makeTextChunk(2, 'i'));

      const snap = engine.snapshot();
      expect(snap.compactedTurns).toHaveLength(0);
      expect(snap.liveJournal).toHaveLength(2);
      expect(snap.lastEventId).toBe(2);
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

describe('EventBus + CompactionEngine integration', () => {
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
  });

  it('snapshotReplay returns undefined when no engine is configured', () => {
    const bus = new EventBus(100);
    bus.publish({ type: 'session_update', data: {} });
    expect(bus.snapshotReplay()).toBeUndefined();
  });

  it('liveJournal contains raw events for incomplete turn', () => {
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
    expect(snapshot.liveJournal).toHaveLength(2);
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
});
