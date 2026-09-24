import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonEvent,
  DaemonSessionToolCalls,
} from '@qwen-code/sdk/daemon';
import transcriptPage from '../../trajectory/__fixtures__/transcript-page.json' with { type: 'json' };
import { loadTurnCalls } from './loadTurnCalls';

const recordedEvents = transcriptPage.events as unknown as DaemonEvent[];
const recordId = 'd18a3a3b-0648-4dfb-a6c9-b4ea9e9fc6b1';

function response(
  events: DaemonEvent[],
  turnId = recordId,
): DaemonSessionToolCalls {
  return { v: 1, sessionId: 'session', turnId, events };
}

function user(id: string, source?: string): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: id },
      _meta: {
        ...(source ? { source } : {}),
        qwenTranscript: { sourceRecordIds: [id], segmentId: `${id}:0` },
        'qwen.session.recordId': id,
      },
    },
  };
}

function tool(id: string, parentToolCallId?: string): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      status: 'completed',
      title: 'ReadFile: file.txt',
      rawInput: { file_path: 'file.txt' },
      _meta: {
        toolName: 'read_file',
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    },
  };
}

describe('loadTurnCalls', () => {
  it('reads the complete turn once and pairs completion and timing without mixing the next turn', async () => {
    const readCalls = vi
      .fn()
      .mockResolvedValue(
        response([...recordedEvents, user('next'), tool('other-turn')]),
      );
    const rows = await loadTurnCalls(readCalls, recordId);
    expect(readCalls.mock.calls).toEqual([[]]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.block.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(rows.map((row) => row.timing?.durationMs)).toEqual([35, 20]);
    expect(rows.map((row) => row.toolStatus)).toEqual(['success', 'success']);
  });

  it('preserves an explicit per-call start through SDK parsing and trajectory projection', async () => {
    const rows = await loadTurnCalls(
      async () =>
        response(
          [
            user('selected'),
            tool('call'),
            {
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '' },
                _meta: {
                  timing: {
                    kind: 'tool',
                    callId: 'call',
                    startedAt: 1_750_000_000_000,
                    durationMs: 4000,
                  },
                },
              },
            },
          ],
          'selected',
        ),
      'selected',
    );
    expect(rows[0]?.timing).toEqual({
      startedAt: 1_750_000_000_000,
      durationMs: 4000,
    });
  });

  it('retains calls after injected user messages and retains child depth without inventing timing', async () => {
    const readCalls = vi
      .fn()
      .mockResolvedValue(
        response(
          [
            user('selected'),
            tool('parent'),
            user('injected', 'mid_turn_message_injected'),
            tool('child', 'parent'),
            user('next'),
            tool('excluded'),
          ],
          'selected',
        ),
      );
    const rows = await loadTurnCalls(readCalls, 'selected');
    expect(rows.map((row) => [row.block.toolCallId, row.depth])).toEqual([
      ['parent', 0],
      ['child', 1],
    ]);
    expect(rows.every((row) => row.timing === undefined)).toBe(true);
  });

  it('loads a scheduled prompt whose anchor is a cron source block', async () => {
    const readCalls = vi
      .fn()
      .mockResolvedValue(
        response(
          [
            user('scheduled-record', 'cron'),
            tool('scheduled-call'),
            user('next'),
            tool('next-call'),
          ],
          'scheduled-record',
        ),
      );
    const rows = await loadTurnCalls(readCalls, 'scheduled-record');
    expect(rows.map((row) => row.block.toolCallId)).toEqual(['scheduled-call']);
    expect(readCalls.mock.calls).toEqual([[]]);
  });

  it('rejects a missing anchor instead of returning an empty turn', async () => {
    await expect(
      loadTurnCalls(
        async () => response([user('different')], 'selected'),
        'selected',
      ),
    ).rejects.toThrow('Turn not found');
  });

  it('rejects a response for another turn', async () => {
    await expect(
      loadTurnCalls(
        async () => response([user('selected')], 'different'),
        'selected',
      ),
    ).rejects.toThrow('Tool calls belong to another turn');
  });

  it('propagates API replay and size-limit failures instead of displaying an empty turn', async () => {
    const readCalls = vi
      .fn()
      .mockRejectedValue(new Error('Turn exceeds replay size limit'));
    await expect(loadTurnCalls(readCalls, 'selected')).rejects.toThrow(
      'Turn exceeds replay size limit',
    );
    expect(readCalls).toHaveBeenCalledTimes(1);
  });

  it('keeps a complete response larger than the former page size', async () => {
    const calls = Array.from({ length: 300 }, (_, index) =>
      tool(`call-${index}`),
    );
    const readCalls = vi
      .fn()
      .mockResolvedValue(response([user('selected'), ...calls], 'selected'));
    const rows = await loadTurnCalls(readCalls, 'selected');
    expect(rows.map((row) => row.block.toolCallId)).toEqual(
      calls.map((_, index) => `call-${index}`),
    );
    expect(readCalls.mock.calls).toEqual([[]]);
  });
});

it('retains full nesting depth and zero durations in historical calls', async () => {
  const events = [
    user('selected'),
    tool('parent'),
    tool('child', 'parent'),
    tool('grandchild', 'child'),
  ];
  events.push({
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        timing: {
          kind: 'tool',
          callId: 'parent',
          toolName: 'read_file',
          durationMs: 0,
          startedAt: 1000,
          toolStatus: 'success',
        },
      },
    },
  });
  const rows = await loadTurnCalls(
    async () => response(events, 'selected'),
    'selected',
  );
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
  expect(rows[0].timing).toMatchObject({ durationMs: 0, startedAt: 1000 });
});
