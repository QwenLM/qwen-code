/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelFactory } from '@qwen-code/acp-bridge/channel';
import {
  createSpawnChannelFactory,
  type SpawnChannelFactoryOptions,
} from '@qwen-code/acp-bridge/spawnChannel';

/**
 * The Managed engine's host for one paired workspace runtime: the same
 * `qwen --acp` child as Legacy, in its private Managed mode. Given the
 * runtime's Legacy factory options, both children share its process
 * registry, heap policy and idle reclamation, so the daemon budgets count the
 * Managed child too. The Bridge starts it only for a session that selects
 * Managed.
 */
export function createManagedEngineChannelFactory(
  options: SpawnChannelFactoryOptions = {},
): ChannelFactory {
  return createSpawnChannelFactory({
    ...options,
    extraArgs: [
      ...(options.extraArgs ?? []),
      '--acp-execution-engine',
      'managed',
    ],
  });
}
