/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { useDaemonStatusReport } from './useDaemonStatusReport.js';

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
 */
export function useDaemonOverloadPause(options: {
  enabled: boolean;
  refusal: OverloadRefusal | null;
  onRefusalExpired: () => void;
}) {
  const { enabled, refusal, onRefusalExpired } = options;
  const { report, reload } = useDaemonStatusReport({ enabled });

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      void reload();
    }, OVERLOAD_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, reload]);

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
