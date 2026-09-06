/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';
import {
  resolveBranchPoints,
  resolveCompletedTurnBranchCandidateFromRecords,
  type BranchPoint,
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

function checkpoint(
  uuid: string,
  parentUuid: string,
  assistantRecordUuid: string,
  startExclusiveRecordUuid: string | null = null,
): ChatRecord {
  return {
    ...record(uuid, parentUuid, 'system'),
    subtype: 'branch_checkpoint',
    systemPayload: {
      v: 1,
      startExclusiveRecordUuid,
      assistantRecordUuid,
    },
  };
}

function resolveSingle(records: ChatRecord[]): BranchPoint | undefined {
  return resolveBranchPoints(records).values().next().value;
}

describe('branch points', () => {
  it('resolves a durable checkpoint for a completed text turn', () => {
    const user = record('u1', null, 'user', [{ text: 'question' }]);
    const assistant = record('a1', 'u1', 'assistant', [{ text: 'answer' }]);

    expect(
      resolveSingle([user, assistant, checkpoint('c1', 'a1', 'a1')]),
    ).toEqual({
      startExclusiveRecordUuid: null,
      endInclusiveRecordUuid: 'a1',
      assistantRecordUuid: 'a1',
      checkpointUuid: 'c1',
    });
  });

  it('accepts a closed tool loop with null transcript parts', () => {
    const records = [
      record('u1', null, 'user', [{ text: 'question' }]),
      record('a-tool', 'u1', 'assistant', [
        null,
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
      ] as unknown as Part[]),
      record('tool', 'a-tool', 'tool_result', [
        null,
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ] as unknown as Part[]),
      record('a-final', 'tool', 'assistant', [
        null,
        { text: 'done' },
      ] as unknown as Part[]),
    ];

    expect(
      resolveSingle([...records, checkpoint('c1', 'a-final', 'a-final')])
        ?.assistantRecordUuid,
    ).toBe('a-final');
  });

  it.each([
    {
      name: 'a dangling tool call',
      records: () => [
        record('u1', null, 'user', [{ text: 'question' }]),
        record('a1', 'u1', 'assistant', [
          { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ]),
      ],
    },
    {
      name: 'a mismatched tool response',
      records: () => [
        record('u1', null, 'user', [{ text: 'question' }]),
        record('a-tool', 'u1', 'assistant', [
          { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ]),
        record('tool', 'a-tool', 'tool_result', [
          {
            functionResponse: {
              id: 'wrong-id',
              name: 'read_file',
              response: {},
            },
          },
        ]),
        record('a1', 'tool', 'assistant', [{ text: 'done' }]),
      ],
    },
    {
      name: 'an ambiguous name-only response',
      records: () => [
        record('u1', null, 'user', [{ text: 'question' }]),
        record('a-tool', 'u1', 'assistant', [
          { functionCall: { name: 'read_file', args: { path: 'a' } } },
          { functionCall: { name: 'read_file', args: { path: 'b' } } },
        ]),
        record('tool', 'a-tool', 'tool_result', [
          {
            functionResponse: {
              name: 'read_file',
              response: {},
            },
          },
        ]),
        record('a1', 'tool', 'assistant', [{ text: 'done' }]),
      ],
    },
    {
      name: 'an orphan tool response',
      records: () => [
        record('u1', null, 'user', [{ text: 'question' }]),
        record('tool', 'u1', 'tool_result', [
          {
            functionResponse: {
              id: 'ghost',
              name: 'read_file',
              response: {},
            },
          },
        ]),
        record('a1', 'tool', 'assistant', [{ text: 'done' }]),
      ],
    },
    {
      name: 'two visible assistants',
      records: () => [
        record('u1', null, 'user', [{ text: 'question' }]),
        record('a1', 'u1', 'assistant', [{ text: 'first' }]),
        record('a2', 'a1', 'assistant', [{ text: 'second' }]),
      ],
    },
    {
      name: 'a thought-only assistant',
      records: () => [
        record('u1', null, 'user', [{ text: 'question' }]),
        record('a1', 'u1', 'assistant', [{ thought: true, text: 'internal' }]),
      ],
    },
  ])('rejects $name', ({ records: makeRecords }) => {
    const records = makeRecords();
    const end = records.at(-1)!.uuid;
    expect(
      resolveBranchPoints([...records, checkpoint('c1', end, end)]),
    ).toEqual(new Map());
  });

  it('allows later balanced turns after an earlier dangling call', () => {
    const chain: ChatRecord[] = [
      record('u0', null, 'user', [{ text: 'first' }]),
      record('a-dangling', 'u0', 'assistant', [
        { functionCall: { id: 'crashed', name: 'read_file', args: {} } },
      ]),
      record('u1', 'a-dangling', 'user', [{ text: 'second' }]),
      record('a1', 'u1', 'assistant', [{ text: 'answer' }]),
      checkpoint('c1', 'a1', 'a1'),
      record('u2', 'c1', 'user', [{ text: 'third' }]),
      record('a2', 'u2', 'assistant', [{ text: 'third answer' }]),
      checkpoint('c2', 'a2', 'a2', 'c1'),
    ];

    const points = resolveBranchPoints(chain);
    expect(points.has('c1')).toBe(false);
    expect(points.get('c2')?.assistantRecordUuid).toBe('a2');
  });

  it('keeps carried pending calls separate from calls in the new turn', () => {
    const records = [
      record('u1', 'old-tail', 'user', [{ text: 'continue' }]),
      record('a-tool', 'u1', 'assistant', [
        { functionCall: { name: 'read_file', args: {} } },
      ]),
      record('tool', 'a-tool', 'tool_result', [
        {
          functionResponse: { name: 'read_file', response: { output: 'ok' } },
        },
      ]),
      record('a1', 'tool', 'assistant', [{ text: 'done' }]),
    ];

    expect(
      resolveCompletedTurnBranchCandidateFromRecords({
        records,
        startExclusiveRecordUuid: 'old-tail',
        pendingCallsAtStart: [{ name: 'read_file' }],
      })?.assistantRecordUuid,
    ).toBe('a1');
  });

  it('rejects duplicate record and checkpoint identifiers', () => {
    const duplicateRecord = [
      record('duplicate', null, 'user', [{ text: 'question' }]),
      record('duplicate', 'duplicate', 'assistant', [{ text: 'answer' }]),
      checkpoint('c1', 'duplicate', 'duplicate'),
    ];
    const user = record('u1', null, 'user', [{ text: 'question' }]);
    const assistant = record('a1', 'u1', 'assistant', [{ text: 'answer' }]);
    const first = checkpoint('c1', 'a1', 'a1');
    const second = checkpoint('c2', 'c1', 'a1');

    expect(resolveBranchPoints(duplicateRecord)).toEqual(new Map());
    expect(resolveBranchPoints([user, assistant, first, second])).toEqual(
      new Map(),
    );
  });

  it.each([
    {
      name: 'detached from its parent',
      checkpoint: checkpoint('c1', 'u1', 'a1'),
    },
    {
      name: 'using a missing start boundary',
      checkpoint: checkpoint('c1', 'a1', 'a1', 'missing'),
    },
    {
      name: 'claiming a different assistant',
      checkpoint: checkpoint('c1', 'a1', 'other'),
    },
  ])('rejects a checkpoint $name', ({ checkpoint: invalid }) => {
    const user = record('u1', null, 'user', [{ text: 'question' }]);
    const assistant = record('a1', 'u1', 'assistant', [{ text: 'answer' }]);
    expect(resolveBranchPoints([user, assistant, invalid])).toEqual(new Map());
  });

  it.each([
    { v: 2, startExclusiveRecordUuid: null, assistantRecordUuid: 'a1' },
    { v: 1, startExclusiveRecordUuid: null, assistantRecordUuid: '' },
    { v: 1, startExclusiveRecordUuid: 42, assistantRecordUuid: 'a1' },
  ])('rejects malformed checkpoint payload %#', (payload) => {
    const user = record('u1', null, 'user', [{ text: 'question' }]);
    const assistant = record('a1', 'u1', 'assistant', [{ text: 'answer' }]);
    const invalid: ChatRecord = {
      ...record('c1', 'a1', 'system'),
      subtype: 'branch_checkpoint',
      systemPayload: payload as ChatRecord['systemPayload'],
    };
    expect(resolveBranchPoints([user, assistant, invalid])).toEqual(new Map());
  });

  it('resolves successive checkpoints without rescanning through a wrapper API', () => {
    const chain = [
      record('u1', null, 'user', [{ text: 'first' }]),
      record('a1', 'u1', 'assistant', [{ text: 'first answer' }]),
      checkpoint('c1', 'a1', 'a1'),
      record('u2', 'c1', 'user', [{ text: 'second' }]),
      record('a2', 'u2', 'assistant', [{ text: 'second answer' }]),
      checkpoint('c2', 'a2', 'a2', 'c1'),
    ];

    expect([...resolveBranchPoints(chain).keys()]).toEqual(['c1', 'c2']);
  });
});
