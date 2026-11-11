/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HookEventName,
  HookType,
  ConfigSource,
} from '../hooks/types.js';
import type { HookDefinition } from '../hooks/types.js';
import type { Config } from '../config/config.js';
import { goalLoopStopHook } from './goalLoopHook.js';

/**
 * First-party goal-loop runtime hooks, always mounted by the hook registry.
 * The stop hook itself no-ops when no goal exists on disk, so mounting is
 * unconditional (there is no dynamic attach/detach API).
 *
 * Kept as a standalone module so hook-related tests can mock it to stay
 * environment-independent.
 */
export function getGoalHooksConfiguration(config: Config): Partial<
  Record<HookEventName, HookDefinition[]>
> {
  return {
    [HookEventName.Stop]: [
      {
        hooks: [
          {
            type: HookType.Runtime,
            name: 'goal-loop-stop',
            action: (input, options) => goalLoopStopHook(config, input, options),
            source: ConfigSource.System,
          },
        ],
      },
    ],
  };
}
