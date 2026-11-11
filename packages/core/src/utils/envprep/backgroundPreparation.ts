/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { getErrorMessage } from '../errors.js';
import { runLogger } from '../runLogger.js';
import {
  getManagedGitDirectory,
  registerGitBashPreparation,
  type GitBashPreparationResult,
  type GitBashPreparationState,
} from './index.js';
import { validateGitBashInstallation } from './validation.js';
import { getWindowsEnvironmentUrls } from './urls.js';
import type { WindowsEnvironmentUrls } from './types.js';
import { PrepareManager } from './manager.js';
import { SevenZrPreparer } from './sevenZrPreparer.js';
import { GitBashPreparer } from './gitBashPreparer.js';

const PREPARATION_DELAY_MS = 2000;

/** Registers the installation result immediately and runs the installer after startup. */
export function scheduleBackgroundPreparation(
  urls: WindowsEnvironmentUrls = getWindowsEnvironmentUrls(),
  signal?: AbortSignal,
): () => Promise<void> {
  signal?.throwIfAborted();
  const gitDir = getManagedGitDirectory();
  const bashPath = path.join(gitDir, 'bin', 'bash.exe');
  let state: GitBashPreparationState;
  const controller = new AbortController();
  let work: Promise<GitBashPreparationResult> | undefined;

  if (validateGitBashInstallation(gitDir) === null) {
    state = { status: 'succeeded', bashPath };
  } else {
    runLogger.log('[envprep] Scheduling background git-bash preparation');
    const delay = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PREPARATION_DELAY_MS);
      timer.unref();
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    work = delay.then(async (): Promise<GitBashPreparationResult> => {
      try {
        controller.signal.throwIfAborted();
        const baseDir = path.dirname(gitDir);
        const manager = new PrepareManager(baseDir);
        manager.registerPreparer(new SevenZrPreparer(baseDir, urls));
        manager.registerPreparer(new GitBashPreparer(baseDir, urls));

        const result = await manager.prepareAll(controller.signal);
        controller.signal.throwIfAborted();
        if (result.ok) {
          state = { status: 'succeeded', bashPath };
          return { ok: true, bashPath };
        }
        state = { status: 'failed', lastError: result.error };
        return { ok: false, error: result.error };
      } catch (error) {
        const message = getErrorMessage(error);
        state = { status: 'failed', lastError: message };
        if (!controller.signal.aborted) {
          runLogger.warn(`[envprep] Background preparation failed: ${message}`);
        }
        return { ok: false, error: message };
      }
    });
    state = { status: 'running', promise: work };
  }

  const unregister = registerGitBashPreparation(() => state);
  const abortPreparation = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortPreparation, { once: true });
  if (signal?.aborted) abortPreparation();
  return async () => {
    controller.abort(
      new Error('Git Bash preparation cancelled during shutdown'),
    );
    try {
      // The manager releases each lock after its installer has stopped writing.
      await work;
    } finally {
      signal?.removeEventListener('abort', abortPreparation);
      unregister();
    }
  };
}
