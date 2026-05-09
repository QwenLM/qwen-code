/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  agentHasUnfinalizedTasks,
  agentReset,
  getRunningMonitorTasks,
  monitorReset,
  shellHasRunningEntries,
  shellReset,
  type Config,
} from '@qwen-code/qwen-code-core';

export function hasBlockingBackgroundWork(config: Config): boolean {
  const registry = config.getTaskRegistry();
  return (
    agentHasUnfinalizedTasks(registry) ||
    getRunningMonitorTasks(registry).length > 0 ||
    shellHasRunningEntries(registry)
  );
}

export function resetBackgroundStateForSessionSwitch(config: Config): void {
  const registry = config.getTaskRegistry();
  agentReset(registry);
  monitorReset(registry);
  shellReset(registry);
}
