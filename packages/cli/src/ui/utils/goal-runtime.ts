/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoalPersistenceUnavailableError,
  type Config,
  type GoalStateCause,
} from '@qwen-code/qwen-code-core';

export function shouldDisplayGoalStateCause(cause: GoalStateCause): boolean {
  switch (cause) {
    case 'turn_finished':
    case 'checkpoint':
    case 'verifier_accept':
      return false;
    case 'verifier_reject':
    case 'create':
    case 'replace':
    case 'edit':
    case 'pause':
    case 'resume':
    case 'complete':
    case 'blocked':
    case 'usage_limited':
    case 'clear':
    case 'migrated':
      return true;
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

/**
 * Awaits the goal runtime becoming ready.
 *
 * `getGoalRuntimeReady()` can stay pending indefinitely when the session
 * writer lease is contended (a crashed/sibling process holding the lease),
 * which previously hung the ink startup gate forever — the command registry
 * was never populated and EVERY slash command, including `/quit`, reported
 * "Unknown command". `timeoutMs` bounds that wait: after the timeout the
 * gate proceeds so the UI stays usable (goal features degrade rather than
 * blocking the whole CLI). Pass no timeout for the original unbounded
 * semantics.
 *
 * Resolves `true` when the runtime settled (or persistence is unavailable,
 * which is treated as settled), `false` when the timeout fired first.
 */
export async function waitForGoalRuntime(
  config: Pick<Config, 'getGoalRuntimeReady'>,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const ready = config.getGoalRuntimeReady();
  const awaitReady = async (): Promise<void> => {
    try {
      await ready;
    } catch (error) {
      if (!(error instanceof GoalPersistenceUnavailableError)) throw error;
    }
  };

  const { timeoutMs } = options;
  if (timeoutMs == null || timeoutMs <= 0) {
    await awaitReady();
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // The timeout must not keep the process alive on its own.
    timer.unref?.();
  });
  try {
    // Promise.race keeps a handler on the losing promise too, so a late
    // rejection of the goal-runtime promise cannot become unhandled.
    const winner = await Promise.race([awaitReady(), timeout]);
    return winner !== 'timeout';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
