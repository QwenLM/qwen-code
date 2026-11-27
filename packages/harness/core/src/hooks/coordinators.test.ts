/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { HookSystem } from './hookSystem.js';
import { DefaultHookCoordinator, SubagentHookCoordinator } from './coordinators.js';

function makeHookSystem() {
  const fireStopFailureEvent = vi.fn(async () => ({}) as never);
  const hookSystem = {
    getConfig: () => undefined,
    fireStopFailureEvent,
    drainPendingAsyncContext: () => undefined,
  } as unknown as HookSystem;
  return { hookSystem, fireStopFailureEvent };
}

describe('StopFailure hooks', () => {
  it('fires the StopFailure event from the default coordinator', async () => {
    const { hookSystem, fireStopFailureEvent } = makeHookSystem();
    const coordinator = new DefaultHookCoordinator(hookSystem);

    await coordinator.fireStopFailure('rate_limit', { errorDetails: 'boom' });

    expect(fireStopFailureEvent).toHaveBeenCalledTimes(1);
    expect(fireStopFailureEvent).toHaveBeenCalledWith(
      'rate_limit',
      { errorDetails: 'boom' },
      undefined,
      undefined,
    );
  });

  it('fires the StopFailure event from the subagent coordinator', async () => {
    const { hookSystem, fireStopFailureEvent } = makeHookSystem();
    const coordinator = new SubagentHookCoordinator(
      hookSystem,
      'agent-1',
      'general-purpose',
    );

    await coordinator.fireStopFailure('server_error');

    expect(fireStopFailureEvent).toHaveBeenCalledTimes(1);
    expect(fireStopFailureEvent).toHaveBeenCalledWith(
      'server_error',
      undefined,
      undefined,
      undefined,
    );
  });
});
