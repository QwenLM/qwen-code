/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import {
  readGitHead,
  resolveGitRepositoryLayout,
} from '@qwen-code/core';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export function useGitBranchName(cwd: string): string | undefined {
  const [branchName, setBranchName] = useState<string | undefined>(undefined);

  const fetchBranchName = useCallback(async () => {
    try {
      const layout = await resolveGitRepositoryLayout(cwd);
      const head = layout ? await readGitHead(layout) : null;
      setBranchName(head?.branch ?? head?.commit?.slice(0, 7));
    } catch {
      setBranchName(undefined);
    }
  }, [cwd, setBranchName]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetchBranchName(); // Initial fetch

    let watcher: fs.FSWatcher | undefined;
    let cancelled = false;

    const setupWatcher = async () => {
      try {
        const layout = await resolveGitRepositoryLayout(cwd);
        if (!layout) return;
        const gitLogsHeadPath = path.join(layout.gitDir, 'logs', 'HEAD');
        // Reflogs may be disabled or absent in a newly initialized repository.
        await fsPromises.access(gitLogsHeadPath, fs.constants.F_OK);
        if (cancelled) return;
        watcher = fs.watch(gitLogsHeadPath, (eventType: string) => {
          // Changes to .git/logs/HEAD (appends) indicate HEAD has likely changed
          if (eventType === 'change' || eventType === 'rename') {
            // Handle rename just in case
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            fetchBranchName();
          }
        });
      } catch {
        // Silently ignore watcher errors (e.g. permissions or file not existing),
        // similar to how exec errors are handled.
        // The branch name will simply not update automatically.
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    setupWatcher();

    return () => {
      cancelled = true;
      watcher?.close();
    };
  }, [cwd, fetchBranchName]);

  return branchName;
}
