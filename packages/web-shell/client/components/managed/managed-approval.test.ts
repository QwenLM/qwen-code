import { describe, expect, it } from 'vitest';
import type { Message } from '../../adapters/types';
import type { ManagedAgentPendingAction } from './managed-agent-provider';
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
});
