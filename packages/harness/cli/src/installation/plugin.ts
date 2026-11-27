/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { runLogger, type BuiltinPluginContext } from '@qwen-code/core';
import type { AppPlugin } from '../app-plugins/types.js';
import { qwenInstallationCommands } from './qwen/commands.js';
import { AUTO_UPDATE_DELAY_MS } from './update/updateTypes.js';

/** Qwen product composition; native execution remains in the common service. */
export class QwenInstallationPlugin implements AppPlugin {
  readonly apiVersion = 1 as const;
  readonly id: string = 'qwen-installation';
  private initialized = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private removeAbortListener?: () => void;

  constructor(private readonly workspaceRoot = process.cwd()) {}

  getTerminalCommands() {
    return qwenInstallationCommands();
  }

  async initialize(context: BuiltinPluginContext): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    const cancel = () => {
      this.disposed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    };
    if (context.signal?.aborted) cancel();
    else context.signal?.addEventListener('abort', cancel, { once: true });
    this.removeAbortListener = () =>
      context.signal?.removeEventListener('abort', cancel);
    if (context.mode !== 'interactive' || process.env['DEV'] === 'true') return;
    void this.start(context).catch((error) =>
      runLogger.debug('[Qwen update] Startup failed', error),
    );
  }

  private async start(context: BuiltinPluginContext): Promise<void> {
    await context.whenReady();
    if (this.disposed || context.signal?.aborted) return;
    // Builds without a release source never poll an implicit remote service.
    const { getQwenReleaseBaseURL } = await import('./qwen/paths.js');
    try {
      getQwenReleaseBaseURL();
    } catch {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkForUpdate(context).catch((error) =>
        runLogger.debug('[Qwen update] Skipped/failed', error),
      );
    }, AUTO_UPDATE_DELAY_MS);
    this.timer.unref?.();
  }

  private async checkForUpdate(context: BuiltinPluginContext): Promise<void> {
    const active = () => !this.disposed && !context.signal?.aborted;
    if (!active()) return;
    const readSettings = async () => ({
      ...((await context.runtime?.getSetting(this.workspaceRoot, 'general')) as
        | { enableAutoUpdate?: boolean; enableAutoUpdateNotification?: boolean }
        | undefined),
      ...(context.getLaunchSetting('general') as
        | { enableAutoUpdate?: boolean; enableAutoUpdateNotification?: boolean }
        | undefined),
    });
    let settings = await readSettings();
    if (
      !active() ||
      (settings.enableAutoUpdate === false &&
        settings.enableAutoUpdateNotification === false)
    )
      return;
    const { createQwenInstallation } = await import('./qwen/operations.js');
    const installation = createQwenInstallation();
    if (await installation.isPaused()) return;
    const info = await installation.check();
    if (!active() || !info.available) return;
    settings = await readSettings();
    if (!active() || (await installation.isPaused())) return;
    const { updateEventEmitter } = await import(
      '../utils/updateEventEmitter.js'
    );
    if (settings.enableAutoUpdate === false) {
      if (settings.enableAutoUpdateNotification !== false)
        updateEventEmitter.emit('update-received', {
          message: `Qwen Code update available: ${info.current} → ${info.latest}`,
          update: {
            current: info.current,
            latest: info.latest,
            name: '@qwen-code/qwen-code',
          },
        });
      return;
    }
    updateEventEmitter.emit('update-received', {
      message: `Updating Qwen Code to ${info.latest}`,
      isUpdating: true,
      update: {
        current: info.current,
        latest: info.latest,
        name: '@qwen-code/qwen-code',
      },
    });
    try {
      const result = await installation.update({
        version: info.latest,
        automatic: true,
      });
      updateEventEmitter.emit('update-success', {
        message: result.changed
          ? `Qwen Code updated to ${result.version}. The next run uses this version.`
          : `Qwen Code remains at ${result.version}. No update was applied.`,
      });
    } catch (error) {
      updateEventEmitter.emit('update-failed', {
        message: `Qwen Code update failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
  }
}
