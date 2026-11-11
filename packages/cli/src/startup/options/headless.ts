/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setPkillSelfProtectionEnabled } from '@qwen-code/core';
import type { HeadlessAppFramework } from '../../framework/headlessAppFramework.js';
import { endCliStartup } from '../../utils/processStartClock.js';
import { logRouteEntered } from '../route/routeLogging.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

/**
 * Pure Headless 入口：与 daemon / ACP 同一层分派，入口不再参与会话装配、
 * 会话恢复或启动后流水线。路由标签与启动事件在这里补发，保证与其他入口可比。
 */
export async function runHeadlessOption(
  context: ConfiguredStartupContext,
  startupCoordinator: StartupCoordinator,
): Promise<void> {
  const { config, framework, settings } = context;
  if (framework.mode !== 'headless') {
    throw new Error('Headless requires its entry framework');
  }
  const { argv } = settings;
  logRouteEntered(
    context,
    argv.inputFormat === 'stream-json'
      ? 'headlessStreamJson'
      : 'headlessText',
  );
  endCliStartup();
  setPkillSelfProtectionEnabled(true);
  startupCoordinator.startAfterModeEntryCleanup(config);

  const headless = framework as HeadlessAppFramework;
  await headless.init();
  const session = await headless.getHeadlessSession();
  await session.run();
}
