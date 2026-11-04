/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentLoopSettledCall,
  AgentLoopToolExecutor,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';
import type { InteractiveToolCall } from '../../services/interactive-mod-tool-scheduler.js';
import type { ScheduleFn } from './useReactToolScheduler.js';

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
 */
export function createInkToolExecutor(
  schedule: ScheduleFn,
  modelOverride: string | undefined,
  onSettled: (calls: InteractiveToolCall[]) => void,
): AgentLoopToolExecutor {
  return {
    run: (requests, signal, hooks) => {
      const launched = requests.filter((request) =>
        hooks.beforeLaunch(request, []),
      );
      if (launched.length === 0) return Promise.resolve([]);
      return new Promise<AgentLoopSettledCall[]>((resolve) => {
        schedule(launched, signal, modelOverride, async (calls) => {
          onSettled(calls);
          resolve(
            calls.flatMap((call): AgentLoopSettledCall[] =>
              call.status === 'success' ||
              call.status === 'error' ||
              call.status === 'cancelled'
                ? [
                    {
                      status: call.status,
                      request: call.request,
                      response: call.response,
                      // The Mod tool middleware counts each native attempt.
                      recorded: call.nativeAttemptsObserved === true,
                    },
                  ]
                : [],
            ),
          );
        });
      });
    },
  };
}
