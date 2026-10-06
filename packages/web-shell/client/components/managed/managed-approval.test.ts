import { describe, expect, it } from 'vitest';
import type { Message } from '../../adapters/types';
import type { ManagedAgentPendingAction } from './managed-agent-provider';
import { managedEventsToMessages } from './managed-session-messages';
import {
  findManagedApprovalTool,
  toManagedPermissionRequest,
} from './managed-approval';

const action: ManagedAgentPendingAction = {
  actionId: 'tool_approval_1',
  sessionId: 's1',
  turnId: 'turn-2',
  functionCallId: 'call-1',
  toolName: 'write_file',
  inputRevision: 1,
  policyRevision: 'hosted-tool-approval/1',
  expiresAt: 600_000,
  options: [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' },
    { id: 'later', label: 'Later' },
  ],
};

function toolGroup(turnId: string, callId: string): Message {
  return {
    id: `managed:s1:${turnId}:1`,
    role: 'tool_group',
    tools: [
      {
        callId: `${turnId}:${callId}`,
        toolName: 'write_file',
        status: 'pending',
        args: { file_path: 'notes.md', content: turnId },
      },
    ],
  } as Message;
}

describe('Managed approval presentation', () => {
  it('attaches the approval to its tool call in the Action Turn', () => {
    const messages = [
      toolGroup('turn-1', 'call-1'),
      toolGroup('turn-2', 'call-1'),
    ];
    expect(toManagedPermissionRequest(action, messages)).toEqual({
      id: 'tool_approval_1',
      sessionId: 's1',
      toolCallId: 'turn-2:call-1',
      toolName: 'write_file',
      title: 'write_file',
      content: [
        {
          type: 'text',
          text: '{\n  "file_path": "notes.md",\n  "content": "turn-2"\n}',
        },
      ],
      contentIsInput: true,
      rawInput: { file_path: 'notes.md', content: 'turn-2' },
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'reject_once' },
        { id: 'later', label: 'Later' },
      ],
    });
  });

  it('falls back to the latest matching call when the Turn is unresolved', () => {
    const { turnId: _turnId, ...unresolved } = action;
    const messages = [
      toolGroup('turn-1', 'call-1'),
      toolGroup('turn-2', 'call-1'),
    ];
    expect(findManagedApprovalTool(messages, unresolved)?.callId).toBe(
      'turn-2:call-1',
    );
    expect(findManagedApprovalTool([], unresolved)).toBeUndefined();
  });

  it('still presents an approval whose tool has not reached the transcript', () => {
    expect(toManagedPermissionRequest(action, [])).toMatchObject({
      toolCallId: 'turn-2:call-1',
      title: 'write_file',
    });
    const { turnId: _turnId, ...unresolved } = action;
    const request = toManagedPermissionRequest(unresolved, []);
    expect(request).not.toHaveProperty('toolCallId');
    expect(request).not.toHaveProperty('rawInput');
  });

  it('matches a row keyed by a Java itemId through its tool call ID', () => {
    const messages = managedEventsToMessages(
      [
        {
          id: 7,
          at: 7,
          type: 'tool_started',
          sessionId: 's1',
          turnId: 'turn-2',
          data: {
            itemId: 'item_tool_1',
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: { file_path: 'notes.md', content: 'turn-2' },
          },
        },
      ],
      '[truncated]',
    );
    const request = toManagedPermissionRequest(action, messages);
    expect(request.toolCallId).toBe('turn-2:item_tool_1');
    expect(request.rawInput).toEqual({
      file_path: 'notes.md',
      content: 'turn-2',
    });
  });

  it('carries the Harness call title into the approval description', () => {
    const messages = managedEventsToMessages(
      [
        {
          id: 8,
          at: 8,
          type: 'tool_requested',
          sessionId: 's1',
          turnId: 'turn-2',
          data: {
            itemId: 'item_tool_1',
            toolCallId: 'call-1',
            toolName: 'write_file',
            title: 'Write notes.md',
            input: { file_path: 'notes.md', content: 'turn-2' },
          },
        },
      ],
      '[truncated]',
    );
    expect(toManagedPermissionRequest(action, messages).title).toBe(
      'Write notes.md',
    );
  });

  it('ignores a call with the same ID in a later Turn', () => {
    // Call IDs restart per Turn, so the later Turn's call must not win.
    const messages = [
      toolGroup('turn-2', 'call-1'),
      toolGroup('turn-3', 'call-1'),
    ];
    expect(findManagedApprovalTool(messages, action)?.callId).toBe(
      'turn-2:call-1',
    );
    const itemRows = managedEventsToMessages(
      ['turn-2', 'turn-3'].map((turnId, index) => ({
        id: 10 + index,
        at: 10 + index,
        type: 'tool_started' as const,
        sessionId: 's1',
        turnId,
        data: {
          itemId: `item_tool_${turnId}`,
          toolCallId: 'call-1',
          toolName: 'write_file',
          input: { file_path: 'notes.md', content: turnId },
        },
      })),
      '[truncated]',
    );
    expect(toManagedPermissionRequest(action, itemRows).rawInput).toEqual({
      file_path: 'notes.md',
      content: 'turn-2',
    });
  });
});
