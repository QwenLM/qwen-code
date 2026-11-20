/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { buildSpawnChildEnv } from '@qwen-code/acp-bridge/spawnChannel';
import type { BridgeOptions } from '@qwen-code/acp-bridge/bridgeOptions';
import {
  matchesRule,
  parseRule,
} from '@qwen-code/qwen-code-core/permissions/rule-parser.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { normalizeDisabledToolList } from '../config/normalizeDisabledTools.js';
import { readSettingsSnapshot } from '../config/settings.js';
import { readStartupEnvironment } from '../config/environment.js';
import {
  expandsAgainstHome,
  isFullyQualifiedPath,
  readEnvironmentVariable,
  spawnedEnvironmentView,
} from '../config/storage-paths-lite.js';

export const DEFAULT_DAEMON_SESSION_SCOPE = 'single';

/** A relative operator path belongs to the daemon, even after ACP changes cwd. */
export function anchorAcpQwenHome(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const qwenHome = readEnvironmentVariable(environment, 'QWEN_HOME');
  if (
    !qwenHome ||
    isFullyQualifiedPath(qwenHome) ||
    expandsAgainstHome(qwenHome)
  ) {
    return environment;
  }
  const anchored = { ...environment };
  if (process.platform === 'win32') {
    for (const key of Object.keys(anchored)) {
      if (key.toUpperCase() === 'QWEN_HOME') delete anchored[key];
    }
  }
  anchored['QWEN_HOME'] = path.resolve(qwenHome);
  return anchored;
}

function readStartupHome(
  environment: Readonly<NodeJS.ProcessEnv>,
  workspaceCwd: string,
): string {
  const home =
    environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
  if (home) return path.resolve(workspaceCwd, home);
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

export function readTrustedWorkflowSettings(
  workspaceCwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  childEnvOverrides?: Readonly<NodeJS.ProcessEnv>,
) {
  try {
    const launchEnv = childEnvOverrides
      ? spawnedEnvironmentView(
          buildSpawnChildEnv(environment, childEnvOverrides),
        )
      : environment;
    const startupHomeDir = childEnvOverrides
      ? readStartupHome(launchEnv, workspaceCwd)
      : undefined;
    const settings = readSettingsSnapshot(workspaceCwd, {
      environment: launchEnv,
      workspaceTrusted: true,
      ...(startupHomeDir !== undefined ? { startupHomeDir } : {}),
    }).merged;
    const startupEnvironment =
      startupHomeDir !== undefined
        ? readStartupEnvironment(
            settings,
            workspaceCwd,
            launchEnv,
            startupHomeDir,
          )
        : undefined;
    if (childEnvOverrides && !startupEnvironment) return null;
    const { tools, permissions } = settings;
    return {
      ...(startupEnvironment
        ? { startupEnvironment: spawnedEnvironmentView(startupEnvironment) }
        : {}),
      enabled:
        typeof tools?.workflowsEnabled === 'boolean'
          ? tools.workflowsEnabled
          : undefined,
      toolDenied:
        normalizeDisabledToolList(tools?.disabled).includes(
          ToolNames.WORKFLOW,
        ) ||
        [
          ...normalizeDisabledToolList(permissions?.deny),
          ...normalizeDisabledToolList(tools?.exclude),
        ].some((rule) => matchesRule(parseRule(rule), ToolNames.WORKFLOW)),
    };
  } catch {
    return null;
  }
}

export function bindDefaultSessionEngine(
  executionEngines: BridgeOptions['executionEngines'],
  workspaceCwd: string,
  sessionScope: NonNullable<BridgeOptions['sessionScope']>,
) {
  return (
    executionEngines &&
    (() =>
      executionEngines.select({
        operation: 'spawn',
        request: { workspaceCwd, sessionScope },
        daemonOwnedStandalone: false,
      }))
  );
}
