/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type HookExecutionRequest,
} from '../confirmation-bus/types.js';
import { runUserPromptSubmit } from './user-prompt-submit.js';

describe('runUserPromptSubmit', () => {
  it('aborts the strict hook when the message-bus verdict times out', async () => {
    vi.useFakeTimers();
    try {
      const bus = new MessageBus();
      const config = {
        hasHooksForEvent: () => true,
        getMessageBus: () => bus,
      } as unknown as Config;
      const parent = new AbortController();
      let hookSignal: AbortSignal | undefined;
      bus.subscribe<HookExecutionRequest>(
        MessageBusType.HOOK_EXECUTION_REQUEST,
        (request) => {
          hookSignal = request.signal;
        },
      );
      const hook = runUserPromptSubmit(
        config,
        'queued',
        undefined,
        parent.signal,
        undefined,
        true,
      );
      const result = hook.catch((error: unknown) => error);
      expect(hookSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(result).resolves.toMatchObject({
        message: expect.stringContaining('Request timed out'),
      });
      expect(hookSignal?.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
