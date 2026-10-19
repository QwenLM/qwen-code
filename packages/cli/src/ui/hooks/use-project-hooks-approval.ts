/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  getProjectHooksApprovalState,
  loadHookApprovals,
} from '../../config/hook-approvals.js';
import { ProjectHooksApprovalChoice } from '../components/hooks/ProjectHooksApprovalDialog.js';
import { appEvents, AppEvent } from '../../utils/events.js';

export interface PendingProjectHooks {
  hooks: Record<string, unknown>;
  /** One display line per configured hook. */
  lines: string[];
}

function describeHook(hook: Record<string, unknown>): string {
  switch (hook['type']) {
    case 'command':
      return String(hook['command'] ?? '');
    case 'http':
      return `http ${String(hook['url'] ?? '')}`;
    default:
      return String(hook['type'] ?? 'unknown');
  }
}

export function summarizeProjectHooks(
  hooks: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const [event, definitions] of Object.entries(hooks)) {
    if (!Array.isArray(definitions)) continue;
    for (const definition of definitions) {
      const matcher = definition?.matcher ? `[${definition.matcher}]` : '';
      const entries = Array.isArray(definition?.hooks) ? definition.hooks : [];
      for (const hook of entries) {
        if (hook && typeof hook === 'object') {
          lines.push(`${event}${matcher}  ${describeHook(hook)}`);
        }
      }
    }
  }
  return lines;
}

/**
 * Drives the startup approval dialog for the workspace's project hooks, the
 * hook counterpart of `useMcpApproval`: a cloned repository's
 * `.qwen/settings.json` can declare arbitrary commands, so they load only
 * after the user approves this exact configuration. Approving persists the
 * hash-bound decision, un-gates the hooks for this session and reloads the
 * registry; rejecting persists the rejection and leaves them unloaded.
 */
export const useProjectHooksApproval = (
  config: Config,
  settings: LoadedSettings,
) => {
  const [pending, setPending] = useState<PendingProjectHooks | undefined>();

  const computePending = useCallback((): PendingProjectHooks | undefined => {
    if (!config.isProjectHooksPendingApproval()) return undefined;
    const hooks = settings.getProjectHooks();
    if (
      !hooks ||
      getProjectHooksApprovalState(hooks, config.getWorkingDir()) !== 'pending'
    ) {
      return undefined;
    }
    return { hooks, lines: summarizeProjectHooks(hooks) };
  }, [config, settings]);

  useEffect(() => {
    setPending(computePending());
  }, [computePending]);

  // A `/hooks` reload can edit the gated block mid-session (a changed hash
  // invalidates its decision); re-evaluate so the dialog pops right away.
  useEffect(() => {
    const onPendingChanged = () => {
      setPending(computePending());
    };
    appEvents.on(AppEvent.ProjectHooksPendingApprovalChanged, onPendingChanged);
    return () => {
      appEvents.off(
        AppEvent.ProjectHooksPendingApprovalChanged,
        onPendingChanged,
      );
    };
  }, [computePending]);

  const handleProjectHooksApprovalSelect = useCallback(
    async (choice: ProjectHooksApprovalChoice) => {
      if (!pending) return;
      const root = config.getWorkingDir();
      if (choice === ProjectHooksApprovalChoice.APPROVE) {
        await loadHookApprovals().setState(root, pending.hooks, 'approved');
        config.setProjectHooksPendingApproval(false);
        await config.getHookSystem()?.reload();
      } else {
        await loadHookApprovals().setState(root, pending.hooks, 'rejected');
      }
      setPending(undefined);
    },
    [config, pending],
  );

  return {
    isProjectHooksApprovalDialogOpen: pending !== undefined,
    pendingProjectHooks: pending,
    handleProjectHooksApprovalSelect,
  };
};
