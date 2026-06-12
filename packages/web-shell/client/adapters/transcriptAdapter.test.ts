import { describe, expect, it } from 'vitest';
import type {
  DaemonTranscriptBlock,
  DaemonTranscriptState,
} from '@qwen-code/webui/daemon-react-sdk';
import { extractPendingPermission } from './transcriptAdapter';

function state(blocks: DaemonTranscriptBlock[]): DaemonTranscriptState {
  return {
    blocks,
    blockIndexById: Object.fromEntries(
      blocks.map((block, index) => [block.id, index]),
    ),
    toolBlockByCallId: {},
    trimmedToolNotificationByCallId: {},
    permissionBlockByRequestId: {},
    toolProgress: {},
    nextOrdinal: blocks.length,
    now: Date.now(),
    maxBlocks: 1000,
    awaitingResync: false,
    resyncRequiredCount: 0,
  };
}

describe('extractPendingPermission', () => {
  it('extracts pending AskUserQuestion options and raw input', () => {
    const permission = {
      id: 'perm-1',
      kind: 'permission',
      requestId: 'request-1',
      sessionId: 'session-1',
      title: 'Ask user 1 question',
      options: [
        {
          optionId: 'proceed_once',
          label: 'Submit',
          raw: { kind: 'allow_once', name: 'Submit' },
        },
        {
          optionId: 'cancel',
          label: 'Cancel',
          raw: { kind: 'reject_once', name: 'Cancel' },
        },
      ],
      toolCall: {
        rawInput: {
          questions: [
            {
              header: '姓名',
              question: '请问学生姓名是什么？',
              options: [{ label: '张三', description: '示例姓名' }],
            },
          ],
        },
      },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
    } as DaemonTranscriptBlock;

    expect(extractPendingPermission(state([permission]).blocks)).toMatchObject({
      id: 'request-1',
      sessionId: 'session-1',
      title: 'Ask user 1 question',
      options: [
        { id: 'proceed_once', label: 'Submit', kind: 'allow_once' },
        { id: 'cancel', label: 'Cancel', kind: 'reject_once' },
      ],
      rawInput: {
        questions: [
          {
            header: '姓名',
            question: '请问学生姓名是什么？',
            options: [{ label: '张三', description: '示例姓名' }],
          },
        ],
      },
    });
  });

  it('extracts toolCallId from toolCall.toolCallId', () => {
    const permission = {
      id: 'perm-tc1',
      kind: 'permission',
      sessionId: 'session-1',
      requestId: 'request-tc1',
      resolved: undefined,
      title: 'Bash: ls',
      options: [{ optionId: 'allow', label: 'Allow', raw: {} }],
      toolCall: { toolCallId: 'call-abc', rawInput: {} },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    } as DaemonTranscriptBlock;

    const result = extractPendingPermission(state([permission]).blocks);
    expect(result?.toolCallId).toBe('call-abc');
  });

  it('falls back to toolCall.id when toolCallId is absent', () => {
    const permission = {
      id: 'perm-tc2',
      kind: 'permission',
      sessionId: 'session-1',
      requestId: 'request-tc2',
      resolved: undefined,
      title: 'Bash: pwd',
      options: [{ optionId: 'allow', label: 'Allow', raw: {} }],
      toolCall: { id: 'call-xyz', rawInput: {} },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    } as DaemonTranscriptBlock;

    const result = extractPendingPermission(state([permission]).blocks);
    expect(result?.toolCallId).toBe('call-xyz');
  });

  it('returns undefined toolCallId when toolCall has neither field', () => {
    const permission = {
      id: 'perm-tc3',
      kind: 'permission',
      sessionId: 'session-1',
      requestId: 'request-tc3',
      resolved: undefined,
      title: 'Read: file',
      options: [{ optionId: 'allow', label: 'Allow', raw: {} }],
      toolCall: { rawInput: {} },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    } as DaemonTranscriptBlock;

    const result = extractPendingPermission(state([permission]).blocks);
    expect(result?.toolCallId).toBeUndefined();
  });
});
