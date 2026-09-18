/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type {
  DaemonWorkspaceCapability,
  DaemonWorkspaceRemovalActivity,
} from '@qwen-code/sdk/daemon';

export interface UseWorkspaceRemovalOptions {
  /** The daemon mutation; the sidebar and the Workspaces panel share it. */
  removeWorkspace: (
    workspaceId: string,
    options: { force: boolean },
  ) => Promise<unknown>;
  /**
   * Runs after the daemon confirmed the removal (directly, or via the
   * `workspace_mismatch` answer that means it was already gone). The caller
   * reconciles its own view — capability refresh, catalog invalidation,
   * selection. The hook clears its dialog state afterwards.
   */
  onRemoved: (removed: DaemonWorkspaceCapability) => Promise<void> | void;
  onError: (error: unknown, message: string) => void;
  /** Localized message for `onError`; the hook itself renders no text. */
  errorMessage: string;
  /**
   * Refuses the forced retry for a candidate (e.g. the active session lives
   * in it). Mirrors the dialog's disabled state so a stale click cannot
   * bypass it.
   */
  blockForce?: (candidate: DaemonWorkspaceCapability) => boolean;
}

export interface WorkspaceRemovalController {
  candidate: DaemonWorkspaceCapability | null;
  activity: DaemonWorkspaceRemovalActivity | null;
  submitting: boolean;
  remoteInProgress: boolean;
  /** Opens the dialog for one workspace; ignored while a removal runs. */
  request: (candidate: DaemonWorkspaceCapability) => void;
  confirm: () => Promise<void>;
  dismiss: () => void;
}

/**
 * The workspace-removal flow shared by the sidebar rows and the Workspaces
 * panel: confirm → remove, `workspace_busy` (409) surfaces the daemon's
 * activity report and arms a forced retry, `workspace_mismatch` (400) means
 * the workspace is already gone and reconciles, and
 * `workspace_removal_in_progress` / `workspace_registration_in_progress`
 * retry briefly while another writer converges.
 */
export function useWorkspaceRemoval(
  options: UseWorkspaceRemovalOptions,
): WorkspaceRemovalController {
  // Callers pass fresh option closures every render; reading them through a
  // ref keeps the controller's identity stable across renders that change
  // nothing, so consumers can key memos (the panel's column definitions)
  // on it without rebuilding per render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [candidate, setCandidate] = useState<DaemonWorkspaceCapability | null>(
    null,
  );
  const [activity, setActivity] =
    useState<DaemonWorkspaceRemovalActivity | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [remoteInProgress, setRemoteInProgress] = useState(false);
  const mountedRef = useRef(false);
  const dismissedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dismissedRef.current = true;
    };
  }, []);

  const handleRemoved = useCallback(
    async (removed: DaemonWorkspaceCapability) => {
      await optionsRef.current.onRemoved(removed);
      if (!mountedRef.current) return;
      setCandidate(null);
      setActivity(null);
      setRemoteInProgress(false);
    },
    [],
  );

  const request = useCallback(
    (next: DaemonWorkspaceCapability) => {
      if (submitting) return;
      dismissedRef.current = false;
      setActivity(null);
      setRemoteInProgress(false);
      setCandidate(next);
    },
    [submitting],
  );

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    setCandidate(null);
    setActivity(null);
    setRemoteInProgress(false);
  }, []);

  const confirm = useCallback(async () => {
    const { removeWorkspace, onError, errorMessage, blockForce } =
      optionsRef.current;
    if (!candidate || submitting) return;
    const force = activity !== null;
    if (force && blockForce?.(candidate)) return;
    setSubmitting(true);
    try {
      await removeWorkspace(candidate.id, { force });
      await handleRemoved(candidate);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof DaemonHttpError) {
        const body = error.body as
          | {
              code?: unknown;
              activity?: DaemonWorkspaceRemovalActivity;
            }
          | undefined;
        if (
          error.status === 409 &&
          body?.code === 'workspace_busy' &&
          body.activity
        ) {
          setActivity(body.activity);
          return;
        }
        if (error.status === 400 && body?.code === 'workspace_mismatch') {
          await handleRemoved(candidate);
          return;
        }
        if (
          error.status === 409 &&
          (body?.code === 'workspace_removal_in_progress' ||
            body?.code === 'workspace_registration_in_progress')
        ) {
          setRemoteInProgress(true);
          let lastError: unknown = error;
          let exhaustedTransientRetries = true;
          for (let attempt = 0; attempt < 20; attempt++) {
            if (!mountedRef.current || dismissedRef.current) {
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            if (!mountedRef.current || dismissedRef.current) {
              return;
            }
            try {
              await removeWorkspace(candidate.id, { force });
              await handleRemoved(candidate);
              return;
            } catch (retryError) {
              if (!mountedRef.current) return;
              lastError = retryError;
              if (retryError instanceof DaemonHttpError) {
                const retryBody = retryError.body as
                  | {
                      code?: unknown;
                      activity?: DaemonWorkspaceRemovalActivity;
                    }
                  | undefined;
                if (
                  retryError.status === 400 &&
                  retryBody?.code === 'workspace_mismatch'
                ) {
                  await handleRemoved(candidate);
                  return;
                }
                if (
                  retryError.status === 409 &&
                  retryBody?.code === 'workspace_busy' &&
                  retryBody.activity
                ) {
                  setRemoteInProgress(false);
                  setActivity(retryBody.activity);
                  return;
                }
                if (
                  retryError.status === 409 &&
                  (retryBody?.code === 'workspace_removal_in_progress' ||
                    retryBody?.code === 'workspace_registration_in_progress')
                ) {
                  continue;
                }
              }
              exhaustedTransientRetries = false;
              break;
            }
          }
          if (!mountedRef.current || dismissedRef.current) {
            return;
          }
          setRemoteInProgress(false);
          onError(
            exhaustedTransientRetries
              ? new Error(
                  'Workspace removal remained in progress after retries.',
                )
              : lastError,
            errorMessage,
          );
          return;
        }
      }
      onError(error, errorMessage);
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }, [activity, candidate, handleRemoved, submitting]);

  // A stable controller identity: consumers put it in memo dependencies
  // (the panel's column definitions), and a fresh object per render would
  // rebuild those on every render — remounting every table cell and
  // re-firing their fetches.
  return useMemo(
    () => ({
      candidate,
      activity,
      submitting,
      remoteInProgress,
      request,
      confirm,
      dismiss,
    }),
    [
      candidate,
      activity,
      submitting,
      remoteInProgress,
      request,
      confirm,
      dismiss,
    ],
  );
}
