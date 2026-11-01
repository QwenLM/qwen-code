/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  getProjectHooksApprovalState,
  getProjectHooksForApproval,
  hashProjectHooks,
  loadHookApprovals,
  summarizeProjectHooks,
  type ProjectHooksApproval,
} from '../../config/hook-approvals.js';
import { ProjectHooksApprovalChoice } from '../components/hooks/ProjectHooksApprovalDialog.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';

export interface PendingProjectHooks {
  approval: ProjectHooksApproval;
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
 * decision open until the next start or until the block changes, and says so
 * via `addInfo`.
 */
export const useProjectHooksApproval = (
  config: Config,
  settings: LoadedSettings,
  addInfo?: (text: string) => void,
) => {
  const [pending, setPending] = useState<PendingProjectHooks | undefined>();
  // Latest caller callback without making the select handler unstable.
  const addInfoRef = useRef(addInfo);
  addInfoRef.current = addInfo;
  // A dismissed block stays dismissed this session, so `/hooks` can show it.
  const dismissedHashRef = useRef<string | undefined>(undefined);

  const computePending = useCallback((): PendingProjectHooks | undefined => {
    if (!config.isProjectHooksPendingApproval()) return undefined;
    const approval = getProjectHooksForApproval(settings);
    if (
      !approval ||
      getProjectHooksApprovalState(approval) !== 'pending' ||
      hashProjectHooks(approval) === dismissedHashRef.current
    ) {
      return undefined;
    }
    return {
      approval,
      lines: summarizeProjectHooks(approval.resolved, approval.hooks),
    };
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
      setPending(undefined);
      if (choice === ProjectHooksApprovalChoice.DISMISS) {
        dismissedHashRef.current = hashProjectHooks(pending.approval);
        addInfoRef.current?.(
          'Project hooks in .qwen/settings.json were not loaded. Open /hooks or restart Qwen Code to review them.',
        );
        return;
      }
      const approve = choice === ProjectHooksApprovalChoice.APPROVE;
      try {
        await loadHookApprovals().setState(
          pending.approval,
          approve ? 'approved' : 'rejected',
        );
      } catch (error) {
        // Nothing was saved: keep the hooks withheld and say so.
        addInfoRef.current?.(
          `Project hooks were not loaded: the decision could not be saved (${getErrorMessage(error)}).`,
        );
        return;
      }
      if (approve) {
        config.setProjectHooksPendingApproval(false);
        await config.getHookSystem()?.reload();
      } else {
        config.setProjectHooksPendingApproval(true, true);
      }
    },
    [config, pending],
  );

  return {
    isProjectHooksApprovalDialogOpen: pending !== undefined,
    pendingProjectHooks: pending,
    handleProjectHooksApprovalSelect,
  };
};
