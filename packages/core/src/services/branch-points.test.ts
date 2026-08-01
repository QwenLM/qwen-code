/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
import {
  resolveBranchPoints,
  resolveCompletedTurnBranchCandidate,
} from './branch-points.js';

function record(
  uuid: string,
  parentUuid: string | null,
  type: ChatRecord['type'],
  parts: NonNullable<ChatRecord['message']>['parts'] = [],
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-07-30T00:00:00.000Z',
    type,
    provenance:
      type === 'user'
        ? 'real_user'
        : type === 'assistant'
          ? 'assistant_output'
          : type === 'tool_result'
            ? 'tool_result'
            : 'system',
    cwd: '/workspace',
    version: 'test',
    message: { role: type === 'assistant' ? 'model' : 'user', parts },
  };
}

describe('branch points', () => {
  it('resolves a completed text turn and its checkpoint', () => {
    const user = record('u1', null, 'user', [{ text: 'question' }]);
    const assistant = record('a1', 'u1', 'assistant', [{ text: 'answer' }]);
    const checkpoint: ChatRecord = {
      ...record('c1', 'a1', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: {
        v: 1,
        startExclusiveRecordUuid: null,
        assistantRecordUuid: 'a1',
      },
    };

    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: [user, assistant],
        startExclusiveRecordUuid: null,
        endInclusiveRecordUuid: 'a1',
      }),
    ).toEqual({
      startExclusiveRecordUuid: null,
      endInclusiveRecordUuid: 'a1',
      assistantRecordUuid: 'a1',
    });
    expect(
      resolveBranchPoints([user, assistant, checkpoint]).get('c1'),
    ).toEqual({
      startExclusiveRecordUuid: null,
      endInclusiveRecordUuid: 'a1',
      assistantRecordUuid: 'a1',
      checkpointUuid: 'c1',
    });
  });

  it('accepts a closed tool loop and rejects its intermediate assistant', () => {
    const records = [
      record('u1', null, 'user', [{ text: 'question' }]),
      record('a-tool', 'u1', 'assistant', [
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
      ]),
      record('tool', 'a-tool', 'tool_result', [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ]),
      record('a-final', 'tool', 'assistant', [{ text: 'done' }]),
    ];

    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: records,
        startExclusiveRecordUuid: null,
        endInclusiveRecordUuid: 'a-final',
      })?.assistantRecordUuid,
    ).toBe('a-final');
    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: records.slice(0, 2),
        startExclusiveRecordUuid: null,
        endInclusiveRecordUuid: 'a-tool',
      }),
    ).toBeUndefined();
  });

  it('rejects mismatched and ambiguous tool responses', () => {
    const mismatchedId = [
      record('u1', null, 'user', [{ text: 'question' }]),
      record('a-tool', 'u1', 'assistant', [
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
      ]),
      record('tool', 'a-tool', 'tool_result', [
        {
          functionResponse: {
            id: 'wrong-id',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ]),
      record('a-final', 'tool', 'assistant', [{ text: 'done' }]),
    ];
    const ambiguousName = [
      record('u2', null, 'user', [{ text: 'question' }]),
      record('a-tools', 'u2', 'assistant', [
        { functionCall: { name: 'read_file', args: { path: 'a' } } },
        { functionCall: { name: 'read_file', args: { path: 'b' } } },
      ]),
      record('one-tool-result', 'a-tools', 'tool_result', [
        {
          functionResponse: {
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ]),
      record('a-final-2', 'one-tool-result', 'assistant', [{ text: 'done' }]),
    ];

    for (const records of [mismatchedId, ambiguousName]) {
      expect(
        resolveCompletedTurnBranchCandidate({
          activeChain: records,
          startExclusiveRecordUuid: null,
          endInclusiveRecordUuid: records.at(-1)!.uuid,
        }),
      ).toBeUndefined();
    }
  });

  it('rejects malformed boundaries and dangling tool calls', () => {
    const records = [
      record('u1', null, 'user', [{ text: 'question' }]),
      record('a1', 'u1', 'assistant', [
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
      ]),
    ];
    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: records,
        startExclusiveRecordUuid: 'missing',
        endInclusiveRecordUuid: 'a1',
      }),
    ).toBeUndefined();
    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: records,
        startExclusiveRecordUuid: null,
        endInclusiveRecordUuid: 'a1',
      }),
    ).toBeUndefined();
  });

  it('rejects checkpoints on a chain with duplicate record identifiers', () => {
    const user = record('duplicate', null, 'user', [{ text: 'question' }]);
    const assistant = record('duplicate', 'duplicate', 'assistant', [
      { text: 'answer' },
    ]);
    const checkpoint: ChatRecord = {
      ...record('checkpoint', 'duplicate', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: {
        v: 1,
        startExclusiveRecordUuid: null,
        assistantRecordUuid: 'duplicate',
      },
    };

    expect(resolveBranchPoints([user, assistant, checkpoint])).toEqual(
      new Map(),
    );
  });

  it('rejects duplicate checkpoints for the same Assistant record', () => {
    const user = record('user', null, 'user', [{ text: 'question' }]);
    const assistant = record('assistant', 'user', 'assistant', [
      { text: 'answer' },
    ]);
    const first: ChatRecord = {
      ...record('checkpoint-1', 'assistant', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: {
        v: 1,
        startExclusiveRecordUuid: null,
        assistantRecordUuid: 'assistant',
      },
    };
    const second: ChatRecord = {
      ...record('checkpoint-2', 'checkpoint-1', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: first.systemPayload,
    };

    expect(resolveBranchPoints([user, assistant, first, second])).toEqual(
      new Map(),
    );
  });

  it('does not slice active-chain prefixes for successive checkpoints', () => {
    const firstUser = record('user-1', null, 'user', [{ text: 'first' }]);
    const firstAssistant = record('assistant-1', 'user-1', 'assistant', [
      { text: 'first answer' },
    ]);
    const firstCheckpoint: ChatRecord = {
      ...record('checkpoint-1', 'assistant-1', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: {
        v: 1,
        startExclusiveRecordUuid: null,
        assistantRecordUuid: 'assistant-1',
      },
    };
    const secondUser = record('user-2', 'checkpoint-1', 'user', [
      { text: 'second' },
    ]);
    const secondAssistant = record('assistant-2', 'user-2', 'assistant', [
      { text: 'second answer' },
    ]);
    const secondCheckpoint: ChatRecord = {
      ...record('checkpoint-2', 'assistant-2', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: {
        v: 1,
        startExclusiveRecordUuid: 'checkpoint-1',
        assistantRecordUuid: 'assistant-2',
      },
    };

    const activeChain = [
      firstUser,
      firstAssistant,
      firstCheckpoint,
      secondUser,
      secondAssistant,
      secondCheckpoint,
    ];
    const sliceSpy = vi.spyOn(activeChain, 'slice');

    expect(resolveBranchPoints(activeChain)).toEqual(
      new Map([
        [
          'checkpoint-1',
          {
            startExclusiveRecordUuid: null,
            endInclusiveRecordUuid: 'assistant-1',
            assistantRecordUuid: 'assistant-1',
            checkpointUuid: 'checkpoint-1',
          },
        ],
        [
          'checkpoint-2',
          {
            startExclusiveRecordUuid: 'checkpoint-1',
            endInclusiveRecordUuid: 'assistant-2',
            assistantRecordUuid: 'assistant-2',
            checkpointUuid: 'checkpoint-2',
          },
        ],
      ]),
    );
    expect(sliceSpy).not.toHaveBeenCalled();
  });

  it('accepts a retry interval that does not append another user record', () => {
    const orphanedUser = record('user', null, 'user', [{ text: 'retry me' }]);
    const assistant = record('assistant', 'user', 'assistant', [
      { text: 'completed retry' },
    ]);

    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: [orphanedUser, assistant],
        startExclusiveRecordUuid: 'user',
        endInclusiveRecordUuid: 'assistant',
      }),
    ).toMatchObject({ assistantRecordUuid: 'assistant' });
  });

  it('accepts a continuation that closes a pre-boundary tool call', () => {
    const records = [
      record('user', null, 'user', [{ text: 'continue me' }]),
      record('assistant-tool', 'user', 'assistant', [
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
      ]),
      record('tool', 'assistant-tool', 'tool_result', [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ]),
      record('assistant-final', 'tool', 'assistant', [{ text: 'done' }]),
    ];

    expect(
      resolveCompletedTurnBranchCandidate({
        activeChain: records,
        startExclusiveRecordUuid: 'assistant-tool',
        endInclusiveRecordUuid: 'assistant-final',
      }),
    ).toMatchObject({ assistantRecordUuid: 'assistant-final' });
  });
});
