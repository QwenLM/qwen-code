/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonLoopWakeup,
} from '@qwen-code/web-shell/daemon-react-sdk';

/**
 * Loop wakeups are minute-scale events; a 30 s poll keeps the next-tick
 * countdown honest without loading the daemon. A visibility/focus change
 * refreshes sooner (debounced) so returning to a tab shows a fresh state.
 */
export const LOOP_WAKEUPS_POLL_MS = 30_000;

const LOOP_WAKEUPS_REFRESH_DEBOUNCE_MS = 1_000;

/**
 * The pending loop wakeups (`/loop`) of the given workspaces' live sessions,
 * keyed by `sessionId`. `undefined` is the primary workspace; one entry per
 * registered (trusted) workspace fans out like the aggregated scheduled-task
 * view.
 *
 * When `enabled` is false the hook issues no requests and reports an empty
 * map — the caller gates it on `experimental.cron`, the same switch that
 * controls the loop tool. One workspace failing keeps the others; a wholly
 * failed poll reports an empty map (the surfaces hide their rows for up to
 * one poll) and the next tick retries. Never rethrows.
 */
export function useLoopWakeups(
  enabled: boolean,
  workspaceIds: ReadonlyArray<string | undefined>,
): Map<string, DaemonLoopWakeup> {
  const actions = useWorkspaceActions();
  const [wakeups, setWakeups] = useState<Map<string, DaemonLoopWakeup>>(
    () => new Map(),
  );
  const seqRef = useRef(0);
  // Stable across renders that pass an equal list.
  const idsKey = JSON.stringify(workspaceIds.map((id) => id ?? ''));

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    const settled = await Promise.all(
      (JSON.parse(idsKey) as Array<string | undefined>).map(async (raw) => {
        // The JSON round-trip turns the primary's `undefined` into ''; map it
        // back so the action sees the exact contract argument.
        const id = raw === '' ? undefined : raw;
        try {
          return await actions.fetchScheduledTaskWakeups(id);
        } catch {
          // One workspace failing keeps the others.
          return [] as DaemonLoopWakeup[];
        }
      }),
    );
    if (seq !== seqRef.current) return;
    const merged = new Map<string, DaemonLoopWakeup>();
    for (const list of settled) {
      for (const entry of list) merged.set(entry.sessionId, entry);
    }
    setWakeups(merged);
  }, [actions, idsKey]);

  useEffect(() => {
    if (!enabled) {
      // Gate off: no requests, empty view.
      seqRef.current += 1;
      setWakeups(new Map());
      return;
    }
    let cancelled = false;
    let timer = 0;
    let refreshDebounce = 0;
    const run = async () => {
      await reload();
      if (cancelled) return;
      timer = window.setTimeout(() => void run(), LOOP_WAKEUPS_POLL_MS);
    };
    const refresh = () => {
      if (cancelled) return;
      window.clearTimeout(refreshDebounce);
      refreshDebounce = window.setTimeout(
        () => void run(),
        LOOP_WAKEUPS_REFRESH_DEBOUNCE_MS,
      );
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    void run();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      // A load in flight answers no one now.
      seqRef.current += 1;
      window.clearTimeout(timer);
      window.clearTimeout(refreshDebounce);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, reload]);

  return wakeups;
}
