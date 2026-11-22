/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import { useOptionalDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import { useDaemonResource } from './useDaemonResource.js';

export interface OverloadRefusal {
  message: string;
  expiresAt: number;
}

export const OVERLOAD_REFUSAL_TTL_MS = 15_000;
export const OVERLOAD_POLL_INTERVAL_MS = 5_000;

/**
 * Combines the two load-admission pause sources: the proactive status poll
 * (`runtime.loadAdmission.overloaded`) and an unexpired `system_overloaded`
 * refusal hint. The poll side is derived each render; the refusal side is a
 * single expiring value owned by the caller, cleared through
 * `onRefusalExpired` so a poll gap cannot hide a fresh refusal and the UI
 * never stays paused longer than the daemon's retry hint without poll
 * confirmation.
 *
 * Best-effort by design: without an ancestor workspace provider (embedded
 * pickers, provider-less renders) the poll simply never runs instead of
 * throwing, and the reactive refusal hint still works.
 */
export function useDaemonOverloadPause(options: {
  enabled: boolean;
  refusal: OverloadRefusal | null;
  onRefusalExpired: () => void;
}) {
  const { enabled, refusal, onRefusalExpired } = options;
  const workspace = useOptionalDaemonWorkspace();
  const actions = workspace?.actions;
  const load = useCallback(
    () => actions!.loadDaemonStatus('summary'),
    [actions],
  );
  // autoLoad so an already-overloaded daemon is visible before the first
  // interval tick (and again after every reconnect, which re-creates load).
  const { data: report, reload } = useDaemonResource(load, {
    enabled: enabled && actions !== undefined,
    autoLoad: true,
  });
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || actions === undefined) return;
    const timer = setInterval(() => {
      // Same guards as the status dialog poller: a saturated daemon can hold
      // a summary request for the full 30 s client timeout, and a hidden tab
      // should not add load to the condition being reported.
      if (document.hidden || inFlightRef.current) return;
      inFlightRef.current = true;
      void reload().finally(() => {
        inFlightRef.current = false;
      });
    }, OVERLOAD_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, actions, reload]);

  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(
      onRefusalExpired,
      Math.max(0, refusal.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [refusal, onRefusalExpired]);

  const loadAdmission = report?.runtime.loadAdmission;
  const pollOverloaded = loadAdmission?.overloaded === true;
  const reactiveActive = refusal !== null && Date.now() < refusal.expiresAt;
  return {
    paused: pollOverloaded || reactiveActive,
    pollOverloaded,
    loadAdmission,
    refusalMessage: refusal?.message,
  };
}
