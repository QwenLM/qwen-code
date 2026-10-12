/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import mock from 'mock-fs';
import * as path from 'node:path';
import { LspConfigLoader } from './LspConfigLoader.js';
import type { Extension } from '../extension/extensionManager.js';

const workspaceRoot = '/workspace';
const loader = () => new LspConfigLoader(workspaceRoot);

/** Mocks `/workspace/.lsp.json` holding `servers` as JSON. */
const mockLspJson = (servers: unknown) =>
  mock({ [workspaceRoot]: { '.lsp.json': JSON.stringify(servers) } });

/** A resolved stdio server config for the workspace. */
const stdioServer = (fields: {
  name: string;
  languages: string[];
  command: string;
  args: string[];
}) => ({
  ...fields,
  transport: 'stdio' as const,
  initializationOptions: {},
  rootUri: 'file:///workspace',
  workspaceFolder: workspaceRoot,
  trustRequired: true,
});

describe('LspConfigLoader config-driven behavior', () => {
  afterEach(() => {
    mock.restore();
  });

  it('does not generate any presets when no user or extension config provided', () => {
    // Even if languages are detected, no built-in presets are generated.
    const configs = loader().mergeConfigs(
      ['java', 'cpp', 'typescript'],
      [],
      [],
    );
    expect(configs).toHaveLength(0);
  });

  it('respects user-provided configs via .lsp.json', () => {
    const userConfigs = [
      stdioServer({
        name: 'jdtls',
        languages: ['java'],
        command: 'jdtls',
        args: [],
      }),
    ];
    const configs = loader().mergeConfigs(['java'], [], userConfigs);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe('jdtls');
    expect(configs[0]?.languages).toEqual(['java']);
  });

  it('respects extension-provided configs', () => {
    const extensionConfigs = [
      stdioServer({
        name: 'clangd',
        languages: ['cpp', 'c'],
        command: 'clangd',
        args: ['--background-index'],
      }),
    ];
    const configs = loader().mergeConfigs(['cpp'], extensionConfigs, []);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe('clangd');
    expect(configs[0]?.command).toBe('clangd');
  });

  it('user configs override extension configs with same name', () => {
    const extensionConfigs = [
      stdioServer({
        name: 'jdtls',
        languages: ['java'],
        command: 'jdtls',
        args: [],
      }),
    ];
    const userConfigs = [
      stdioServer({
        name: 'jdtls',
        languages: ['java'],
        command: '/custom/path/jdtls',
        args: ['--custom-flag'],
      }),
    ];
    const configs = loader().mergeConfigs(
      ['java'],
      extensionConfigs,
      userConfigs,
    );

    expect(configs).toHaveLength(1);
    expect(configs[0]?.command).toBe('/custom/path/jdtls');
    expect(configs[0]?.args).toEqual(['--custom-flag']);
  });

  it('accepts valid string socket ports from .lsp.json', async () => {
    mockLspJson({
      typescript: { transport: 'tcp', host: '127.0.0.1', port: '1234' },
    });
    const configs = await loader().loadUserConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0]?.socket).toEqual({ host: '127.0.0.1', port: 1234 });
  });

  it('rejects malformed socket ports from .lsp.json', async () => {
    for (const port of ['1.5', '0x10', 1.5, 0, 65_536]) {
      mockLspJson({
        typescript: { transport: 'tcp', host: '127.0.0.1', port },
      });
      const configs = await loader().loadUserConfigs();
      expect(configs, `port ${JSON.stringify(port)}`).toHaveLength(0);
      mock.restore();
    }
  });

  it('strict user config loading rejects invalid server entries', async () => {
    mockLspJson({ typescript: { transport: 'stdio' } });
    const result = await loader().loadUserConfigsStrict();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        `Invalid LSP server config in ${path.join('/workspace', '.lsp.json')}: typescript`,
      );
    }
  });

  it('strict user config loading accepts empty object as explicit empty config', async () => {
    mockLspJson({});
    const result = await loader().loadUserConfigsStrict();
    expect(result).toEqual({ ok: true, configs: [] });
  });

  it('strict user config loading treats deleted config as empty', async () => {
    mock({ [workspaceRoot]: {} });
    const result = await loader().loadUserConfigsStrict();
    expect(result).toEqual({ ok: true, configs: [] });
  });

  it('non-strict user config loading skips invalid entries without rejecting all configs', async () => {
    mockLspJson({
      typescript: { command: 'typescript-language-server' },
      invalid: { transport: 'stdio' },
    });
    const configs = await loader().loadUserConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe('typescript-language-server');
  });

  it('non-strict user config loading returns empty configs for malformed JSON', async () => {
    mock({ [workspaceRoot]: { '.lsp.json': '{' } });
    const configs = await loader().loadUserConfigs();
    expect(configs).toEqual([]);
  });

  it('forces user configs to require trusted workspaces', async () => {
    mockLspJson({
      typescript: {
        command: 'typescript-language-server',
        trustRequired: false,
      },
    });
    const configLoader = loader();

    await expect(configLoader.loadUserConfigs()).resolves.toEqual([
      expect.objectContaining({ trustRequired: true }),
    ]);
    await expect(configLoader.loadUserConfigsStrict()).resolves.toEqual({
      ok: true,
      configs: [expect.objectContaining({ trustRequired: true })],
    });
  });
});

describe('LspConfigLoader extension configs', () => {
  const extensionPath = '/extensions/ts-plugin';

  /** An active `ts-plugin` extension declaring `lspServers`. */
  const tsPlugin = (lspServers: unknown) =>
    ({
      id: 'ts-plugin',
      name: 'ts-plugin',
      version: '1.0.0',
      isActive: true,
      path: extensionPath,
      contextFiles: [],
      config: { name: 'ts-plugin', version: '1.0.0', lspServers },
    }) as Extension;

  afterEach(() => {
    mock.restore();
  });

  it('loads inline lspServers config from extension', async () => {
    const extension = tsPlugin({
      typescript: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript' },
      },
    });
    const configs = await loader().loadExtensionConfigs([extension]);

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
            env: { EXT_ROOT: '${CLAUDE_PLUGIN_ROOT}' },
            extensionToLanguage: { '.ts': 'typescript' },
          },
        }),
      },
    });
    const configs = await loader().loadExtensionConfigs([
      tsPlugin('./.lsp.json'),
    ]);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.env?.['EXT_ROOT']).toBe(extensionPath);
  });
});
