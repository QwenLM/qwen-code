/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cloneUsage } from '../../provider/empty-usage.js';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { normalizeMessagesForAPI } from '../../provider/request-converter.js';
import type {
  ModelStreamToolResultContent,
  ModelStreamUserContent,
} from '../../../provider/modelStreamRequest.js';
import {
  createToolResultMessage,
  createUserMessage,
  modelInputToTranscriptBlock,
} from '../conversions.js';
import type {
  Message,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ProgressMessage,
  AttachmentMessage,
  ToolUseSummaryMessage,
  TombstoneMessage,
} from '../message.js';

// ---------------------------------------------------------------------------
// Helpers — construct Message objects for tests
// ---------------------------------------------------------------------------

function makeUser(content: ModelStreamUserContent): UserMessage {
  return createUserMessage(
    typeof content === 'string'
      ? content
      : content.map(modelInputToTranscriptBlock),
  );
}

function makeAssistant(
  content: AssistantMessage['message']['content'],
  overrides?: Partial<AssistantMessage['message']>,
): AssistantMessage {
  return {
    type: 'assistant' as const,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      model: 'test-model',
      stop_reason: 'end_turn',

      usage: {
        ...cloneUsage(),
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,

      ...overrides,
    },
  };
}

function makeSystem(
  subtype: SystemMessage['subtype'],
  content = 'system content',
  level: SystemMessage['level'] = 'info',
): SystemMessage {
  return {
    type: 'system' as const,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    subtype,
    content,
    level,
  };
}

function makeProgress(): ProgressMessage {
  return {
    type: 'progress' as const,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    data: { percent: 50 },
  };
}

function makeAttachment(): AttachmentMessage {
  return {
    type: 'attachment' as const,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: { type: 'hook_success' as const },
  };
}

function makeToolUseSummary(): ToolUseSummaryMessage {
  return {
    type: 'tool_use_summary' as const,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    summary: { description: 'ran 3 tools' },
    precedingToolUseIds: ['tu_1', 'tu_2', 'tu_3'],
  };
}

function makeTombstone(): TombstoneMessage {
  return {
    type: 'tombstone' as const,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { partial: true },
  };
}

function makeToolResultUser(
  toolUseId: string,
  content: ModelStreamToolResultContent,
  isError = false,
): UserMessage {
  return createToolResultMessage(
    [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      },
    ],
    randomUUID(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizeMessagesForAPI', () => {
  // =========================================================================
  // Step 1: Filter + Convert
  // =========================================================================
  describe('Step 1: filter + convert', () => {
    it('用户字符串转换为标准文本块', () => {
      const result = normalizeMessagesForAPI([makeUser('Hello')]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      });
    });

    it('混合历史中的用户文本和工具结果分别生成标准消息', () => {
      const message = makeToolResultUser('tu_1', 'result');
      if (typeof message.message.content === 'string') {
        throw new Error('工具结果 factory 必须返回结构化内容');
      }
      message.message.content = [
        { type: 'text', text: 'Hi' },
        ...message.message.content,
      ];
      expect(normalizeMessagesForAPI([message])).toEqual([
        {
          role: 'tool',
          toolCallId: 'tu_1',
          content: [{ type: 'text', text: 'result' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      ]);
    });

    it('assistant messages pass through', () => {
      const result = normalizeMessagesForAPI([
        makeAssistant([{ type: 'text' as const, text: 'Reply' }]),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('assistant');
      expect(result[0].content).toEqual([{ type: 'text', text: 'Reply' }]);
    });

    it('synthetic content-filter API errors never reach the model', () => {
      const syntheticError = makeAssistant(
        [{ type: 'text', text: 'Dynamic 406 message' }],
        {
          model: '<synthetic>',
          stop_reason: null,
        },
      );
      syntheticError.isApiErrorMessage = true;
      syntheticError.isContentFilteredMessage = true;

      expect(normalizeMessagesForAPI([syntheticError])).toEqual([]);
    });

    it('virtual user and assistant messages are filtered out', () => {
      const virtualUser = makeUser('hidden user');
      virtualUser.isVirtual = true;
      const virtualAssistant = makeAssistant([
        { type: 'text' as const, text: 'hidden assistant' },
      ]);
      virtualAssistant.isVirtual = true;

      const result = normalizeMessagesForAPI([virtualUser, virtualAssistant]);
      expect(result).toEqual([]);
    });

    it('system(local_command) no longer converted — now stored as user type', () => {
      // local_command messages are now created with type: "user" at the source
      // (via createUserMessage/createSyntheticUserCaveatMessage). Any remaining
      // system/local_command entries in old transcripts are simply dropped.
      const result = normalizeMessagesForAPI([
        makeSystem('local_command', 'Command output here'),
      ]);
      expect(result).toHaveLength(0);
    });

    it('system(local_command_output) no longer converted — now stored as user type', () => {
      const result = normalizeMessagesForAPI([
        makeSystem('local_command_output', 'Entered Vim mode.'),
      ]);
      expect(result).toHaveLength(0);
    });

    it('local_command stored as user messages are passed through and merged', () => {
      const result = normalizeMessagesForAPI([
        makeUser('/vim'),
        makeUser('Entered Vim mode.'),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      const content = result[0].content;
      expect(content).toHaveLength(2);
      // NOTE: the merge pipeline appends \n to non-last text blocks — pre-existing behavior
      expect(content[0]).toEqual({ type: 'text', text: '/vim\n' });
      expect(content[1]).toEqual({ type: 'text', text: 'Entered Vim mode.' });
    });

    it('system(informational) filtered out', () => {
      const result = normalizeMessagesForAPI([makeSystem('informational')]);
      expect(result).toHaveLength(0);
    });

    it('system(api_error) filtered out', () => {
      const result = normalizeMessagesForAPI([makeSystem('api_error')]);
      expect(result).toHaveLength(0);
    });

    it('progress messages filtered out', () => {
      const result = normalizeMessagesForAPI([makeProgress()]);
      expect(result).toHaveLength(0);
    });

    it('attachment messages filtered out', () => {
      const result = normalizeMessagesForAPI([makeAttachment()]);
      expect(result).toHaveLength(0);
    });

    it('moves provider-visible attachments before the current user prompt', () => {
      const attachment: AttachmentMessage = {
        type: 'attachment',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        attachment: {
          type: 'skill_listing',
          content: '- inspect: Inspect a repository',
          names: ['inspect'],
          skillCount: 1,
          isInitial: true,
        },
      };

      const result = normalizeMessagesForAPI([
        makeUser('original request'),
        attachment,
        makeAssistant([{ type: 'text', text: 'done' }]),
      ]);

      expect(result[0]?.role).toBe('user');
      expect(result[0]?.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('inspect: Inspect a repository'),
      });
      expect(result[0]?.content[1]).toEqual({
        type: 'text',
        text: 'original request',
      });
    });

    it('tool_use_summary messages filtered out', () => {
      const result = normalizeMessagesForAPI([makeToolUseSummary()]);
      expect(result).toHaveLength(0);
    });

    it('tombstone messages filtered out', () => {
      const result = normalizeMessagesForAPI([makeTombstone()]);
      expect(result).toHaveLength(0);
    });
  });

  // =========================================================================
  // Step 2: Merge Adjacent Users
  // =========================================================================
  describe('Step 2: merge adjacent users', () => {
    it('consecutive user messages are merged', () => {
      const result = normalizeMessagesForAPI([
        makeUser('First'),
        makeUser('Second'),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toEqual([
        { type: 'text', text: 'First\n' },
        { type: 'text', text: 'Second' },
      ]);
    });

    it('标准工具结果排在合并后的用户消息之前', () => {
      const textUser = makeUser('Hello');
      const toolResultUser = makeToolResultUser('tu_123', 'result');
      expect(normalizeMessagesForAPI([textUser, toolResultUser])).toEqual([
        {
          role: 'tool',
          toolCallId: 'tu_123',
          content: [{ type: 'text', text: 'result' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]);
    });

    it('adjacent assistant fragments are merged', () => {
      const sharedId = randomUUID();
      const first = makeAssistant([{ type: 'text' as const, text: 'Part 1' }], {
        id: sharedId,
      });
      const second = makeAssistant(
        [{ type: 'text' as const, text: 'Part 2' }],
        { id: sharedId },
      );

      const result = normalizeMessagesForAPI([first, second]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      });
    });

    it('non-consecutive users not merged', () => {
      const result = normalizeMessagesForAPI([
        makeUser('First'),
        makeAssistant([{ type: 'text' as const, text: 'Middle' }]),
        makeUser('Second'),
      ]);
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
      expect(result[2].role).toBe('user');
    });

    it('user + local_command user messages merged as adjacent users', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Before'),
        makeUser('ls output'),
      ]);
      expect(result).toHaveLength(1);
      // NOTE: the merge pipeline appends \n to non-last text blocks — pre-existing behavior
      expect(result[0].content).toEqual([
        { type: 'text', text: 'Before\n' },
        { type: 'text', text: 'ls output' },
      ]);
    });
  });

  // =========================================================================
  // Step 3: Sanitize Thinking Blocks
  // =========================================================================
  describe('Step 3: sanitize thinking blocks', () => {
    it('all-thinking assistant messages removed', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          {
            type: 'thinking' as const,
            thinking: 'some thought',
            signature: 'sig',
          },
          { type: 'redacted_thinking' as const, data: 'redacted' },
        ]),
        makeAssistant([{ type: 'text' as const, text: 'Visible' }]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
      expect(result[1].content).toEqual([{ type: 'text', text: 'Visible' }]);
    });

    it('mixed content assistants preserved', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          { type: 'thinking' as const, thinking: 'thought', signature: 'sig' },
          { type: 'text' as const, text: 'Answer' },
        ]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1].content).toHaveLength(2);
      expect(result[1].content[0]).toMatchObject({ type: 'thinking' });
      expect(result[1].content[1]).toMatchObject({
        type: 'text',
        text: 'Answer',
      });
    });

    it('trailing thinking stripped from last assistant', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          { type: 'text' as const, text: 'Answer' },
          {
            type: 'thinking' as const,
            thinking: 'trailing thought',
            signature: 'sig',
          },
        ]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1].content).toEqual([{ type: 'text', text: 'Answer' }]);
    });

    it('trailing redacted_thinking stripped from last assistant', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          { type: 'text' as const, text: 'Answer' },
          { type: 'redacted_thinking' as const, data: 'redacted' },
        ]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1].content).toEqual([{ type: 'text', text: 'Answer' }]);
    });

    it('all-thinking last assistant is removed', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          {
            type: 'thinking' as const,
            thinking: 'only thought',
            signature: 'sig',
          },
        ]),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
    });

    it('multiple trailing thinking blocks stripped from last assistant', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          { type: 'text' as const, text: 'Answer' },
          {
            type: 'thinking' as const,
            thinking: 'thought 1',
            signature: 'sig1',
          },
          { type: 'redacted_thinking' as const, data: 'redacted' },
        ]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1].content).toEqual([{ type: 'text', text: 'Answer' }]);
    });

    it('all-thinking assistant is removed before placeholder handling', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          { type: 'thinking' as const, thinking: 'thought', signature: 'sig' },
          { type: 'redacted_thinking' as const, data: 'redacted' },
        ]),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
    });

    it('non-last assistant with trailing thinking is not stripped', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          { type: 'text' as const, text: 'First reply' },
          { type: 'thinking' as const, thinking: 'thought', signature: 'sig' },
        ]),
        makeUser('Follow up'),
        makeAssistant([{ type: 'text' as const, text: 'Second reply' }]),
      ]);
      expect(result).toHaveLength(4);
      expect(result[1].content).toHaveLength(2);
      expect(result[1].content[1]).toMatchObject({ type: 'thinking' });
    });

    it('empty content assistant survives thinking sanitization', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([]),
        makeUser('Follow up'),
        makeAssistant([{ type: 'text' as const, text: 'Reply' }]),
      ]);
      expect(result).toHaveLength(4);
    });
  });

  // =========================================================================
  // Step 4: Ensure Non-Empty Assistant Content
  // =========================================================================
  describe('Step 4: ensure non-empty assistant content', () => {
    it('empty assistant content gets placeholder', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([]),
        makeUser('Follow up'),
        makeAssistant([{ type: 'text' as const, text: 'Reply' }]),
      ]);
      expect(result).toHaveLength(4);
      expect(result[1].content).toEqual([
        { type: 'text', text: '[No message content]' },
      ]);
    });

    it('last assistant skipped (prefill)', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1].content).toEqual([]);
    });

    it('non-empty assistant content unchanged', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([{ type: 'text' as const, text: 'Reply' }]),
        makeUser('Follow up'),
        makeAssistant([{ type: 'text' as const, text: 'Reply 2' }]),
      ]);
      expect(result[1].content).toEqual([{ type: 'text', text: 'Reply' }]);
    });
  });

  // =========================================================================
  // Step 5: Sanitize Error Tool Results
  // =========================================================================
  describe('Step 5: sanitize error tool_results', () => {
    it('error tool_result with image content strips to text only', () => {
      const message = makeToolResultUser(
        'tu_err',
        [
          { type: 'text', text: 'Error occurred' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
          },
        ],
        true,
      );
      expect(normalizeMessagesForAPI([message])).toEqual([
        {
          role: 'tool',
          toolCallId: 'tu_err',
          isError: true,
          content: [{ type: 'text', text: 'Error occurred' }],
        },
      ]);
    });

    it('non-error tool_result with image content preserved', () => {
      const content: ModelStreamToolResultContent = [
        { type: 'text', text: 'Success' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
        },
      ];
      expect(
        normalizeMessagesForAPI([makeToolResultUser('tu_ok', content)]),
      ).toEqual([{ role: 'tool', toolCallId: 'tu_ok', content }]);
    });

    it('error tool_result with text-only content preserved as-is', () => {
      const content: ModelStreamToolResultContent = [
        { type: 'text', text: 'Only text error' },
      ];
      expect(
        normalizeMessagesForAPI([makeToolResultUser('tu_err2', content, true)]),
      ).toEqual([
        { role: 'tool', toolCallId: 'tu_err2', isError: true, content },
      ]);
    });

    it('error tool_result with string content preserved as-is', () => {
      const result = normalizeMessagesForAPI([
        makeToolResultUser('tu_str', 'string error content', true),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'tool',
        toolCallId: 'tu_str',
        isError: true,
        content: [{ type: 'text', text: 'string error content' }],
      });
    });

    it('error tool_result with only image content results in empty text array', () => {
      const message = makeToolResultUser(
        'tu_img',
        [
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
          },
        ],
        true,
      );
      expect(normalizeMessagesForAPI([message])).toEqual([
        { role: 'tool', toolCallId: 'tu_img', isError: true, content: [] },
      ]);
    });

    it('non-tool_result user content blocks pass through unchanged', () => {
      const result = normalizeMessagesForAPI([makeUser('Plain text')]);
      expect(result).toHaveLength(1);
      expect(result[0].content).toEqual([{ type: 'text', text: 'Plain text' }]);
    });

    it('assistant messages skip error tool_result sanitization', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([
          {
            type: 'tool_use' as const,
            id: 'tu_123',
            name: 'bash',
            input: { command: 'ls' },
          },
        ]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe('assistant');
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe('Edge cases', () => {
    it('empty array returns empty array', () => {
      const result = normalizeMessagesForAPI([]);
      expect(result).toEqual([]);
    });

    it('single user message', () => {
      const result = normalizeMessagesForAPI([makeUser('Solo')]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'Solo' }],
      });
    });

    it('single assistant message', () => {
      const result = normalizeMessagesForAPI([
        makeAssistant([{ type: 'text' as const, text: 'Solo assistant' }]),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('assistant');
    });

    it('all messages filtered results in empty array', () => {
      const messages: Message[] = [
        makeProgress(),
        makeAttachment(),
        makeToolUseSummary(),
        makeTombstone(),
        makeSystem('informational'),
        makeSystem('api_error'),
      ];
      const result = normalizeMessagesForAPI(messages);
      expect(result).toEqual([]);
    });

    it('mixed message types with filtering, merging, and sanitization', () => {
      const messages: Message[] = [
        makeUser('Hello'),
        makeProgress(), // filtered
        makeUser('ls output'), // local_command now stored as user type, merged with prev
        makeAssistant([
          { type: 'thinking' as const, thinking: 'thought', signature: 'sig' },
          { type: 'text' as const, text: 'Reply' },
        ]),
        makeAttachment(), // filtered
        makeUser('Follow up'),
        makeAssistant([
          { type: 'text' as const, text: 'Final' },
          {
            type: 'thinking' as const,
            thinking: 'trailing',
            signature: 'sig2',
          },
        ]),
      ];

      const result = normalizeMessagesForAPI(messages);

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe('user');
      // NOTE: the merge pipeline appends \n to non-last text blocks — pre-existing behavior
      expect(result[0].content).toEqual([
        { type: 'text', text: 'Hello\n' },
        { type: 'text', text: 'ls output' },
      ]);
      expect(result[1].role).toBe('assistant');
      expect(result[2].role).toBe('user');
      expect(result[3].role).toBe('assistant');
      expect(result[3].content).toEqual([{ type: 'text', text: 'Final' }]);
    });

    it('three consecutive user messages merged into one', () => {
      const result = normalizeMessagesForAPI([
        makeUser('One'),
        makeUser('Two'),
        makeUser('Three'),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].content).toEqual([
        { type: 'text', text: 'One\n' },
        { type: 'text', text: 'Two\n' },
        { type: 'text', text: 'Three' },
      ]);
    });

    it('tool_result hoisted in multi-user merge', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Text first'),
        makeToolResultUser('tu_1', 'result 1'),
        makeUser('Text second'),
        makeToolResultUser('tu_2', 'result 2'),
      ]);

      expect(result).toEqual([
        {
          role: 'tool',
          toolCallId: 'tu_1',
          content: [{ type: 'text', text: 'result 1' }],
        },
        {
          role: 'tool',
          toolCallId: 'tu_2',
          content: [{ type: 'text', text: 'result 2' }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Text first\n' },
            { type: 'text', text: 'Text second' },
          ],
        },
      ]);
    });

    it('last user message does not trigger assistant sanitization', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Hello'),
        makeAssistant([{ type: 'text' as const, text: 'Reply' }]),
        makeUser('Last'),
      ]);
      expect(result).toHaveLength(3);
      expect(result[2].role).toBe('user');
    });

    it('assistant with tool_use content passes through', () => {
      const result = normalizeMessagesForAPI([
        makeUser('Do something'),
        makeAssistant([
          {
            type: 'tool_use' as const,
            id: 'tu_123',
            name: 'bash',
            input: { command: 'ls' },
          },
        ]),
      ]);
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({
        role: 'assistant',
        content: [],
        toolCalls: [
          { id: 'tu_123', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      });
    });

    it('all system message subtypes are filtered (local_command now stored as user type)', () => {
      const subtypes: Array<SystemMessage['subtype']> = [
        'api_error',
        'api_retry',
        'compact_boundary',
        'error',
        'error_during_execution',
        'error_max_turns',
        'hook_started',
        'hook_progress',
        'hook_response',
        'informational',
        'init',
        'interrupt',
        'local_command',
        'local_command_output',
        'memory_saved',
        'model_queue_status',
        'permission_denied',
        'permission_retry',
        'session_state_changed',
        'status',
        'success',
        'turn_duration',
      ];

      for (const subtype of subtypes) {
        const result = normalizeMessagesForAPI([makeSystem(subtype)]);
        expect(result).toHaveLength(0);
      }
    });
  });
});
