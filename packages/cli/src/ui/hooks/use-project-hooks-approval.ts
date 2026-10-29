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
  getProjectHooksRoot,
  hashProjectHooks,
  loadHookApprovals,
  summarizeProjectHooks,
} from '../../config/hook-approvals.js';
import { ProjectHooksApprovalChoice } from '../components/hooks/ProjectHooksApprovalDialog.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import { t } from '../../i18n/index.js';

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
    const hooks = getProjectHooksForApproval(settings);
    if (
      !hooks ||
      getProjectHooksApprovalState(hooks, getProjectHooksRoot(settings)) !==
        'pending' ||
      hashProjectHooks(hooks) === dismissedHashRef.current
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
      setPending(undefined);
      if (choice === ProjectHooksApprovalChoice.DISMISS) {
        dismissedHashRef.current = hashProjectHooks(pending.hooks);
        addInfoRef.current?.(
          t(
            'Project hooks in .qwen/settings.json were not loaded. Open /hooks or restart Qwen Code to review them.',
          ),
        );
        return;
      }
      const approve = choice === ProjectHooksApprovalChoice.APPROVE;
      try {
        await loadHookApprovals().setState(
          root,
          pending.hooks,
          approve ? 'approved' : 'rejected',
        );
      } catch (error) {
        // Nothing was saved: keep the hooks withheld and say so.
        addInfoRef.current?.(
          t(
            'Project hooks were not loaded: the decision could not be saved ({{error}}).',
            { error: getErrorMessage(error) },
          ),
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
    [config, settings, pending],
  );

  return {
    isProjectHooksApprovalDialogOpen: pending !== undefined,
    pendingProjectHooks: pending,
    handleProjectHooksApprovalSelect,
  };
};
