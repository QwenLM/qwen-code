/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { Hunk } from 'diff';
import {
  createDebugLogger,
  fetchGitDiff,
  fetchGitDiffHunks,
  type GitDiffResult,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('DiffDialog');

export interface CurrentDiffData {
  /** `null` ⇒ not a git repo / HEAD missing / mid-rebase / etc. */
  result: GitDiffResult | null;
  hunks: Map<string, Hunk[]>;
  loading: boolean;
}

/**
 * Loads "working tree vs HEAD" stats and hunks **once at mount**. Mirrors
 * the data shape `fetchGitDiff` already returns so renderers can be
 * driven from a single contract — see `DiffDialog`.
 *
 * Snapshot semantics: the dialog's "Current" tab reflects the state at
 * the moment `/diff` was opened, not the live worktree. Re-fetching on
 * every render would flicker the UI as users navigate between sources;
 * users who want a fresh view can close and reopen `/diff`. The
 * `cwd`-only dependency reinforces this — typing in another shell pane
 * does not retrigger the fetch.
 *
 * Failures are swallowed and surfaced as the empty result (the dialog
 * displays an explanatory empty-state instead of crashing), matching
 * how non-interactive `/diff` already behaves. We log them at the debug
 * level so an operator can still trace permission flips, corrupt index
 * files, or other git failures.
 */
export function useDiffData(cwd: string | undefined): CurrentDiffData {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [hunks, setHunks] = useState<Map<string, Hunk[]>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!cwd) {
      setResult(null);
      setHunks(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      fetchGitDiff(cwd).catch((err) => {
        debugLogger.debug(`fetchGitDiff failed: ${err}`);
        return null;
      }),
      fetchGitDiffHunks(cwd).catch((err) => {
        debugLogger.debug(`fetchGitDiffHunks failed: ${err}`);
        return new Map<string, Hunk[]>();
      }),
    ])
      .then(([statsRes, hunksRes]) => {
        if (cancelled) return;
        setResult(statsRes);
        setHunks(hunksRes);
        setLoading(false);
      })
      .catch((err) => {
        // Defense-in-depth: each inner promise already swallows its own
        // errors, but a setState during unmount or a future refactor could
        // still throw here. Log and unstick `loading` rather than letting
        // the rejection propagate to the default-handler.
        debugLogger.debug(`useDiffData pipeline failed: ${err}`);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return { result, hunks, loading };
}
