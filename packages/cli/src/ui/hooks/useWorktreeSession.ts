/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import fs from 'node:fs';
import { shouldPollFileWatchers } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { WorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { readWorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';

/**
 * Watches the active session's WorktreeSession sidecar file and returns
 * its current contents (or `null` when no active worktree exists).
 *
 * Bun on macOS polls the exact sidecar path, including when it is absent.
 * Other runtimes retain the directory watcher, whose inode does not reattach
 * after an out-of-band directory replacement.
 */
export function useWorktreeSession(config: Config): WorktreeSession | null {
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    session: WorktreeSession | null;
  } | null>(null);
  const sessionId = config.getSessionId();

  useEffect(() => {
    if (config.getShellExecutionSandbox?.()) {
      setLoaded(null);
      return;
    }
    let cancelled = false;

    const safeLoad = async () => {
      try {
        const filePath = config
          .getSessionService()
          .getWorktreeSessionPath(sessionId);
        const ws = await readWorktreeSession(filePath);
        if (!cancelled) setLoaded({ sessionId, session: ws });
      } catch {
        if (!cancelled) setLoaded({ sessionId, session: null });
      }
    };

    void safeLoad();

    const filePath = config
      .getSessionService()
      .getWorktreeSessionPath(sessionId);
    if (shouldPollFileWatchers()) {
      const listener = () => {
        if (cancelled) return;
        void safeLoad();
      };
      try {
        fs.watchFile(filePath, { persistent: false, interval: 500 }, listener);
      } catch {
        // Watcher setup is best-effort.
      }
      return () => {
        cancelled = true;
        fs.unwatchFile(filePath, listener);
      };
    }

    const dirPath = path.dirname(filePath);
    const fileName = path.basename(filePath);

    let watcher: fs.FSWatcher | undefined;

    const setupWatcher = async () => {
      try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        if (cancelled) return;
        watcher = fs.watch(dirPath, (_eventType, filename) => {
          if (filename === null || filename.toString() === fileName) {
            void safeLoad();
          }
        });
      } catch {
        // Watcher setup is best-effort
      }
    };

    void setupWatcher();

    return () => {
      cancelled = true;
      watcher?.close();
    };
  }, [config, sessionId]);

  return loaded?.sessionId === sessionId ? loaded.session : null;
}
