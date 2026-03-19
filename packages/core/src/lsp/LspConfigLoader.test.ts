/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import mock from 'mock-fs';
import { LspConfigLoader } from './LspConfigLoader.js';
import type { Extension } from '../extension/extensionManager.js';

describe('LspConfigLoader extension configs', () => {
  const workspaceRoot = '/workspace';
  const extensionPath = '/extensions/ts-plugin';

  afterEach(() => {
    mock.restore();
  });

  it('loads inline lspServers config from extension', async () => {
    const loader = new LspConfigLoader(workspaceRoot);
    const extension = {
      id: 'ts-plugin',
      name: 'ts-plugin',
      version: '1.0.0',
      isActive: true,
      path: extensionPath,
      contextFiles: [],
      config: {
        name: 'ts-plugin',
        version: '1.0.0',
        lspServers: {
          typescript: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: {
              '.ts': 'typescript',
            },
          },
        },
      },
    } as Extension;

    const configs = await loader.loadExtensionConfigs([extension]);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.languages).toEqual(['typescript']);
    expect(configs[0]?.command).toBe('typescript-language-server');
    expect(configs[0]?.args).toEqual(['--stdio']);
  });

  it('loads lspServers config from referenced file and hydrates variables', async () => {
    mock({
      [extensionPath]: {
        '.lsp.json': JSON.stringify({
          typescript: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            env: {
              EXT_ROOT: '${CLAUDE_PLUGIN_ROOT}',
            },
            extensionToLanguage: {
              '.ts': 'typescript',
            },
          },
        }),
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const extension = {
      id: 'ts-plugin',
      name: 'ts-plugin',
      version: '1.0.0',
      isActive: true,
      path: extensionPath,
      contextFiles: [],
      config: {
        name: 'ts-plugin',
        version: '1.0.0',
        lspServers: './.lsp.json',
      },
    } as Extension;

    const configs = await loader.loadExtensionConfigs([extension]);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.env?.['EXT_ROOT']).toBe(extensionPath);
  });
});
