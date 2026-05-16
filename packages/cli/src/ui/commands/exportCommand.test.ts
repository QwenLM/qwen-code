/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { exportCommand } from './exportCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import type { Part, Content } from '@google/genai';
import {
  collectSessionData,
  normalizeSessionData,
  toMarkdown,
  toHtml,
  toJson,
  toJsonl,
  generateExportFilename,
} from '../utils/export/index.js';

const mockSessionServiceMocks = vi.hoisted(() => ({
  loadSession: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', () => {
  class SessionService {
    constructor(_cwd: string) {}
    async loadSession(_sessionId: string) {
      return mockSessionServiceMocks.loadSession();
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
  toJson: vi.fn(),
  toJsonl: vi.fn(),
  generateExportFilename: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  realpath: vi.fn(),
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

    mockSessionServiceMocks.loadSession.mockResolvedValue(mockSessionData);

    mockContext = createMockCommandContext({
      services: {
        config: {
          getWorkingDir: vi.fn().mockReturnValue('/test/dir'),
          getProjectRoot: vi.fn().mockReturnValue('/test/project'),
          getSessionId: vi.fn().mockReturnValue('test-session-id'),
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
    vi.mocked(toJson).mockReturnValue('{"messages":[]}');
    vi.mocked(toJsonl).mockReturnValue('{"type":"session_metadata"}');
    vi.mocked(generateExportFilename).mockImplementation(
      (ext: string) => `export-2025-01-01T00-00-00-000Z.${ext}`,
    );
    vi.mocked(fs.realpath).mockImplementation(async (p) => p.toString());
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

      expect(mockSessionServiceMocks.loadSession).toHaveBeenCalled();
      expect(collectSessionData).toHaveBeenCalledWith(
        mockSessionData.conversation,
        expect.anything(),
      );
      expect(normalizeSessionData).toHaveBeenCalled();
      expect(toMarkdown).toHaveBeenCalled();
      expect(generateExportFilename).toHaveBeenCalledWith('md');
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('export-2025-01-01T00-00-00-000Z.md'),
        '# Test Markdown',
        'utf-8',
      );
    });

    it('should export markdown to a relative custom directory', async () => {
      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }

      const result = await mdCommand.action(mockContext, './logs');
      const outputDir = path.resolve('/test/dir', './logs');
      const filepath = path.join(
        outputDir,
        'export-2025-01-01T00-00-00-000Z.md',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(filepath),
      });
      expect(fs.mkdir).toHaveBeenCalledWith(outputDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        filepath,
        '# Test Markdown',
        'utf-8',
      );
    });

    it('should keep cwd-equivalent directory output concise', async () => {
      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }

      const result = await mdCommand.action(mockContext, '.');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'Session exported to markdown: export-2025-01-01T00-00-00-000Z.md',
      });
      expect(fs.mkdir).not.toHaveBeenCalled();
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
      mockSessionServiceMocks.loadSession.mockResolvedValue(undefined);

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
        content: expect.stringContaining('Failed to export session:'),
      });
      if (!result || result.type !== 'message') {
        throw new Error('expected message result');
      }
      expect(result.content).toContain('File write failed');
      expect(result.content).toContain('markdown target:');
    });

    it('should use project root when working dir is not available', async () => {
      const contextWithProjectRoot = createMockCommandContext({
        services: {
          config: {
            getWorkingDir: vi.fn().mockReturnValue(null),
            getProjectRoot: vi.fn().mockReturnValue('/test/project'),
            getSessionId: vi.fn().mockReturnValue('test-session-id'),
          },
        },
      });

      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }
      const result = await mdCommand.action(contextWithProjectRoot, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('export-2025-01-01T00-00-00-000Z.md'),
      });
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${path.sep}test${path.sep}project`),
        '# Test Markdown',
        'utf-8',
      );
    });

    it('should reject output directories outside the working directory', async () => {
      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }

      const result = await mdCommand.action(mockContext, '../outside');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Export directory must be within the project working directory.',
      });
      expect(mockSessionServiceMocks.loadSession).not.toHaveBeenCalled();
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should reject symlinked output directories outside the working directory', async () => {
      const mdCommand = exportCommand.subCommands?.find((c) => c.name === 'md');
      if (!mdCommand?.action) {
        throw new Error('md command not found');
      }

      const outputDir = path.resolve('/test/dir', './logs');
      vi.mocked(fs.realpath).mockImplementation(async (p) =>
        p.toString() === outputDir
          ? path.resolve('/outside/logs')
          : p.toString(),
      );

      const result = await mdCommand.action(mockContext, './logs');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Export directory must be within the project working directory.',
      });
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
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

      expect(mockSessionServiceMocks.loadSession).toHaveBeenCalled();
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

    it('should export default HTML to a relative custom directory', async () => {
      if (!exportCommand.action) {
        throw new Error('export command action not found');
      }

      const result = await exportCommand.action(mockContext, './logs');
      const outputDir = path.resolve('/test/dir', './logs');
      const filepath = path.join(
        outputDir,
        'export-2025-01-01T00-00-00-000Z.html',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(filepath),
      });
      expect(fs.mkdir).toHaveBeenCalledWith(outputDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        filepath,
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
      mockSessionServiceMocks.loadSession.mockResolvedValue(undefined);

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
        content: expect.stringContaining('Failed to export session:'),
      });
      if (!result || result.type !== 'message') {
        throw new Error('expected message result');
      }
      expect(result.content).toContain('Failed to generate HTML');
      expect(result.content).toContain('HTML target:');
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
        content: expect.stringContaining('Failed to export session:'),
      });
      if (!result || result.type !== 'message') {
        throw new Error('expected message result');
      }
      expect(result.content).toContain('File write failed');
      expect(result.content).toContain('HTML target:');
    });
  });

  describe('exportJsonAction', () => {
    it('should export session to JSON file', async () => {
      const jsonCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'json',
      );
      if (!jsonCommand?.action) {
        throw new Error('json command not found');
      }

      const result = await jsonCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          'export-2025-01-01T00-00-00-000Z.json',
        ),
      });

      expect(mockSessionServiceMocks.loadSession).toHaveBeenCalled();
      expect(collectSessionData).toHaveBeenCalledWith(
        mockSessionData.conversation,
        expect.anything(),
      );
      expect(normalizeSessionData).toHaveBeenCalled();
      expect(toJson).toHaveBeenCalled();
      expect(generateExportFilename).toHaveBeenCalledWith('json');
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('export-2025-01-01T00-00-00-000Z.json'),
        '{"messages":[]}',
        'utf-8',
      );
    });

    it('should export JSON to a relative custom directory', async () => {
      const jsonCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'json',
      );
      if (!jsonCommand?.action) {
        throw new Error('json command not found');
      }

      const result = await jsonCommand.action(mockContext, './logs');
      const outputDir = path.resolve('/test/dir', './logs');
      const filepath = path.join(
        outputDir,
        'export-2025-01-01T00-00-00-000Z.json',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(filepath),
      });
      expect(fs.mkdir).toHaveBeenCalledWith(outputDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        filepath,
        '{"messages":[]}',
        'utf-8',
      );
    });
  });

  describe('exportJsonlAction', () => {
    it('should export session to JSONL file', async () => {
      const jsonlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'jsonl',
      );
      if (!jsonlCommand?.action) {
        throw new Error('jsonl command not found');
      }

      const result = await jsonlCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          'export-2025-01-01T00-00-00-000Z.jsonl',
        ),
      });

      expect(mockSessionServiceMocks.loadSession).toHaveBeenCalled();
      expect(collectSessionData).toHaveBeenCalledWith(
        mockSessionData.conversation,
        expect.anything(),
      );
      expect(normalizeSessionData).toHaveBeenCalled();
      expect(toJsonl).toHaveBeenCalled();
      expect(generateExportFilename).toHaveBeenCalledWith('jsonl');
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('export-2025-01-01T00-00-00-000Z.jsonl'),
        '{"type":"session_metadata"}',
        'utf-8',
      );
    });

    it('should export JSONL to a relative custom directory', async () => {
      const jsonlCommand = exportCommand.subCommands?.find(
        (c) => c.name === 'jsonl',
      );
      if (!jsonlCommand?.action) {
        throw new Error('jsonl command not found');
      }

      const result = await jsonlCommand.action(mockContext, './logs');
      const outputDir = path.resolve('/test/dir', './logs');
      const filepath = path.join(
        outputDir,
        'export-2025-01-01T00-00-00-000Z.jsonl',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(filepath),
      });
      expect(fs.mkdir).toHaveBeenCalledWith(outputDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        filepath,
        '{"type":"session_metadata"}',
        'utf-8',
      );
    });
  });
});
