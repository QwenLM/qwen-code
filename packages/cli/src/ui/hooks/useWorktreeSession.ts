/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import fs from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { WorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { readWorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';

/**
 * Polls the exact session sidecar, including creation and atomic replacement.
 * Listener-specific cleanup preserves other subscribers to the same path.
 */
export function useWorktreeSession(config: Config): WorktreeSession | null {
  const [loaded, setLoaded] = useState<{
    config: Config;
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
    const filePath = config
      .getSessionService()
      .getWorktreeSessionPath(sessionId);

    const safeLoad = async () => {
      if (cancelled) return;
      try {
        const ws = await readWorktreeSession(filePath);
        if (!cancelled) setLoaded({ config, sessionId, session: ws });
      } catch {
        if (!cancelled) setLoaded({ config, sessionId, session: null });
      }
    };

    const listener = () => {
      void safeLoad();
    };
    try {
      fs.watchFile(filePath, { persistent: false, interval: 500 }, listener);
    } catch {
      // Watcher setup is best-effort.
    }
    void safeLoad();

    return () => {
      cancelled = true;
      fs.unwatchFile(filePath, listener);
    };
  }, [config, sessionId]);

  return loaded?.config === config && loaded.sessionId === sessionId
    ? loaded.session
    : null;
}
