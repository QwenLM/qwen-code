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
import { ExtensionUpdateState } from '../state/extensions.js';
import {
  type Extension,
  ExtensionManager,
  parseInstallSource,
} from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    parseInstallSource: vi.fn(),
  };
});

const mockGetExtensions = vi.fn();
const mockUpdateExtension = vi.fn();
const mockUpdateAllUpdatableExtensions = vi.fn();
const mockCheckForAllExtensionUpdates = vi.fn();
const mockInstallExtension = vi.fn();
const mockUninstallExtension = vi.fn();
const mockGetLoadedExtensions = vi.fn();
const mockEnableExtension = vi.fn();
const mockDisableExtension = vi.fn();

const createMockExtensionManager = () => ({
  updateExtension: mockUpdateExtension,
  updateAllUpdatableExtensions: mockUpdateAllUpdatableExtensions,
  checkForAllExtensionUpdates: mockCheckForAllExtensionUpdates,
  installExtension: mockInstallExtension,
  uninstallExtension: mockUninstallExtension,
  getLoadedExtensions: mockGetLoadedExtensions,
  enableExtension: mockEnableExtension,
  disableExtension: mockDisableExtension,
});

describe('extensionsCommand', () => {
  let mockContext: CommandContext;
  let mockExtensionManager: ReturnType<typeof createMockExtensionManager>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockExtensionManager = createMockExtensionManager();
    mockGetExtensions.mockReturnValue([]);
    mockGetLoadedExtensions.mockReturnValue([]);
    mockCheckForAllExtensionUpdates.mockResolvedValue(undefined);
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

  describe('list', () => {
    it('should add an EXTENSIONS_LIST item to the UI when extensions exist', async () => {
      if (!extensionsCommand.action) throw new Error('Action not defined');
      mockGetExtensions.mockReturnValue([{ name: 'test-ext', isActive: true }]);
      await extensionsCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.EXTENSIONS_LIST,
        },
        expect.any(Number),
      );
    });

    it('should show info message when no extensions installed', async () => {
      if (!extensionsCommand.action) throw new Error('Action not defined');
      mockGetExtensions.mockReturnValue([]);
      await extensionsCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'No extensions installed.',
        },
        expect.any(Number),
      );
    });
  });

  describe('update', () => {
    const updateAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'update',
    )?.action;

    if (!updateAction) {
      throw new Error('Update action not found');
    }

    it('should show usage if no args are provided', async () => {
      await updateAction(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Usage: /extensions update <extension-names>|--all',
        },
        expect.any(Number),
      );
    });

    it('should inform user if there are no extensions to update with --all', async () => {
      mockGetExtensions.mockReturnValue([{ name: 'ext-one', isActive: true }]);
      mockUpdateAllUpdatableExtensions.mockResolvedValue([]);
      await updateAction(mockContext, '--all');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'No extensions to update.',
        },
        expect.any(Number),
      );
    });

    it('should call setPendingItem and addItem in a finally block on success', async () => {
      mockGetExtensions.mockReturnValue([{ name: 'ext-one', isActive: true }]);
      mockUpdateAllUpdatableExtensions.mockResolvedValue([
        {
          name: 'ext-one',
          originalVersion: '1.0.0',
          updatedVersion: '1.0.1',
        },
        {
          name: 'ext-two',
          originalVersion: '2.0.0',
          updatedVersion: '2.0.1',
        },
      ]);
      await updateAction(mockContext, '--all');
      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith({
        type: MessageType.EXTENSIONS_LIST,
      });
      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.EXTENSIONS_LIST,
        },
        expect.any(Number),
      );
    });

    it('should call setPendingItem and addItem in a finally block on failure', async () => {
      mockGetExtensions.mockReturnValue([{ name: 'ext-one', isActive: true }]);
      mockUpdateAllUpdatableExtensions.mockRejectedValue(
        new Error('Something went wrong'),
      );
      await updateAction(mockContext, '--all');
      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith({
        type: MessageType.EXTENSIONS_LIST,
      });
      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.EXTENSIONS_LIST,
        },
        expect.any(Number),
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Something went wrong',
        },
        expect.any(Number),
      );
    });

    it('should update a single extension by name', async () => {
      const extension: Extension = {
        id: 'ext-one',
        name: 'ext-one',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/ext-one',
        contextFiles: [],
        config: { name: 'ext-one', version: '1.0.0' },
        installMetadata: {
          type: 'git',
          autoUpdate: false,
          source: 'https://github.com/some/extension.git',
        },
      };
      mockUpdateExtension.mockResolvedValue({
        name: extension.name,
        originalVersion: extension.version,
        updatedVersion: '1.0.1',
      });
      mockGetExtensions.mockReturnValue([extension]);
      mockContext.ui.extensionsUpdateState.set(extension.name, {
        status: ExtensionUpdateState.UPDATE_AVAILABLE,
        processed: false,
      });
      await updateAction(mockContext, 'ext-one');
      expect(mockUpdateExtension).toHaveBeenCalledWith(
        extension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        expect.any(Function),
      );
    });

    it('should handle errors when updating a single extension', async () => {
      // Provide at least one extension so we don't get "No extensions installed" message
      const otherExtension: Extension = {
        id: 'other-ext',
        name: 'other-ext',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/other-ext',
        contextFiles: [],
        config: { name: 'other-ext', version: '1.0.0' },
      };
      mockGetExtensions.mockReturnValue([otherExtension]);
      await updateAction(mockContext, 'ext-one');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Extension "ext-one" not found.',
        },
        expect.any(Number),
      );
    });

    it('should update multiple extensions by name', async () => {
      const extensionOne: Extension = {
        id: 'ext-one',
        name: 'ext-one',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/ext-one',
        contextFiles: [],
        config: { name: 'ext-one', version: '1.0.0' },
        installMetadata: {
          type: 'git',
          autoUpdate: false,
          source: 'https://github.com/some/extension.git',
        },
      };
      const extensionTwo: Extension = {
        id: 'ext-two',
        name: 'ext-two',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/ext-two',
        contextFiles: [],
        config: { name: 'ext-two', version: '1.0.0' },
        installMetadata: {
          type: 'git',
          autoUpdate: false,
          source: 'https://github.com/some/extension.git',
        },
      };
      mockGetExtensions.mockReturnValue([extensionOne, extensionTwo]);
      mockContext.ui.extensionsUpdateState.set(extensionOne.name, {
        status: ExtensionUpdateState.UPDATE_AVAILABLE,
        processed: false,
      });
      mockContext.ui.extensionsUpdateState.set(extensionTwo.name, {
        status: ExtensionUpdateState.UPDATE_AVAILABLE,
        processed: false,
      });
      mockUpdateExtension
        .mockResolvedValueOnce({
          name: 'ext-one',
          originalVersion: '1.0.0',
          updatedVersion: '1.0.1',
        })
        .mockResolvedValueOnce({
          name: 'ext-two',
          originalVersion: '2.0.0',
          updatedVersion: '2.0.1',
        });
      await updateAction(mockContext, 'ext-one ext-two');
      expect(mockUpdateExtension).toHaveBeenCalledTimes(2);
      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith({
        type: MessageType.EXTENSIONS_LIST,
      });
      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.EXTENSIONS_LIST,
        },
        expect.any(Number),
      );
    });

    describe('completion', () => {
      const updateCompletion = extensionsCommand.subCommands?.find(
        (cmd) => cmd.name === 'update',
      )?.completion;

      if (!updateCompletion) {
        throw new Error('Update completion not found');
      }

      const extensionOne: Extension = {
        id: 'ext-one',
        name: 'ext-one',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/ext-one',
        contextFiles: [],
        config: { name: 'ext-one', version: '1.0.0' },
        installMetadata: {
          type: 'git',
          autoUpdate: false,
          source: 'https://github.com/some/extension.git',
        },
      };
      const extensionTwo: Extension = {
        id: 'another-ext',
        contextFiles: [],
        config: { name: 'another-ext', version: '1.0.0' },
        name: 'another-ext',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/another-ext',
        installMetadata: {
          type: 'git',
          autoUpdate: false,
          source: 'https://github.com/some/extension.git',
        },
      };
      const allExt: Extension = {
        id: 'all-ext',
        name: 'all-ext',
        contextFiles: [],
        config: { name: 'all-ext', version: '1.0.0' },
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/all-ext',
        installMetadata: {
          type: 'git',
          autoUpdate: false,
          source: 'https://github.com/some/extension.git',
        },
      };

      it.each([
        {
          description: 'should return matching extension names',
          extensions: [extensionOne, extensionTwo],
          partialArg: 'ext',
          expected: ['ext-one'],
        },
        {
          description: 'should return --all when partialArg matches',
          extensions: [],
          partialArg: '--al',
          expected: ['--all'],
        },
        {
          description:
            'should return both extension names and --all when both match',
          extensions: [allExt],
          partialArg: 'all',
          expected: ['--all', 'all-ext'],
        },
        {
          description: 'should return an empty array if no matches',
          extensions: [extensionOne],
          partialArg: 'nomatch',
          expected: [],
        },
      ])('$description', async ({ extensions, partialArg, expected }) => {
        mockGetExtensions.mockReturnValue(extensions);
        const suggestions = await updateCompletion(mockContext, partialArg);
        expect(suggestions).toEqual(expected);
      });
    });

    it('should call reloadCommands in finally block', async () => {
      mockGetExtensions.mockReturnValue([{ name: 'ext-one', isActive: true }]);
      mockUpdateAllUpdatableExtensions.mockResolvedValue([
        {
          name: 'ext-one',
          originalVersion: '1.0.0',
          updatedVersion: '1.0.1',
        },
      ]);
      await updateAction(mockContext, '--all');
      expect(mockContext.ui.reloadCommands).toHaveBeenCalled();
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
          text: 'Usage: /extensions install <source>',
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
  });

  describe('uninstall', () => {
    const uninstallAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'uninstall',
    )?.action;

    if (!uninstallAction) {
      throw new Error('Uninstall action not found');
    }

    let realMockExtensionManager: ExtensionManager;

    beforeEach(() => {
      vi.resetAllMocks();
      realMockExtensionManager = Object.create(ExtensionManager.prototype);
      realMockExtensionManager.uninstallExtension = mockUninstallExtension;

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

    it('should show usage if no name is provided', async () => {
      await uninstallAction(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Usage: /extensions uninstall <extension-name>',
        },
        expect.any(Number),
      );
    });

    it('should uninstall extension successfully', async () => {
      mockUninstallExtension.mockResolvedValue(undefined);

      await uninstallAction(mockContext, 'test-extension');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Uninstalling extension "test-extension"...',
        },
        expect.any(Number),
      );
      expect(mockUninstallExtension).toHaveBeenCalledWith(
        'test-extension',
        false,
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension "test-extension" uninstalled successfully.',
        },
        expect.any(Number),
      );
      expect(mockContext.ui.reloadCommands).toHaveBeenCalled();
    });

    it('should handle uninstall errors', async () => {
      mockUninstallExtension.mockRejectedValue(
        new Error('Extension not found.'),
      );

      await uninstallAction(mockContext, 'nonexistent-extension');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to uninstall extension "nonexistent-extension": Extension not found.',
        },
        expect.any(Number),
      );
    });
  });

  describe('disable', () => {
    const disableAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'disable',
    )?.action;

    if (!disableAction) {
      throw new Error('Disable action not found');
    }

    let realMockExtensionManager: ExtensionManager;

    beforeEach(() => {
      vi.resetAllMocks();
      realMockExtensionManager = Object.create(ExtensionManager.prototype);
      realMockExtensionManager.disableExtension = mockDisableExtension;
      realMockExtensionManager.getLoadedExtensions = mockGetLoadedExtensions;

      mockContext = createMockCommandContext({
        invocation: {
          raw: '/extensions disable',
          name: 'disable',
          args: '',
        },
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

    it('should show usage if invalid args are provided', async () => {
      await disableAction(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Usage: /extensions disable <extension> [--scope=<user|workspace>]',
        },
        expect.any(Number),
      );
    });

    it('should disable extension at user scope', async () => {
      mockDisableExtension.mockResolvedValue(undefined);

      await disableAction(mockContext, 'test-extension --scope=user');

      expect(mockDisableExtension).toHaveBeenCalledWith(
        'test-extension',
        'User',
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension "test-extension" disabled for scope "User"',
        },
        expect.any(Number),
      );
    });

    it('should disable extension at workspace scope', async () => {
      mockDisableExtension.mockResolvedValue(undefined);

      await disableAction(mockContext, 'test-extension --scope workspace');

      expect(mockDisableExtension).toHaveBeenCalledWith(
        'test-extension',
        'Workspace',
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension "test-extension" disabled for scope "Workspace"',
        },
        expect.any(Number),
      );
    });

    it('should show error for invalid scope', async () => {
      await disableAction(mockContext, 'test-extension --scope=invalid');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Unsupported scope "invalid", should be one of "user" or "workspace"',
        },
        expect.any(Number),
      );
    });
  });

  describe('enable', () => {
    const enableAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'enable',
    )?.action;

    if (!enableAction) {
      throw new Error('Enable action not found');
    }

    let realMockExtensionManager: ExtensionManager;

    beforeEach(() => {
      vi.resetAllMocks();
      realMockExtensionManager = Object.create(ExtensionManager.prototype);
      realMockExtensionManager.enableExtension = mockEnableExtension;
      realMockExtensionManager.getLoadedExtensions = mockGetLoadedExtensions;

      mockContext = createMockCommandContext({
        invocation: {
          raw: '/extensions enable',
          name: 'enable',
          args: '',
        },
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

    it('should show usage if invalid args are provided', async () => {
      await enableAction(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Usage: /extensions enable <extension> [--scope=<user|workspace>]',
        },
        expect.any(Number),
      );
    });

    it('should enable extension at user scope', async () => {
      mockEnableExtension.mockResolvedValue(undefined);

      await enableAction(mockContext, 'test-extension --scope=user');

      expect(mockEnableExtension).toHaveBeenCalledWith(
        'test-extension',
        'User',
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension "test-extension" enabled for scope "User"',
        },
        expect.any(Number),
      );
    });

    it('should enable extension at workspace scope', async () => {
      mockEnableExtension.mockResolvedValue(undefined);

      await enableAction(mockContext, 'test-extension --scope workspace');

      expect(mockEnableExtension).toHaveBeenCalledWith(
        'test-extension',
        'Workspace',
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension "test-extension" enabled for scope "Workspace"',
        },
        expect.any(Number),
      );
    });

    it('should show error for invalid scope', async () => {
      await enableAction(mockContext, 'test-extension --scope=invalid');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Unsupported scope "invalid", should be one of "user" or "workspace"',
        },
        expect.any(Number),
      );
    });
  });

  describe('detail', () => {
    const detailAction = extensionsCommand.subCommands?.find(
      (cmd) => cmd.name === 'detail',
    )?.action;

    if (!detailAction) {
      throw new Error('Detail action not found');
    }

    let realMockExtensionManager: ExtensionManager;

    beforeEach(() => {
      vi.resetAllMocks();
      realMockExtensionManager = Object.create(ExtensionManager.prototype);
      realMockExtensionManager.getLoadedExtensions = mockGetLoadedExtensions;

      mockContext = createMockCommandContext({
        invocation: {
          raw: '/extensions detail',
          name: 'detail',
          args: '',
        },
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

    it('should show usage if no name is provided', async () => {
      await detailAction(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Usage: /extensions detail <extension-name>',
        },
        expect.any(Number),
      );
    });

    it('should show error if extension not found', async () => {
      mockGetExtensions.mockReturnValue([]);
      await detailAction(mockContext, 'nonexistent-extension');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Extension "nonexistent-extension" not found.',
        },
        expect.any(Number),
      );
    });

    it('should show extension details when found', async () => {
      const extension: Extension = {
        id: 'test-ext',
        name: 'test-ext',
        version: '1.0.0',
        isActive: true,
        path: '/test/dir/test-ext',
        contextFiles: [],
        config: { name: 'test-ext', version: '1.0.0' },
      };
      mockGetExtensions.mockReturnValue([extension]);
      realMockExtensionManager.isEnabled = vi.fn().mockReturnValue(true);

      await detailAction(mockContext, 'test-ext');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('test-ext'),
        },
        expect.any(Number),
      );
    });
  });
});
