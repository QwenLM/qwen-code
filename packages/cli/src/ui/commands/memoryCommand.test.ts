/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { memoryCommand } from './memoryCommand.js';
import type { SlashCommand, CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_MEMORY_TYPES,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryTopicPath,
  getErrorMessage,
  loadServerHierarchicalMemory,
  QWEN_DIR,
  scheduleAutoMemoryExtract,
  setGeminiMdFilename,
  type FileDiscoveryService,
  type LoadServerHierarchicalMemoryResponse,
} from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    getErrorMessage: vi.fn((error: unknown) => {
      if (error instanceof Error) return error.message;
      return String(error);
    }),
    loadServerHierarchicalMemory: vi.fn(),
    scheduleAutoMemoryExtract: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => {
  const readFile = vi.fn();
  return {
    readFile,
    default: {
      readFile,
    },
  };
});

const mockLoadServerHierarchicalMemory = loadServerHierarchicalMemory as Mock;
const mockScheduleAutoMemoryExtract = scheduleAutoMemoryExtract as Mock;
const mockReadFile = readFile as unknown as Mock;

describe('memoryCommand', () => {
  let mockContext: CommandContext;

  const getSubCommand = (name: 'show' | 'add' | 'refresh'): SlashCommand => {
    const subCommand = memoryCommand.subCommands?.find(
      (cmd) => cmd.name === name,
    );
    if (!subCommand) {
      throw new Error(`/memory ${name} command not found.`);
    }
    return subCommand;
  };

  describe('/memory show', () => {
    let showCommand: SlashCommand;
    let mockGetUserMemory: Mock;
    let mockGetGeminiMdFileCount: Mock;

    beforeEach(() => {
      setGeminiMdFilename('QWEN.md');
      mockReadFile.mockReset();
      vi.restoreAllMocks();

      showCommand = getSubCommand('show');

      mockGetUserMemory = vi.fn();
      mockGetGeminiMdFileCount = vi.fn();

      mockContext = createMockCommandContext({
        services: {
          config: {
            getUserMemory: mockGetUserMemory,
            getGeminiMdFileCount: mockGetGeminiMdFileCount,
          },
        },
      });
    });

    it('should display a message if memory is empty', async () => {
      if (!showCommand.action) throw new Error('Command has no action');

      mockGetUserMemory.mockReturnValue('');
      mockGetGeminiMdFileCount.mockReturnValue(0);

      await showCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Memory is currently empty.',
        },
        expect.any(Number),
      );
    });

    it('should display the memory content and file count if it exists', async () => {
      if (!showCommand.action) throw new Error('Command has no action');

      const memoryContent = 'This is a test memory.';

      mockGetUserMemory.mockReturnValue(memoryContent);
      mockGetGeminiMdFileCount.mockReturnValue(1);

      await showCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: `Current memory content from 1 file(s):\n\n---\n${memoryContent}\n---`,
        },
        expect.any(Number),
      );
    });

    it('should show project memory from the configured context file', async () => {
      const projectCommand = showCommand.subCommands?.find(
        (cmd) => cmd.name === '--project',
      );
      if (!projectCommand?.action) throw new Error('Command has no action');

      setGeminiMdFilename('AGENTS.md');
      vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
      mockReadFile.mockResolvedValue('project memory');

      await projectCommand.action(mockContext, '');

      const expectedProjectPath = path.join('/test/project', 'AGENTS.md');
      expect(mockReadFile).toHaveBeenCalledWith(expectedProjectPath, 'utf-8');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining(expectedProjectPath),
        },
        expect.any(Number),
      );
    });

    it('should show global memory from the configured context file', async () => {
      const globalCommand = showCommand.subCommands?.find(
        (cmd) => cmd.name === '--global',
      );
      if (!globalCommand?.action) throw new Error('Command has no action');

      setGeminiMdFilename('AGENTS.md');
      vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
      mockReadFile.mockResolvedValue('global memory');

      await globalCommand.action(mockContext, '');

      const expectedGlobalPath = path.join('/home/user', QWEN_DIR, 'AGENTS.md');
      expect(mockReadFile).toHaveBeenCalledWith(expectedGlobalPath, 'utf-8');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('Global memory content'),
        },
        expect.any(Number),
      );
    });

    it('should fall back to AGENTS.md when QWEN.md does not exist for --project', async () => {
      const projectCommand = showCommand.subCommands?.find(
        (cmd) => cmd.name === '--project',
      );
      if (!projectCommand?.action) throw new Error('Command has no action');

      setGeminiMdFilename(['QWEN.md', 'AGENTS.md']);
      vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('AGENTS.md')) return 'agents memory content';
        throw new Error('ENOENT');
      });

      await projectCommand.action(mockContext, '');

      const expectedPath = path.join('/test/project', 'AGENTS.md');
      expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('agents memory content'),
        },
        expect.any(Number),
      );
    });

    it('should fall back to AGENTS.md when QWEN.md does not exist for --global', async () => {
      const globalCommand = showCommand.subCommands?.find(
        (cmd) => cmd.name === '--global',
      );
      if (!globalCommand?.action) throw new Error('Command has no action');

      setGeminiMdFilename(['QWEN.md', 'AGENTS.md']);
      vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('AGENTS.md')) return 'global agents memory';
        throw new Error('ENOENT');
      });

      await globalCommand.action(mockContext, '');

      const expectedPath = path.join('/home/user', QWEN_DIR, 'AGENTS.md');
      expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('global agents memory'),
        },
        expect.any(Number),
      );
    });

    it('should show content from both QWEN.md and AGENTS.md for --project when both exist', async () => {
      const projectCommand = showCommand.subCommands?.find(
        (cmd) => cmd.name === '--project',
      );
      if (!projectCommand?.action) throw new Error('Command has no action');

      setGeminiMdFilename(['QWEN.md', 'AGENTS.md']);
      vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('QWEN.md')) return 'qwen memory';
        if (filePath.endsWith('AGENTS.md')) return 'agents memory';
        throw new Error('ENOENT');
      });

      await projectCommand.action(mockContext, '');

      expect(mockReadFile).toHaveBeenCalledWith(
        path.join('/test/project', 'QWEN.md'),
        'utf-8',
      );
      expect(mockReadFile).toHaveBeenCalledWith(
        path.join('/test/project', 'AGENTS.md'),
        'utf-8',
      );
      const addItemCall = (mockContext.ui.addItem as Mock).mock.calls[0][0];
      expect(addItemCall.text).toContain('qwen memory');
      expect(addItemCall.text).toContain('agents memory');
    });

    it('should show content from both files for --global when both exist', async () => {
      const globalCommand = showCommand.subCommands?.find(
        (cmd) => cmd.name === '--global',
      );
      if (!globalCommand?.action) throw new Error('Command has no action');

      setGeminiMdFilename(['QWEN.md', 'AGENTS.md']);
      vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('QWEN.md')) return 'global qwen memory';
        if (filePath.endsWith('AGENTS.md')) return 'global agents memory';
        throw new Error('ENOENT');
      });

      await globalCommand.action(mockContext, '');

      expect(mockReadFile).toHaveBeenCalledWith(
        path.join('/home/user', QWEN_DIR, 'QWEN.md'),
        'utf-8',
      );
      expect(mockReadFile).toHaveBeenCalledWith(
        path.join('/home/user', QWEN_DIR, 'AGENTS.md'),
        'utf-8',
      );
      const addItemCall = (mockContext.ui.addItem as Mock).mock.calls[0][0];
      expect(addItemCall.text).toContain('global qwen memory');
      expect(addItemCall.text).toContain('global agents memory');
    });
  });

  describe('/memory status', () => {
    let statusCommand: SlashCommand;

    beforeEach(() => {
      statusCommand = memoryCommand.subCommands?.find(
        (cmd) => cmd.name === 'status',
      ) as SlashCommand;
      mockReadFile.mockReset();
      mockContext = createMockCommandContext({
        services: {
          config: {
            getProjectRoot: vi.fn().mockReturnValue('/test/project'),
          },
        },
      });
    });

    it('shows managed auto-memory root, cursor and topic counts', async () => {
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === getAutoMemoryExtractCursorPath('/test/project')) {
          return JSON.stringify({
            sessionId: 'session-1',
            processedOffset: 3,
            updatedAt: '2026-04-01T00:00:00.000Z',
          });
        }

        for (const topic of AUTO_MEMORY_TYPES) {
          if (filePath === getAutoMemoryTopicPath('/test/project', topic)) {
            return [
              '---',
              `type: ${topic}`,
              `title: ${topic}`,
              'description: topic',
              '---',
              '',
              `# ${topic}`,
              '',
              '- one',
              '- two',
            ].join('\n');
          }
        }

        throw new Error('ENOENT');
      });

      await statusCommand.action?.(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Managed auto-memory root: /test/project/.qwen/memory'),
        }),
        expect.any(Number),
      );
      const text = (mockContext.ui.addItem as Mock).mock.calls[0][0].text;
      expect(text).toContain('Cursor: session=session-1, offset=3');
      expect(text).toContain('- user.md: 2 entries');
    });
  });

  describe('/memory extract-now', () => {
    let extractCommand: SlashCommand;

    beforeEach(() => {
      extractCommand = memoryCommand.subCommands?.find(
        (cmd) => cmd.name === 'extract-now',
      ) as SlashCommand;
      mockScheduleAutoMemoryExtract.mockReset();
      mockContext = createMockCommandContext({
        services: {
          config: {
            getProjectRoot: vi.fn().mockReturnValue('/test/project'),
            getSessionId: vi.fn().mockReturnValue('session-1'),
            getGeminiClient: vi.fn().mockReturnValue({
              getChat: vi.fn().mockReturnValue({
                getHistory: vi.fn().mockReturnValue([
                  { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
                ]),
              }),
            }),
          },
        },
      });
    });

    it('runs extraction and shows the returned system message', async () => {
      mockScheduleAutoMemoryExtract.mockResolvedValue({
        patches: [],
        touchedTopics: ['user'],
        cursor: { updatedAt: '2026-04-01T00:00:00.000Z' },
        systemMessage: 'Managed auto-memory updated: user.md',
      });

      await extractCommand.action?.(mockContext, '');

      expect(mockScheduleAutoMemoryExtract).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Managed auto-memory updated: user.md',
        },
        expect.any(Number),
      );
    });
  });

  describe('/memory add', () => {
    let addCommand: SlashCommand;

    beforeEach(() => {
      addCommand = getSubCommand('add');
      mockContext = createMockCommandContext();
    });

    it('should return an error message if no arguments are provided', () => {
      if (!addCommand.action) throw new Error('Command has no action');

      const result = addCommand.action(mockContext, '  ');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Usage: /memory add [--global|--project] <text to remember>',
      });

      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    });

    it('should return a tool action and add an info message when arguments are provided', () => {
      if (!addCommand.action) throw new Error('Command has no action');

      const fact = 'remember this';
      const result = addCommand.action(mockContext, `  ${fact}  `);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: `Attempting to save to memory : "${fact}"`,
        },
        expect.any(Number),
      );

      expect(result).toEqual({
        type: 'tool',
        toolName: 'save_memory',
        toolArgs: { fact },
      });
    });

    it('should handle --global flag and add scope to tool args', () => {
      if (!addCommand.action) throw new Error('Command has no action');

      const fact = 'remember this globally';
      const result = addCommand.action(mockContext, `--global ${fact}`);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: `Attempting to save to memory (global): "${fact}"`,
        },
        expect.any(Number),
      );

      expect(result).toEqual({
        type: 'tool',
        toolName: 'save_memory',
        toolArgs: { fact, scope: 'global' },
      });
    });

    it('should handle --project flag and add scope to tool args', () => {
      if (!addCommand.action) throw new Error('Command has no action');

      const fact = 'remember this for project';
      const result = addCommand.action(mockContext, `--project ${fact}`);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: `Attempting to save to memory (project): "${fact}"`,
        },
        expect.any(Number),
      );

      expect(result).toEqual({
        type: 'tool',
        toolName: 'save_memory',
        toolArgs: { fact, scope: 'project' },
      });
    });

    it('should return error if flag is provided but no fact follows', () => {
      if (!addCommand.action) throw new Error('Command has no action');

      const result = addCommand.action(mockContext, '--global   ');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Usage: /memory add [--global|--project] <text to remember>',
      });

      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    });
  });

  describe('/memory refresh', () => {
    let refreshCommand: SlashCommand;
    let mockSetUserMemory: Mock;
    let mockSetGeminiMdFileCount: Mock;

    beforeEach(() => {
      refreshCommand = getSubCommand('refresh');
      mockSetUserMemory = vi.fn();
      mockSetGeminiMdFileCount = vi.fn();
      const mockConfig = {
        setUserMemory: mockSetUserMemory,
        setGeminiMdFileCount: mockSetGeminiMdFileCount,
        getWorkingDir: () => '/test/dir',
        getDebugMode: () => false,
        getFileService: () => ({}) as FileDiscoveryService,
        getExtensionContextFilePaths: () => [],
        shouldLoadMemoryFromIncludeDirectories: () => false,
        getWorkspaceContext: () => ({
          getDirectories: () => [],
        }),
        getFileFilteringOptions: () => ({
          ignore: [],
          include: [],
        }),
        getFolderTrust: () => false,
      };

      mockContext = createMockCommandContext({
        services: {
          config: mockConfig,
          settings: {
            merged: {},
          } as LoadedSettings,
        },
      });
      mockLoadServerHierarchicalMemory.mockClear();
    });

    it('should display success message when memory is refreshed with content', async () => {
      if (!refreshCommand.action) throw new Error('Command has no action');

      const refreshResult: LoadServerHierarchicalMemoryResponse = {
        memoryContent: 'new memory content',
        fileCount: 2,
      };
      mockLoadServerHierarchicalMemory.mockResolvedValue(refreshResult);

      await refreshCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Refreshing memory from source files...',
        },
        expect.any(Number),
      );

      expect(loadServerHierarchicalMemory).toHaveBeenCalledOnce();
      expect(mockSetUserMemory).toHaveBeenCalledWith(
        refreshResult.memoryContent,
      );
      expect(mockSetGeminiMdFileCount).toHaveBeenCalledWith(
        refreshResult.fileCount,
      );

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Memory refreshed successfully. Loaded 18 characters from 2 file(s).',
        },
        expect.any(Number),
      );
    });

    it('should display success message when memory is refreshed with no content', async () => {
      if (!refreshCommand.action) throw new Error('Command has no action');

      const refreshResult = { memoryContent: '', fileCount: 0 };
      mockLoadServerHierarchicalMemory.mockResolvedValue(refreshResult);

      await refreshCommand.action(mockContext, '');

      expect(loadServerHierarchicalMemory).toHaveBeenCalledOnce();
      expect(mockSetUserMemory).toHaveBeenCalledWith('');
      expect(mockSetGeminiMdFileCount).toHaveBeenCalledWith(0);

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Memory refreshed successfully. No memory content found.',
        },
        expect.any(Number),
      );
    });

    it('should display an error message if refreshing fails', async () => {
      if (!refreshCommand.action) throw new Error('Command has no action');

      const error = new Error('Failed to read memory files.');
      mockLoadServerHierarchicalMemory.mockRejectedValue(error);

      await refreshCommand.action(mockContext, '');

      expect(loadServerHierarchicalMemory).toHaveBeenCalledOnce();
      expect(mockSetUserMemory).not.toHaveBeenCalled();
      expect(mockSetGeminiMdFileCount).not.toHaveBeenCalled();

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: `Error refreshing memory: ${error.message}`,
        },
        expect.any(Number),
      );

      expect(getErrorMessage).toHaveBeenCalledWith(error);
    });

    it('should not throw if config service is unavailable', async () => {
      if (!refreshCommand.action) throw new Error('Command has no action');

      const nullConfigContext = createMockCommandContext({
        services: { config: null },
      });

      await expect(
        refreshCommand.action(nullConfigContext, ''),
      ).resolves.toBeUndefined();

      expect(nullConfigContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Refreshing memory from source files...',
        },
        expect.any(Number),
      );

      expect(loadServerHierarchicalMemory).not.toHaveBeenCalled();
    });
  });
});
