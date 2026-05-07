/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { directoryCommand } from './directoryCommand.js';
import * as core from '@qwen-code/qwen-code-core';
import type { CommandContext } from './types.js';

import { MessageType } from '../types.js';
import { SettingScope } from '../../config/settings.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Mock fs to allow spying on realpathSync in a way that works with ESM
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn(actual.realpathSync),
  };
});

describe('directoryCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: core.Config;
  let mockWorkspaceContext: core.WorkspaceContext;
  let mockWorkspaceDirectories: string[];
  const addCommand = directoryCommand.subCommands?.find(
    (c) => c.name === 'add',
  );
  const removeCommand = directoryCommand.subCommands?.find(
    (c) => c.name === 'remove',
  );
  const showCommand = directoryCommand.subCommands?.find(
    (c) => c.name === 'show',
  );

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkspaceDirectories = [
      path.normalize('/home/user/project1'),
      path.normalize('/home/user/project2'),
    ];
    const initialDirs = new Set([path.normalize('/home/user/project1')]);
    mockWorkspaceContext = {
      addDirectory: vi.fn((directory: string) => {
        const normalizedDirectory = path.normalize(directory);
        if (!mockWorkspaceDirectories.includes(normalizedDirectory)) {
          mockWorkspaceDirectories.push(normalizedDirectory);
        }
      }),
      getDirectories: vi.fn(() => [...mockWorkspaceDirectories]),
      getInitialDirectories: vi.fn(() => [...initialDirs]),
      isInitialDirectory: vi.fn((dir: string) =>
        initialDirs.has(path.normalize(dir)),
      ),
      removeDirectory: vi.fn(),
    } as unknown as core.WorkspaceContext;

    mockConfig = {
      getWorkspaceContext: () => mockWorkspaceContext,
      isRestrictiveSandbox: vi.fn().mockReturnValue(false),
      getGeminiClient: vi.fn().mockReturnValue({
        addDirectoryContext: vi.fn(),
      }),
      getWorkingDir: () => '/test/dir',
      shouldLoadMemoryFromIncludeDirectories: () => false,
      getDebugMode: () => false,
      getFileService: () => ({}),
      getExtensionContextFilePaths: () => [],
      getFileFilteringOptions: () => ({ ignore: [], include: [] }),
      setUserMemory: vi.fn(),
      setGeminiMdFileCount: vi.fn(),
      setConditionalRulesRegistry: vi.fn(),
      getContextRuleExcludes: () => [],
      getFolderTrust: () => ({ isTrusted: true }),
    } as unknown as core.Config;

    mockContext = {
      services: {
        config: mockConfig,
        settings: {
          merged: {},
          workspace: {
            settings: {},
            originalSettings: {},
          },
          user: {
            settings: {},
            originalSettings: {},
          },
          setValue: vi.fn(),
          forScope: vi.fn((scope) => {
            if (scope === SettingScope.Workspace) {
              return mockContext.services.settings.workspace;
            }
            if (scope === SettingScope.User) {
              return mockContext.services.settings.user;
            }
            return { settings: {}, originalSettings: {} };
          }),
        },
      },
      ui: {
        addItem: vi.fn(),
        setGeminiMdFileCount: vi.fn(),
      },
    } as unknown as CommandContext;
  });

  describe('show', () => {
    it('should display the list of directories', () => {
      if (!showCommand?.action) throw new Error('No action');
      showCommand.action(mockContext, '');
      expect(mockWorkspaceContext.getDirectories).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Current workspace directories:\n- ${path.normalize(
            '/home/user/project1',
          )}\n- ${path.normalize('/home/user/project2')}`,
        }),
        expect.any(Number),
      );
    });
  });

  describe('add', () => {
    it('should show an error if no path is provided', () => {
      if (!addCommand?.action) throw new Error('No action');
      addCommand.action(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Please provide at least one path to add.',
        }),
        expect.any(Number),
      );
    });

    it('should call addDirectory and show a success message for a single path', async () => {
      const newPath = path.normalize('/home/user/new-project');
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, newPath);
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(newPath);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Successfully added directories:\n- ${newPath}`,
        }),
        expect.any(Number),
      );
    });

    it('should persist added directories to workspace settings', async () => {
      const existingPath = path.normalize('/home/user/existing-project');
      const newPath = path.normalize('/home/user/new-project');
      mockContext.services.settings.workspace.settings = {
        context: { includeDirectories: [existingPath] },
      };
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [existingPath] },
      };

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, newPath);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [existingPath, newPath],
      );
    });

    it('should not duplicate existing workspace settings when persisting', async () => {
      const existingPath = path.normalize('/home/user/existing-project');
      mockContext.services.settings.workspace.settings = {
        context: { includeDirectories: [existingPath] },
      };
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [existingPath] },
      };

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, existingPath);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [existingPath],
      );
    });

    it('should not persist directories skipped by the workspace context', async () => {
      const skippedPath = path.normalize('/home/user/missing-project');
      vi.mocked(mockWorkspaceContext.addDirectory).mockImplementation(
        () => undefined,
      );

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, skippedPath);

      expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
      expect(mockContext.ui.addItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Successfully added directories:\n- ${skippedPath}`,
        }),
        expect.any(Number),
      );
    });

    it('should show already-added directories without an empty success message', async () => {
      const existingPath = path.normalize('/home/user/project1');

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, existingPath);

      expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Directories already in workspace:\n- ${existingPath}`,
        }),
        expect.any(Number),
      );
      expect(mockContext.ui.addItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Successfully added QWEN.md files from the following directories if there are:\n- ',
        }),
        expect.any(Number),
      );
    });

    it('should preserve env-var-form include directories when persisting', async () => {
      const originalExistingPath = '$HOME/existing-project';
      const resolvedExistingPath = path.normalize(
        '/home/user/existing-project',
      );
      const newPath = path.normalize('/home/user/new-project');
      mockContext.services.settings.workspace.settings = {
        context: { includeDirectories: [resolvedExistingPath] },
      };
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [originalExistingPath] },
      };

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, newPath);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [originalExistingPath, newPath],
      );
    });

    it('should persist the directory path accepted by the workspace context', async () => {
      const inputPath = 'linked-project';
      const acceptedPath = path.normalize('/home/user/real-project');
      vi.mocked(mockWorkspaceContext.addDirectory).mockImplementation(() => {
        mockWorkspaceDirectories.push(acceptedPath);
      });

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, inputPath);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [acceptedPath],
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Successfully added directories:\n- ${acceptedPath}`,
        }),
        expect.any(Number),
      );
    });

    it('should call addDirectory for each path and show a success message for multiple paths', async () => {
      const newPath1 = path.normalize('/home/user/new-project1');
      const newPath2 = path.normalize('/home/user/new-project2');
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, `${newPath1},${newPath2}`);
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(newPath1);
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(newPath2);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Successfully added directories:\n- ${newPath1}\n- ${newPath2}`,
        }),
        expect.any(Number),
      );
    });

    it('should show an error if addDirectory throws an exception', async () => {
      const error = new Error('Directory does not exist');
      vi.mocked(mockWorkspaceContext.addDirectory).mockImplementation(() => {
        throw error;
      });
      const newPath = path.normalize('/home/user/invalid-project');
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, newPath);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Error adding '${newPath}': ${error.message}`,
        }),
        expect.any(Number),
      );
    });

    it('should handle a mix of successful and failed additions', async () => {
      const validPath = path.normalize('/home/user/valid-project');
      const invalidPath = path.normalize('/home/user/invalid-project');
      const error = new Error('Directory does not exist');
      vi.mocked(mockWorkspaceContext.addDirectory).mockImplementation(
        (p: string) => {
          if (p === invalidPath) {
            throw error;
          }
          if (!mockWorkspaceDirectories.includes(p)) {
            mockWorkspaceDirectories.push(p);
          }
        },
      );

      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, `${validPath},${invalidPath}`);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Successfully added directories:\n- ${validPath}`,
        }),
        expect.any(Number),
      );

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Error adding '${invalidPath}': ${error.message}`,
        }),
        expect.any(Number),
      );
    });
  });
  describe('remove', () => {
    it('should show an error if no path is provided', async () => {
      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Please provide a directory path to remove.',
        }),
        expect.any(Number),
      );
    });

    it('should show an error when trying to remove the initial directory', async () => {
      const initialDir = path.normalize('/home/user/project1');
      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, initialDir);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Cannot remove initial workspace directory: ${initialDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should show an error when directory is not in workspace', async () => {
      const nonExistent = path.normalize('/not/in/workspace');
      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, nonExistent);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Directory not found in workspace: ${nonExistent}`,
        }),
        expect.any(Number),
      );
    });

    it('should remove a directory and persist to settings', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as core.WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as core.Config;

      mockContext.services.settings.workspace.originalSettings = {
        context: {
          includeDirectories: [
            path.normalize('/home/user/project1'),
            removableDir,
          ],
        },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockContext.services.settings.forScope).toHaveBeenCalledWith(
        SettingScope.Workspace,
      );
      expect(mockWorkspaceContext.removeDirectory).toHaveBeenCalledWith(
        removableDir,
      );
      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [path.normalize('/home/user/project1')],
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${removableDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should remove a directory from user scope if not in workspace scope', async () => {
      const userDir = path.normalize('/home/user/user-project');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        getInitialDirectories: vi.fn().mockReturnValue([]),
      } as unknown as core.WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as core.Config;

      // Not in workspace scope
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [] },
      };
      // Is in user scope
      mockContext.services.settings.user.originalSettings = {
        context: { includeDirectories: [userDir] },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, userDir);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'context.includeDirectories',
        [],
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${userDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should match and remove from settings using canonical path', async () => {
      const canonicalDir = path.normalize('/home/user/real-project');
      const symlinkDir = path.normalize('/home/user/link-project');

      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        getInitialDirectories: vi.fn().mockReturnValue([]),
      } as unknown as core.WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as core.Config;

      // Stored as canonical
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [canonicalDir] },
      };

      // Input is symlink
      vi.mocked(fs.realpathSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('link-project'))
          return canonicalDir;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (vi.importActual('node:fs') as any).realpathSync(p);
      });

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, symlinkDir);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [],
      );
    });

    it('should refresh memory when shouldLoadMemoryFromIncludeDirectories is true', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        getInitialDirectories: vi.fn().mockReturnValue([]),
      } as unknown as core.WorkspaceContext;

      const updatedMockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
        shouldLoadMemoryFromIncludeDirectories: () => true,
        getWorkingDir: () => '/test/dir',
        getFileService: () => ({}),
        getExtensionContextFilePaths: () => [],
        getFolderTrust: () => ({ isTrusted: true }),
        getContextRuleExcludes: () => [],
        setUserMemory: vi.fn(),
        setGeminiMdFileCount: vi.fn(),
        setConditionalRulesRegistry: vi.fn(),
      } as unknown as core.Config;

      mockContext.services.config = updatedMockConfig;
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [removableDir] },
      };

      const loadMemorySpy = vi
        .spyOn(core, 'loadServerHierarchicalMemory')
        .mockResolvedValue({
          memoryContent: 'new memory',
          fileCount: 10,
          conditionalRules: [],
          projectRoot: '/test/dir',
        });

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(loadMemorySpy).toHaveBeenCalled();
      expect(updatedMockConfig.setUserMemory).toHaveBeenCalledWith(
        'new memory',
      );
      expect(mockContext.ui.setGeminiMdFileCount).toHaveBeenCalledWith(10);
    });

    it('should correctly resolve relative paths and ~ before checking initial directories', async () => {
      const initialDir = path.resolve(path.normalize('/home/user/project1'));
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        getInitialDirectories: vi.fn().mockReturnValue([initialDir]),
      } as unknown as core.WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as core.Config;

      // Test with a relative path that resolves to the initial directory
      const relativePath = path.relative(process.cwd(), initialDir);

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, relativePath);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Cannot remove initial workspace directory: ${initialDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should correctly handle symlinks when checking initial directories', async () => {
      const initialDir = path.normalize('/home/user/project1');
      const symlinkDir = path.normalize('/home/user/link-to-project1');

      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        getInitialDirectories: vi.fn().mockReturnValue([initialDir]),
      } as unknown as core.WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as core.Config;

      // Mock fs.realpathSync to return the target directory for the symlink
      vi.mocked(fs.realpathSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('link-to-project1'))
          return initialDir;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (vi.importActual('node:fs') as any).realpathSync(p);
      });

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, symlinkDir);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Cannot remove initial workspace directory: ${initialDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should show error when settings update fails after removal', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as core.WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as core.Config;

      const settingsError = new Error('write failed');
      mockContext.services.settings.workspace.originalSettings = {
        context: { includeDirectories: [removableDir] },
      };
      vi.mocked(mockContext.services.settings.setValue).mockImplementation(
        () => {
          throw settingsError;
        },
      );

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Directory removed from workspace but error updating settings: ${settingsError.message}`,
        }),
        expect.any(Number),
      );
    });
  });

  it('should correctly expand a Windows-style home directory path', () => {
    const windowsPath = '%userprofile%\\Documents';
    const expectedPath = path.win32.join(os.homedir(), 'Documents');
    const result = core.expandHomeDir(windowsPath);
    expect(path.win32.normalize(result)).toBe(
      path.win32.normalize(expectedPath),
    );
  });
});
