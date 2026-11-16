/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  createTranscriptExecutionLifecycleUpdate,
  createTranscriptHookLifecycleUpdate,
  createTranscriptReplayMachine,
  parseExecutionLifecycle,
  type TranscriptExecutionLifecycle,
} from './transcript-replay.js';
import type { TranscriptRecordInput } from '@qwen-code/qwen-code-core/transcriptRecords';

const started: TranscriptExecutionLifecycle = {
  v: 1,
  kind: 'request',
  executionId: 'exec',
  sessionId: 'session',
  promptId: 'prompt',
  model: 'model',
  startedAt: 100,
  phase: 'started',
};
const record = (event: Record<string, unknown>): TranscriptRecordInput => ({
  uuid: 'record',
  parentUuid: null,
  sessionId: 'session',
  type: 'system',
  timestamp: '2026-10-09T00:00:00Z',
  subtype: 'ui_telemetry',
  systemPayload: {
    uiEvent: { 'event.name': 'request_lifecycle', ...event },
  },
});

describe('execution lifecycle replay', () => {
  it('replays safe hook records as inert metadata and excludes them from text exports', () => {
    const hook = {
      v: 1 as const,
      kind: 'hook' as const,
      runtimeId: 'runtime',
      executionId: 'hook',
      sessionId: 'session',
      promptId: 'turn',
      agentId: null,
      eventName: 'Stop',
      hookType: 'command' as const,
      name: 'safe',
      source: 'user' as const,
      startedAt: 100,
      phase: 'started' as const,
    };
    const input = record({
      ...hook,
      'event.name': 'hook_lifecycle',
      command: 'SECRET',
    });
    const frames = [
      ...createTranscriptReplayMachine({ includeTiming: true }).project(input),
    ];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.update).toMatchObject(
      createTranscriptHookLifecycleUpdate(hook),
    );
    expect(JSON.stringify(frames)).not.toContain('SECRET');
    expect([...createTranscriptReplayMachine().project(input)]).toEqual([]);
  });

  it('constructs inert frames without usage or timing', () => {
    expect(createTranscriptExecutionLifecycleUpdate(started)).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: { executionLifecycle: started },
    });
    const meta = createTranscriptExecutionLifecycleUpdate(started)._meta;
    expect(meta).not.toHaveProperty('usage');
    expect(meta).not.toHaveProperty('timing');
  });
  it('projects valid lifecycle only when includeTiming is explicit', () => {
    const enabled = [
      ...createTranscriptReplayMachine({ includeTiming: true }).project(
        record(started),
      ),
    ];
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.update).toMatchObject({
      _meta: { executionLifecycle: started },
    });
    expect([
      ...createTranscriptReplayMachine().project(record(started)),
    ]).toEqual([]);
    expect([
      ...createTranscriptReplayMachine({ includeTiming: true }).project(
        record({ ...started, v: 2 }),
      ),
    ]).toEqual([]);
  });
  it('rejects invalid and accepts recorded interrupted terminal', () => {
    expect(
      parseExecutionLifecycle({
        ...started,
        phase: 'ended',
        endedAt: 140,
        durationMs: 40,
        outcome: 'interrupted',
        reason: 'consumer_closed',
      }),
    ).toMatchObject({ outcome: 'interrupted' });
    expect(parseExecutionLifecycle({ ...started, model: '' })).toBeUndefined();
    expect(
      parseExecutionLifecycle({
        ...started,
        phase: 'ended',
        endedAt: 99,
        durationMs: 0,
        outcome: 'error',
      }),
    ).toBeUndefined();
  });
});
