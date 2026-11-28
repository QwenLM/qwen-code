/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  // A backgrounded tab must not issue the mount request either; becoming
  // visible re-enables the resource and its autoLoad effect.
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  // Track the mount/autoLoad request too: the interval guard alone would
  // stack a second summary on top of a mount request the daemon holds for
  // the full 30 s client timeout.
  const pendingRef = useRef(0);
  const load = useCallback(() => {
    pendingRef.current += 1;
    return actions!.loadDaemonStatus('summary').finally(() => {
      pendingRef.current -= 1;
    });
  }, [actions]);
  // autoLoad so an already-overloaded daemon is visible before the first
  // interval tick (and again after every reconnect, which re-creates load).
  const {
    data: report,
    error,
    reload,
  } = useDaemonResource(load, {
    enabled: enabled && actions !== undefined && visible,
    autoLoad: true,
  });
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || actions === undefined) return;
    const timer = setInterval(() => {
      // Same guards as the status dialog poller: a saturated daemon can hold
      // a summary request for the full 30 s client timeout, and a hidden tab
      // should not add load to the condition being reported.
      if (document.hidden || inFlightRef.current || pendingRef.current > 0)
        return;
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
  // Freshness bound: useDaemonResource keeps the last payload across poll
  // failures and when disabled/unavailable. Gate on both the settled error
  // and enabled so stale overload data cannot revive during a retry or keep
  // creation disabled while status stops answering or the daemon is offline.
  const pollOverloaded =
    enabled && error === undefined && loadAdmission?.overloaded === true;
  const reactiveActive = refusal !== null && Date.now() < refusal.expiresAt;
  return {
    paused: pollOverloaded || reactiveActive,
    pollOverloaded,
    loadAdmission,
    refusalMessage: refusal?.message,
  };
}
