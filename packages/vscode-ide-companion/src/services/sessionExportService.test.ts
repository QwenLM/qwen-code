/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLoadSession,
  mockCollectSessionData,
  mockNormalizeSessionData,
  mockToHtml,
  mockToMarkdown,
  mockToJson,
  mockToJsonl,
  mockGenerateExportFilename,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockLoadSession: vi.fn(),
  mockCollectSessionData: vi.fn(),
  mockNormalizeSessionData: vi.fn(),
  mockToHtml: vi.fn(),
  mockToMarkdown: vi.fn(),
  mockToJson: vi.fn(),
  mockToJsonl: vi.fn(),
  mockGenerateExportFilename: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', () => {
  class SessionService {
    constructor(_cwd: string) {}

    async loadSession(_sessionId: string) {
      return mockLoadSession();
    }
  }

  return {
    SessionService,
  };
});

vi.mock('../../../cli/src/ui/utils/export/index.js', () => ({
  collectSessionData: mockCollectSessionData,
  normalizeSessionData: mockNormalizeSessionData,
  toHtml: mockToHtml,
  toMarkdown: mockToMarkdown,
  toJson: mockToJson,
  toJsonl: mockToJsonl,
  generateExportFilename: mockGenerateExportFilename,
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mockWriteFile,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
}));

import {
  exportSessionToFile,
  parseExportSlashCommand,
} from './sessionExportService.js';

describe('sessionExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadSession.mockResolvedValue({
      conversation: {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00Z',
        messages: [],
      },
    });
    mockCollectSessionData.mockResolvedValue({
      sessionId: 'session-1',
      startTime: '2025-01-01T00:00:00Z',
      messages: [],
    });
    mockNormalizeSessionData.mockImplementation((data) => data);
    mockToHtml.mockReturnValue('<html>export</html>');
    mockToMarkdown.mockReturnValue('# export');
    mockToJson.mockReturnValue('{"ok":true}');
    mockToJsonl.mockReturnValue('{"ok":true}');
    mockGenerateExportFilename.mockImplementation(
      (format: string) => `qwen-export.${format}`,
    );
  });

  describe('parseExportSlashCommand', () => {
    it('returns null for non-export input', () => {
      expect(parseExportSlashCommand('hello')).toBeNull();
      expect(parseExportSlashCommand('/model')).toBeNull();
    });

    it('requires an explicit subcommand for bare /export', () => {
      expect(() => parseExportSlashCommand('/export')).toThrow(
        "Command '/export' requires a subcommand.",
      );
      expect(() => parseExportSlashCommand('/export   ')).toThrow(
        "Command '/export' requires a subcommand.",
      );
    });

    it('returns the requested export format', () => {
      expect(parseExportSlashCommand('/export html')).toBe('html');
      expect(parseExportSlashCommand('/export md')).toBe('md');
      expect(parseExportSlashCommand('/export JSON')).toBe('json');
    });

    it('rejects unsupported export arguments', () => {
      expect(() => parseExportSlashCommand('/export csv')).toThrow(
        'Unsupported /export format. Use /export html, /export md, /export json, or /export jsonl.',
      );
      expect(() => parseExportSlashCommand('/export md extra')).toThrow(
        'Unsupported /export format. Use /export html, /export md, /export json, or /export jsonl.',
      );
    });
  });

  describe('exportSessionToFile', () => {
    it('writes the exported session to the default CLI export path', async () => {
      const result = await exportSessionToFile({
        sessionId: 'session-1',
        cwd: '/workspace',
        format: 'html',
      });

      expect(mockCollectSessionData).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1' }),
        expect.anything(),
      );
      expect(mockNormalizeSessionData).toHaveBeenCalled();
      expect(mockToHtml).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/workspace/qwen-export.html',
        '<html>export</html>',
        'utf-8',
      );
      expect(result).toEqual({
        filename: 'qwen-export.html',
        uri: { fsPath: '/workspace/qwen-export.html' },
      });
    });

    it('throws when the target session cannot be loaded', async () => {
      mockLoadSession.mockResolvedValue(undefined);

      await expect(
        exportSessionToFile({
          sessionId: 'missing-session',
          cwd: '/workspace',
          format: 'json',
        }),
      ).rejects.toThrow('No active session found to export.');
    });
  });
});
