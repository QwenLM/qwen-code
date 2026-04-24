/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopAcpLaunchConfig } from './resolveCli.js';

describe('resolveDesktopAcpLaunchConfig', () => {
  it('resolves the built CLI entry in development', () => {
    const root = fileURLToPath(new URL('../../../../..', import.meta.url));
    const config = resolveDesktopAcpLaunchConfig({
      isPackaged: false,
      resourcesPath: '/unused/resources',
      mainModuleUrl: pathToFileURL(
        join(root, 'packages/desktop/dist/main/main.js'),
      ).toString(),
      env: { npm_node_execpath: '/usr/local/bin/node' },
      execPath: '/Applications/Qwen Code.app/Contents/MacOS/Qwen Code',
    });

    expect(config).toMatchObject({
      cliEntryPath: join(root, 'packages/cli/dist/index.js'),
      command: '/usr/local/bin/node',
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
  });

  it('resolves the extraResources CLI bundle in packaged apps', () => {
    const config = resolveDesktopAcpLaunchConfig({
      isPackaged: true,
      resourcesPath: '/Applications/Qwen Code.app/Contents/Resources',
      mainModuleUrl: 'file:///app.asar/dist/main/main.js',
      env: {},
      execPath: '/Applications/Qwen Code.app/Contents/MacOS/Qwen Code',
    });

    expect(config).toMatchObject({
      cliEntryPath:
        '/Applications/Qwen Code.app/Contents/Resources/qwen-cli/cli.js',
      command: '/Applications/Qwen Code.app/Contents/MacOS/Qwen Code',
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
  });

  it('honors an explicit desktop CLI override', () => {
    const config = resolveDesktopAcpLaunchConfig({
      isPackaged: true,
      resourcesPath: '/unused/resources',
      mainModuleUrl: 'file:///app.asar/dist/main/main.js',
      env: {
        QWEN_DESKTOP_CLI_PATH: '/tmp/qwen-cli.js',
        QWEN_DESKTOP_NODE_PATH: '/opt/node/bin/node',
      },
      execPath: '/Applications/Qwen Code.app/Contents/MacOS/Qwen Code',
    });

    expect(config).toMatchObject({
      cliEntryPath: '/tmp/qwen-cli.js',
      command: '/opt/node/bin/node',
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
  });
});
