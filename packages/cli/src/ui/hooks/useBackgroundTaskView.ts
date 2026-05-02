/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useBackgroundTaskView — subscribes to all three registries (background
 * subagents, managed shells, and event monitors) and merges them into a
 * single ordered snapshot of `DialogEntry`s. Each registry fires
 * `statusChange` on register too, so a single subscription per registry
 * is enough to keep the snapshot fresh for new + transitioning entries.
 *
 * Surfaces that only care about live work (the footer pill, the
 * composer's Down-arrow route) filter for `running` themselves.
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
  type BackgroundShellEntry,
  type Config,
  type MonitorEntry,
} from '@qwen-code/qwen-code-core';

export type AgentDialogEntry = BackgroundTaskEntry & {
  kind: 'agent';
  resumeBlockedReason?: string;
};

/**
 * A unified view-model entry the dialog/pill/context render against.
 * Discriminated by `kind`; per-kind fields are inlined verbatim so
 * renderer code can stay mechanical (`entry.kind === 'agent'` /
 * `'shell'` / `'monitor'` guard, then access fields directly).
 */
export type DialogEntry =
  | AgentDialogEntry
  | (BackgroundShellEntry & { kind: 'shell' })
  | (MonitorEntry & { kind: 'monitor' });

export interface UseBackgroundTaskViewResult {
  entries: readonly DialogEntry[];
}

/** Stable id of an entry regardless of kind — used as React key + lookup. */
export function entryId(entry: DialogEntry): string {
  switch (entry.kind) {
    case 'agent':
      return entry.agentId;
    case 'shell':
      return entry.shellId;
    case 'monitor':
      return entry.monitorId;
    default: {
      const _exhaustive: never = entry;
      throw new Error(
        `entryId: unknown DialogEntry kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

export function useBackgroundTaskView(
  config: Config | null,
): UseBackgroundTaskViewResult {
  const [entries, setEntries] = useState<DialogEntry[]>([]);

  useEffect(() => {
    if (!config) return;
    const agentRegistry = config.getBackgroundTaskRegistry();
    const shellRegistry = config.getBackgroundShellRegistry();
    const monitorRegistry = config.getMonitorRegistry();

    const refresh = () => {
      const agentEntries: DialogEntry[] = agentRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'agent' as const }));
      const shellEntries: DialogEntry[] = shellRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'shell' as const }));
      const monitorEntries: DialogEntry[] = monitorRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'monitor' as const }));
      // Merge by startTime so the order matches launch order across all
      // registries (matters when an agent, shell, and monitor are
      // launched alternately).
      const merged = [...agentEntries, ...shellEntries, ...monitorEntries].sort(
        (a, b) => a.startTime - b.startTime,
      );
      setEntries(merged);
    };

    refresh();

    agentRegistry.setStatusChangeCallback(refresh);
    shellRegistry.setStatusChangeCallback(refresh);
    monitorRegistry.setStatusChangeCallback(refresh);

    return () => {
      agentRegistry.setStatusChangeCallback(undefined);
      shellRegistry.setStatusChangeCallback(undefined);
      monitorRegistry.setStatusChangeCallback(undefined);
    };
  }, [config]);

  return { entries };
}
