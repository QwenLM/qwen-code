/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Config, WorktreeSession } from '@qwen-code/qwen-code-core';
import { readWorktreeSession } from '@qwen-code/qwen-code-core';

/**
 * Watches the active session's WorktreeSession sidecar file and returns
 * its current contents (or `null` when no active worktree exists).
 *
 * The sidecar lives at `<chatsDir>/<sessionId>.worktree.json`. We watch the
 * directory rather than the file directly because the file may not exist
 * yet when `enter_worktree` hasn't run. Directory watchers also catch
 * rename/delete events that file watchers miss.
 *
 * Known limitation: `fs.watch` holds an inode handle to `chatsDir` at
 * mount time. If the directory is deleted out-of-band (manual cleanup,
 * antivirus quarantine, reset scripts) and then recreated, the watcher
 * does NOT re-attach to the new inode — the Footer indicator stops
 * responding to sidecar changes until the session restarts. In normal
 * use `chatsDir` is stable for the session's lifetime; if rotation
 * becomes a real failure mode, add a polling fallback or listen for
 * `watcher.on('error')` and re-run `setupWatcher`. (PR #4174 review
 * #3256239608.)
 */
export function useWorktreeSession(config: Config): WorktreeSession | null {
  const [session, setSession] = useState<WorktreeSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    const safeLoad = async () => {
      try {
        const filePath = config
          .getSessionService()
          .getWorktreeSessionPath(config.getSessionId());
        const ws = await readWorktreeSession(filePath);
        if (!cancelled) setSession(ws);
      } catch {
        if (!cancelled) setSession(null);
      }
    };

    void safeLoad();

    const filePath = config
      .getSessionService()
      .getWorktreeSessionPath(config.getSessionId());
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
  }, [config]);

  return session;
}
