import { describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  redactWorkflowsFromAvailableCommandsEvent,
  redactWorkflowsFromSupportedCommands,
  redactWorkflowsFromReplayArrays,
} from './workflow-session-gate.js';

interface CommandsData {
  sessionUpdate: string;
  availableCommands: Array<{ name: string; description: string }>;
}

interface WrappedEvent extends BridgeEvent {
  data: { sessionId: string; update: CommandsData };
}

interface FlatEvent extends BridgeEvent {
  data: CommandsData;
}

function wrappedCommandsEvent(): WrappedEvent {
  return {
    id: 1,
    v: 1,
    type: 'session_update',
    data: {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'workflows', description: 'Run workflows' },
          { name: 'init', description: 'Initialize' },
        ],
      },
    },
  };
}

function flatCommandsEvent(): FlatEvent {
  return {
    id: 2,
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'workflows', description: 'Run workflows' },
        { name: 'init', description: 'Initialize' },
      ],
    },
  };
}

describe('redactWorkflowsFromAvailableCommandsEvent', () => {
  it('removes workflows from wrapped frames without mutating the source', () => {
    const event = wrappedCommandsEvent();
    const shaped = redactWorkflowsFromAvailableCommandsEvent(event);

    expect(shaped.data.update.availableCommands).toEqual([
      { name: 'init', description: 'Initialize' },
    ]);
    expect(event.data.update.availableCommands).toHaveLength(2);
  });

  it('removes workflows from flat persisted-transcript frames', () => {
    const shaped =
      redactWorkflowsFromAvailableCommandsEvent(flatCommandsEvent());

    expect(shaped.data.availableCommands).toEqual([
      { name: 'init', description: 'Initialize' },
    ]);
  });

  it('passes through unrelated frames unchanged', () => {
    const event: BridgeEvent = {
      id: 3,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      },
    };

    expect(redactWorkflowsFromAvailableCommandsEvent(event)).toBe(event);
  });

  it('passes through command frames without workflows unchanged', () => {
    const event = wrappedCommandsEvent();
    event.data.update.availableCommands = [
      { name: 'init', description: 'Initialize' },
    ];

    expect(redactWorkflowsFromAvailableCommandsEvent(event)).toBe(event);
  });
});

describe('redactWorkflowsFromReplayArrays', () => {
  it('redacts both replay arrays without mutating them', () => {
    const compactedEvent = wrappedCommandsEvent();
    const journalEvent = flatCommandsEvent();
    const session = {
      sessionId: 'sess-1',
      compactedReplay: [compactedEvent],
      liveJournal: [journalEvent],
    };
    const shaped = redactWorkflowsFromReplayArrays(session);

    expect(
      (shaped.compactedReplay[0] as WrappedEvent).data.update.availableCommands,
    ).toEqual([{ name: 'init', description: 'Initialize' }]);
    expect((shaped.liveJournal[0] as FlatEvent).data.availableCommands).toEqual(
      [{ name: 'init', description: 'Initialize' }],
    );
    expect(compactedEvent.data.update.availableCommands).toHaveLength(2);
    expect(journalEvent.data.availableCommands).toHaveLength(2);
  });

  it('returns its input unchanged when no replay arrays are present', () => {
    const session = { sessionId: 'sess-1', compactedReplay: undefined };
    expect(redactWorkflowsFromReplayArrays(session)).toBe(session);
  });
});

describe('structured workflow capability trust gate', () => {
  it('removes structured run capability on an untrusted workspace', () => {
    expect(
      redactWorkflowsFromSupportedCommands({
        v: 1,
        sessionId: 's-1',
        availableCommands: [],
        availableSkills: [],
        workflowsEnabled: true,
        workflowRunV1: true,
      }),
    ).toMatchObject({ workflowsEnabled: false, workflowRunV1: false });
  });
});
