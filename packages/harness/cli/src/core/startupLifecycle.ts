/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getSystemContext,
  prewarmShellProvider,
  runLogger,
  startupTaskId,
  type Config,
} from '@qwen-code/core';
import { registerCleanup } from '../utils/cleanup.js';

const POST_CONFIG_STARTUP_TASK = startupTaskId<boolean>(
  'lifecycle:post-config',
);

export function runAfterAuthAttemptStartup(_config: Config): Promise<void> {
  return Promise.resolve();
}

export function runAfterConfigInitializedStartup(
  config: Config,
): Promise<boolean> {
  if (!config.isInitialized?.()) {
    runLogger.debug(
      '[startup] Skipping config-initialized lifecycle before config.initialize()',
    );
    return Promise.resolve(false);
  }

  if (config.getBuiltinPluginContributions()?.isReady())
    config.getBuiltinPluginContributions()!.markHostReady();

  return config
    .getStartupRuntime()
    .runOnceWhenReady(
      'base',
      { taskId: POST_CONFIG_STARTUP_TASK },
      async () => {
        await runAfterConfigInitializedStartupOnce(config);
        return true;
      },
    );
}

async function runAfterConfigInitializedStartupOnce(
  config: Config,
): Promise<void> {
  startShellSnapshotPrewarm(config);

  // Git status is part of the system prompt, so the first turn cannot start
  // until it has been collected. Collecting it here overlaps the git commands
  // with the rest of startup instead of the user's first request — most
  // visible under `-p`, where startup is immediately followed by a submit and
  // nothing masks the latency.
  startGitSystemContextPrewarm(config);
}

function startGitSystemContextPrewarm(config: Config): void {
  try {
    // Running git against a directory the user has not approved yet would put
    // repository probing ahead of the trust decision. Untrusted folders keep
    // paying the collection cost on their first turn instead.
    if (!config.isTrustedFolder()) {
      runLogger.debug(
        '[system-context] git prewarm skipped: folder not trusted',
      );
      return;
    }

    const startedAt = Date.now();
    const sessionId = config.getSessionId();
    const cwd = config.getWorkingDir();
    const abortController = new AbortController();
    registerCleanup(() =>
      abortController.abort(
        new Error('Git system context prewarm cancelled during cleanup'),
      ),
    );

    runLogger.log(
      `[system-context] git prewarm scheduled session_id=${sessionId} cwd=${cwd}`,
    );

    // No need to wait for worktree settings: resolving them only fills in
    // metadata and never changes the working directory. The paths that do move
    // it (worktree enter/exit/resume) clear the prompt caches explicitly, and
    // the snapshot is keyed by directory, so a stale prewarm goes unused rather
    // than describing the wrong repository.
    void getSystemContext(sessionId, cwd, {
      signal: abortController.signal,
    }).then(
      (systemContext) => {
        runLogger.log(
          `[system-context] git prewarm completed duration_ms=${Date.now() - startedAt} has_git_status=${'gitStatus' in systemContext}`,
        );
      },
      (err: unknown) => {
        if (abortController.signal.aborted) {
          runLogger.log(
            `[system-context] git prewarm cancelled duration_ms=${Date.now() - startedAt}`,
          );
          return;
        }
        runLogger.warn(
          `[system-context] git prewarm failed duration_ms=${Date.now() - startedAt}:`,
          err instanceof Error ? err.message : err,
        );
      },
    );
  } catch (err) {
    runLogger.warn(
      '[system-context] git prewarm scheduling failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

function startShellSnapshotPrewarm(config: Config): void {
  try {
    if (!config.getToolRegistry().getTool('Bash')) {
      return;
    }

    const abortController = new AbortController();
    registerCleanup(() => abortController.abort());
    void prewarmShellProvider('bash', {
      signal: abortController.signal,
    }).catch((err: unknown) => {
      runLogger.debug(
        '[Shell] snapshot prewarm failed:',
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    runLogger.debug(
      '[Shell] snapshot prewarm scheduling failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
