/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  enableDetachedProcessGuard,
  setPkillSelfProtectionEnabled,
  startupProfiler,
} from '@qwen-code/core';
import { endCliStartup } from '../../utils/processStartClock.js';
import { logRouteEntered } from '../route/routeLogging.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

type AcpStartupContext = Pick<
  ConfiguredStartupContext,
  'framework' | 'settings' | 'policy'
>;

export async function runAcpOption(
  context: AcpStartupContext,
  startupCoordinator: StartupCoordinator,
): Promise<void> {
  logRouteEntered(context, 'acp');
  endCliStartup();
  setPkillSelfProtectionEnabled(true);
  enableDetachedProcessGuard();
  const { framework } = context;
  const { argv } = context.settings;
  if (framework.mode !== 'acp') throw new Error('ACP requires its entry framework');
  const manager = await framework.threadManager!.whenCreated();
  const managerReady = framework.threadManager!.whenReady();
  startupCoordinator.startAfterModeEntryCleanup();
  const moduleLoadHandle = startupProfiler.start('acp.module_load');
  const { runAcpServer } = await import('../../acp/acpServer.js');
  moduleLoadHandle?.end();
  await runAcpServer((connection) =>
    framework.createAcpServer({
      argv,
      connection,
      manager,
      managerReady,
    }),
  );
}
