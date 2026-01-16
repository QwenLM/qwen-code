/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractTextFromContent,
  transformToMarkdown,
  loadHtmlTemplate,
  prepareExportData,
  injectDataIntoHtmlTemplate,
  generateExportFilename,
} from './exportUtils.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import type { Part, Content } from '@google/genai';

describe('exportUtils', () => {
  describe('extractTextFromContent', () => {
    it('should return empty string for undefined content', () => {
      expect(extractTextFromContent(undefined)).toBe('');
    });

    it('should return empty string for content without parts', () => {
      expect(extractTextFromContent({} as Content)).toBe('');
    });

    it('should extract text from text parts', () => {
      const content: Content = {
        parts: [{ text: 'Hello' }, { text: 'World' }] as Part[],
      };
      expect(extractTextFromContent(content)).toBe('Hello\nWorld');
    });

    it('should format function call parts', () => {
      const content: Content = {
        parts: [
          {
            functionCall: {
              name: 'testFunction',
              args: { param1: 'value1' },
            },
          },
        ] as Part[],
      };
      const result = extractTextFromContent(content);
      expect(result).toContain('[Function Call: testFunction]');
      expect(result).toContain('"param1": "value1"');
    });

    it('should format function response parts', () => {
      const content: Content = {
        parts: [
          {
            functionResponse: {
              name: 'testFunction',
              response: { result: 'success' },
            },
          },
        ] as Part[],
      };
      const result = extractTextFromContent(content);
      expect(result).toContain('[Function Response: testFunction]');
      expect(result).toContain('"result": "success"');
    });

    it('should handle mixed part types', () => {
      const content: Content = {
        parts: [
          { text: 'Start' },
          {
            functionCall: {
              name: 'call',
              args: {},
            },
          },
          { text: 'End' },
        ] as Part[],
      };
      const result = extractTextFromContent(content);
      expect(result).toContain('Start');
      expect(result).toContain('[Function Call: call]');
      expect(result).toContain('End');
    });
  });

  describe('transformToMarkdown', () => {
    const mockMessages: ChatRecord[] = [
      {
        uuid: 'uuid-1',
        parentUuid: null,
        sessionId: 'test-session-id',
        timestamp: '2025-01-01T00:00:00Z',
        type: 'user',
        cwd: '/test',
        version: '1.0.0',
        message: {
          parts: [{ text: 'Hello, how are you?' }] as Part[],
        } as Content,
      },
      {
        uuid: 'uuid-2',
        parentUuid: 'uuid-1',
        sessionId: 'test-session-id',
        timestamp: '2025-01-01T00:00:01Z',
        type: 'assistant',
        cwd: '/test',
        version: '1.0.0',
        message: {
          parts: [{ text: 'I am doing well, thank you!' }] as Part[],
        } as Content,
      },
    ];

    it('should transform messages to markdown format', () => {
      const result = transformToMarkdown(
        mockMessages,
        'test-session-id',
        '2025-01-01T00:00:00Z',
      );

      expect(result).toContain('# Chat Session Export');
      expect(result).toContain('**Session ID**: test-session-id');
      expect(result).toContain('**Start Time**: 2025-01-01T00:00:00Z');
      expect(result).toContain('## User');
      expect(result).toContain('Hello, how are you?');
      expect(result).toContain('## Assistant');
      expect(result).toContain('I am doing well, thank you!');
    });

    it('should include exported timestamp', () => {
      const before = new Date().toISOString();
      const result = transformToMarkdown(
        mockMessages,
        'test-session-id',
        '2025-01-01T00:00:00Z',
      );
      const after = new Date().toISOString();

      expect(result).toContain('**Exported**:');
      const exportedMatch = result.match(/\*\*Exported\*\*: (.+)/);
      expect(exportedMatch).toBeTruthy();
      if (exportedMatch) {
        const exportedTime = exportedMatch[1].trim();
        expect(exportedTime >= before).toBe(true);
        expect(exportedTime <= after).toBe(true);
      }
    });

    it('should format tool_result messages', () => {
      const messages: ChatRecord[] = [
        {
          uuid: 'uuid-3',
          parentUuid: 'uuid-2',
          sessionId: 'test-session-id',
          timestamp: '2025-01-01T00:00:02Z',
          type: 'tool_result',
          cwd: '/test',
          version: '1.0.0',
          toolCallResult: {
            resultDisplay: 'Tool output',
          },
          message: {
            parts: [{ text: 'Additional info' }] as Part[],
          } as Content,
        },
      ];

      const result = transformToMarkdown(
        messages,
        'test-session-id',
        '2025-01-01T00:00:00Z',
      );

      expect(result).toContain('## Tool Result');
      expect(result).toContain('```');
      expect(result).toContain('Tool output');
      expect(result).toContain('Additional info');
    });

    it('should format tool_result with JSON resultDisplay', () => {
      const messages: ChatRecord[] = [
        {
          uuid: 'uuid-4',
          parentUuid: 'uuid-3',
          sessionId: 'test-session-id',
          timestamp: '2025-01-01T00:00:03Z',
          type: 'tool_result',
          cwd: '/test',
          version: '1.0.0',
          toolCallResult: {
            resultDisplay: '{"key": "value"}',
          },
          message: {} as Content,
        },
      ];

      const result = transformToMarkdown(
        messages,
        'test-session-id',
        '2025-01-01T00:00:00Z',
      );

      expect(result).toContain('## Tool Result');
      expect(result).toContain('```');
      expect(result).toContain('"key": "value"');
    });

    it('should handle chat compression system messages', () => {
      const messages: ChatRecord[] = [
        {
          uuid: 'uuid-5',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2025-01-01T00:00:04Z',
          type: 'system',
          subtype: 'chat_compression',
          cwd: '/test',
          version: '1.0.0',
          message: {} as Content,
        },
      ];

      const result = transformToMarkdown(
        messages,
        'test-session-id',
        '2025-01-01T00:00:00Z',
      );

      expect(result).toContain('_[Chat history compressed]_');
    });

    it('should skip system messages without subtype', () => {
      const messages: ChatRecord[] = [
        {
          uuid: 'uuid-6',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2025-01-01T00:00:05Z',
          type: 'system',
          cwd: '/test',
          version: '1.0.0',
          message: {} as Content,
        },
      ];

      const result = transformToMarkdown(
        messages,
        'test-session-id',
        '2025-01-01T00:00:00Z',
      );

      expect(result).not.toContain('## System');
    });
  });

  describe('loadHtmlTemplate', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should load HTML template from URL', async () => {
      const mockTemplate = '<html><body>Test Template</body></html>';
      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue(mockTemplate),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

      const result = await loadHtmlTemplate();

      expect(result).toBe(mockTemplate);
      expect(fetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/QwenLM/qwen-code/main/template_portable.html',
      );
    });

    it('should throw error when fetch fails', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

      await expect(loadHtmlTemplate()).rejects.toThrow(
        'Failed to fetch HTML template: 404 Not Found',
      );
    });

    it('should throw error when network request fails', async () => {
      const networkError = new Error('Network error');
      vi.mocked(fetch).mockRejectedValue(networkError);

      await expect(loadHtmlTemplate()).rejects.toThrow(
        'Failed to load HTML template',
      );
      await expect(loadHtmlTemplate()).rejects.toThrow('Network error');
    });
  });

  describe('prepareExportData', () => {
    it('should prepare export data from conversation', () => {
      const conversation = {
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
      };

      const result = prepareExportData(conversation);

      expect(result).toEqual({
        sessionId: 'test-session-id',
        startTime: '2025-01-01T00:00:00Z',
        messages: conversation.messages,
      });
    });
  });

  describe('injectDataIntoHtmlTemplate', () => {
    it('should inject JSON data into HTML template', () => {
      const template = `
        <html>
          <body>
            <script id="chat-data" type="application/json">
              // DATA_PLACEHOLDER: Your JSONL data will be injected here
            </script>
          </body>
        </html>
      `;

      const data = {
        sessionId: 'test-session-id',
        startTime: '2025-01-01T00:00:00Z',
        messages: [] as ChatRecord[],
      };

      const result = injectDataIntoHtmlTemplate(template, data);

      expect(result).toContain(
        '<script id="chat-data" type="application/json">',
      );
      expect(result).toContain('"sessionId": "test-session-id"');
      expect(result).toContain('"startTime": "2025-01-01T00:00:00Z"');
      expect(result).not.toContain('DATA_PLACEHOLDER');
    });

    it('should handle template with whitespace around placeholder', () => {
      const template = `<script id="chat-data" type="application/json">\n// DATA_PLACEHOLDER: Your JSONL data will be injected here\n</script>`;

      const data = {
        sessionId: 'test',
        startTime: '2025-01-01T00:00:00Z',
        messages: [] as ChatRecord[],
      };

      const result = injectDataIntoHtmlTemplate(template, data);

      expect(result).toContain('"sessionId": "test"');
      expect(result).not.toContain('DATA_PLACEHOLDER');
    });
  });

  describe('generateExportFilename', () => {
    it('should generate filename with timestamp and extension', () => {
      const filename = generateExportFilename('md');

      expect(filename).toMatch(
        /^export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/,
      );
    });

    it('should use provided extension', () => {
      const filename1 = generateExportFilename('html');
      const filename2 = generateExportFilename('json');

      expect(filename1).toMatch(/\.html$/);
      expect(filename2).toMatch(/\.json$/);
    });

    it('should replace colons and dots in timestamp', () => {
      const filename = generateExportFilename('md');

      expect(filename).not.toContain(':');
      // The filename should contain a dot only for the extension
      expect(filename.split('.').length).toBe(2);
      // Check that timestamp part (before extension) doesn't contain dots
      const timestampPart = filename.split('.')[0];
      expect(timestampPart).not.toContain('.');
    });
  });
});
