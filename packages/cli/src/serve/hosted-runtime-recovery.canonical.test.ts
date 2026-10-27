/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { HostedSessionCommandSession } from './hosted-session-command-session.js';
import { fillParkedRoundCommandGaps } from './hosted-runtime-recovery.js';

it('answers a parked command sibling once using canonical records beyond the model context', async () => {
  const assistant = {
    uuid: 'round',
    type: 'assistant',
    daemonPromptId: 'prompt',
    message: {
      role: 'model',
      parts: [
        { functionCall: { id: 'waited', name: 'task_list', args: {} } },
        { functionCall: { id: 'sibling', name: 'task_list', args: {} } },
      ],
    },
  } as ChatRecord;
  const records = [assistant];
  const write = vi.fn(async (record: ChatRecord) => {
    records.push(record);
  });
  const projectContextRecords = vi.fn(async () => [assistant]);
  const managed = {
    authority: {
      get committedSequence() {
        return records.length;
      },
      harnessRunAuthorization: async () => ({
        status: 'runnable',
        checkpoint: {
          commandWait: {
            runs: [{ modelMessageId: 'round', functionCallId: 'waited' }],
          },
        },
      }),
    },
    sink: {
      write,
      projectContextRecords,
      async *iterateRecords(through: number) {
        for (let index = 0; index < through; index++) yield records[index]!;
      },
    },
  } as unknown as ManagedSession;
  const input = {
    managed,
    sessionId: 'session',
    promptId: 'prompt',
    cwd: '/workspace',
    gapText: 'not reached',
    commands: {} as HostedSessionCommandSession,
  };
  expect(await fillParkedRoundCommandGaps(input)).toBe(1);
  expect(await fillParkedRoundCommandGaps(input)).toBe(0);
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]![0].message?.parts?.[0].functionResponse?.id).toBe(
    'sibling',
  );
  expect(projectContextRecords).not.toHaveBeenCalled();
});
