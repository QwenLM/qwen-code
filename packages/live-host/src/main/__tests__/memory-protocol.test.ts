import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LiveMemoryAction,
  LiveMemoryResult,
  LiveMemoryState,
} from '../../../../qwen-live/src/host/types.ts';
import {
  encodeHostControlMessage,
  parseDaemonControlMessage,
  parseMemoryAction,
  parseMemoryState,
  type MemoryAction,
  type MemoryState,
} from '../../shared/protocol.ts';

const memory: MemoryState = {
  enabled: true,
  visualEnabled: false,
  libraryId: 'default',
  model: 'qwen3.7-plus',
  libraries: [{ id: 'default', name: 'Default' }],
  locked: false,
};
const daemonMemory: LiveMemoryState = memory;
const actions: LiveMemoryAction[] = [
  { action: 'set_enabled', enabled: false },
  { action: 'set_visual_enabled', enabled: true },
  { action: 'select', libraryId: 'work' },
  { action: 'create', name: 'Work' },
  { action: 'rename', libraryId: 'default', name: 'Personal' },
  { action: 'set_model', model: 'qwen3.7-plus' },
];

describe('memory protocol', () => {
  it('round-trips all management actions and authoritative state', () => {
    for (const action of actions) {
      const hostAction: MemoryAction = action;
      assert.deepEqual(parseMemoryAction(action), action);
      assert.deepEqual(
        JSON.parse(
          encodeHostControlMessage({
            type: 'host.memory_action',
            requestId: 'request-1',
            epoch: 3,
            ...hostAction,
          }),
        ),
        {
          type: 'host.memory_action',
          requestId: 'request-1',
          epoch: 3,
          ...action,
        },
      );
    }
    const result: LiveMemoryResult = {
      type: 'host.memory_result',
      requestId: 'request-1',
      ok: true,
      memory: daemonMemory,
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(result)), result);
    assert.deepEqual(parseMemoryState(memory), memory);
  });

  it('rejects unsafe or malformed actions, names, states, and incomplete results', () => {
    for (const action of [
      { action: 'select', libraryId: '../other' },
      { action: 'create', name: '   ' },
      { action: 'create', name: 'x'.repeat(81) },
      { action: 'rename', libraryId: 'default', name: 'bad\u0000name' },
      { action: 'set_enabled', enabled: 'true' },
      { action: 'set_model', model: '' },
      { action: 'remove', libraryId: 'default' },
    ]) {
      assert.equal(parseMemoryAction(action), undefined);
    }
    assert.deepEqual(parseMemoryAction({ action: 'create', name: ' 工作 ' }), {
      action: 'create',
      name: '工作',
    });
    assert.equal(parseMemoryState({ ...memory, locked: 'yes' }), undefined);
    assert.equal(
      parseMemoryState({
        ...memory,
        libraries: [
          { id: 'default', name: 'One' },
          { id: 'default', name: 'Two' },
        ],
      }),
      undefined,
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.memory_result',
          requestId: 'request-1',
          ok: true,
        }),
      ),
      undefined,
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.memory_result',
          requestId: 'request-1',
          ok: false,
          error: '',
        }),
      ),
      undefined,
    );
  });

  it('keeps memory optional for qwen serve and validates it when supplied', () => {
    const state = {
      type: 'host.state',
      epoch: 0,
      status: { v: 1, available: true, state: 'idle', shortcut: 'Command+Q' },
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(state)), state);
    assert.deepEqual(
      parseDaemonControlMessage(JSON.stringify({ ...state, memory })),
      { ...state, memory },
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({ ...state, memory: { enabled: true } }),
      ),
      undefined,
    );
  });
});
