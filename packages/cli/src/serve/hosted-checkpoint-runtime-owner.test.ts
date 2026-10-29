/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  HarnessCheckpointV1,
  HarnessToolItem,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { ManagedHistoryQuery } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-history.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  originalRuntimeBroker,
  RecoveryDeclined,
} from './hosted-runtime-recovery.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';

function item(index: number): HarnessToolItem {
  return {
    functionCallId: `call-${index}`,
    toolName: 'read_file',
    executionCallId: `execution-${index}`,
    modelMessageId: `message-${index}`,
    partIndex: 0,
    ordinal: index,
    inputDigest: 'a'.repeat(64),
    outcomeSource: 'runtime',
    state: 'settled',
    outcomeRef: {
      kind: 'managed-tool-outcome',
      schemaVersion: 1,
      resourceId: `outcome-${index}`,
      byteLength: 2,
      digest: 'a'.repeat(64),
    },
    consumed: true,
  };
}

describe('checkpoint Runtime owner history', () => {
  it.each([false, true])(
    'checks archived Runtime pins lazily with conflicting old owner=%s',
    async (conflict) => {
      let produced = 0;
      const read = vi.fn(
        async (ref: ManagedSessionDurableRef): Promise<Buffer> => {
          expect(produced).toBe(read.mock.calls.length);
          return Buffer.from(
            JSON.stringify({
              harnessSessionId: sessionId,
              runtimeSessionId:
                conflict && ref.resourceId === 'execution-0'
                  ? 'different-old-owner'
                  : 'original-owner',
            }),
          );
        },
      );
      const managed = {
        authority: {
          sessionHeader: {
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId,
            },
          },
          findEvent: vi.fn(
            async (_kind: string, _field: string, executionCallId: string) => ({
              payload: {
                argsRef: {
                  kind: 'managed-tool-input',
                  resourceId: executionCallId,
                },
              },
            }),
          ),
        },
        resources: { read },
      } as unknown as ManagedSession;
      const tools = new ManagedHistoryQuery(async function* () {
        for (let index = 0; index < 66; index++) {
          produced++;
          yield item(index);
        }
      });
      const checkpoint = {
        identity: { coveredSequence: 100 },
      } as HarnessCheckpointV1;
      const broker = originalRuntimeBroker(
        managed,
        promptId,
        { checkpoint, tools },
        {
          baseUrl: 'http://127.0.0.1:1',
          token: 'test',
        },
      );
      if (conflict)
        await expect(broker).rejects.toBeInstanceOf(RecoveryDeclined);
      else expect((await broker).runtimeSessionId).toBe('original-owner');
      expect(read).toHaveBeenCalledTimes(66);
      expect(managed.authority.findEvent).toHaveBeenNthCalledWith(
        1,
        'tool.intent',
        'executionCallId',
        'execution-0',
        { throughSequence: 100 },
      );
      expect(managed.authority.findEvent).toHaveBeenLastCalledWith(
        'tool.intent',
        'executionCallId',
        'execution-65',
        { throughSequence: 100 },
      );
    },
  );
});
