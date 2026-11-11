/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createWorkingStdio,
  enableDetachedProcessGuard,
  setPkillSelfProtectionEnabled,
  StartupDiagnostics,
  startupProfiler,
} from '@qwen-code/core';
import { gracefulExit, runExitCleanupWithTimeout } from '../../utils/cleanup.js';
import { endCliStartup } from '../../utils/processStartClock.js';
import { logRouteEntered } from '../route/routeLogging.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

export async function runSdkOption(
  context: ConfiguredStartupContext,
  startupCoordinator: StartupCoordinator,
): Promise<void> {
  logRouteEntered(context, 'daemon');
  endCliStartup();
  setPkillSelfProtectionEnabled(true);
  enableDetachedProcessGuard();
  const { config, framework } = context;
  if (framework.mode !== 'daemon') throw new Error('Daemon requires its entry framework');
  const diagnostics = new StartupDiagnostics(
    config.getSessionId(),
    config.getTargetDir(),
  );
  try {
    startupCoordinator.startAfterModeEntryCleanup(config);
    // 只等注册表创建，不等 built-in 插件初始化；握手不依赖插件 ready。
    (await framework.appPlugins!.whenCreated()).markHostReady();
    // TUI 入口已重定向 process.stdout.write；协议 NDJSON 必须绕过该补丁。
    const { stdout } = createWorkingStdio();
    const createServerHandle = startupProfiler.start('daemon.create_server');
    const server = await diagnostics.phase('daemon.create_server', async () =>
      framework.createSdkServer({
        input: process.stdin,
        output: stdout,
        config,
        framework,
      }),
    );
    createServerHandle?.end();
    await server.run();
  } finally {
    // Common cleanup owns the root Config; the product server disposes its workers/auth.
    await diagnostics.phase('daemon.cleanup', () =>
      runExitCleanupWithTimeout(),
    );
  }
  // A completed protocol shutdown owns process termination, just like headless.
  await gracefulExit(0, { exitReason: 'natural_end' });
}
