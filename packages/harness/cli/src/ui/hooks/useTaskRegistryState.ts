/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useEffect, useMemo } from 'react';
import type { TaskRegistry, UnifiedTask } from '@qwen-code/core';

export interface TaskRegistryState {
  tasks: UnifiedTask[];
  runningCount: number;
}

const EMPTY_TASKS: UnifiedTask[] = [];
const EMPTY_STATE: TaskRegistryState = { tasks: EMPTY_TASKS, runningCount: 0 };

/**
 * React hook that subscribes to TaskRegistry events and returns a monotonically
 * increasing version number. Components can depend on the version when they
 * need to read a specific task directly from the registry.
 */
export function useTaskRegistryVersion(registry: TaskRegistry | null): number {
  const [version, refresh] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    if (!registry) return;

    registry.on('task_registered', refresh);
    registry.on('task_updated', refresh);
    registry.on('task_removed', refresh);

    refresh();

    return () => {
      registry.off('task_registered', refresh);
      registry.off('task_updated', refresh);
      registry.off('task_removed', refresh);
    };
  }, [registry, refresh]);

  return version;
}

/**
 * React hook that subscribes to TaskRegistry events and returns reactive state.
 */
export function useTaskRegistryState(
  registry: TaskRegistry | null,
): TaskRegistryState {
  const version = useTaskRegistryVersion(registry);

  // Only surface backgrounded tasks. Foreground agents register in the
  // registry for lifecycle tracking but should never appear in the panel.
  const tasks = useMemo(
    () => {
      // `version` intentionally invalidates this memo when TaskRegistry emits.
      void version;
      if (!registry) return EMPTY_TASKS;
      return registry
        .all()
        .filter((t) => !('isBackgrounded' in t) || t.isBackgrounded)
        .sort((a, b) => b.startTime - a.startTime);
    },
    [registry, version],
  );
  const runningCount = useMemo(
    () => {
      // `version` intentionally invalidates this memo when TaskRegistry emits.
      void version;
      return registry?.runningCount() ?? 0;
    },
    [registry, version],
  );

  return useMemo(
    () => (registry ? { tasks, runningCount } : EMPTY_STATE),
    [registry, tasks, runningCount],
  );
}
