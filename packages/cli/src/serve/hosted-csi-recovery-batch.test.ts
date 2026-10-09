/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { HarnessToolItem } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { CSI_NATIVE_RESPONSE_LIMIT } from './managed-csi-native-readback.js';
import {
  readCsiRecoveryResult,
  readHostedCsiRecoveryBatch,
} from './hosted-csi-recovery-batch.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  {
    executionStatus: 'success',
    responseParts: [{ text: '' }, { type: 'text', text: 'owned' }],
  },
  {
    executionStatus: 'error',
    responseParts: [],
    error: { message: 'original refusal', type: 'OriginalError' },
  },
  {
    executionStatus: 'success',
    responseParts: [
      { inlineData: { mimeType: 'image/png', data: 'AA==' } },
      { fileData: { mimeType: 'text/plain', fileUri: 'owned://result' } },
    ],
  },
])('retains the closed native success/error grammar %#', (result) => {
  expect(readCsiRecoveryResult(result)).toEqual(result);
});

it.each([
  { executionStatus: 'cancelled', responseParts: [] },
  { executionStatus: 'success', responseParts: [], capture: null },
  {
    executionStatus: 'success',
    responseParts: [{ text: 'owned', thought: true }],
  },
  {
    executionStatus: 'success',
    responseParts: [{ text: 'owned', type: 'other' }],
  },
  { executionStatus: 'error', responseParts: [], error: { message: '' } },
  {
    executionStatus: 'error',
    responseParts: [],
    error: { message: 'x'.repeat(4097) },
  },
  {
    executionStatus: 'success',
    responseParts: [
      { inlineData: { mimeType: 'image/png', data: 'AA==', foreign: true } },
    ],
  },
])('refuses unsupported native result shapes %#', (result) => {
  expect(() => readCsiRecoveryResult(result)).toThrow();
});

it('cancels the response stream at the complete response byte limit before decoding', async () => {
  const cancel = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(CSI_NATIVE_RESPONSE_LIMIT + 1));
        },
        cancel,
      }),
    ),
  );
  const session = {
    authority: {
      sessionHeader: {
        sessionKey: {
          tenantId: 'unit-tenant',
          workspaceId: 'unit-workspace',
          sessionId: 'unit-session',
        },
      },
    },
  } as unknown as ManagedSession;
  const item = { modelMessageId: 'unit-batch' } as HarnessToolItem;
  await expect(
    readHostedCsiRecoveryBatch(
      session,
      { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
      'unit-prompt',
      [item],
      [],
      {
        bindingId: 'unit-binding',
        generation: '1',
        writerId: 'unit-writer',
        writerGeneration: 2,
        activationId: 'unit-activation',
        activationEpoch: 2,
      },
    ),
  ).rejects.toThrow('settled batch differs');
  expect(cancel).toHaveBeenCalledOnce();
});
