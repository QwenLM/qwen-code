/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { exportCommand } from './exportCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import type { Part, Content } from '@google/genai';
import {
  collectSessionData,
  normalizeSessionData,
  toMarkdown,
  toHtml,
  generateExportFilename,
} from '../utils/export/index.js';

const mockSessionServiceMocks = vi.hoisted(() => ({
  loadLastSession: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', () => {
  class SessionService {
    constructor(_cwd: string) {}
    async loadLastSession() {
      return mockSessionServiceMocks.loadLastSession();
    }
  }

  return {
    SessionService,
  };
});

vi.mock('../utils/export/index.js', () => ({
  collectSessionData: vi.fn(),
  normalizeSessionData: vi.fn(),
  toMarkdown: vi.fn(),
  toHtml: vi.fn(),
  generateExportFilename: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
}));

describe('exportCommand', () => {
  const mockSessionData = {
    conversation: {
      sessionId: 'test-session-id',
      startTime: '2025-01-01T00:00:00Z',
      messages: [
        {
          type: 'user',
          message: {
            parts: [{ text: 'Hello' }] as Part[],
          } as Content,
        },
      ] as ChatRecord[],
    },
  };

  let mockContext: ReturnType<typeof createMockCommandContext>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionServiceMocks.loadLastSession.mockResolvedValue(mockSessionData);

    mockContext = createMockCommandContext({
      services: {
        config: {
          getWorkingDir: vi.fn().mockReturnValue('/test/dir'),
          getProjectRoot: vi.fn().mockReturnValue('/test/project'),
        },
      },
    });

    vi.mocked(collectSessionData).mockResolvedValue({
      sessionId: 'test-session-id',
      startTime: '2025-01-01T00:00:00Z',
      messages: [],
    });
    vi.mocked(normalizeSessionData).mockImplementation((data) => data);
    vi.mocked(toMarkdown).mockReturnValue('# Test Markdown');
    vi.mocked(toHtml).mockReturnValue(
      '<html><script id="chat-data" type="application/json">{"data": "test"}</script></html>',
    );
    vi.mocked(generateExportFilename).mockImplementation(
      (ext: string) => `export-2025-01-01T00-00-00-000Z.${ext}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('command structure', () => {
    it('should have correct name and description', () => {
      expect(exportCommand.name).toBe('export');
      expect(exportCommand.description).toBe(
        'Export current session message history to a file',
      );
    });

    it('should have html, md, json, and jsonl subcommands', () => {
      expect(exportCommand.subCommands).toHaveLength(4);
      expect(exportCommand.subCommands?.map((c) => c.name)).toEqual([
        'html',
        'md',
        'json',
        'jsonl',
      ]);
    });
  });

  describe('exportMarkdownAction', () => {
    it('should export session to markdown file', async () => {
      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }

      const result = await mdCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('export-2025-01-01T00-00-00-000Z.md'),
      });

      expect(mockSessionServiceMocks.loadLastSession).toHaveBeenCalled();
      expect(collectSessionData).toHaveBeenCalledWith(
        mockSessionData.conversation,
        expect.anything(),
      );
      expect(normalizeSessionData).toHaveBeenCalled();
      expect(toMarkdown).toHaveBeenCalled();
      expect(generateExportFilename).toHaveBeenCalledWith('md');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('export-2025-01-01T00-00-00-000Z.md'),
        '# Test Markdown',
        'utf-8',
      );
    });

    it('should return error when config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }
      const result = await mdCommand.action(contextWithoutConfig, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      });
    });

    it('should return error when working directory cannot be determined', async () => {
      const contextWithoutCwd = createMockCommandContext({
        services: {
          config: {
            getWorkingDir: vi.fn().mockReturnValue(null),
            getProjectRoot: vi.fn().mockReturnValue(null),
          },
        },
      });

      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand || !mdCommand.action) {
        throw new Error('md command not found');
      }
      const result = await mdCommand.action(contextWithoutCwd, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Could not determine current working directory.',
      });
    });

    it('should return error when no session is found', async () => {
      mockSessionServiceMocks.loadLastSession.mockResolvedValue(undefined);

      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }
      const result = await mdCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'No active session found to export.',
      });
    });

    it('should handle errors during export', async () => {
      const error = new Error('File write failed');
      vi.mocked(fs.writeFile).mockRejectedValue(error);

      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }
      const result = await mdCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Failed to export session: File write failed',
      });
    });

    it('should use project root when working dir is not available', async () => {
      const contextWithProjectRoot = createMockCommandContext({
        services: {
          config: {
            getWorkingDir: vi.fn().mockReturnValue(null),
            getProjectRoot: vi.fn().mockReturnValue('/test/project'),
          },
        },
      });

      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }
      await mdCommand.action(contextWithProjectRoot, '');
    });
  });

  describe('exportHtmlAction', () => {
    it('should export session to HTML file', async () => {
      const htmlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'html',
      );
      if (!htmlCommand?.action) {
        throw new Error('html command not found');
      }

      const result = await htmlCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          'export-2025-01-01T00-00-00-000Z.html',
        ),
      });

      expect(mockSessionServiceMocks.loadLastSession).toHaveBeenCalled();
      expect(collectSessionData).toHaveBeenCalledWith(
        mockSessionData.conversation,
        expect.anything(),
      );
      expect(normalizeSessionData).toHaveBeenCalled();
      expect(toHtml).toHaveBeenCalled();
      expect(generateExportFilename).toHaveBeenCalledWith('html');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('export-2025-01-01T00-00-00-000Z.html'),
        expect.stringContaining('{"data": "test"}'),
        'utf-8',
      );
    });

    it('should return error when config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const htmlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'html',
      );
      if (!htmlCommand?.action) {
        throw new Error('html command not found');
      }
      const result = await htmlCommand.action(contextWithoutConfig, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      });
    });

    it('should return error when working directory cannot be determined', async () => {
      const contextWithoutCwd = createMockCommandContext({
        services: {
          config: {
            getWorkingDir: vi.fn().mockReturnValue(null),
            getProjectRoot: vi.fn().mockReturnValue(null),
          },
        },
      });

      const htmlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'html',
      );
      if (!htmlCommand || !htmlCommand.action) {
        throw new Error('html command not found');
      }
      const result = await htmlCommand.action(contextWithoutCwd, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Could not determine current working directory.',
      });
    });

    it('should return error when no session is found', async () => {
      mockSessionServiceMocks.loadLastSession.mockResolvedValue(undefined);

      const htmlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'html',
      );
      if (!htmlCommand?.action) {
        throw new Error('html command not found');
      }
      const result = await htmlCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'No active session found to export.',
      });
    });

    it('should handle errors during HTML generation', async () => {
      const error = new Error('Failed to generate HTML');
      vi.mocked(toHtml).mockImplementation(() => {
        throw error;
      });

      const htmlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'html',
      );
      if (!htmlCommand?.action) {
        throw new Error('html command not found');
      }
      const result = await htmlCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Failed to export session: Failed to generate HTML',
      });
    });

    it('should handle errors during file write', async () => {
      const error = new Error('File write failed');
      vi.mocked(fs.writeFile).mockRejectedValue(error);

      const htmlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'html',
      );
      if (!htmlCommand?.action) {
        throw new Error('html command not found');
      }
      const result = await htmlCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Failed to export session: File write failed',
      });
    });
  });
});
