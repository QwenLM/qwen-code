import { describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  redactWorkflowModeFromConfigOptions,
  redactWorkflowModeFromSessionState,
  redactWorkflowsFromAvailableCommandsEvent,
  redactWorkflowsFromReplayArrays,
} from './workflow-session-gate.js';

const configOptions = [
  { id: 'model', currentValue: 'qwen' },
  {
    id: 'workflow_mode',
    currentValue: 'off',
    _meta: {
      'qwen.workflowMode': { available: false, effective: false },
    },
  },
  { id: 'reasoning_effort', currentValue: 'high' },
];

describe('Workflow mode state redaction', () => {
  it('removes only mode and preserves unrelated state and option identities', () => {
    const state = { configOptions, _meta: { marker: 'preserved' } };
    const session = { sessionId: 's', state };
    const shaped = redactWorkflowModeFromSessionState(session);

    expect(shaped).toEqual({
      sessionId: 's',
      state: {
        configOptions: [configOptions[0], configOptions[2]],
        _meta: state._meta,
      },
    });
    expect(shaped.state.configOptions[0]).toBe(configOptions[0]);
    expect(shaped.state._meta).toBe(state._meta);
    expect(session.state).toBe(state);
    expect(state.configOptions).toHaveLength(3);
  });

  it('keeps absent, null and already-redacted option sets unchanged', () => {
    for (const state of [
      {},
      { configOptions: null },
      { configOptions: [configOptions[0]] },
    ]) {
      expect(redactWorkflowModeFromConfigOptions(state)).toBe(state);
    }
  });
});

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
  it.each([false, true])(
    'redacts mode updates (wrapped: %s) without changing shared events',
    (wrapped) => {
      const update = {
        sessionUpdate: 'config_option_update',
        configOptions,
        _meta: { marker: 'keep' },
      };
      const event = {
        v: 1,
        type: 'session_update',
        data: wrapped ? { sessionId: 's', update } : update,
      };
      const shaped = redactWorkflowsFromAvailableCommandsEvent(event);
      const expectedUpdate = {
        ...update,
        configOptions: [configOptions[0], configOptions[2]],
      };
      expect(shaped.data).toEqual(
        wrapped ? { sessionId: 's', update: expectedUpdate } : expectedUpdate,
      );
      expect(update.configOptions).toHaveLength(3);
    },
  );

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
  it('redacts state and every replay lane, including state without replay arrays', () => {
    const update: BridgeEvent = {
      v: 1,
      type: 'session_update',
      data: { sessionUpdate: 'config_option_update', configOptions },
    };
    const session = {
      state: { configOptions },
      compactedReplay: [update],
      liveJournal: [update],
      lifecycleReplay: [update],
    };
    const expected = [configOptions[0], configOptions[2]];
    const shaped = redactWorkflowsFromReplayArrays(session);
    expect(shaped.state.configOptions).toEqual(expected);
    for (const lane of [
      shaped.compactedReplay,
      shaped.liveJournal,
      shaped.lifecycleReplay,
    ]) {
      expect(lane[0].data).toEqual({
        sessionUpdate: 'config_option_update',
        configOptions: expected,
      });
    }
    expect(
      redactWorkflowsFromReplayArrays({ state: session.state }).state
        .configOptions,
    ).toEqual(expected);
    expect(session.state.configOptions).toHaveLength(3);
  });

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
