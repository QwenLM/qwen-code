/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  directoryCommand,
  expandHomeDir,
  getDirPathCompletions,
} from './directoryCommand.js';
import type { Config, WorkspaceContext } from '@qwen-code/qwen-code-core';
import type { CommandContext, SlashCommandActionReturn } from './types.js';
import { SettingScope } from '../../config/settings.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

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

  it('declares acp in supportedModes for parent and subcommands', () => {
    expect(directoryCommand.supportedModes).toEqual(['interactive', 'acp']);
    expect(addCommand!.supportedModes).toEqual(['interactive', 'acp']);
    expect(showCommand!.supportedModes).toEqual(['interactive', 'acp']);
  });

  it('add subcommand has argumentHint', () => {
    expect(addCommand!.argumentHint).toBe('<path>[,<path>,...]');
  });

  it('returns usage hint when invoked without a subcommand', async () => {
    const result = await directoryCommand.action?.({} as CommandContext, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('/directory add'),
    });
  });

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
    it('should return the list of directories', async () => {
      if (!showCommand?.action) throw new Error('No action');
      const result = await showCommand.action(mockContext, '');
      expect(mockWorkspaceContext.getDirectories).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: `Current workspace directories:\n- ${path.normalize(
          '/home/user/project1',
        )}\n- ${path.normalize('/home/user/project2')}`,
      });
    });
  });

  describe('add', () => {
    it('should return an error if no path is provided', async () => {
      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(mockContext, '');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Please provide at least one path to add.',
      });
    });

    it('should return an error on restrictive sandbox', async () => {
      vi.mocked(mockConfig.isRestrictiveSandbox).mockReturnValue(true);
      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(mockContext, '/some/path');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('restrictive sandbox'),
      });
    });

    it('should handle paths with spaces without splitting on space', async () => {
      const spacePath = path.normalize('/home/user/My Project');
      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(mockContext, spacePath);
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(spacePath);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          `Successfully added directories:\n- ${spacePath}`,
        ),
      });
    });

    it('should call addDirectory and return a success message for a single path', async () => {
      const newPath = path.normalize('/home/user/new-project');
      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(mockContext, newPath);
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(newPath);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          `Successfully added directories:\n- ${newPath}`,
        ),
      });
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
      const result = (await addCommand.action(
        mockContext,
        skippedPath,
      )) as SlashCommandActionReturn;

      expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      expect((result as { content: string }).content).not.toContain(
        'Successfully added directories',
      );
    });

    it('should return already-added directories without a success message', async () => {
      const existingPath = path.normalize('/home/user/project1');

      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(mockContext, existingPath);

      expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('already in workspace'),
      });
      expect((result as { content: string }).content).toContain(existingPath);
      expect((result as { content: string }).content).not.toContain(
        'Successfully added',
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
      const result = await addCommand.action(mockContext, inputPath);

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [acceptedPath],
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          `Successfully added directories:\n- ${acceptedPath}`,
        ),
      });
    });

    it('should call addDirectory for each path and return a success message for multiple paths', async () => {
      const newPath1 = path.normalize('/home/user/new-project1');
      const newPath2 = path.normalize('/home/user/new-project2');
      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(
        mockContext,
        `${newPath1},${newPath2}`,
      );
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(newPath1);
      expect(mockWorkspaceContext.addDirectory).toHaveBeenCalledWith(newPath2);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          `Successfully added directories:\n- ${newPath1}\n- ${newPath2}`,
        ),
      });
    });

    it('should return an error if addDirectory throws an exception', async () => {
      const error = new Error('Directory does not exist');
      vi.mocked(mockWorkspaceContext.addDirectory).mockImplementation(() => {
        throw error;
      });
      const newPath = path.normalize('/home/user/invalid-project');
      if (!addCommand?.action) throw new Error('No action');
      const result = await addCommand.action(mockContext, newPath);
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining(
          `Error adding '${newPath}': ${error.message}`,
        ),
      });
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
      const result = await addCommand.action(
        mockContext,
        `${validPath},${invalidPath}`,
      );

      // Mixed result should be warning type since some paths succeeded
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'warning',
      });
      const content = (result as { content: string }).content;
      expect(content).toContain(
        `Successfully added directories:\n- ${validPath}`,
      );
      expect(content).toContain(
        `Error adding '${invalidPath}': ${error.message}`,
      );
      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'context.includeDirectories',
        [validPath],
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

describe('getDirPathCompletions', () => {
  let tempTestDir = '';

  beforeEach(() => {
    // Clean up any previous test runs
    if (tempTestDir) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch (err) {
        // ignore cleanup errors
        void err;
      }
    }

    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-dir-test-'));
    // Create a nested directory structure: root/sub1, root/sub2, root/sub1/deep
    fs.mkdirSync(tempTestDir, { recursive: true });
    fs.mkdirSync(path.join(tempTestDir, 'sub1'), { recursive: true });
    fs.mkdirSync(path.join(tempTestDir, 'sub2'), { recursive: true });
    fs.mkdirSync(path.join(tempTestDir, 'sub1', 'deep'), { recursive: true });
    // Add some non-directory files (should be filtered out)
    fs.writeFileSync(path.join(tempTestDir, 'file.txt'), '');
    fs.writeFileSync(path.join(tempTestDir, 'sub1', 'nested.txt'), '');
  });

  afterAll(() => {
    // Cleanup after all tests
    if (tempTestDir) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch (err) {
        // ignore cleanup errors
        void err;
      }
    }
  });

  describe('directory completions should include isDirectory flag', () => {
    it('should return suggestions with isDirectory: true and trailing /', () => {
      // Use "/" suffix so getDirPathCompletions searches INSIDE the directory
      const results = getDirPathCompletions(`${tempTestDir}/`);

      expect(results.length).toBeGreaterThan(0);

      // Each suggestion should be a CommandCompletionItem with isDirectory: true
      results.forEach((suggestion) => {
        expect(suggestion.value).toBeDefined();
        expect(suggestion.isDirectory).toBe(true);

        // Directory values should end with path separator for continued navigation
        expect(suggestion.value.endsWith(path.sep)).toBe(true);

        // Should match one of our created directories
        const dirNameWithoutSlash = suggestion.value.slice(0, -1);
        const basename = path.basename(dirNameWithoutSlash);
        expect(['sub1', 'sub2'].includes(basename)).toBe(true);
      });
    });

    it('should filter by prefix while preserving isDirectory flag', () => {
      const results = getDirPathCompletions(`${tempTestDir}/su`);

      expect(results.length).toBeGreaterThan(0);

      // Only directories starting with "su" should be returned
      results.forEach((suggestion) => {
        expect(suggestion.isDirectory).toBe(true);
        const sepRe = path.sep === '\\' ? '\\\\' : path.sep;
        expect(suggestion.value).toMatch(new RegExp(`${sepRe}su.+$`));
        // Only top-level directories matching the prefix are returned
        const basename = path.basename(suggestion.value.slice(0, -1));
        expect(basename).toMatch(/^su/);
        const dirname = path.dirname(suggestion.value);
        expect(dirname).toContain(tempTestDir);
      });
    });

    it('should support comma-separated paths with isDirectory flag on last segment', () => {
      const multiPath = `${tempTestDir}, ${tempTestDir}/`;
      const results = getDirPathCompletions(multiPath);

      expect(results.length).toBeGreaterThan(0);

      // Results should start with the prefix from first part
      results.forEach((suggestion) => {
        expect(suggestion.isDirectory).toBe(true);
        expect(suggestion.value.startsWith(`${tempTestDir}`)).toBe(true);
        expect(suggestion.value.endsWith(path.sep)).toBe(true);
      });
    });

    it('should handle deeply nested directories with isDirectory flag', () => {
      // Navigate into sub1
      const deepResults = getDirPathCompletions(`${tempTestDir}/sub1/`);

      expect(deepResults.length).toBeGreaterThan(0);

      // Only directories inside sub1 should be returned
      deepResults.forEach((suggestion) => {
        expect(suggestion.isDirectory).toBe(true);
        expect(suggestion.value).toContain('sub1');
        expect(suggestion.value.endsWith(path.sep)).toBe(true);
        // The nested 'deep' directory should be in the results
        const basename = path.basename(suggestion.value.slice(0, -1));
        expect(basename).toBe('deep');
      });
    });
  });
});
