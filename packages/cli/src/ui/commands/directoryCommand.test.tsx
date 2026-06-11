/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { directoryCommand, expandHomeDir } from './directoryCommand.js';
import type { Config, WorkspaceContext } from '@qwen-code/qwen-code-core';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';
import { SettingScope, saveSettings } from '../../config/settings.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadServerHierarchicalMemory } from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    loadServerHierarchicalMemory: vi.fn().mockResolvedValue({
      memoryContent: 'mock memory',
      fileCount: 0,
      conditionalRules: [],
      projectRoot: '/test',
    }),
    ConditionalRulesRegistry: vi.fn(),
  };
});

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    saveSettings: vi.fn(),
  };
});

describe('directoryCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: Config;
  let mockWorkspaceContext: WorkspaceContext;
  let mockWorkspaceDirectories: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSettings: any;
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
    } as unknown as WorkspaceContext;

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
    } as unknown as Config;

    mockSettings = {
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
      recomputeMerged: vi.fn(),
      forScope: vi.fn((scope: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (scope === 'User') return (mockSettings as any).user;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (mockSettings as any).workspace;
      }),
    };

    mockContext = {
      services: {
        config: mockConfig,
        settings: mockSettings,
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
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as Config;

      // Set up workspace settings with the directories that include the
      // removable one, so the persist path can find and remove it.
      mockSettings.workspace = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [
              path.normalize('/home/user/project1'),
              removableDir,
            ],
          },
        },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [path.normalize('/home/user/project1')],
      );
      expect(mockWorkspaceContext.removeDirectory).toHaveBeenCalledWith(
        removableDir,
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${removableDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should show error when settings update fails and not remove from memory', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as Config;

      const settingsError = new Error('write failed');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newSettings: any = {
        ...mockSettings,
        workspace: {
          settings: {},
          originalSettings: {
            context: { includeDirectories: [removableDir] },
          },
        },
        setValue: vi.fn().mockImplementation(() => {
          throw settingsError;
        }),
        recomputeMerged: vi.fn(),
      };
      newSettings.forScope = vi.fn((scope: string) => {
        if (scope === 'User') return newSettings.user;
        return newSettings.workspace;
      });

      mockContext = {
        ...mockContext,
        services: {
          ...mockContext.services,
          config: mockConfig,
          settings: newSettings,
        },
      } as unknown as CommandContext;

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      // Settings update failed — directory should NOT have been removed
      // from memory since persist happened first.
      expect(mockWorkspaceContext.removeDirectory).not.toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: `Error updating settings: ${settingsError.message}`,
        }),
        expect.any(Number),
      );
    });

    it('should remove a directory stored only in user settings', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as Config;

      mockSettings.workspace = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [path.normalize('/home/user/project1')],
          },
        },
      };
      mockSettings.user = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [removableDir],
          },
        },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'context.includeDirectories',
        [],
      );
      expect(mockWorkspaceContext.removeDirectory).toHaveBeenCalledWith(
        removableDir,
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${removableDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should remove a directory stored in both workspace and user settings', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as Config;

      mockSettings.workspace = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [
              path.normalize('/home/user/project1'),
              removableDir,
            ],
          },
        },
      };
      mockSettings.user = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [removableDir],
          },
        },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [path.normalize('/home/user/project1')],
      );
      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'context.includeDirectories',
        [],
      );
      expect(mockWorkspaceContext.removeDirectory).toHaveBeenCalledWith(
        removableDir,
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${removableDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should roll back committed scopes when later scope fails', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as Config;

      const originalWorkspaceDirs = [
        path.normalize('/home/user/project1'),
        removableDir,
      ];
      const originalUserDirs = [removableDir];

      mockSettings.workspace = {
        settings: {
          context: { includeDirectories: [...originalWorkspaceDirs] },
        },
        originalSettings: {
          context: { includeDirectories: [...originalWorkspaceDirs] },
        },
      };
      mockSettings.user = {
        settings: {
          context: { includeDirectories: [...originalUserDirs] },
        },
        originalSettings: {
          context: { includeDirectories: [...originalUserDirs] },
        },
      };

      let callCount = 0;
      mockSettings.setValue = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          throw new Error('user scope write failed');
        }
      });
      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      // Should have rolled back and shown error.
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Error updating settings: user scope write failed',
        }),
        expect.any(Number),
      );
      // Directory should NOT have been removed from memory.
      expect(mockWorkspaceContext.removeDirectory).not.toHaveBeenCalled();

      // Verify in-memory workspace settings were restored to original state.
      expect(
        mockSettings.workspace.settings.context.includeDirectories,
      ).toEqual(originalWorkspaceDirs);
      expect(
        mockSettings.workspace.originalSettings.context.includeDirectories,
      ).toEqual(originalWorkspaceDirs);

      // Verify disk rollback was called for the committed workspace scope.
      expect(saveSettings).toHaveBeenCalledWith(
        mockSettings.workspace,
        expect.objectContaining({
          context: expect.objectContaining({
            includeDirectories: originalWorkspaceDirs,
          }),
        }),
      );
      // Verify merged settings were recomputed after rollback.
      expect(mockSettings.recomputeMerged).toHaveBeenCalled();
    });

    it('should roll back settings when in-memory removal fails', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(false),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
      } as unknown as Config;

      const originalDirs = [
        path.normalize('/home/user/project1'),
        removableDir,
      ];
      mockSettings.workspace = {
        settings: {
          context: { includeDirectories: [...originalDirs] },
        },
        originalSettings: {
          context: { includeDirectories: [...originalDirs] },
        },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      // Settings should have been rolled back.
      expect(
        mockSettings.workspace.originalSettings.context.includeDirectories,
      ).toEqual(originalDirs);
      expect(saveSettings).toHaveBeenCalledWith(
        mockSettings.workspace,
        expect.objectContaining({
          context: expect.objectContaining({
            includeDirectories: originalDirs,
          }),
        }),
      );
      expect(mockSettings.recomputeMerged).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining(
            'Could not remove directory from the active workspace',
          ),
        }),
        expect.any(Number),
      );
    });

    it('should show error in sandbox mode and not mutate settings', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
        isRestrictiveSandbox: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      mockContext = {
        ...mockContext,
        services: {
          ...mockContext.services,
          config: mockConfig,
        },
      } as unknown as CommandContext;

      mockSettings.workspace = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [
              path.normalize('/home/user/project1'),
              removableDir,
            ],
          },
        },
      };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('not supported in restrictive sandbox'),
        }),
        expect.any(Number),
      );
      expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
      expect(mockWorkspaceContext.removeDirectory).not.toHaveBeenCalled();
    });

    it('should refresh memory after successful removal', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
        shouldLoadMemoryFromIncludeDirectories: () => true,
        getFileService: () => ({}),
        getExtensionContextFilePaths: () => [],
        getFolderTrust: () => true,
        getContextRuleExcludes: () => [],
        setUserMemory: vi.fn(),
        setGeminiMdFileCount: vi.fn(),
        setConditionalRulesRegistry: vi.fn(),
      } as unknown as Config;

      mockContext = {
        ...mockContext,
        services: {
          ...mockContext.services,
          config: mockConfig,
        },
      } as unknown as CommandContext;

      mockSettings.workspace = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [
              path.normalize('/home/user/project1'),
              removableDir,
            ],
          },
        },
      };
      mockSettings.merged = { context: { importFormat: 'tree' } };

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      expect(mockConfig.setUserMemory).toHaveBeenCalled();
      expect(mockConfig.setGeminiMdFileCount).toHaveBeenCalled();
      expect(mockConfig.setConditionalRulesRegistry).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${removableDir}`,
        }),
        expect.any(Number),
      );
    });

    it('should show warning when memory refresh fails but still report success', async () => {
      const removableDir = path.normalize('/home/user/project2');
      mockWorkspaceContext = {
        ...mockWorkspaceContext,
        removeDirectory: vi.fn().mockReturnValue(true),
        isInitialDirectory: vi.fn().mockReturnValue(false),
        getInitialDirectories: vi
          .fn()
          .mockReturnValue([path.normalize('/home/user/project1')]),
      } as unknown as WorkspaceContext;

      mockConfig = {
        ...mockConfig,
        getWorkspaceContext: () => mockWorkspaceContext,
        shouldLoadMemoryFromIncludeDirectories: () => true,
        getFileService: () => ({}),
        getExtensionContextFilePaths: () => [],
        getFolderTrust: () => true,
        getContextRuleExcludes: () => [],
        setUserMemory: vi.fn(),
        setGeminiMdFileCount: vi.fn(),
        setConditionalRulesRegistry: vi.fn(),
      } as unknown as Config;

      mockContext = {
        ...mockContext,
        services: {
          ...mockContext.services,
          config: mockConfig,
        },
      } as unknown as CommandContext;

      mockSettings.workspace = {
        settings: {},
        originalSettings: {
          context: {
            includeDirectories: [
              path.normalize('/home/user/project1'),
              removableDir,
            ],
          },
        },
      };
      mockSettings.merged = { context: { importFormat: 'tree' } };

      // Make loadServerHierarchicalMemory throw for this test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loadServerHierarchicalMemory as any).mockRejectedValueOnce(
        new Error('memory load failed'),
      );

      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, removableDir);

      // Success message should still be shown
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `Removed directory: ${removableDir}`,
        }),
        expect.any(Number),
      );
      // Memory refresh failure should be a warning, not an error
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.WARNING,
          text: expect.stringContaining(
            'Directory removed but memory refresh failed',
          ),
        }),
        expect.any(Number),
      );
    });

    it('should correctly expand a Windows-style home directory path', () => {
      const windowsPath = '%userprofile%\\Documents';
      const expectedPath = path.win32.join(os.homedir(), 'Documents');
      const result = expandHomeDir(windowsPath);
      expect(path.win32.normalize(result)).toBe(
        path.win32.normalize(expectedPath),
      );
    });
  });
});
