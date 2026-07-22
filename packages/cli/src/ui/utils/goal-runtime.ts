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
    case 'verifier_accept':
    case 'verifier_reject':
      return false;
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

export async function waitForGoalRuntime(
  config: Pick<Config, 'getGoalRuntimeReady'>,
): Promise<void> {
  try {
    await config.getGoalRuntimeReady();
  } catch (error) {
    if (!(error instanceof GoalPersistenceUnavailableError)) throw error;
  }
}
