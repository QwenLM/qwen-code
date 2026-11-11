/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { cloneUsage, type Message } from '@qwen-code/core';
import {
  buildDefaultExportFilename,
  normalizeExportFilename,
  renderMessagesToPlainText,
  sanitizeExportFilename,
} from './conversationExport.js';
import { loadMermaidRenderer } from './MermaidBlock.js';
import { createMockSettings } from '../../test-utils/settings.js';

describe('conversationExport', () => {
  describe('renderMessagesToPlainText', () => {
    it('renders user and assistant messages', async () => {
      const messages: Message[] = [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          message: {
            role: 'user',
            content: 'Hello world',
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-21T10:00:01.000Z',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            stop_sequence: null,
            container: null,
            context_management: null,

            model: 'test-model',
            stop_reason: 'end_turn',

            usage: cloneUsage(),
            content: [
              {
                type: 'text',
                text: 'Hi there!',
              },
            ],
          },
        },
      ];

      const result = await renderMessagesToPlainText(
        messages,
        createMockSettings(),
      );
      expect(result.match(/Hello world/g)).toHaveLength(1);
      expect(result.match(/Hi there!/g)).toHaveLength(1);
    });

    it('keeps mermaid source instead of drawing a diagram', async () => {
      const messages: Message[] = [
        {
          type: 'assistant',
          uuid: 'assistant-mermaid',
          timestamp: '2026-04-21T10:00:01.000Z',
          message: {
            id: 'msg_mermaid',
            type: 'message',
            role: 'assistant',
            stop_sequence: null,
            container: null,
            context_management: null,

            model: 'test-model',
            stop_reason: 'end_turn',

            usage: cloneUsage(),
            content: [
              {
                type: 'text',
                text: 'Flow:\n\n```mermaid\ngraph TD\nA[Start]-->B[Done]\n```',
              },
            ],
          },
        },
      ];

      // Load the renderer first so only the export opt-out keeps the source.
      await loadMermaidRenderer();
      const result = await renderMessagesToPlainText(
        messages,
        createMockSettings(),
      );
      expect(result).toContain('A[Start]-->B[Done]');
      expect(result).not.toContain('┌');
    });

    it('filters out isMeta messages', async () => {
      const messages: Message[] = [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          isMeta: true,
          message: {
            role: 'user',
            content: 'This is a meta message that should not appear',
          },
        },
        {
          type: 'user',
          uuid: 'user-2',
          timestamp: '2026-04-21T10:00:01.000Z',
          message: {
            role: 'user',
            content: 'Visible user message',
          },
        },
      ];

      const result = await renderMessagesToPlainText(
        messages,
        createMockSettings(),
      );
      expect(result).not.toContain('meta message');
      expect(result).toContain('Visible user message');
    });

    it('renders tool use messages without raw JSON', async () => {
      const messages: Message[] = [
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-21T10:00:01.000Z',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            stop_sequence: null,
            container: null,
            context_management: null,

            model: 'test-model',
            stop_reason: 'tool_use',

            usage: cloneUsage(),
            content: [
              {
                type: 'text',
                text: 'Let me read that file.',
              },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Read',
                input: {
                  path: 'README.md',
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'user-2',
          timestamp: '2026-04-21T10:00:02.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'README contents here',
                is_error: false,
              },
            ],
          },
        },
      ];

      const result = await renderMessagesToPlainText(
        messages,
        createMockSettings(),
      );
      expect(result).toContain('Let me read that file.');
      // Tool name should appear in some form (the exact format depends on UI rendering)
      expect(result).toContain('Read');
    });

    it('does not render raw XML tags for local commands', async () => {
      const messages: Message[] = [
        {
          type: 'system',
          uuid: 'system-0',
          timestamp: '2026-04-21T10:00:01.500Z',
          subtype: 'local_command',
          content:
            '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fast</command-args>',
          level: 'info',
        },
      ];

      const result = await renderMessagesToPlainText(
        messages,
        createMockSettings(),
      );
      // XML tags should NOT appear in output
      expect(result).not.toContain('<command-name>');
      expect(result).not.toContain('<command-message>');
      expect(result).not.toContain('<command-args>');
    });

    it('does not render raw XML for local command output', async () => {
      const messages: Message[] = [
        {
          type: 'system',
          uuid: 'system-1',
          timestamp: '2026-04-21T10:00:03.000Z',
          subtype: 'local_command_output',
          content:
            '<local-command-stdout>Conversation exported to: /tmp/output.txt</local-command-stdout>',
          level: 'info',
        },
      ];

      const result = await renderMessagesToPlainText(
        messages,
        createMockSettings(),
      );
      expect(result).not.toContain('<local-command-stdout>');
      expect(result).not.toContain('</local-command-stdout>');
    });

    it.each(['off', 'full'] as const)(
      'uses supplied thinking settings across chunks (%s)',
      async (inlineThinkingMode) => {
        const messages: Message[] = Array.from(
          { length: 45 },
          (_, index): Message => ({
            type: 'assistant',
            uuid: `assistant-${index}`,
            timestamp: '2026-04-21T10:00:01.000Z',
            message: {
              id: `msg_${index}`,
              type: 'message',
              role: 'assistant',
              stop_sequence: null,
              container: null,
              context_management: null,
              usage: cloneUsage(),
              model: 'test-model',
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'thinking',
                  thinking: `Thought [${index}]`,
                  signature: '',
                },
                { type: 'text', text: `Answer [${index}]` },
              ],
            },
          }),
        );
        const settings = createMockSettings({ ui: { inlineThinkingMode } });

        const result = await renderMessagesToPlainText(messages, settings);

        for (let index = 0; index < messages.length; index++) {
          expect(result.split(`Answer [${index}]`)).toHaveLength(2);
          if (inlineThinkingMode === 'off') {
            expect(result).not.toContain(`Thought [${index}]`);
          } else {
            expect(result.split(`Thought [${index}]`)).toHaveLength(2);
          }
        }
      },
    );

    it('returns an empty string when no messages are provided', async () => {
      const result = await renderMessagesToPlainText([], createMockSettings());
      expect(result).toBe('');
    });
  });

  describe('filename utilities', () => {
    it('builds a default filename from the first meaningful user prompt', () => {
      const messages: Message[] = [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          message: {
            role: 'user',
            content: '/help',
          },
        },
        {
          type: 'user',
          uuid: 'user-2',
          timestamp: '2026-04-21T10:00:01.000Z',
          message: {
            role: 'user',
            content: 'Generate release notes for Qwen CLI',
          },
        },
      ];

      expect(
        buildDefaultExportFilename(messages, new Date(2026, 3, 21, 10, 0, 2)),
      ).toBe('2026-04-21-100002-generate-release-notes-for-qwen-cli.txt');
    });

    it('caps the generated default filename length', () => {
      const longPrompt = 'a'.repeat(400);
      const messages: Message[] = [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          message: {
            role: 'user',
            content: longPrompt,
          },
        },
      ];

      const filename = buildDefaultExportFilename(
        messages,
        new Date(2026, 3, 21, 10, 0, 2),
      );

      expect(filename.endsWith('.txt')).toBe(true);
      expect(filename.length).toBeLessThanOrEqual(255);
    });

    it('normalizes filenames to .txt', () => {
      expect(normalizeExportFilename('conversation')).toBe('conversation.txt');
      expect(normalizeExportFilename('conversation.md')).toBe(
        'conversation.txt',
      );
    });

    it('sanitizes filenames to ascii slugs', () => {
      expect(sanitizeExportFilename('Release Notes: Qwen CLI!')).toBe(
        'release-notes-qwen-cli',
      );
    });
  });
});
