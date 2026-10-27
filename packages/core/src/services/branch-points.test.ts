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
  resolveCompletedTurnBranchCandidateFromHistory,
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

describe('streaming branch checkpoint candidate', () => {
  it.each([
    'complete',
    'duplicate-answer',
    'mixed-response',
    'internal',
    'dangling',
    'prefix-name',
  ])('preserves the interval contract for %s', async (kind) => {
    const call = record('call', 'old-tail', 'assistant', [
      {
        functionCall: {
          id: kind === 'prefix-name' ? undefined : 'new',
          name: 'read_file',
          args: {},
        },
      },
    ]);
    const response = record('response', 'call', 'tool_result', [
      {
        functionResponse: {
          id: 'new',
          name: 'read_file',
          response: { output: 'ok' },
        },
      },
    ]);
    const answer = record('answer', 'response', 'assistant', [
      { text: 'done' },
    ]);
    const records =
      kind === 'duplicate-answer'
        ? [answer, { ...answer, uuid: 'another' }]
        : kind === 'mixed-response'
          ? [
              record('mixed', 'old-tail', 'assistant', [
                {
                  functionResponse: {
                    id: 'old',
                    name: 'read_file',
                    response: { output: 'ok' },
                  },
                },
                { text: 'same record is not a final answer' },
              ]),
            ]
          : kind === 'internal'
            ? [
                { ...response, subtype: 'code_mode_tool_result' as const },
                answer,
              ]
            : kind === 'dangling'
              ? [call, answer]
              : [call, response, answer];
    const pendingCallsAtStart = [{ id: 'old', name: 'read_file' }];
    const result = await resolveCompletedTurnBranchCandidateFromHistory({
      records: {
        async *[Symbol.asyncIterator]() {
          yield* records;
        },
      },
      startExclusiveRecordUuid: 'old-tail',
      pendingCallsAtStart,
    });
    expect(result).toEqual(
      resolveCompletedTurnBranchCandidateFromRecords({
        records,
        startExclusiveRecordUuid: 'old-tail',
        pendingCallsAtStart,
      }),
    );
    expect(result?.assistantRecordUuid).toBe(
      ['complete', 'internal', 'prefix-name'].includes(kind)
        ? 'answer'
        : undefined,
    );
  });

  it('consumes a long lazy interval without requiring its record bodies as an array', async () => {
    let read = 0;
    const result = await resolveCompletedTurnBranchCandidateFromHistory({
      records: {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 100_000; index++) {
            read++;
            yield record(String(index), null, 'system');
          }
          yield record('answer', null, 'assistant', [{ text: 'done' }]);
        },
      },
      startExclusiveRecordUuid: null,
      pendingCallsAtStart: [],
    });
    expect(read).toBe(100_000);
    expect(result?.assistantRecordUuid).toBe('answer');
  });
});

describe('branch points', () => {
  it('creates and recovers checkpoints for turns with internal Code Mode evidence', () => {
    const records = [
      record('calls', null, 'assistant', [
        { functionCall: { id: 'outer', name: 'exec', args: {} } },
      ]),
      ...[
        ['nested-read', 'read_file'],
        ['nested-goal', 'get_goal'],
      ].map(
        ([id, name], index): ChatRecord => ({
          ...record(id, index === 0 ? 'calls' : 'nested-read', 'tool_result', [
            {
              functionResponse: { id, name, response: { output: 'internal' } },
            },
          ]),
          subtype: 'code_mode_tool_result',
          provenance: name === 'get_goal' ? 'goal_runtime' : 'tool_result',
        }),
      ),
      record('outer-result', 'nested-goal', 'tool_result', [
        {
          functionResponse: {
            id: 'outer',
            name: 'exec',
            response: { output: 'ok' },
          },
        },
      ]),
      record('answer', 'outer-result', 'assistant', [{ text: 'done' }]),
    ];
    expect(
      resolveCompletedTurnBranchCandidateFromRecords({
        records,
        startExclusiveRecordUuid: null,
        pendingCallsAtStart: [],
      }),
    ).toEqual({
      startExclusiveRecordUuid: null,
      endInclusiveRecordUuid: 'answer',
      assistantRecordUuid: 'answer',
    });
    expect(
      resolveSingle([...records, checkpoint('c1', 'answer', 'answer')]),
    ).toMatchObject({ checkpointUuid: 'c1', assistantRecordUuid: 'answer' });
  });
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
