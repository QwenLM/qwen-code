/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { extensionsCommand } from './extensionsCommand.js';
import { type CommandContext } from './types.js';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockedFunction,
} from 'vitest';

import {
  ExtensionManager,
  ExtensionScope,
  parseInstallSource,
} from '@qwen-code/qwen-code-core';

const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    openBrowserSecurely: mockOpenBrowserSecurely,
    parseInstallSource: vi.fn(),
  };
});

const mockGetExtensions = vi.fn();
const mockGetLoadedExtensions = vi.fn();
const mockInstallExtension = vi.fn();

const createMockExtensionManager = () => ({
  installExtension: mockInstallExtension,
  getLoadedExtensions: mockGetLoadedExtensions,
});

describe('extensionsCommand', () => {
  let mockContext: CommandContext;
  let mockExtensionManager: ReturnType<typeof createMockExtensionManager>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockOpenBrowserSecurely.mockResolvedValue(undefined);
    mockExtensionManager = createMockExtensionManager();
    mockGetExtensions.mockReturnValue([]);
    mockGetLoadedExtensions.mockReturnValue([]);
    mockContext = createMockCommandContext({
      services: {
        config: {
          getExtensions: mockGetExtensions,
          getWorkingDir: () => '/test/dir',
          getExtensionManager: () =>
            mockExtensionManager as unknown as ExtensionManager,
        },
      },
      ui: {
        dispatchExtensionStateUpdate: vi.fn(),
      },
    });
  });

  describe('explore', () => {
    const exploreAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'explore',
    )?.action;

    if (!exploreAction) {
      throw new Error('Explore action not found');
    }

    it('should open the selected extensions gallery through the shared browser helper', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      await exploreAction(mockContext, 'Gemini');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Opening extensions page in your browser: https://geminicli.com/extensions/',
        },
        expect.any(Number),
      );
      expect(mockOpenBrowserSecurely).toHaveBeenCalledWith(
        'https://geminicli.com/extensions/',
      );
    });

    it('should show the URL when browser launch fails', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      mockOpenBrowserSecurely.mockRejectedValue(new Error('no browser'));

      await exploreAction(mockContext, 'ClaudeCode');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to open browser. Check out the extensions gallery at https://claudemarketplaces.com/',
        },
        expect.any(Number),
      );
    });
  });

  describe('default action (manage)', () => {
    it('should open extensions manager dialog when extensions exist', async () => {
      if (!extensionsCommand.action) throw new Error('Action not defined');
      mockGetExtensions.mockReturnValue([{ name: 'test-ext', isActive: true }]);
      const result = await extensionsCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'extensions_manage',
      });
    });

    it('should open extensions manager dialog when no extensions installed', async () => {
      if (!extensionsCommand.action) throw new Error('Action not defined');
      mockGetExtensions.mockReturnValue([]);
      const result = await extensionsCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'extensions_manage',
      });
    });
  });

  describe('manage', () => {
    const manageAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'manage',
    )?.action;

    if (!manageAction) {
      throw new Error('Manage action not found');
    }

    it('should return dialog action for extensions manager', async () => {
      mockGetExtensions.mockReturnValue([{ name: 'test-ext', isActive: true }]);
      const result = await manageAction(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'extensions_manage',
      });
    });

    it('should return dialog action even when no extensions installed', async () => {
      mockGetExtensions.mockReturnValue([]);
      const result = await manageAction(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'extensions_manage',
      });
    });
  });

  describe('install', () => {
    const installAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'install',
    )?.action;

    if (!installAction) {
      throw new Error('Install action not found');
    }

    const mockParseInstallSource = parseInstallSource as MockedFunction<
      typeof parseInstallSource
    >;

    // Create a real ExtensionManager mock that passes instanceof check
    let realMockExtensionManager: ExtensionManager;

    beforeEach(() => {
      vi.resetAllMocks();
      // Create a mock that inherits from ExtensionManager prototype
      realMockExtensionManager = Object.create(ExtensionManager.prototype);
      realMockExtensionManager.installExtension = mockInstallExtension;

      mockContext = createMockCommandContext({
        services: {
          config: {
            getExtensions: mockGetExtensions,
            getWorkingDir: () => '/test/dir',
            getExtensionManager: () => realMockExtensionManager,
          },
        },
        ui: {
          dispatchExtensionStateUpdate: vi.fn(),
        },
      });
    });

    it('should show usage if no source is provided', async () => {
      await installAction(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Usage: /extensions install <source> [--scope user|project]',
        },
        expect.any(Number),
      );
    });

    it('should install extension successfully', async () => {
      mockParseInstallSource.mockResolvedValue({
        type: 'git',
        source: 'https://github.com/test/extension',
      });
      mockInstallExtension.mockResolvedValue({
        name: 'test-extension',
        version: '1.0.0',
      });

      await installAction(mockContext, 'https://github.com/test/extension');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Installing extension from "https://github.com/test/extension"...',
        },
        expect.any(Number),
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension "test-extension" installed successfully.',
        },
        expect.any(Number),
      );
      expect(mockContext.ui.reloadCommands).toHaveBeenCalled();
    });

    it('parses --scope project and installs at project scope', async () => {
      mockParseInstallSource.mockResolvedValue({
        type: 'git',
        source: 'https://github.com/test/extension',
      });
      mockInstallExtension.mockResolvedValue({
        name: 'test-extension',
        version: '1.0.0',
      });

      await installAction(
        mockContext,
        'https://github.com/test/extension --scope project',
      );

      // The source is parsed without the flag, and the scope is forwarded as
      // the 6th argument to installExtension.
      expect(mockParseInstallSource).toHaveBeenCalledWith(
        'https://github.com/test/extension',
      );
      expect(mockInstallExtension).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
        undefined,
        undefined,
        undefined,
        ExtensionScope.Project,
      );
    });

    it('parses the --scope=project form', async () => {
      mockParseInstallSource.mockResolvedValue({
        type: 'git',
        source: 'https://github.com/test/extension',
      });
      mockInstallExtension.mockResolvedValue({
        name: 'test-extension',
        version: '1.0.0',
      });

      await installAction(
        mockContext,
        '--scope=project https://github.com/test/extension',
      );

      expect(mockParseInstallSource).toHaveBeenCalledWith(
        'https://github.com/test/extension',
      );
      expect(mockInstallExtension).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
        undefined,
        undefined,
        undefined,
        ExtensionScope.Project,
      );
    });

    it('defaults to user scope when no --scope flag is given', async () => {
      mockParseInstallSource.mockResolvedValue({
        type: 'git',
        source: 'https://github.com/test/extension',
      });
      mockInstallExtension.mockResolvedValue({
        name: 'test-extension',
        version: '1.0.0',
      });

      await installAction(mockContext, 'https://github.com/test/extension');

      expect(mockInstallExtension).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
        undefined,
        undefined,
        undefined,
        ExtensionScope.User,
      );
    });

    it('should redact URL credentials in install progress messages', async () => {
      mockParseInstallSource.mockResolvedValue({
        type: 'git',
        source: 'https://user:token@example.com/test/extension',
      });
      mockInstallExtension.mockResolvedValue({
        name: 'test-extension',
        version: '1.0.0',
      });

      await installAction(
        mockContext,
        'https://user:token@example.com/test/extension',
      );

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Installing extension from "https://***REDACTED***@example.com/test/extension"...',
        },
        expect.any(Number),
      );
    });

    it('should handle install errors', async () => {
      mockParseInstallSource.mockRejectedValue(
        new Error('Install source not found.'),
      );

      await installAction(mockContext, '/invalid/path');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to install extension from "/invalid/path": Install source not found.',
        },
        expect.any(Number),
      );
    });

    it('should redact URL credentials in install error messages and causes', async () => {
      mockParseInstallSource.mockRejectedValue(
        new Error(
          'Install source not found: https://user:token@example.com/test/extension',
        ),
      );

      await installAction(
        mockContext,
        'https://user:token@example.com/test/extension',
      );

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to install extension from "https://***REDACTED***@example.com/test/extension": Install source not found: https://***REDACTED***@example.com/test/extension',
        },
        expect.any(Number),
      );
    });
  });
});
