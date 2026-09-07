/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import {
  resolveBranchName,
  watchRepoBranch,
} from '@qwen-code/qwen-code-core/utils/gitDirect.js';

/**
 * Polling interval (ms) for the branch-name fallback. `fs.watch` on the
 * reflog is unreliable on NFS / FUSE / Docker overlay and some Linux
 * filesystems — events can be silently dropped with no recovery path.
 * A lightweight poll every 5 s ensures the footer branch name self-heals
 * within one interval even when the watcher misses a branch switch.
 */
export const BRANCH_POLL_INTERVAL_MS = 5_000;

/**
 * Tracks the current git branch (or a short commit hash when detached) for
 * `cwd`, read directly from `.git` via core's gitDirect helpers — no `git`
 * subprocess. Re-reads automatically when the repository's reflog moves
 * (branch switch, commit, reset), with a polling fallback for filesystems
 * where `fs.watch` is unreliable (#7828).
 */
export function useGitBranchName(cwd: string): string | undefined {
  const [branchName, setBranchName] = useState<string | undefined>(undefined);
  const branchNameRef = useRef(branchName);
  branchNameRef.current = branchName;

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    // Orders concurrent refreshes (watcher callback + polling interval): a
    // read that started earlier can resolve later and would otherwise
    // overwrite a newer result with a stale branch name.
    let refreshGeneration = 0;

    const refresh = async () => {
      const generation = ++refreshGeneration;
      const name = await resolveBranchName(cwd);
      if (
        !cancelled &&
        generation === refreshGeneration &&
        name !== branchNameRef.current
      ) {
        setBranchName(name);
      }
    };

    const init = async () => {
      await refresh();
      if (cancelled) return;
      const disposer = await watchRepoBranch(cwd, () => {
        void refresh().catch(() => {});
      });
      // The component may have unmounted while we were resolving the watcher;
      // if so, dispose immediately rather than leaking the subscription.
      if (cancelled) {
        disposer();
      } else {
        dispose = disposer;
      }

      if (!cancelled) {
        pollTimer = setInterval(() => {
          void refresh().catch(() => {});
        }, BRANCH_POLL_INTERVAL_MS);
        // Don't keep the process alive just for this timer.
        pollTimer.unref?.();
      }
    };

    // Defensive: init() shouldn't reject (resolveBranchName / watchRepoBranch
    // swallow their own errors), but guard so a future change can't surface an
    // unhandled rejection on the render path.
    void init().catch(() => {});

    return () => {
      cancelled = true;
      dispose?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [cwd]);

  return branchName;
}
