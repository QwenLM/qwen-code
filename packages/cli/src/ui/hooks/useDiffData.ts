/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { Hunk } from 'diff';
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  type GitDiffResult,
} from '@qwen-code/qwen-code-core';

export interface CurrentDiffData {
  /** `null` ⇒ not a git repo / HEAD missing / mid-rebase / etc. */
  result: GitDiffResult | null;
  hunks: Map<string, Hunk[]>;
  loading: boolean;
}

/**
 * Loads "working tree vs HEAD" stats and hunks once when the hook mounts.
 * Mirrors the data shape `fetchGitDiff` already returns so renderers can be
 * driven from a single contract — see `DiffDialog`.
 *
 * Failures are swallowed and surfaced as the empty result; the dialog
 * displays an explanatory empty-state instead of crashing, matching how
 * `/diff` already behaves in non-interactive mode (`diffCommand.ts`).
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
      fetchGitDiff(cwd).catch(() => null),
      fetchGitDiffHunks(cwd).catch(() => new Map<string, Hunk[]>()),
    ]).then(([statsRes, hunksRes]) => {
      if (cancelled) return;
      setResult(statsRes);
      setHunks(hunksRes);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return { result, hunks, loading };
}
