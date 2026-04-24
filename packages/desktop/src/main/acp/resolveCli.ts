/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcpProcessClientOptions } from '../../server/acp/AcpProcessClient.js';

export interface ResolveDesktopAcpLaunchOptions {
  isPackaged: boolean;
  resourcesPath: string;
  mainModuleUrl: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

export function resolveDesktopAcpLaunchConfig(
  options: ResolveDesktopAcpLaunchOptions,
): AcpProcessClientOptions {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const command =
    env['QWEN_DESKTOP_NODE_PATH'] ?? env['npm_node_execpath'] ?? execPath;
  const childEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const overridePath = env['QWEN_DESKTOP_CLI_PATH'];

  if (overridePath) {
    return {
      cliEntryPath: overridePath,
      command,
      env: childEnv,
    };
  }

  if (options.isPackaged) {
    return {
      cliEntryPath: join(options.resourcesPath, 'qwen-cli', 'cli.js'),
      command: execPath,
      env: childEnv,
    };
  }

  return {
    cliEntryPath: join(
      getRepositoryRoot(options.mainModuleUrl),
      'packages',
      'cli',
      'dist',
      'index.js',
    ),
    command,
    env: childEnv,
  };
}

function getRepositoryRoot(mainModuleUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainModuleUrl));
  return resolve(mainDir, '../../../..');
}
