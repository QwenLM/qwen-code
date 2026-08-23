import { describe, expect, it } from 'vitest';
import { adaptAcpTranscriptUpdates } from './acpTranscriptAdapter.js';

const scopeKey = 'workspace-a:session-a';

function textUpdate(text: string, segmentId?: string) {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(segmentId ? { _meta: { qwenTranscript: { segmentId } } } : {}),
  };
}

describe('ACP transcript adapter', () => {
  it('keeps stable identity under prepend', () => {
    const updates = [
      textUpdate('first', 'record-1:0'),
      textUpdate('second', 'record-2:0'),
    ];
    const complete = adaptAcpTranscriptUpdates(updates, scopeKey);
    const tail = adaptAcpTranscriptUpdates(updates.slice(1), scopeKey);

    expect(complete.compatible).toBe(true);
    expect(tail.compatible).toBe(true);
    expect(complete.blocks[1]?.id).toBe(tail.blocks[0]?.id);
  });

  it('keeps one streaming segment stable across partial replay', () => {
    const updates = [
      textUpdate('first ', 'prompt-1:assistant:0'),
      textUpdate('second', 'prompt-1:assistant:0'),
    ];
    const complete = adaptAcpTranscriptUpdates(updates, scopeKey);
    const tail = adaptAcpTranscriptUpdates(updates.slice(1), scopeKey);

    expect(complete.blocks).toHaveLength(1);
    expect(complete.blocks[0]?.id).toBe(tail.blocks[0]?.id);
  });

  it('falls back when text has no stable source identity', () => {
    const result = adaptAcpTranscriptUpdates(
      [textUpdate('untagged')],
      scopeKey,
    );

    expect(result.compatible).toBe(false);
  });

  it('uses toolCallId for tool identity', () => {
    const result = adaptAcpTranscriptUpdates(
      [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'completed',
          rawInput: { path: 'src/index.ts' },
          _meta: { toolName: 'read' },
        },
      ],
      scopeKey,
    );

    expect(result.compatible).toBe(true);
    expect(result.blocks[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'read-1',
    });
  });

  it('uses stamped identity for shell and image-only updates', () => {
    const result = adaptAcpTranscriptUpdates(
      [
        {
          sessionUpdate: 'shell_output',
          output: 'shell output',
          _meta: { qwenTranscript: { segmentId: 'shell-1' } },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'image', data: 'AA==', mimeType: 'image/png' },
          _meta: { qwenTranscript: { segmentId: 'image-1' } },
        },
      ],
      scopeKey,
    );

    expect(result.compatible).toBe(true);
    expect(result.blocks).toMatchObject([
      { kind: 'shell', segmentId: 'shell-1' },
      { kind: 'user', segmentId: 'image-1' },
    ]);
  });

  it('rejects a reused source identity for distinct blocks', () => {
    const result = adaptAcpTranscriptUpdates(
      [
        textUpdate('before', 'reused-segment'),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'completed',
        },
        textUpdate('after', 'reused-segment'),
      ],
      scopeKey,
    );

    expect(result.blocks).toHaveLength(3);
    expect(result.compatible).toBe(false);
  });

  it('does not silently trim long sessions at the SDK default block limit', () => {
    const updates = Array.from({ length: 1_001 }, (_, index) =>
      textUpdate(`block-${index}`, `record-${index}:0`),
    );

    const result = adaptAcpTranscriptUpdates(updates, scopeKey);

    expect(result.compatible).toBe(true);
    expect(result.blocks).toHaveLength(1_001);
  });
});
