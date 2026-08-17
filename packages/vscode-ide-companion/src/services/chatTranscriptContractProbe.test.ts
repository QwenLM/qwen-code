import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  probeAcpTranscriptUpdates,
  probeDirectDaemonTranscript,
} from './chatTranscriptContractProbe.js';

const context = { scopeKey: 'session-a:main', generation: 2 } as const;

function textEvent(
  id: number,
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk',
  text: string,
  segmentId = `event-${id}:0`,
): DaemonEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate,
        content: { type: 'text', text },
        _meta: { qwenTranscript: { segmentId } },
      },
    },
  };
}

describe('chat transcript contract probes', () => {
  it('keeps direct-daemon identity stable under prepend', () => {
    const tail = probeDirectDaemonTranscript(
      [textEvent(20, 'agent_message_chunk', 'answer')],
      context,
      context,
    );
    const prepended = probeDirectDaemonTranscript(
      [
        textEvent(10, 'user_message_chunk', 'request'),
        textEvent(20, 'agent_message_chunk', 'answer'),
      ],
      context,
      context,
    );

    expect(tail.diagnostics).toEqual([]);
    expect(prepended.diagnostics).toEqual([]);
    expect(prepended.model.blocks[1]?.id).toBe(tail.model.blocks[0]?.id);
    expect(prepended.identities[1]?.sourceIdentity).toEqual([
      'segmentId',
      'event-20:0',
    ]);
  });

  it('keeps one direct-daemon segment stable across append and partial replay', () => {
    const first = {
      ...textEvent(20, 'agent_message_chunk', 'first ', 'prompt-1:assistant:0'),
      promptId: 'prompt-1',
    };
    const second = {
      ...textEvent(21, 'agent_message_chunk', 'second', 'prompt-1:assistant:0'),
      promptId: 'prompt-1',
    };
    const firstOnly = probeDirectDaemonTranscript([first], context, context);
    const complete = probeDirectDaemonTranscript(
      [first, second],
      context,
      context,
    );
    const tailOnly = probeDirectDaemonTranscript([second], context, context);

    expect(complete.model.blocks).toHaveLength(1);
    expect(tailOnly.model.blocks).toHaveLength(1);
    expect(complete.model.blocks[0]?.id).toBe(tailOnly.model.blocks[0]?.id);
    expect(complete.model.blocks[0]?.id).toBe(firstOnly.model.blocks[0]?.id);
    expect(complete.diagnostics).toEqual([]);
    expect(tailOnly.diagnostics).toEqual([]);
  });

  it('uses the SDK normalizer/reducer as the ACP thin conversion', () => {
    const result = probeAcpTranscriptUpdates(
      [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'answer' },
          _meta: {
            qwenTranscript: { segmentId: 'record-1:0' },
          },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'completed',
          rawInput: { path: 'src/index.ts' },
          _meta: { toolName: 'read' },
        },
      ],
      context,
      context,
    );

    expect(result.model.blocks.map((block) => block.kind)).toEqual([
      'assistant',
      'tool',
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.identities).toMatchObject([
      { sourceIdentity: ['segmentId', 'record-1:0'] },
      { sourceIdentity: ['toolCallId', 'read-1'] },
    ]);
  });

  it('makes untagged ACP live text a blocking identity diagnostic', () => {
    const result = probeAcpTranscriptUpdates(
      [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'untagged answer' },
        },
      ],
      context,
      context,
    );

    expect(result.diagnostics).toContainEqual({
      code: 'stable_native_identity_missing',
      severity: 'error',
    });
  });

  it('keeps distinct tagged ACP segments stable under prepend', () => {
    const updates = ['first ', 'second'].map((text, index) => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      _meta: {
        qwenTranscript: {
          segmentId: `record-${index + 1}:0`,
          sourceRecordIds: [`record-${index + 1}`],
        },
      },
    }));
    const complete = probeAcpTranscriptUpdates(updates, context, context);
    const tailOnly = probeAcpTranscriptUpdates(
      updates.slice(1),
      context,
      context,
    );

    expect(complete.diagnostics).toEqual([]);
    expect(tailOnly.diagnostics).toEqual([]);
    expect(complete.model.blocks).toHaveLength(2);
    expect(tailOnly.model.blocks).toHaveLength(1);
    expect(complete.model.blocks[1]?.id).toBe(tailOnly.model.blocks[0]?.id);
    expect(complete.identities[1]?.sourceIdentity).toEqual(
      tailOnly.identities[0]?.sourceIdentity,
    );
  });

  it('prefers semantic segment identity over a replay-local event cursor', () => {
    const result = probeDirectDaemonTranscript(
      [
        {
          ...textEvent(20, 'agent_message_chunk', 'answer'),
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'answer' },
              _meta: { qwenTranscript: { segmentId: 'record-1:0' } },
            },
          },
        },
      ],
      context,
      context,
    );

    expect(result.identities[0]?.sourceIdentity).toEqual([
      'segmentId',
      'record-1:0',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('uses the native permission request identity', () => {
    const result = probeDirectDaemonTranscript(
      [
        {
          id: 30,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'permission-1',
            sessionId: 'session-a',
            toolCall: {
              toolCallId: 'read-1',
              name: 'read',
              rawInput: { path: 'src/index.ts' },
            },
            options: [{ optionId: 'allow' }],
          },
        },
      ],
      context,
      context,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.model.blocks).toHaveLength(1);
    expect(result.identities[0]?.sourceIdentity).toEqual([
      'requestId',
      'permission-1',
    ]);
  });

  it('fails closed when one source segment is reused for distinct blocks', () => {
    const result = probeDirectDaemonTranscript(
      [
        textEvent(20, 'agent_message_chunk', 'before', 'reused-segment'),
        {
          id: 21,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'read-1',
              title: 'Read',
              status: 'completed',
            },
          },
        },
        textEvent(22, 'agent_message_chunk', 'after', 'reused-segment'),
      ],
      context,
      context,
    );

    expect(result.diagnostics).toContainEqual({
      code: 'duplicate_stable_block_identity',
      severity: 'error',
    });
  });

  it('drops events from a stale scope generation', () => {
    const result = probeDirectDaemonTranscript(
      [textEvent(20, 'agent_message_chunk', 'late answer')],
      context,
      { ...context, generation: 3 },
    );

    expect(result.model.blocks).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'stale_scope_generation_ignored', severity: 'info' },
    ]);
  });
});
