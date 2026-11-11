/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/core';
import type { Settings } from '../config/settings.js';
import { registerCleanup } from '../utils/cleanup.js';
import {
  cancelDeferredStartupCleanup,
  startDeferredStartupCleanup,
} from '../utils/deferredStartupTasks.js';
import {
  runAfterAuthAttemptStartup as runAfterAuthAttemptStartupLifecycle,
  runAfterConfigInitializedStartup as runAfterConfigInitializedStartupLifecycle,
} from '../core/startupLifecycle.js';
import type { StartupCleanupPhase, StartupPolicy } from './startupPolicy.js';

export class StartupCoordinator {
  constructor(
    readonly policy: StartupPolicy,
    private readonly settings: Settings,
  ) {}

  private startCleanupForPhase(
    phase: StartupCleanupPhase,
    config: Config | undefined,
    options: { includeProjectCleanup?: boolean } = {},
  ): void {
    if (this.policy.cleanup.phase !== phase) {
      return;
    }
    startDeferredStartupCleanup(this.settings, config, {
      delayMs: this.policy.cleanup.delayMs,
      ref: this.policy.cleanup.ref,
      ...options,
    });
  }

  /** 无进程级 Config 的入口（ACP）只跑不依赖项目目录的全局清理。 */
  startAfterModeEntryCleanup(config?: Config): void {
    this.startCleanupForPhase('afterModeEntry', config);
  }

  startAfterSdkInitializeCleanup(config: Config): void {
    this.startCleanupForPhase('afterSdkInitialize', config);
  }

  startAfterFirstRenderCleanup(
    config: Config,
    options: { includeProjectCleanup?: boolean } = {},
  ): void {
    this.startCleanupForPhase('afterFirstRender', config, options);
  }

  registerStartupCleanupOnExit(): void {
    registerCleanup(() => {
      cancelDeferredStartupCleanup(this.settings);
    });
  }

  async runAfterAuthAttemptStartup(config: Config): Promise<void> {
    await runAfterAuthAttemptStartupLifecycle(config);
  }

  async runAfterConfigInitializedStartup(config: Config): Promise<boolean> {
    return runAfterConfigInitializedStartupLifecycle(config);
  }
}

export {
  runAfterAuthAttemptStartupLifecycle as runAfterAuthAttemptStartup,
  runAfterConfigInitializedStartupLifecycle as runAfterConfigInitializedStartup,
};
