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
  getProjectHooksRoot,
  loadHookApprovals,
  summarizeProjectHooks,
} from '../../config/hook-approvals.js';
import { ProjectHooksApprovalChoice } from '../components/hooks/ProjectHooksApprovalDialog.js';
import { appEvents, AppEvent } from '../../utils/events.js';

export interface PendingProjectHooks {
  hooks: Record<string, unknown>;
  /** One sanitized display line per configured hook. */
  lines: string[];
}

/**
 * Drives the startup approval dialog for the workspace's project hooks, the
 * hook counterpart of `useMcpApproval`: a cloned repository's
 * `.qwen/settings.json` can declare arbitrary commands, so they load only
 * after the user approves this exact configuration. Approving persists the
 * hash-bound decision, un-gates the hooks for this session and reloads the
 * registry; rejecting persists the rejection; dismissing (Esc) leaves the
 * decision open until the next start.
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
      getProjectHooksApprovalState(hooks, getProjectHooksRoot(settings)) !==
        'pending'
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
      const root = getProjectHooksRoot(settings);
      if (choice === ProjectHooksApprovalChoice.APPROVE) {
        await loadHookApprovals().setState(root, pending.hooks, 'approved');
        config.setProjectHooksPendingApproval(false);
        await config.getHookSystem()?.reload();
      } else if (choice === ProjectHooksApprovalChoice.REJECT) {
        await loadHookApprovals().setState(root, pending.hooks, 'rejected');
      }
      setPending(undefined);
    },
    [config, settings, pending],
  );

  return {
    isProjectHooksApprovalDialogOpen: pending !== undefined,
    pendingProjectHooks: pending,
    handleProjectHooksApprovalSelect,
  };
};
