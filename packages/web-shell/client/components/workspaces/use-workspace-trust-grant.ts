/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';

/**
 * A trust grant is written to the daemon's trust file at once, but the
 * capabilities payload reflects each workspace's runtime, which the daemon
 * rebuilds asynchronously. Poll until the rebuild shows up, bounded so a
 * failed reconcile still returns the action to a clickable state.
 */
const TRUST_APPLY_POLL_MS = 1_000;
const TRUST_APPLY_TIMEOUT_MS = 30_000;

export interface UseWorkspaceTrustGrantOptions {
  client: DaemonClient;
  workspaces: readonly DaemonWorkspaceCapability[];
  refreshCapabilities?: () => Promise<unknown>;
  onError: (error: unknown, message: string) => void;
  errorMessage: string;
}

export interface WorkspaceTrustGrantState {
  trustPendingCwd: string | null;
  grantTrust: (ws: DaemonWorkspaceCapability) => void;
}

export function useWorkspaceTrustGrant({
  client,
  workspaces,
  refreshCapabilities,
  onError,
  errorMessage,
}: UseWorkspaceTrustGrantOptions): WorkspaceTrustGrantState {
  const [trustPendingCwd, setTrustPendingCwd] = useState<string | null>(null);
  const [trustTick, setTrustTick] = useState(0);
  const trustDeadlineRef = useRef(0);
  const clientRef = useRef(client);
  const refreshRef = useRef(refreshCapabilities);

  useEffect(() => {
    clientRef.current = client;
    refreshRef.current = refreshCapabilities;
  }, [client, refreshCapabilities]);

  const grantTrust = useCallback(
    (ws: DaemonWorkspaceCapability) => {
      if (trustPendingCwd !== null) return;
      trustDeadlineRef.current = Date.now() + TRUST_APPLY_TIMEOUT_MS;
      setTrustPendingCwd(ws.cwd);
      void (async () => {
        try {
          await clientRef.current.workspaceByCwd(ws.cwd).grantWorkspaceTrust();
        } catch (error) {
          setTrustPendingCwd(null);
          onError(error, errorMessage);
          return;
        }
        void refreshRef.current?.().catch(() => {});
      })();
    },
    [errorMessage, onError, trustPendingCwd],
  );

  // Clears once the granted workspace reports trusted, or at the deadline.
  // The timer re-arms itself rather than relying on the polled payload to
  // change: a refresh that fails leaves `workspaces` untouched, and the
  // deadline must still be reached so the control becomes clickable again.
  useEffect(() => {
    if (trustPendingCwd === null) return;
    const entry = workspaces.find((ws) => ws.cwd === trustPendingCwd);
    if (entry?.trusted || Date.now() >= trustDeadlineRef.current) {
      setTrustPendingCwd(null);
      return;
    }
    const timer = setTimeout(() => {
      void refreshRef.current?.().catch(() => {});
      setTrustTick((tick) => tick + 1);
    }, TRUST_APPLY_POLL_MS);
    return () => clearTimeout(timer);
  }, [trustPendingCwd, trustTick, workspaces]);

  return { trustPendingCwd, grantTrust };
}
