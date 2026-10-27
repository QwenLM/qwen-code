/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { ManagedHistoryQuery } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-history.js';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { findHostedCommittedModelOutput } from './hosted-model-recovery.js';

function fixture(withTerminal: boolean, advanceHead = false) {
  const promptId = 'prompt';
  let committedSequence = withTerminal ? 12 : 11;
  const assistant = {
    uuid: 'answer',
    type: 'assistant',
    daemonPromptId: promptId,
    message: { role: 'model', parts: [{ text: 'committed answer' }] },
  } as ChatRecord;
  const terminal = {
    uuid: 'terminal',
    type: 'system',
    subtype: 'turn_result',
    daemonPromptId: promptId,
  } as ChatRecord;
  const envelope = {
    v: 1 as const,
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    occurredAt: 0,
  };
  const events: ManagedSessionEvent[] = [
    {
      ...envelope,
      eventId: 'attempt',
      sequence: 10,
      kind: 'model.attempt',
      payload: { attemptId: `${promptId}:main:0`, state: 'output_committed' },
    },
    {
      ...envelope,
      eventId: 'message',
      sequence: 11,
      kind: 'message.committed',
      payload: { messageId: assistant.uuid, role: 'assistant' },
    },
  ];
  const iterateEvents = vi.fn(
    (_from: number, through: number) =>
      new ManagedHistoryQuery(async function* () {
        for (const event of events) {
          if (event.sequence <= through) yield event;
          if (advanceHead) {
            await Promise.resolve();
            committedSequence = 12;
          }
        }
      }),
  );
  const iterateRecords = vi.fn(async function* (through: number) {
    yield assistant;
    if (through >= 12) yield terminal;
  });
  const projectContextRecords = vi.fn(async () => [assistant]);
  const session = {
    authority: {
      get committedSequence() {
        return committedSequence;
      },
      iterateEvents,
      harnessRunAuthorization: async () => ({
        status: 'runnable',
        checkpoint: {
          continuation: { phase: 'model_output_committed' },
          tools: { items: [] },
        },
        history: { allToolsSettled: true, allToolsConsumed: true },
      }),
    },
    sink: { iterateRecords, projectContextRecords },
  } as unknown as ManagedSession;
  return {
    session,
    promptId,
    iterateEvents,
    iterateRecords,
    projectContextRecords,
  };
}

describe('Hosted committed model output history', () => {
  it('observes terminal metadata omitted from the current model context', async () => {
    const f = fixture(true);
    expect(
      await findHostedCommittedModelOutput(f.session, f.promptId),
    ).toBeUndefined();
    expect(f.projectContextRecords).not.toHaveBeenCalled();
    expect(f.iterateRecords).toHaveBeenCalledWith(12);
  });

  it('keeps the original committed prefix when the head advances across a read', async () => {
    const f = fixture(false, true);
    expect(await findHostedCommittedModelOutput(f.session, f.promptId)).toEqual(
      {
        promptId: f.promptId,
      },
    );
    expect(f.session.authority.committedSequence).toBe(12);
    expect(f.iterateEvents).toHaveBeenCalledWith(1, 11);
    expect(f.iterateRecords).toHaveBeenCalledWith(11);
    expect(f.projectContextRecords).not.toHaveBeenCalled();
  });
});
