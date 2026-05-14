/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

export function getActivityAgentDepth(activity: object): number | undefined {
  if (!('agentDepth' in activity)) return undefined;
  return typeof activity.agentDepth === 'number'
    ? activity.agentDepth
    : undefined;
}
