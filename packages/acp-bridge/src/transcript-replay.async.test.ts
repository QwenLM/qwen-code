/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { TranscriptRecordInput } from '@qwen-code/qwen-code-core/transcriptRecords';
import {
  createTranscriptReplayMachine,
  type TranscriptReplayEmission,
} from './transcript-replay.js';

function toolRecord(id: string, result = false): TranscriptRecordInput {
  return {
    uuid: `${result ? 'result' : 'call'}-${id}`,
    parentUuid: null,
    sessionId: 'streamed-session',
    timestamp: '2026-10-27T00:00:00.000Z',
    type: result ? 'tool_result' : 'assistant',
    message: {
      role: result ? 'user' : 'model',
      parts: result
        ? [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'done' },
              },
            },
          ]
        : [{ functionCall: { id, name: 'read_file', args: {} } }],
    },
  };
}

async function collect(source: AsyncIterable<TranscriptReplayEmission>) {
  const result: TranscriptReplayEmission[] = [];
  for await (const item of source) result.push(item);
  return result;
}

function claimIds() {
  const used = new Set<string>();
  return vi.fn(async (candidate: string) => {
    let allocated = candidate;
    for (let suffix = 2; used.has(allocated); suffix++) {
      allocated = `${candidate}:${suffix}`;
    }
    used.add(allocated);
    return allocated;
  });
}

describe('asynchronous transcript replay identities', () => {
  it('preserves synchronous collision suffixes, result correlation, and finalization', async () => {
    const records = [
      toolRecord('shared:2'),
      toolRecord('shared:2', true),
      toolRecord('shared'),
      toolRecord('shared', true),
      toolRecord('shared'),
      toolRecord('shared', true),
      toolRecord('shared'),
    ];
    const sync = createTranscriptReplayMachine();
    const expected = records.flatMap((item) => [...sync.project(item)]);
    expected.push(...sync.finalize());
    const machine = createTranscriptReplayMachine();
    const claim = claimIds();
    const actual: TranscriptReplayEmission[] = [];
    for (const item of records)
      actual.push(...(await collect(machine.projectAsync(item, claim))));
    actual.push(...machine.finalize());
    expect(actual).toEqual(expected);
    expect(claim.mock.calls.map(([candidate]) => candidate)).toEqual([
      'shared:2',
      'shared',
      'shared',
      'shared',
    ]);
    expect(machine.snapshot()).toEqual(sync.snapshot());
  });

  it('keeps completed identities in the supplied history rather than resident replay state', async () => {
    const machine = createTranscriptReplayMachine();
    const claim = claimIds();
    for (let index = 0; index < 500; index++) {
      await collect(machine.projectAsync(toolRecord(`call-${index}`), claim));
      await collect(
        machine.projectAsync(toolRecord(`call-${index}`, true), claim),
      );
      expect(machine.snapshot().pendingToolCalls).toEqual([]);
    }
    expect(claim).toHaveBeenCalledTimes(500);
    expect(Reflect.get(machine, 'usedToolCallIds').size).toBe(0);
  });

  it('propagates an identity history failure before announcing an unproven tool call', async () => {
    const machine = createTranscriptReplayMachine();
    const failure = new Error('identity history unavailable');
    await expect(
      collect(
        machine.projectAsync(toolRecord('call'), async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(machine.snapshot().pendingToolCalls).toEqual([]);
  });
});
