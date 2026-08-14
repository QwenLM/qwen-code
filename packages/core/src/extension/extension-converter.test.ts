/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertCompatibleExtension as convertGeminiOrClaudeExtension } from './extension-converter.js';
import { ExtensionManager, type ExtensionConfig } from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';
import { ExtensionStorage } from './storage.js';
import {
  AGENT_PLUGIN_SCHEMA,
  AGENT_PLUGIN_SCHEMA_PREFIX,
} from './agent-plugins-v1/index.js';

function snapshotDirectory(root: string): Array<[string, string]> {
  const snapshot: Array<[string, string]> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (entry.isDirectory()) {
        snapshot.push([`${relativePath}/`, 'directory']);
        visit(absolutePath);
      } else if (entry.isSymbolicLink()) {
        snapshot.push([
          relativePath,
          `symlink:${fs.readlinkSync(absolutePath)}`,
        ]);
      } else {
        snapshot.push([
          relativePath,
          fs.readFileSync(absolutePath).toString('base64'),
        ]);
      }
    }
  };
  visit(root);
  return snapshot.sort(([left], [right]) => left.localeCompare(right));
}

describe('convertGeminiOrClaudeExtension', () => {
  let extensionDir: string;
  let convertedDir: string | undefined;
  let installRoot: string;
  let installedDir: string | undefined;

  beforeEach(() => {
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-extension-'));
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-installed-'));
  });

  afterEach(() => {
    if (convertedDir && fs.existsSync(convertedDir)) {
      fs.rmSync(convertedDir, { recursive: true, force: true });
    }
    fs.rmSync(installRoot, { recursive: true, force: true });
    fs.rmSync(extensionDir, { recursive: true, force: true });
  });

  it.each([
    {
      installKind: 'standalone',
      pluginName: undefined,
      marketplacePluginName: 'ponytail',
      marketplaceSource: './',
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: undefined,
      includeMarketplace: true,
    },
    {
      installKind: 'named root',
      pluginName: 'ponytail',
      marketplacePluginName: 'ponytail',
      marketplaceSource: './',
      marketplaceHooks: './hooks/marketplace-hooks.json',
      expectedHookPath: 'scripts/marketplace-session-start.sh',
      pluginSourceKind: undefined,
      includeMarketplace: true,
    },
    {
      installKind: 'aliased root',
      pluginName: 'ponytail-alias',
      marketplacePluginName: 'ponytail-alias',
      marketplaceSource: './',
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: undefined,
      includeMarketplace: true,
    },
    {
      installKind: 'direct root alias',
      pluginName: 'ponytail-alias',
      marketplacePluginName: 'different-plugin',
      marketplaceSource: './plugins/different-plugin',
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: 'extension-root' as const,
      includeMarketplace: true,
    },
    {
      installKind: 'matching direct root alias with a subplugin entry',
      pluginName: 'ponytail-alias',
      marketplacePluginName: 'ponytail-alias',
      marketplaceSource: './plugins/ponytail-alias',
      marketplaceHooks: './hooks/marketplace-hooks.json',
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: 'extension-root' as const,
      includeMarketplace: true,
    },
    {
      installKind: 'legacy direct root alias',
      pluginName: 'ponytail-alias',
      marketplacePluginName: 'different-plugin',
      marketplaceSource: './plugins/different-plugin',
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: undefined,
      includeMarketplace: true,
    },
    {
      installKind: 'standalone without marketplace',
      pluginName: undefined,
      marketplacePluginName: 'ponytail',
      marketplaceSource: './',
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: undefined,
      includeMarketplace: false,
    },
    {
      installKind: 'named root without marketplace',
      pluginName: 'ponytail',
      marketplacePluginName: 'ponytail',
      marketplaceSource: './',
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: 'marketplace-entry' as const,
      includeMarketplace: false,
    },
    {
      installKind: 'sourceless marketplace root',
      pluginName: 'ponytail',
      marketplacePluginName: 'ponytail',
      marketplaceSource: undefined,
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: 'marketplace-entry' as const,
      includeMarketplace: true,
    },
    {
      installKind: 'null-source marketplace root',
      pluginName: 'ponytail',
      marketplacePluginName: 'ponytail',
      marketplaceSource: null,
      marketplaceHooks: undefined,
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: 'marketplace-entry' as const,
      includeMarketplace: true,
    },
    {
      installKind: 'explicit matching extension root',
      pluginName: 'ponytail',
      marketplacePluginName: 'ponytail',
      marketplaceSource: './',
      marketplaceHooks: './hooks/marketplace-hooks.json',
      expectedHookPath: 'scripts/session-start.sh',
      pluginSourceKind: 'extension-root' as const,
      includeMarketplace: true,
    },
    {
      installKind: 'explicit matching marketplace root',
      pluginName: 'ponytail',
      marketplacePluginName: 'ponytail',
      marketplaceSource: './',
      marketplaceHooks: './hooks/marketplace-hooks.json',
      expectedHookPath: 'scripts/marketplace-session-start.sh',
      pluginSourceKind: 'marketplace-entry' as const,
      includeMarketplace: true,
    },
  ])(
    'keeps Gemini resources and imports only selected root Claude hooks for a dual-manifest $installKind extension',
    async ({
      pluginName,
      marketplacePluginName,
      marketplaceSource,
      marketplaceHooks,
      expectedHookPath,
      pluginSourceKind,
      includeMarketplace,
    }) => {
      fs.writeFileSync(
        path.join(extensionDir, 'gemini-extension.json'),
        JSON.stringify({
          name: 'ponytail',
          version: '4.8.4',
          contextFileName: 'AGENTS.md',
          settings: [
            {
              name: 'Ponytail mode',
              envVar: 'PONYTAIL_MODE',
              description: 'Select the ponytail mode',
            },
          ],
        }),
        'utf-8',
      );
      fs.writeFileSync(path.join(extensionDir, 'AGENTS.md'), '# Ponytail');

      const claudePluginDir = path.join(extensionDir, '.claude-plugin');
      fs.mkdirSync(claudePluginDir, { recursive: true });
      if (includeMarketplace) {
        fs.writeFileSync(
          path.join(claudePluginDir, 'marketplace.json'),
          JSON.stringify({
            name: 'ponytail',
            owner: { name: 'Ponytail' },
            plugins: [
              {
                name: marketplacePluginName,
                source: marketplaceSource,
                hooks: marketplaceHooks,
              },
            ],
          }),
          'utf-8',
        );
      }
      fs.writeFileSync(
        path.join(claudePluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'ponytail',
          version: '4.8.4',
          description: 'A dual-manifest extension',
          hooks: './hooks/claude-codex-hooks.json',
        }),
        'utf-8',
      );

      const hooksDir = path.join(extensionDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir, 'claude-codex-hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: '${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh',
                  },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(hooksDir, 'marketplace-hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command:
                      '${CLAUDE_PLUGIN_ROOT}/scripts/marketplace-session-start.sh',
                  },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );

      const commandsDir = path.join(extensionDir, 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(
        path.join(commandsDir, 'ponytail.toml'),
        'description = "Use ponytail mode"\nprompt = "Keep it simple"\n',
        'utf-8',
      );

      const sourceSnapshotBefore = snapshotDirectory(extensionDir);
      const converted = await convertGeminiOrClaudeExtension(
        extensionDir,
        pluginName,
        undefined,
        undefined,
        pluginSourceKind,
      );
      expect(snapshotDirectory(extensionDir)).toEqual(sourceSnapshotBefore);
      convertedDir = converted.extensionDir;
      const config = JSON.parse(
        fs.readFileSync(
          path.join(converted.extensionDir, 'qwen-extension.json'),
          'utf-8',
        ),
      ) as ExtensionConfig;

      expect(converted.originSource).toBe('Gemini');
      expect(converted.requiresClaudeFileAdaptation).toBe(true);
      expect(config.name).toBe('ponytail');
      expect(config.contextFileName).toBe('AGENTS.md');
      expect(config.settings).toEqual([
        {
          name: 'Ponytail mode',
          envVar: 'PONYTAIL_MODE',
          description: 'Select the ponytail mode',
        },
      ]);
      expect(
        (
          config.hooks?.['SessionStart']?.[0].hooks?.[0] as {
            command?: string;
          }
        )?.command,
      ).toBe(
        expectedHookPath
          ? '${CLAUDE_PLUGIN_ROOT}/' + expectedHookPath
          : undefined,
      );
      expect(config.hooks?.['SessionStart']).toHaveLength(
        expectedHookPath ? 1 : 0,
      );
      expect(
        fs.existsSync(
          path.join(converted.extensionDir, 'commands', 'ponytail.md'),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(converted.extensionDir, 'commands', 'ponytail.toml'),
        ),
      ).toBe(false);

      installedDir = path.join(installRoot, 'ponytail');
      fs.renameSync(converted.extensionDir, installedDir);
      convertedDir = undefined;
      fs.rmSync(extensionDir, { recursive: true, force: true });

      const manager = new ExtensionManager({
        workspaceDir: os.tmpdir(),
        isWorkspaceTrusted: true,
        extensionStore: new ExtensionStore({
          extensionsDir: installRoot,
          storeDir: path.join(installRoot, '.store'),
        }),
      });
      const installedConfig = manager.loadExtensionConfig({
        extensionDir: installedDir,
      });

      const installedCommand = (
        installedConfig.hooks?.['SessionStart']?.[0].hooks?.[0] as {
          command?: string;
        }
      )?.command;
      expect(installedConfig.hooks?.['SessionStart']).toHaveLength(
        expectedHookPath ? 1 : 0,
      );
      expect(installedCommand && path.normalize(installedCommand)).toBe(
        expectedHookPath
          ? path.join(installedDir, expectedHookPath)
          : undefined,
      );
    },
  );

  it('ignores an escaping marketplace manifest when selecting dual-manifest root hooks', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'safe-root', version: '1.0.0' }),
    );
    const manifestDir = path.join(extensionDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({
        name: 'safe-root',
        version: '1.0.0',
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '${CLAUDE_PLUGIN_ROOT}/scripts/root-hook.sh',
                },
              ],
            },
          ],
        },
      }),
    );
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dual-marketplace-'),
    );
    fs.writeFileSync(
      path.join(outsideDir, 'marketplace.json'),
      JSON.stringify({
        name: 'untrusted',
        owner: { name: 'Untrusted' },
        plugins: [{ name: 'safe-root', source: './' }],
      }),
    );
    fs.symlinkSync(
      path.join(outsideDir, 'marketplace.json'),
      path.join(manifestDir, 'marketplace.json'),
    );

    try {
      const converted = await convertGeminiOrClaudeExtension(
        extensionDir,
        'safe-root',
      );
      convertedDir = converted.extensionDir;
      const config = JSON.parse(
        fs.readFileSync(
          path.join(converted.extensionDir, 'qwen-extension.json'),
          'utf-8',
        ),
      ) as ExtensionConfig;

      expect(converted.originSource).toBe('Gemini');
      expect(converted.requiresClaudeFileAdaptation).toBe(true);
      expect(
        (
          config.hooks?.['SessionStart']?.[0].hooks?.[0] as {
            command?: string;
          }
        )?.command,
      ).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/root-hook.sh');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      format: 'Qwen',
      manifest: 'qwen-extension.json',
      expectedOrigin: 'QwenCode' as const,
    },
    {
      format: 'Gemini',
      manifest: 'gemini-extension.json',
      expectedOrigin: 'Gemini' as const,
    },
  ])(
    'keeps a classic $format root extension when a named install has no marketplace',
    async ({ manifest, expectedOrigin }) => {
      fs.writeFileSync(
        path.join(extensionDir, manifest),
        JSON.stringify({ name: 'classic-root', version: '1.0.0' }),
      );

      const converted = await convertGeminiOrClaudeExtension(
        extensionDir,
        'classic-root',
        undefined,
        undefined,
        'marketplace-entry',
      );
      if (converted.extensionDir !== extensionDir) {
        convertedDir = converted.extensionDir;
      }
      const config = JSON.parse(
        fs.readFileSync(
          path.join(converted.extensionDir, 'qwen-extension.json'),
          'utf-8',
        ),
      ) as ExtensionConfig;

      expect(converted.originSource).toBe(expectedOrigin);
      expect(config.name).toBe('classic-root');
      expect(config.version).toBe('1.0.0');
    },
  );

  it('treats pluginName as an alias for an explicit Claude extension-root install', async () => {
    const claudeDir = path.join(extensionDir, '.claude-plugin');
    const hooksDir = path.join(extensionDir, 'hooks');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'marketplace.json'),
      JSON.stringify({
        name: 'unrelated-marketplace',
        owner: { name: 'Owner' },
        plugins: [
          {
            name: 'different-plugin',
            source: './plugins/different-plugin',
          },
        ],
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(claudeDir, 'plugin.json'),
      JSON.stringify({
        name: 'root-plugin',
        version: '1.0.0',
        hooks: './hooks/hooks.json',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '${CLAUDE_PLUGIN_ROOT}/scripts/start.sh',
                },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );

    const converted = await convertGeminiOrClaudeExtension(
      extensionDir,
      'root-alias',
      undefined,
      undefined,
      'extension-root',
    );
    convertedDir = converted.extensionDir;
    const config = JSON.parse(
      fs.readFileSync(
        path.join(converted.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as ExtensionConfig;

    expect(converted.originSource).toBe('Claude');
    expect(config.name).toBe('root-plugin');
    expect(
      (
        config.hooks?.['SessionStart']?.[0].hooks?.[0] as {
          command?: string;
        }
      )?.command,
    ).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/start.sh');
  });

  it('installs a selected same-named subdirectory instead of the marketplace root Gemini extension', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({
        name: 'marketplace-root',
        version: '1.0.0',
        contextFileName: 'ROOT.md',
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(extensionDir, 'ROOT.md'), '# Root');

    const rootClaudeDir = path.join(extensionDir, '.claude-plugin');
    fs.mkdirSync(rootClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootClaudeDir, 'marketplace.json'),
      JSON.stringify({
        name: 'marketplace-root',
        owner: { name: 'Owner' },
        plugins: [
          {
            name: 'ponytail',
            source: './plugins/ponytail',
          },
        ],
      }),
      'utf-8',
    );

    const pluginDir = path.join(extensionDir, 'plugins', 'ponytail');
    const pluginManifestDir = path.join(pluginDir, '.claude-plugin');
    const hooksDir = path.join(pluginDir, 'hooks');
    const scriptsDir = path.join(pluginDir, 'scripts');
    fs.mkdirSync(pluginManifestDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginManifestDir, 'plugin.json'),
      JSON.stringify({
        name: 'ponytail-child',
        version: '2.0.0',
        description: 'Selected child plugin',
        hooks: './hooks/hooks.json',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '${CLAUDE_PLUGIN_ROOT}/scripts/start.sh',
                },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(scriptsDir, 'start.sh'), '#!/bin/sh\n');

    const sourceSnapshotBefore = snapshotDirectory(extensionDir);
    const converted = await convertGeminiOrClaudeExtension(
      extensionDir,
      'ponytail',
      undefined,
      undefined,
      'marketplace-entry',
    );
    convertedDir = converted.extensionDir;
    expect(snapshotDirectory(extensionDir)).toEqual(sourceSnapshotBefore);

    const config = JSON.parse(
      fs.readFileSync(
        path.join(converted.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as ExtensionConfig;
    expect(converted.originSource).toBe('Claude');
    expect(config.name).toBe('ponytail');
    expect(config.description).toBe('Selected child plugin');
    expect(config.contextFileName).toBeUndefined();
    expect(
      (
        config.hooks?.['SessionStart']?.[0].hooks?.[0] as {
          command?: string;
        }
      )?.command,
    ).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/start.sh');
    expect(
      fs.existsSync(path.join(converted.extensionDir, 'scripts', 'start.sh')),
    ).toBe(true);

    installedDir = path.join(installRoot, 'ponytail-child');
    fs.renameSync(converted.extensionDir, installedDir);
    convertedDir = undefined;
    fs.rmSync(extensionDir, { recursive: true, force: true });

    const manager = new ExtensionManager({
      workspaceDir: os.tmpdir(),
      isWorkspaceTrusted: true,
      extensionStore: new ExtensionStore({
        extensionsDir: installRoot,
        storeDir: path.join(installRoot, '.store'),
      }),
    });
    const installedConfig = manager.loadExtensionConfig({
      extensionDir: installedDir,
    });
    const installedCommand = (
      installedConfig.hooks?.['SessionStart']?.[0].hooks?.[0] as {
        command?: string;
      }
    )?.command;
    expect(installedCommand && path.normalize(installedCommand)).toBe(
      path.join(installedDir, 'scripts', 'start.sh'),
    );
  });

  it('converts a named subplugin for legacy metadata without a source kind', async () => {
    const rootClaudeDir = path.join(extensionDir, '.claude-plugin');
    const pluginDir = path.join(extensionDir, 'plugins', 'legacy-child');
    fs.mkdirSync(rootClaudeDir, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(rootClaudeDir, 'marketplace.json'),
      JSON.stringify({
        name: 'legacy-marketplace',
        owner: { name: 'Owner' },
        plugins: [
          {
            name: 'legacy-child',
            source: './plugins/legacy-child',
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'legacy-child', version: '2.0.0' }),
    );

    const converted = await convertGeminiOrClaudeExtension(
      extensionDir,
      'legacy-child',
    );
    convertedDir = converted.extensionDir;
    const config = JSON.parse(
      fs.readFileSync(
        path.join(converted.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as ExtensionConfig;

    expect(converted.originSource).toBe('Claude');
    expect(config).toMatchObject({ name: 'legacy-child', version: '2.0.0' });
  });

  it('merges conventional Gemini hooks with Claude hooks by event', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'dual-hooks', version: '1.0.0' }),
    );
    const manifestDir = path.join(extensionDir, '.claude-plugin');
    const hooksDir = path.join(extensionDir, 'hooks');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({
        name: 'dual-hooks',
        version: '1.0.0',
        hooks: './hooks/claude-hooks.json',
      }),
    );
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'gemini-pre.sh' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'gemini-start.sh' }] },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(hooksDir, 'claude-hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'claude-start.sh' }] },
          ],
        },
      }),
    );

    const converted = await convertGeminiOrClaudeExtension(extensionDir);
    convertedDir = converted.extensionDir;
    const config = JSON.parse(
      fs.readFileSync(
        path.join(converted.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as ExtensionConfig;

    expect(config.hooks?.['PreToolUse']).toHaveLength(1);
    expect(converted.requiresClaudeFileAdaptation).toBe(true);
    expect(
      config.hooks?.['SessionStart']?.map(
        (definition) =>
          (definition.hooks?.[0] as { command?: string })?.command,
      ),
    ).toEqual(['gemini-start.sh', 'claude-start.sh']);
  });

  it.each(['constructor', '__proto__'])(
    'merges prototype-named %s hooks from conventional and Claude sources',
    async (eventName) => {
      fs.writeFileSync(
        path.join(extensionDir, 'gemini-extension.json'),
        JSON.stringify({ name: 'prototype-hooks', version: '1.0.0' }),
      );
      const manifestDir = path.join(extensionDir, '.claude-plugin');
      const hooksDir = path.join(extensionDir, 'hooks');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(manifestDir, 'plugin.json'),
        JSON.stringify({
          name: 'prototype-hooks',
          version: '1.0.0',
          hooks: './hooks/claude-hooks.json',
        }),
      );
      fs.writeFileSync(
        path.join(hooksDir, 'hooks.json'),
        JSON.stringify({
          hooks: {
            [eventName]: [
              { hooks: [{ type: 'command', command: 'conventional.sh' }] },
            ],
          },
        }),
      );
      fs.writeFileSync(
        path.join(hooksDir, 'claude-hooks.json'),
        JSON.stringify({
          hooks: {
            [eventName]: [
              { hooks: [{ type: 'command', command: 'claude.sh' }] },
            ],
          },
        }),
      );

      const converted = await convertGeminiOrClaudeExtension(extensionDir);
      convertedDir = converted.extensionDir;
      const config = JSON.parse(
        fs.readFileSync(
          path.join(converted.extensionDir, 'qwen-extension.json'),
          'utf-8',
        ),
      ) as ExtensionConfig;

      expect(
        Object.prototype.hasOwnProperty.call(config.hooks, eventName),
      ).toBe(true);
      expect(
        (config.hooks as Record<string, unknown[]> | undefined)?.[eventName],
      ).toHaveLength(2);
    },
  );

  it('uses the selected root marketplace entry version in a dual manifest', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'versioned-root', version: '1.0.0' }),
    );
    const manifestDir = path.join(extensionDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'versioned-root', version: '1.0.0' }),
    );
    fs.writeFileSync(
      path.join(manifestDir, 'marketplace.json'),
      JSON.stringify({
        name: 'catalog',
        owner: { name: 'Owner' },
        plugins: [{ name: 'versioned-root', version: '2.1.0', source: './' }],
      }),
    );

    const converted = await convertGeminiOrClaudeExtension(
      extensionDir,
      'versioned-root',
      undefined,
      undefined,
      'marketplace-entry',
    );
    convertedDir = converted.extensionDir;
    const config = JSON.parse(
      fs.readFileSync(
        path.join(converted.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as ExtensionConfig;

    expect(config.version).toBe('2.1.0');
  });

  it('keeps a valid Gemini conversion when Claude metadata is malformed', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'valid-gemini', version: '1.0.0' }),
    );
    const manifestDir = path.join(extensionDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'plugin.json'), '{');
    const createTmpDir = ExtensionStorage.createTmpDir.bind(ExtensionStorage);
    const tempDirs: string[] = [];
    const createTmpDirSpy = vi
      .spyOn(ExtensionStorage, 'createTmpDir')
      .mockImplementation(async () => {
        const tempDir = await createTmpDir();
        tempDirs.push(tempDir);
        return tempDir;
      });

    try {
      const converted = await convertGeminiOrClaudeExtension(extensionDir);
      convertedDir = converted.extensionDir;
      const config = JSON.parse(
        fs.readFileSync(
          path.join(converted.extensionDir, 'qwen-extension.json'),
          'utf-8',
        ),
      ) as ExtensionConfig;

      expect(converted.originSource).toBe('Gemini');
      expect(converted.requiresClaudeFileAdaptation).toBe(false);
      expect(config.name).toBe('valid-gemini');
      expect(tempDirs.filter((tempDir) => fs.existsSync(tempDir))).toEqual([
        converted.extensionDir,
      ]);
    } finally {
      createTmpDirSpy.mockRestore();
    }
  });

  it('reads Claude hooks without creating a second converted copy', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'cleanup-success', version: '1.0.0' }),
    );
    const manifestDir = path.join(extensionDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'cleanup-success', version: '1.0.0' }),
    );
    const createTmpDir = ExtensionStorage.createTmpDir.bind(ExtensionStorage);
    const tempDirs: string[] = [];
    const createTmpDirSpy = vi
      .spyOn(ExtensionStorage, 'createTmpDir')
      .mockImplementation(async () => {
        const tempDir = await createTmpDir();
        tempDirs.push(tempDir);
        return tempDir;
      });

    try {
      const converted = await convertGeminiOrClaudeExtension(extensionDir);
      convertedDir = converted.extensionDir;
      expect(tempDirs).toHaveLength(1);
      expect(converted.extensionDir).toBe(tempDirs[0]);
      expect(fs.existsSync(tempDirs[0])).toBe(true);
    } finally {
      createTmpDirSpy.mockRestore();
    }
  });

  it('removes the Gemini conversion when hook loading observes an abort', async () => {
    fs.writeFileSync(
      path.join(extensionDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'cleanup-abort', version: '1.0.0' }),
    );
    const manifestDir = path.join(extensionDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'cleanup-abort', version: '1.0.0' }),
    );
    const controller = new AbortController();
    const reason = new Error('conversion expired');
    const createTmpDir = ExtensionStorage.createTmpDir.bind(ExtensionStorage);
    const tempDirs: string[] = [];
    const createTmpDirSpy = vi
      .spyOn(ExtensionStorage, 'createTmpDir')
      .mockImplementation(async () => {
        const tempDir = await createTmpDir();
        tempDirs.push(tempDir);
        controller.abort(reason);
        return tempDir;
      });

    try {
      await expect(
        convertGeminiOrClaudeExtension(
          extensionDir,
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(tempDirs).toHaveLength(1);
      expect(tempDirs.every((tempDir) => !fs.existsSync(tempDir))).toBe(true);
    } finally {
      createTmpDirSpy.mockRestore();
    }
  });
});
describe('Agent Plugins extension conversion', () => {
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('selects a supported Agent Plugin without converting it', async () => {
    const manifest = JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'portable-plugin',
    });
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), manifest);

    await expect(
      convertGeminiOrClaudeExtension(pluginRoot),
    ).resolves.toMatchObject({
      extensionDir: pluginRoot,
      originSource: 'AgentPlugins',
      externalContent: false,
    });
    expect(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).toBe(
      manifest,
    );
    expect(fs.existsSync(path.join(pluginRoot, 'qwen-extension.json'))).toBe(
      false,
    );
  });

  it('detects a direct-root Agent Plugin even when it has an install alias', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'portable-plugin',
      }),
    );

    await expect(
      convertGeminiOrClaudeExtension(
        pluginRoot,
        'catalog-alias',
        undefined,
        undefined,
        'extension-root',
      ),
    ).resolves.toMatchObject({
      extensionDir: pluginRoot,
      originSource: 'AgentPlugins',
    });
  });

  it('does not parse a stray malformed Gemini manifest before selecting an Agent Plugin', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'portable-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'gemini-extension.json'),
      '{ not valid json',
    );

    await expect(
      convertGeminiOrClaudeExtension(
        pluginRoot,
        'catalog-alias',
        undefined,
        undefined,
        'extension-root',
      ),
    ).resolves.toMatchObject({
      extensionDir: pluginRoot,
      originSource: 'AgentPlugins',
    });
  });

  it('gives an unsupported Agent Plugins schema priority over Qwen format', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'qwen-extension.json'),
      JSON.stringify({ name: 'qwen-fallback', version: '1.0.0' }),
    );

    await expect(convertGeminiOrClaudeExtension(pluginRoot)).rejects.toThrow(
      'Unsupported Agent Plugins schema',
    );
  });

  it('leaves an unrelated plugin.json out of format detection', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({ $schema: 'https://example.com/plugin.schema.json' }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'qwen-extension.json'),
      JSON.stringify({ name: 'qwen-extension', version: '1.0.0' }),
    );

    await expect(
      convertGeminiOrClaudeExtension(pluginRoot),
    ).resolves.toMatchObject({
      extensionDir: pluginRoot,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });

  it('honors an explicit marketplace selection over a root Agent Plugin manifest', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'root-agent-plugin',
      }),
    );
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'sample-marketplace',
        owner: { name: 'Test Owner', email: 'owner@example.com' },
        plugins: [
          {
            name: 'requested-plugin',
            version: '2.0.0',
            source: './plugin-src',
          },
        ],
      }),
    );
    const selectedRoot = path.join(pluginRoot, 'plugin-src');
    fs.mkdirSync(path.join(selectedRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(selectedRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'requested-plugin', version: '2.0.0' }),
    );
    fs.writeFileSync(
      path.join(selectedRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'carried-agent-plugin',
      }),
    );

    const selected = await convertGeminiOrClaudeExtension(
      pluginRoot,
      'requested-plugin',
      undefined,
      undefined,
      'marketplace-entry',
    );
    expect(selected.originSource).toBe('Claude');
    const selectedConfig = JSON.parse(
      fs.readFileSync(
        path.join(selected.extensionDir, 'qwen-extension.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(selectedConfig['name']).toBe('requested-plugin');
    expect(fs.existsSync(path.join(selected.extensionDir, 'plugin.json'))).toBe(
      false,
    );
    fs.rmSync(selected.extensionDir, { recursive: true, force: true });

    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-root-agent-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(selectedRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-carried-agent-plugin',
      }),
    );
    const selectedWithFutureRoot = await convertGeminiOrClaudeExtension(
      pluginRoot,
      'requested-plugin',
      undefined,
      undefined,
      'marketplace-entry',
    );
    expect(selectedWithFutureRoot.originSource).toBe('Claude');
    expect(
      fs.existsSync(
        path.join(selectedWithFutureRoot.extensionDir, 'plugin.json'),
      ),
    ).toBe(false);
    fs.rmSync(selectedWithFutureRoot.extensionDir, {
      recursive: true,
      force: true,
    });
  });
});
