/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command, Option } from '@commander-js/extra-typings';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppPlugin } from './types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { MockTool } from '../../../core/src/test-utils/mock-tool.js';

// Use the real Core registry without importing the unrelated Core services.
vi.mock('@qwen-code/core', async () => ({
  ...(await import('../../../core/src/builtin-plugins/registry.js')),
  runLogger: { warn: vi.fn() },
}));
import { createAppPluginFixture } from '../test-utils/appPluginFixture.js';
const { registerAppPlugins,
  getAppPluginPromptSuggestionContributions,
  getAppPluginSlashCommands,
  getAppPluginRootOptions,
  getAppPluginTerminalCommands,
 initializeAppPlugins, disposeAppPlugins, getAppPluginTools } = createAppPluginFixture();

const context = {
  mode: 'interactive' as const,
  isSettingSourceAllowed: () => true,
  notifyChanged: async () => {},
  whenReady: async () => {},
};

afterEach(async () => {
  await disposeAppPlugins();
  registerAppPlugins([]);
});

it('keeps terminal help available before initialization and shares the Core lifecycle', async () => {
  let slashCommands: SlashCommand[] = [];
  let promptContributions = [{ id: 'example', prompt: 'Example prompt' }];
  const terminal = new Command('example').description('Example');
  const rootOption = new Option('--example-root');
  const tool = new MockTool({ name: 'ExampleTool', description: 'Example' });
  const plugin: AppPlugin = {
    apiVersion: 1,
    id: 'example',
    initialize: vi.fn(async () => {
      slashCommands = [
        {
          name: 'example',
          description: 'Example',
          kind: CommandKind.BUILT_IN,
          altNames: ['ex'],
          progressMessage: 'Working...',
          completion: () => ['argument'],
          action: async () => ({
            type: 'message',
            messageType: 'info',
            content: 'ok',
          }),
        },
      ];
    }),
    dispose: vi.fn(async () => {}),
    getRootOptions: () => [rootOption],
    getTerminalCommands: () => [terminal],
    getSlashCommands: vi.fn(() => slashCommands),
    getPromptSuggestionContributions: vi.fn(() => promptContributions),
    getTools: () => [tool],
  };
  registerAppPlugins([plugin]);
  expect(getAppPluginRootOptions()).toEqual([rootOption]);
  expect(getAppPluginTerminalCommands()).toEqual([terminal]);
  expect(getAppPluginSlashCommands()).toEqual([]);
  expect(getAppPluginPromptSuggestionContributions()).toEqual([]);
  expect(plugin.getSlashCommands).not.toHaveBeenCalled();
  expect(plugin.initialize).not.toHaveBeenCalled();

  await initializeAppPlugins(context);
  await initializeAppPlugins(context);
  expect(plugin.initialize).toHaveBeenCalledOnce();
  expect(getAppPluginSlashCommands()).toEqual(slashCommands);
  expect(getAppPluginSlashCommands()[0]).toBe(slashCommands[0]);
  expect(getAppPluginPromptSuggestionContributions()).toEqual(
    promptContributions,
  );
  expect(getAppPluginTools()).toEqual([tool]);

  // Contributions are read again, rather than cached at initialization.
  slashCommands = [];
  expect(getAppPluginSlashCommands()).toEqual([]);
  slashCommands = [
    {
      name: 'updated',
      description: 'Updated',
      kind: CommandKind.BUILT_IN,
      action: async () => ({
        type: 'message',
        messageType: 'info',
        content: 'ok',
      }),
    },
  ];
  expect(getAppPluginSlashCommands()).toEqual(slashCommands);
  promptContributions = [];
  expect(getAppPluginPromptSuggestionContributions()).toEqual([]);
  await disposeAppPlugins();
  await disposeAppPlugins();
  expect(plugin.dispose).toHaveBeenCalledOnce();
  expect(getAppPluginSlashCommands()).toEqual([]);
  expect(getAppPluginPromptSuggestionContributions()).toEqual([]);
});

it('preserves hidden command metadata contributed through AppPlugin before initialization', () => {
  const initialize = vi.fn(async () => {});
  const contribution = {
    command: new Command('management'),
    hidden: true,
    startup: 'local' as const,
  };
  registerAppPlugins([
    {
      apiVersion: 1,
      id: 'command-plugin',
      initialize,
      dispose: async () => {},
      getTerminalCommands: () => [contribution],
    },
  ]);

  expect(getAppPluginTerminalCommands()).toEqual([contribution]);
  expect(initialize).not.toHaveBeenCalled();
});

it('does not expose slash commands after a partial initialization failure', async () => {
  const plugin: AppPlugin = {
    apiVersion: 1,
    id: 'broken',
    initialize: async () => {
      throw new Error('failed');
    },
    dispose: vi.fn(async () => {}),
    getSlashCommands: vi.fn(() => []),
  };
  registerAppPlugins([plugin]);
  await expect(initializeAppPlugins(context)).rejects.toThrow('failed');
  expect(plugin.dispose).toHaveBeenCalledOnce();
  expect(getAppPluginSlashCommands()).toEqual([]);
  expect(plugin.getSlashCommands).not.toHaveBeenCalled();
});

it('clears CLI command contributions when a new host registers no plugins', () => {
  registerAppPlugins([
    {
      apiVersion: 1,
      id: 'previous',
      initialize: async () => {},
      dispose: async () => {},
      getTerminalCommands: () => [
        new Command('previous').description('Previous'),
      ],
    },
  ]);
  registerAppPlugins([]);
  expect(getAppPluginTerminalCommands()).toEqual([]);
  expect(getAppPluginSlashCommands()).toEqual([]);
});
