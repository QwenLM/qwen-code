/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useBackgroundTaskView — subscribes to the background task registry's
 * status-change callback and maintains a reactive snapshot of every
 * `BackgroundTaskEntry`, including terminal ones. Surfaces that only
 * care about live work (the footer pill, the composer's Down-arrow
 * route) filter for `running` themselves.
 *
 * Intentionally ignores activity updates (appendActivity). Tool-call
 * traffic from a running background agent would otherwise churn the
 * Footer pill and the AppContainer every few hundred ms. The detail
 * dialog subscribes to the activity callback directly when it needs
 * live Progress updates.
 */

import { useState, useEffect } from 'react';
import {
  type BackgroundTaskEntry,
  type Config,
} from '@qwen-code/qwen-code-core';

export interface UseBackgroundTaskViewResult {
  entries: readonly BackgroundTaskEntry[];
}

export function useBackgroundTaskView(
  config: Config | null,
): UseBackgroundTaskViewResult {
  const [entries, setEntries] = useState<BackgroundTaskEntry[]>([]);

  useEffect(() => {
    if (!config) return;
    const registry = config.getBackgroundTaskRegistry();

    // getAll() returns a fresh array in registration (= startTime) order.
    setEntries(registry.getAll());

    const onStatusChange = () => {
      setEntries(registry.getAll());
    };

    registry.setStatusChangeCallback(onStatusChange);

    return () => {
      registry.setStatusChangeCallback(undefined);
    };
  }, [config]);

  return { entries };
}
