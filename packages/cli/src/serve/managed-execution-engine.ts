/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SpawnChannelFactoryOptions } from '@qwen-code/acp-bridge/spawnChannel';
import {
  evaluateManagedCompatibility,
  type ManagedCompatibilityRuntime,
} from '../config/managed-compatibility.js';
import { createManagedEngineChannelFactory } from './managed-engine-channel-factory.js';
import type { ManagedExecutionEngine } from './session-execution-engine-selector.js';

export interface ManagedExecutionEngineOptions {
  /**
   * The runtime's own Legacy factory options. Both children then share its
   * process registry, heap policy, idle reclamation, pipe limits and
   * diagnostics, and the daemon's process budget counts both.
   */
  readonly legacy: SpawnChannelFactoryOptions;
  /** The M3 evaluation's view of the runtime, read once per selection. */
  readonly host: ManagedCompatibilityRuntime;
}

/**
 * The Managed engine of one paired workspace runtime: the M2 child host plus
 * the M3 evaluation the selector consults before it lets a new session, or a
 * Managed owner's restore, run here. Building it starts no host, worker or
 * compatibility scan; the Bridge starts the child only for a session that
 * selects Managed.
 */
export function createManagedExecutionEngine(
  options: ManagedExecutionEngineOptions,
): ManagedExecutionEngine {
  return {
    factory: createManagedEngineChannelFactory(options.legacy),
    evaluate: (selection) =>
      evaluateManagedCompatibility(
        {
          workspaceCwd: selection.request.workspaceCwd,
          ...(selection.request.approvalMode !== undefined
            ? { approvalMode: selection.request.approvalMode }
            : {}),
        },
        options.host,
      ),
  };
}
