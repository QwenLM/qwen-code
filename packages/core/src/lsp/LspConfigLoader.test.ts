/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import mock from 'mock-fs';
import { LspConfigLoader } from './LspConfigLoader.js';
import type { Extension } from '../extension/extensionManager.js';

describe('LspConfigLoader config-driven behavior', () => {
  const workspaceRoot = '/workspace';

  it('does not generate any presets when no user or extension config provided', () => {
    const loader = new LspConfigLoader(workspaceRoot);
    // Even if languages are detected, no built-in presets should be generated
    const configs = loader.mergeConfigs(['java', 'cpp', 'typescript'], [], []);

    expect(configs).toHaveLength(0);
  });

  it('respects user-provided configs via .lsp.json', () => {
    const loader = new LspConfigLoader(workspaceRoot);
    const userConfigs = [
      {
        name: 'jdtls',
        languages: ['java'],
        command: 'jdtls',
        args: [],
        transport: 'stdio' as const,
        initializationOptions: {},
        rootUri: 'file:///workspace',
        workspaceFolder: workspaceRoot,
        trustRequired: true,
      },
    ];

    const configs = loader.mergeConfigs(['java'], [], userConfigs);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe('jdtls');
    expect(configs[0]?.languages).toEqual(['java']);
  });

  it('respects extension-provided configs', () => {
    const loader = new LspConfigLoader(workspaceRoot);
    const extensionConfigs = [
      {
        name: 'clangd',
        languages: ['cpp', 'c'],
        command: 'clangd',
        args: ['--background-index'],
        transport: 'stdio' as const,
        initializationOptions: {},
        rootUri: 'file:///workspace',
        workspaceFolder: workspaceRoot,
        trustRequired: true,
      },
    ];

    const configs = loader.mergeConfigs(['cpp'], extensionConfigs, []);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe('clangd');
    expect(configs[0]?.command).toBe('clangd');
  });

  it('user configs override extension configs with same name', () => {
    const loader = new LspConfigLoader(workspaceRoot);
    const extensionConfigs = [
      {
        name: 'jdtls',
        languages: ['java'],
        command: 'jdtls',
        args: [],
        transport: 'stdio' as const,
        initializationOptions: {},
        rootUri: 'file:///workspace',
        workspaceFolder: workspaceRoot,
        trustRequired: true,
      },
    ];
    const userConfigs = [
      {
        name: 'jdtls',
        languages: ['java'],
        command: '/custom/path/jdtls',
        args: ['--custom-flag'],
        transport: 'stdio' as const,
        initializationOptions: {},
        rootUri: 'file:///workspace',
        workspaceFolder: workspaceRoot,
        trustRequired: true,
      },
    ];

    const configs = loader.mergeConfigs(['java'], extensionConfigs, userConfigs);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.command).toBe('/custom/path/jdtls');
    expect(configs[0]?.args).toEqual(['--custom-flag']);
  });
});

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
