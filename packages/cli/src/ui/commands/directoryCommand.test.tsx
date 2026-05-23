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
import { SettingScope } from '../../config/settings.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('directoryCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: Config;
  let mockWorkspaceContext: WorkspaceContext;
  let mockWorkspaceDirectories: string[];
  const addCommand = directoryCommand.subCommands?.find(
    (c) => c.name === 'add',
  );
  const showCommand = directoryCommand.subCommands?.find(
    (c) => c.name === 'show',
  );

  beforeEach(() => {
    mockWorkspaceDirectories = [
      path.normalize('/home/user/project1'),
      path.normalize('/home/user/project2'),
    ];
    mockWorkspaceContext = {
      addDirectory: vi.fn((directory: string) => {
        const normalizedDirectory = path.normalize(directory);
        if (!mockWorkspaceDirectories.includes(normalizedDirectory)) {
          mockWorkspaceDirectories.push(normalizedDirectory);
        }
      }),
      getDirectories: vi.fn(() => [...mockWorkspaceDirectories]),
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

    mockContext = {
      services: {
        config: mockConfig,
        settings: {
          merged: {},
          workspace: {
            settings: {},
            originalSettings: {},
          },
          setValue: vi.fn(),
        },
      },
      ui: {
        addItem: vi.fn(),
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
  it('should correctly expand a Windows-style home directory path', () => {
    const windowsPath = '%userprofile%\\Documents';
    const expectedPath = path.win32.join(os.homedir(), 'Documents');
    const result = expandHomeDir(windowsPath);
    expect(path.win32.normalize(result)).toBe(
      path.win32.normalize(expectedPath),
    );
  });
});
