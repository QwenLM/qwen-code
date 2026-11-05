/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentLoopSettledCall,
  AgentLoopToolExecutor,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { InteractiveToolCall } from '../../services/interactive-mod-tool-scheduler.js';
import type { ScheduleFn } from './useReactToolScheduler.js';

const debugLogger = createDebugLogger('INK_TOOL_EXECUTOR');

/**
 * Runs the shared loop's tool batches on the TUI's scheduler, so the tool
 * group, its approvals and the Mod tool middleware stay as they are.
 *
 * The scheduler queues a batch as one, so each call is offered to the loop's
 * `beforeLaunch` when the batch is scheduled rather than right before its own
 * launch; the TUI refuses no launch there.
 *
 * `onSettled` runs as soon as the scheduler completes the batch, before the
 * loop finalizes its results, with the calls as the scheduler reported them.
 * It runs inside the scheduler's completion callback, right after the
 * scheduler cleared its display list, so a tool group committed there lands
 * in the same render as the clear (#9420). The batch settles once the
 * promise `onSettled` returns does, which the scheduler's completion callback
 * does not wait for, or at once when it throws.
 */
export function createInkToolExecutor(
  schedule: ScheduleFn,
  modelOverride: string | undefined,
  onSettled: (calls: InteractiveToolCall[]) => void | Promise<void>,
): AgentLoopToolExecutor {
  return {
    run: (requests, signal, hooks) => {
      const launched = requests.filter((request) =>
        hooks.beforeLaunch(request, []),
      );
      if (launched.length === 0) return Promise.resolve([]);
      return new Promise<AgentLoopSettledCall[]>((resolve) => {
        schedule(launched, signal, modelOverride, async (calls) => {
          const settledCalls = calls.flatMap((call): AgentLoopSettledCall[] =>
            call.status === 'success' ||
            call.status === 'error' ||
            call.status === 'cancelled'
              ? [
                  {
                    status: call.status,
                    request: call.request,
                    response: call.response,
                    // The Mod tool middleware counts each native attempt,
                    // and the TUI counts a cancelled call only where the
                    // current path does (not when history answered it).
                    recorded:
                      call.nativeAttemptsObserved === true ||
                      call.status === 'cancelled',
                  },
                ]
              : [],
          );
          // The batch settles even when `onSettled` throws or rejects, so
          // the loop finalizes it and its caller releases what it holds.
          let pending: void | Promise<void>;
          try {
            pending = onSettled(calls);
          } catch (error) {
            resolve(settledCalls);
            throw error;
          }
          void Promise.resolve(pending)
            .catch((error: unknown) => {
              debugLogger.error('Settling a shared tool batch failed:', error);
            })
            .then(() => resolve(settledCalls));
        });
      });
    },
  };
}
