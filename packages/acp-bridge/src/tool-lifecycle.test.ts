/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  createTranscriptReplayMachine,
  createTranscriptToolLifecycleUpdate,
  parseToolLifecycle,
  type TranscriptToolLifecycle,
} from './transcript-replay.js';
import type { TranscriptRecordInput } from '@qwen-code/qwen-code-core/transcriptRecords';
const started: TranscriptToolLifecycle = {
  v: 1,
  kind: 'tool',
  sessionId: 's',
  executionId: 'e',
  callId: 'c',
  toolName: 'shell',
  phase: 'started',
  executionStatus: 'running',
  startedAt: 100,
};
const record = (event: unknown): TranscriptRecordInput => ({
  uuid: 'r',
  parentUuid: null,
  sessionId: 's',
  type: 'system',
  timestamp: '2026-10-10T00:00:00Z',
  subtype: 'ui_telemetry',
  systemPayload: {
    uiEvent: {
      ...(event as Record<string, unknown>),
      'event.name': 'tool_lifecycle',
    },
  },
});
describe('tool lifecycle replay', () => {
  it('emits metadata without card content/status, gated by includeTiming', () => {
    const update = createTranscriptToolLifecycleUpdate(started);
    expect(update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c',
      _meta: { toolLifecycle: started },
    });
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('content');
    expect([
      ...createTranscriptReplayMachine().project(record(started)),
    ]).toEqual([]);
    const result = [
      ...createTranscriptReplayMachine({ includeTiming: true }).project(
        record(started),
      ),
    ];
    expect(result).toHaveLength(1);
    expect(result[0]?.update).toMatchObject(update);
    expect([
      ...createTranscriptReplayMachine({ includeTiming: true }).project(
        record({ ...started, v: 2 }),
      ),
    ]).toEqual([]);
  });
  it('keeps repeated raw IDs bound to separate occurrences across carried replay pages', () => {
    const machine = createTranscriptReplayMachine({ includeTiming: true });
    const assistant = (uuid: string): TranscriptRecordInput => ({
      uuid,
      parentUuid: null,
      sessionId: 's',
      type: 'assistant',
      timestamp: '2026-10-10T00:00:00Z',
      message: {
        role: 'model',
        parts: [{ functionCall: { id: 'c', name: 'shell', args: {} } }],
      },
    });
    const first = [...machine.project(assistant('a'))][0]!.update;
    const second = [...machine.project(assistant('b'))][0]!.update;
    const firstStart = [...machine.project(record(started))][0]!.update;
    const secondStart = [
      ...machine.project(record({ ...started, executionId: 'next' })),
    ][0]!.update;
    expect(firstStart).toHaveProperty(
      'toolCallId',
      (first as { toolCallId: string }).toolCallId,
    );
    expect(secondStart).toHaveProperty(
      'toolCallId',
      (second as { toolCallId: string }).toolCallId,
    );
    const carried = createTranscriptReplayMachine({
      includeTiming: true,
      initialState: JSON.parse(JSON.stringify(machine.snapshot())),
    });
    const terminal = [
      ...carried.project(
        record({
          ...started,
          executionId: 'next',
          phase: 'ended',
          executionStatus: 'success',
          endedAt: 120,
          executionDurationMs: 20,
          outcome: 'success',
        }),
      ),
    ][0]!.update;
    expect(terminal).toHaveProperty(
      'toolCallId',
      (second as { toolCallId: string }).toolCallId,
    );
    expect(terminal._meta?.['toolLifecycle']).toMatchObject({
      callId: 'c',
      executionId: 'next',
    });
  });
  it('rejects made-up execution timings and permits explicit not-started terminal', () => {
    expect(
      parseToolLifecycle({
        ...started,
        phase: 'ended',
        executionStatus: 'not_started',
        endedAt: 120,
        outcome: 'cancelled',
      }),
    ).toBeUndefined();
    const { startedAt: _start, ...identity } = started;
    expect(
      parseToolLifecycle({
        ...identity,
        phase: 'ended',
        executionStatus: 'not_started',
        endedAt: 120,
        outcome: 'cancelled',
      }),
    ).toMatchObject({ executionStatus: 'not_started' });
  });
});
