/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonAutofixPrWatchList,
} from '@qwen-code/web-shell/daemon-react-sdk';

/** A watch moves when a gate fires or a round runs: minutes, not seconds. */
export const AUTOFIX_PR_WATCHES_RELOAD_MS = 15_000;

/** The key a workspace's list is under: its id, or '' for the primary. */
export function autofixPrWatchesKey(workspaceId: string | undefined): string {
  return workspaceId ?? '';
}

export interface AutofixPrWatchesState {
  /** Each workspace's watches, by `autofixPrWatchesKey`; missing while it
   * loads or when it failed. */
  lists: ReadonlyMap<string, DaemonAutofixPrWatchList>;
  /** The first workspace that failed, if any. */
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
}

/**
 * The `/autofix-pr` watches of the given workspaces (`undefined` is the
 * primary), polled on a slow lane while `enabled`. One workspace failing
 * keeps the others.
 */
export function useAutofixPrWatches(
  enabled: boolean,
  workspaceIds: ReadonlyArray<string | undefined>,
): AutofixPrWatchesState {
  const actions = useWorkspaceActions();
  const [lists, setLists] = useState<
    ReadonlyMap<string, DaemonAutofixPrWatchList>
  >(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const seqRef = useRef(0);
  // Stable across renders that pass an equal list.
  const key = JSON.stringify(workspaceIds.map(autofixPrWatchesKey));

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    if (!enabled) return;
    let firstError: string | null = null;
    const results = await Promise.all(
      (JSON.parse(key) as string[]).map(async (id) => {
        try {
          return [
            id,
            await actions.listAutofixPrWatches(id === '' ? undefined : id),
          ] as const;
        } catch (err) {
          firstError ??= err instanceof Error ? err.message : String(err);
          return null;
        }
      }),
    );
    if (seq !== seqRef.current) return;
    setLists(
      new Map(
        results.filter(
          (entry): entry is readonly [string, DaemonAutofixPrWatchList] =>
            entry !== null,
        ),
      ),
    );
    setError(firstError);
    setLoaded(true);
  }, [actions, enabled, key]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer = 0;
    const run = async () => {
      await reload();
      if (cancelled) return;
      timer = window.setTimeout(() => void run(), AUTOFIX_PR_WATCHES_RELOAD_MS);
    };
    void run();
    return () => {
      cancelled = true;
      // A load in flight answers no one now.
      seqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [enabled, reload]);

  return { lists, error, loaded, reload };
}
