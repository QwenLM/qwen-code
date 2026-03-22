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
  mockShowSaveDialog,
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
  mockShowSaveDialog: vi.fn(),
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
  window: {
    showSaveDialog: mockShowSaveDialog,
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

    it('defaults to html for bare /export', () => {
      expect(parseExportSlashCommand('/export')).toBe('html');
      expect(parseExportSlashCommand('/export   ')).toBe('html');
    });

    it('returns the requested export format', () => {
      expect(parseExportSlashCommand('/export md')).toBe('md');
      expect(parseExportSlashCommand('/export JSON')).toBe('json');
    });

    it('rejects unsupported export arguments', () => {
      expect(() => parseExportSlashCommand('/export csv')).toThrow(
        'Unsupported /export format',
      );
      expect(() => parseExportSlashCommand('/export md extra')).toThrow(
        'Unsupported /export format',
      );
    });
  });

  describe('exportSessionToFile', () => {
    it('writes the exported session to the user-selected file', async () => {
      mockShowSaveDialog.mockResolvedValue({
        fsPath: '/workspace/custom-export.html',
      });

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
        '/workspace/custom-export.html',
        '<html>export</html>',
        'utf-8',
      );
      expect(result).toEqual({
        cancelled: false,
        filename: 'custom-export.html',
        uri: { fsPath: '/workspace/custom-export.html' },
      });
    });

    it('returns cancelled when the save dialog is dismissed', async () => {
      mockShowSaveDialog.mockResolvedValue(undefined);

      const result = await exportSessionToFile({
        sessionId: 'session-1',
        cwd: '/workspace',
        format: 'md',
      });

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(result).toEqual({ cancelled: true });
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
