/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { resolveBranchName, watchRepoBranch } from '@qwen-code/qwen-code-core';

/**
 * Tracks the current git branch (or a short commit hash when detached) for
 * `cwd`, read directly from `.git` via core's gitDirect helpers — no `git`
 * subprocess. Re-reads automatically when the repository's reflog moves
 * (branch switch, commit, reset).
 */
export function useGitBranchName(cwd: string): string | undefined {
  const [branchName, setBranchName] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    const refresh = async () => {
      const name = await resolveBranchName(cwd);
      if (!cancelled) setBranchName(name);
    };

    const init = async () => {
      await refresh();
      if (cancelled) return;
      const disposer = await watchRepoBranch(cwd, () => {
        // Guard the watcher-triggered refresh too: the synchronous try/catch
        // inside watchRepoBranch can't observe an async rejection.
        void refresh().catch(() => {});
      });
      // The component may have unmounted while we were resolving the watcher;
      // if so, dispose immediately rather than leaking the subscription.
      if (cancelled) {
        disposer();
      } else {
        dispose = disposer;
      }
    };

    // Defensive: init() shouldn't reject (resolveBranchName / watchRepoBranch
    // swallow their own errors), but guard so a future change can't surface an
    // unhandled rejection on the render path.
    void init().catch(() => {});

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [cwd]);

  return branchName;
}
