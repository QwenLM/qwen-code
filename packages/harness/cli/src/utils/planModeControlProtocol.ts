/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK control and event projection for the main session's independent Plan
 * Mode state. The legacy `set_permission_mode: plan` adapter also delegates to
 * this module so old and new wire entry points share one transition path.
 */

import { randomUUID } from 'node:crypto';
import {
  coreEvents,
  CoreEvent,
  isPlanStateBlockedByMode,
  PLAN_MODE_BLOCKED_MESSAGE,
  type Config,
  type PlanStateChangedPayload,
  type SDKPlanModeSnapshot,
} from '@qwen-code/core';

/** Return the authoritative main-session Plan Mode snapshot. */
export function buildPlanModeSnapshot(config: Config): SDKPlanModeSnapshot {
  return { active: config.isPlanMode() };
}

/**
 * Enter or leave Plan Mode without changing the underlying permission mode.
 * Repeated requests are idempotent and still return the current snapshot.
 */
export function setSdkPlanMode(
  config: Config,
  active: boolean,
): SDKPlanModeSnapshot {
  if (active) {
    if (!config.isPlanEnabled()) {
      throw new Error('Plan mode is disabled.');
    }
    if (isPlanStateBlockedByMode(config.getPermissionMode())) {
      throw new Error(PLAN_MODE_BLOCKED_MESSAGE);
    }
    if (!config.isPlanMode()) {
      config.planStateManager.enter();
      config.resetPreApprovedPrompts?.();
      config.notifyPlanStateChanged();
    }
    return buildPlanModeSnapshot(config);
  }

  if (config.isPlanMode()) {
    config.planStateManager.exit();
    config.notifyPlanStateChanged();
  }
  return buildPlanModeSnapshot(config);
}

/**
 * Bridge every main-session Plan transition to the SDK NDJSON event stream.
 * The event carries a full replacement snapshot rather than a delta.
 */
export function installPlanModeEventBridge(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeNdjson: (msg: any) => void;
  sessionId: string;
}): () => void {
  const onChanged = ({ active }: PlanStateChangedPayload): void => {
    deps.writeNdjson({
      type: 'system',
      subtype: 'plan_mode_changed',
      plan_mode: { active },
      uuid: randomUUID(),
      session_id: deps.sessionId,
    });
  };

  coreEvents.on(CoreEvent.PlanStateChanged, onChanged);
  return () => {
    coreEvents.off(CoreEvent.PlanStateChanged, onChanged);
  };
}
