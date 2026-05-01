/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useBackgroundTaskView — subscribes to both registries (background
 * subagents and background shells) and merges them into a single ordered
 * snapshot of `DialogEntry`s. Both registries fire `statusChange` on
 * register too, so a single subscription per registry is enough to keep
 * the snapshot fresh for new + transitioning entries.
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
} from '@qwen-code/qwen-code-core';

export type AgentDialogEntry = BackgroundTaskEntry & {
  kind: 'agent';
  resumeBlockedReason?: string;
};

/**
 * A unified view-model entry the dialog/pill/context render against.
 * Discriminated by `kind`; agent-shaped fields and shell-shaped fields
 * are inlined verbatim to keep the renderer code unchanged on the agent
 * branch (just guarded by `kind === 'agent'`).
 */
export type DialogEntry =
  | AgentDialogEntry
  | (BackgroundShellEntry & { kind: 'shell' });

export interface UseBackgroundTaskViewResult {
  entries: readonly DialogEntry[];
}

/** Stable id of an entry regardless of kind — used as React key + lookup. */
export function entryId(entry: DialogEntry): string {
  return entry.kind === 'agent' ? entry.agentId : entry.shellId;
}

export function useBackgroundTaskView(
  config: Config | null,
): UseBackgroundTaskViewResult {
  const [entries, setEntries] = useState<DialogEntry[]>([]);

  useEffect(() => {
    if (!config) return;
    const agentRegistry = config.getBackgroundTaskRegistry();
    const shellRegistry = config.getBackgroundShellRegistry();

    const refresh = () => {
      const agentEntries: DialogEntry[] = agentRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'agent' as const }));
      const shellEntries: DialogEntry[] = shellRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'shell' as const }));
      // Merge by startTime so the order matches launch order across both
      // registries (matters when an agent and a shell are launched
      // alternately).
      const merged = [...agentEntries, ...shellEntries].sort(
        (a, b) => a.startTime - b.startTime,
      );
      setEntries(merged);
    };

    refresh();

    agentRegistry.setStatusChangeCallback(refresh);
    shellRegistry.setStatusChangeCallback(refresh);

    return () => {
      agentRegistry.setStatusChangeCallback(undefined);
      shellRegistry.setStatusChangeCallback(undefined);
    };
  }, [config]);

  return { entries };
}
