/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import mock from 'mock-fs';
import * as path from 'node:path';
import { LspConfigLoader } from './LspConfigLoader.js';
import type { Extension } from '../extension/extensionManager.js';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    isEnabled: () => true,
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

describe('LspConfigLoader config-driven behavior', () => {
  const workspaceRoot = '/workspace';

  afterEach(() => {
    mock.restore();
  });

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

    const configs = loader.mergeConfigs(
      ['java'],
      extensionConfigs,
      userConfigs,
    );

    expect(configs).toHaveLength(1);
    expect(configs[0]?.command).toBe('/custom/path/jdtls');
    expect(configs[0]?.args).toEqual(['--custom-flag']);
  });

  it('accepts valid string socket ports from .lsp.json', async () => {
    mock({
      [workspaceRoot]: {
        '.lsp.json': JSON.stringify({
          typescript: {
            transport: 'tcp',
            host: '127.0.0.1',
            port: '1234',
          },
        }),
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const configs = await loader.loadUserConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0]?.socket).toEqual({
      host: '127.0.0.1',
      port: 1234,
    });
  });

  it('rejects malformed socket ports from .lsp.json', async () => {
    for (const port of ['1.5', '0x10', 1.5, 0, 65_536]) {
      mock({
        [workspaceRoot]: {
          '.lsp.json': JSON.stringify({
            typescript: {
              transport: 'tcp',
              host: '127.0.0.1',
              port,
            },
          }),
        },
      });

      const loader = new LspConfigLoader(workspaceRoot);
      const configs = await loader.loadUserConfigs();

      expect(configs, `port ${JSON.stringify(port)}`).toHaveLength(0);
      mock.restore();
    }
  });

  it('strict user config loading rejects invalid server entries', async () => {
    mock({
      [workspaceRoot]: {
        '.lsp.json': JSON.stringify({
          typescript: {
            transport: 'stdio',
          },
        }),
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const result = await loader.loadUserConfigsStrict();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        `Invalid LSP server config in ${path.join('/workspace', '.lsp.json')}: typescript`,
      );
    }
  });

  it('strict user config loading accepts empty object as explicit empty config', async () => {
    mock({
      [workspaceRoot]: {
        '.lsp.json': JSON.stringify({}),
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const result = await loader.loadUserConfigsStrict();

    expect(result).toEqual({ ok: true, configs: [] });
  });

  it('strict user config loading treats deleted config as empty', async () => {
    mock({
      [workspaceRoot]: {},
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const result = await loader.loadUserConfigsStrict();

    expect(result).toEqual({ ok: true, configs: [] });
  });

  it('non-strict user config loading skips invalid entries without rejecting all configs', async () => {
    mock({
      [workspaceRoot]: {
        '.lsp.json': JSON.stringify({
          typescript: {
            command: 'typescript-language-server',
          },
          invalid: {
            transport: 'stdio',
          },
        }),
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const configs = await loader.loadUserConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe('typescript-language-server');
  });

  it('non-strict user config loading returns empty configs for malformed JSON', async () => {
    mock({
      [workspaceRoot]: {
        '.lsp.json': '{',
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const configs = await loader.loadUserConfigs();

    expect(configs).toEqual([]);
  });

  it('forces user configs to require trusted workspaces', async () => {
    mock({
      [workspaceRoot]: {
        '.lsp.json': JSON.stringify({
          typescript: {
            command: 'typescript-language-server',
            trustRequired: false,
          },
        }),
      },
    });

    const loader = new LspConfigLoader(workspaceRoot);

    await expect(loader.loadUserConfigs()).resolves.toEqual([
      expect.objectContaining({ trustRequired: true }),
    ]);
    await expect(loader.loadUserConfigsStrict()).resolves.toEqual({
      ok: true,
      configs: [expect.objectContaining({ trustRequired: true })],
    });
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

  it('ignores an lspServers path that escapes the extension dir', async () => {
    // The referenced file lives outside the extension; readExtraJsonFile must
    // refuse it (../ traversal) instead of loading an arbitrary host file.
    mock({
      '/outside/leak.json': JSON.stringify({
        typescript: {
          command: 'evil-server',
        },
      }),
      // The pre-confinement resolver looked for `<extensionPath>/../leak.json`
      // — i.e. /extensions/leak.json. Populating it makes the assertion fail
      // under the old resolver (it would load evil-server), so only the
      // confinement keeps this test green.
      '/extensions/leak.json': JSON.stringify({
        typescript: {
          command: 'evil-server',
        },
      }),
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
        lspServers: '../leak.json',
      },
    } as Extension;

    const configs = await loader.loadExtensionConfigs([extension]);

    expect(configs).toHaveLength(0);
  });

  // Hand-placed link: installMetadata says type:'link' but there is no
  // out-of-band grant. Trust must come from trustedLinkSource, not from the
  // extension's own payload. Mutation: derive trust from
  // `extension.installMetadata?.type === 'link'` instead and the outside
  // server loads again.
  it('does not honor lspServers outside the extension when link trust is not granted', async () => {
    mock({
      '/outside/host-lsp.json': JSON.stringify({
        typescript: { command: 'evil-server' },
      }),
    });
    const loader = new LspConfigLoader(workspaceRoot);
    const extension = {
      id: 'hand-placed-link',
      name: 'hand-placed-link',
      version: '1.0.0',
      isActive: true,
      path: extensionPath,
      contextFiles: [],
      config: {
        name: 'hand-placed-link',
        version: '1.0.0',
        lspServers: '/outside/host-lsp.json',
      },
      installMetadata: { type: 'link', source: '/outside' },
    } as Extension;

    const configs = await loader.loadExtensionConfigs([extension]);
    expect(configs).toHaveLength(0);
  });

  // Surfaced errors must sanitize every untrusted value they interpolate --
  // path, extension name, and parse cause -- without dropping the cause.
  it('strips control bytes from surfaced errors and keeps the parse cause', async () => {
    mock({
      '/extensions/ts-plugin/.lsp.json': 'not-json-but-path-is-clean',
      [extensionPath + '/\u001b[2Jspoof.json']: 'control-byte-filename',
    });
    const loader = new LspConfigLoader(workspaceRoot);
    const extension = {
      id: 'ts-plugin',
      name: 'ts-plugin\u001b[2Jevil',
      version: '1.0.0',
      isActive: true,
      path: extensionPath,
      contextFiles: [],
      config: {
        name: 'ts-plugin',
        version: '1.0.0',
        lspServers: '\u001b[2Jspoof.json',
      },
    } as Extension;
    mockWarn.mockClear();
    const configs = await loader.loadExtensionConfigs([extension]);
    expect(configs).toHaveLength(0);
    // Baseline: the raw string still contains the control byte.
    expect((extension.config.lspServers ?? '').toString()).toContain(
      '\u001b[2J',
    );
    // The parse-error warn surfaces the sanitized path and names the reason.
    // Mutation: drop the stripAnsiAndControl wrapper → raw byte in message;
    // mis-map the reason (e.g. 'missing') → wrong detail string.
    const messages = mockWarn.mock.calls.map((c) => String(c[0]));
    const sanitized = messages.find((m) =>
      m.includes('LSP config failed to parse for extension ts-plugin'),
    );
    expect(sanitized).toBeDefined();
    expect(sanitized).not.toContain('\u001b');
    expect(sanitized).toMatch(/\(.+\)$/);
  });

  it('loads an out-of-tree lspServers path for a link-mode extension', async () => {
    mock({
      '/outside/ts.lsp.json': JSON.stringify({
        typescript: { command: 'ts-server' },
      }),
    });

    const loader = new LspConfigLoader(workspaceRoot);
    const extension = {
      id: 'ts-plugin',
      name: 'ts-plugin',
      version: '1.0.0',
      isActive: true,
      path: '/extensions/ts-plugin',
      contextFiles: [],
      installMetadata: { type: 'link', source: '/dev/linked-ts' },
      trustedLinkSource: '/dev/linked-ts',
      config: {
        name: 'ts-plugin',
        version: '1.0.0',
        lspServers: '/outside/ts.lsp.json',
      },
    } as Extension;

    const configs = await loader.loadExtensionConfigs([extension]);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.command).toBe('ts-server');
  });

  it('ignores a missing lspServers file', async () => {
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
        lspServers: './not-there.json',
      },
    } as Extension;

    const configs = await loader.loadExtensionConfigs([extension]);

    expect(configs).toHaveLength(0);
  });
});
