/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ModelStreamTextBlock } from '../../../provider/modelStreamRequest.js';
import type {
  ToolResultBlockParam,
  ContentBlockParam,
  MessageBase,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ProgressMessage,
  AttachmentMessage,
  ToolUseSummaryMessage,
  TombstoneMessage,
  Message,
  MessageType,
  SystemSubtype,
  AttachmentType,
} from '../message.js';
import type { NonNullableUsage } from '../../schemas/common.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = () => randomUUID();
const now = () => new Date().toISOString();

function makeUsage(): NonNullableUsage {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard' as const,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: '',
    iterations: [],
    speed: 'standard' as const,
  };
}

// ---------------------------------------------------------------------------
// ContentBlockParam types
// ---------------------------------------------------------------------------
describe('ContentBlockParam types', () => {
  it('标准请求文本块可以构造', () => {
    const block: ModelStreamTextBlock = { type: 'text', text: 'Hello world' };
    expect(block.type).toBe('text');
    expect(block.text).toBe('Hello world');
  });

  it('ToolResultBlockParam can omit is_error for successful output', () => {
    const block: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'toolu_123',
      content: 'Tool output text',
    };
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('toolu_123');
    expect(block.content).toBe('Tool output text');
    expect(block.is_error).toBeUndefined();
  });

  it('ToolResultBlockParam can be constructed with content parts array', () => {
    const block: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'toolu_456',
      content: [
        { type: 'text', text: 'Some output' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBOR...',
          },
        },
      ],
      is_error: false,
    };
    expect(block.type).toBe('tool_result');
    expect(Array.isArray(block.content)).toBe(true);
    expect(block.content).toHaveLength(2);
  });

  it('ToolResultBlockParam supports is_error: true', () => {
    const block: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'toolu_err',
      content: 'Error: file not found',
      is_error: true,
    };
    expect(block.is_error).toBe(true);
  });

  it('ContentBlockParam union accepts TextBlockParam', () => {
    const block: ContentBlockParam = { type: 'text', text: 'hi' };
    expect(block.type).toBe('text');
  });

  it('ContentBlockParam union accepts ToolResultBlockParam', () => {
    const block: ContentBlockParam = {
      type: 'tool_result',
      tool_use_id: 'toolu_x',
      content: 'result',
      is_error: false,
    };
    expect(block.type).toBe('tool_result');
  });

  it('ContentBlockParam narrows correctly via type discriminant', () => {
    const blocks: ContentBlockParam[] = [
      { type: 'text', text: 'foo' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'bar',
        is_error: false,
      },
    ];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          expect(block.text).toBe('foo');
          break;
        case 'tool_result':
          expect(block.tool_use_id).toBe('toolu_1');
          break;
        default:
          throw new Error(`Unexpected block type: ${String(block)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// MessageBase optional fields
// ---------------------------------------------------------------------------
describe('MessageBase optional fields', () => {
  it('minimal MessageBase only requires uuid and timestamp', () => {
    const base: MessageBase = {
      uuid: uuid(),
      timestamp: now(),
    };
    expect(base.uuid).toBeDefined();
    expect(base.timestamp).toBeDefined();
    expect(base.isMeta).toBeUndefined();
    expect(base.isVisibleInTranscriptOnly).toBeUndefined();
    expect(base.cwd).toBeUndefined();
    expect(base.sessionId).toBeUndefined();
  });

  it('supports all optional flag fields', () => {
    const base: MessageBase = {
      uuid: uuid(),
      timestamp: now(),
      isMeta: true,
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
    };
    expect(base.isMeta).toBe(true);
    expect(base.isVisibleInTranscriptOnly).toBe(true);
    expect(base.isCompactSummary).toBe(true);
  });

  it('supports all optional session context fields', () => {
    const base: MessageBase = {
      uuid: uuid(),
      timestamp: now(),
      cwd: '/home/user/project',
      sessionId: uuid(),
      userType: 'external',
      entrypoint: 'cli',
      version: '1.2.3',
      gitBranch: 'main',
      agentId: 'agent-001',
      teamName: 'core-team',
      agentName: 'researcher',
      slug: 'my-session',
      promptId: uuid(),
    };
    expect(base.cwd).toBe('/home/user/project');
    expect(base.userType).toBe('external');
    expect(base.entrypoint).toBe('cli');
    expect(base.version).toBe('1.2.3');
    expect(base.gitBranch).toBe('main');
    expect(base.agentId).toBe('agent-001');
    expect(base.teamName).toBe('core-team');
    expect(base.agentName).toBe('researcher');
    expect(base.slug).toBe('my-session');
    expect(base.promptId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// UserMessage
// ---------------------------------------------------------------------------
describe('UserMessage', () => {
  it('can be constructed with string content', () => {
    const msg: UserMessage = {
      type: 'user',
      uuid: uuid(),
      timestamp: now(),
      message: {
        role: 'user',
        content: 'What is 2+2?',
      },
    };
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toBe('What is 2+2?');
  });

  it('can be constructed with ContentBlockParam[] content', () => {
    const msg: UserMessage = {
      type: 'user',
      uuid: uuid(),
      timestamp: now(),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is my question' },
          { type: 'text', text: 'And a follow-up' },
        ],
      },
    };
    expect(msg.type).toBe('user');
    expect(Array.isArray(msg.message.content)).toBe(true);
    expect((msg.message.content as ContentBlockParam[]).length).toBe(2);
  });

  it('can carry tool_result content blocks', () => {
    const msg: UserMessage = {
      type: 'user',
      uuid: uuid(),
      timestamp: now(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_abc',
            content: 'File contents here',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_def',
            content: 'Error: permission denied',
            is_error: true,
          },
        ],
      },
      sourceToolAssistantUUID: uuid(),
    };
    expect(msg.type).toBe('user');
    const content = msg.message.content as ToolResultBlockParam[];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('tool_result');
    expect(content[0].is_error).toBe(false);
    expect(content[1].is_error).toBe(true);
    expect(msg.sourceToolAssistantUUID).toBeDefined();
  });

  it('supports optional fields', () => {
    const msg: UserMessage = {
      type: 'user',
      uuid: uuid(),
      timestamp: now(),
      message: { role: 'user', content: 'hello' },
      sourceToolAssistantUUID: uuid(),
      permissionMode: 'auto-edit',
      origin: { kind: 'human' },
      humanInput: {
        text: '/skill   keep\n  formatting',
        mode: 'prompt',
      },
      isReplay: true,
    };
    expect(msg.permissionMode).toBe('auto-edit');
    expect(msg.origin?.kind).toBe('human');
    expect(msg.humanInput).toEqual({
      text: '/skill   keep\n  formatting',
      mode: 'prompt',
    });
    expect(msg.isReplay).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AssistantMessage
// ---------------------------------------------------------------------------
describe('AssistantMessage', () => {
  it('can be constructed with full API response shape', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: uuid(),
      timestamp: now(),
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: uuid(),

        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',

        usage: makeUsage(),
        content: [{ type: 'text', text: 'The answer is 4.' }],
      },
    };
    expect(msg.type).toBe('assistant');
    expect(msg.message.id).toBeDefined();
    expect(msg.message.type).toBe('message');
    expect(msg.message.role).toBe('assistant');
    expect(msg.message.model).toBe('claude-sonnet-4-20250514');
    expect(msg.message.stop_reason).toBe('end_turn');
    expect(msg.message.stop_sequence).toBeNull();
    expect(msg.message.container).toBeNull();
    expect(msg.message.context_management).toBeNull();
  });

  it('usage has non-nullable fields', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: uuid(),
      timestamp: now(),
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: uuid(),

        model: 'test-model',
        stop_reason: 'end_turn',

        usage: makeUsage(),
        content: [],
      },
    };
    expect(msg.message.usage).toEqual(makeUsage());
    expect(msg).not.toHaveProperty('usage');
    const { usage } = msg.message;
    expect(usage).toBeDefined();
    if (!usage) {
      throw new Error('expected usage');
    }
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(20);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.server_tool_use).toEqual({
      web_search_requests: 0,
      web_fetch_requests: 0,
    });
    expect(usage.service_tier).toBe('standard');
    expect(usage.cache_creation).toEqual({
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    });
    expect(usage.inference_geo).toBe('');
    expect(usage.iterations).toEqual([]);
    expect(usage.speed).toBe('standard');
  });

  it('supports multiple content block types', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: uuid(),
      timestamp: now(),
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: uuid(),

        model: 'test-model',
        stop_reason: 'tool_use',

        usage: makeUsage(),
        content: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: { file_path: '/tmp/test.txt' },
          },
        ],
      },
    };
    expect(msg.message.content).toHaveLength(2);
    expect(msg.message.content[0].type).toBe('text');
    expect(msg.message.content[1].type).toBe('tool_use');
    expect(msg.message.stop_reason).toBe('tool_use');
  });

  it('supports thinking and redacted_thinking content blocks', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: uuid(),
      timestamp: now(),
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: uuid(),

        model: 'test-model',
        stop_reason: 'end_turn',

        usage: makeUsage(),
        content: [
          {
            type: 'thinking',
            thinking: 'Let me think about this...',
            signature: 'sig123',
          },
          { type: 'redacted_thinking', data: 'REDACTED' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    };
    expect(msg.message.content).toHaveLength(3);
    expect(msg.message.content[0].type).toBe('thinking');
    expect(msg.message.content[1].type).toBe('redacted_thinking');
    expect(msg.message.content[2].type).toBe('text');
  });

  it('supports optional fields', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: uuid(),
      timestamp: now(),
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: uuid(),

        model: 'test-model',
        stop_reason: null,

        usage: makeUsage(),
        content: [],
      },
      requestId: 'req_abc123',
      session_id: uuid(),
      parent_tool_use_id: 'toolu_parent',
    };
    expect(msg.requestId).toBe('req_abc123');
    expect(msg.session_id).toBeDefined();
    expect(msg.parent_tool_use_id).toBe('toolu_parent');
  });

  it('parent_tool_use_id can be null', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: uuid(),
      timestamp: now(),
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: uuid(),

        model: 'test-model',
        stop_reason: 'end_turn',

        usage: makeUsage(),
        content: [],
      },
      parent_tool_use_id: null,
    };
    expect(msg.parent_tool_use_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SystemMessage
// ---------------------------------------------------------------------------
describe('SystemMessage', () => {
  it('can be constructed with info level', () => {
    const msg: SystemMessage = {
      type: 'system',
      uuid: uuid(),
      timestamp: now(),
      subtype: 'informational',
      content: 'Session started.',
      level: 'info',
    };
    expect(msg.type).toBe('system');
    expect(msg.subtype).toBe('informational');
    expect(msg.level).toBe('info');
    expect(msg.content).toBe('Session started.');
  });

  it('can be constructed with error level', () => {
    const msg: SystemMessage = {
      type: 'system',
      uuid: uuid(),
      timestamp: now(),
      subtype: 'error',
      content: 'Something went wrong.',
      level: 'error',
    };
    expect(msg.level).toBe('error');
    expect(msg.subtype).toBe('error');
  });

  it('supports all defined subtypes', () => {
    const subtypes: SystemSubtype[] = [
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
      'task_notification',
      'task_progress',
      'task_started',
      'turn_duration',
    ];
    expect(subtypes).toHaveLength(25);

    // Each subtype can be assigned to a SystemMessage
    for (const subtype of subtypes) {
      const msg: SystemMessage = {
        type: 'system',
        uuid: uuid(),
        timestamp: now(),
        subtype,
        content: `Test ${subtype}`,
        level: 'info',
      };
      expect(msg.subtype).toBe(subtype);
    }
  });
});

// ---------------------------------------------------------------------------
// ProgressMessage
// ---------------------------------------------------------------------------
describe('ProgressMessage', () => {
  it('can be constructed with minimal fields', () => {
    const msg: ProgressMessage = {
      type: 'progress',
      uuid: uuid(),
      timestamp: now(),
      data: { percent: 50, status: 'downloading' },
    };
    expect(msg.type).toBe('progress');
    expect(msg.data).toEqual({ percent: 50, status: 'downloading' });
    expect(msg.toolUseID).toBeUndefined();
  });

  it('supports optional toolUseID', () => {
    const msg: ProgressMessage = {
      type: 'progress',
      uuid: uuid(),
      timestamp: now(),
      data: 'Streaming...',
      toolUseID: 'toolu_progress',
    };
    expect(msg.toolUseID).toBe('toolu_progress');
  });

  it('data can be any type', () => {
    const msg: ProgressMessage = {
      type: 'progress',
      uuid: uuid(),
      timestamp: now(),
      data: null,
    };
    expect(msg.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AttachmentMessage
// ---------------------------------------------------------------------------
describe('AttachmentMessage', () => {
  it('can be constructed', () => {
    const msg: AttachmentMessage = {
      type: 'attachment',
      uuid: uuid(),
      timestamp: now(),
      attachment: {
        type: 'hook_success',
        output: 'Hook ran successfully',
      },
    };
    expect(msg.type).toBe('attachment');
    expect(msg.attachment.type).toBe('hook_success');
  });

  it('supports all defined attachment types', () => {
    const types: AttachmentType[] = [
      'hook_success',
      'hook_error',
      'hook_cancelled',
      'hook_system_message',
      'hook_blocking_error',
      'queued_command',
      'relevant_memories',
    ];
    expect(types).toHaveLength(7);

    for (const attachType of types) {
      const msg: AttachmentMessage = {
        type: 'attachment',
        uuid: uuid(),
        timestamp: now(),
        attachment: { type: attachType },
      };
      expect(msg.attachment.type).toBe(attachType);
    }
  });

  it('attachment supports additional arbitrary properties', () => {
    const msg: AttachmentMessage = {
      type: 'attachment',
      uuid: uuid(),
      timestamp: now(),
      attachment: {
        type: 'relevant_memories',
        memories: ['Always use strict mode', 'Prefer const over let'],
        count: 2,
      },
    };
    expect(msg.attachment.type).toBe('relevant_memories');
    expect(msg.attachment['memories']).toEqual([
      'Always use strict mode',
      'Prefer const over let',
    ]);
    expect(msg.attachment['count']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ToolUseSummaryMessage
// ---------------------------------------------------------------------------
describe('ToolUseSummaryMessage', () => {
  it('can be constructed', () => {
    const msg: ToolUseSummaryMessage = {
      type: 'tool_use_summary',
      uuid: uuid(),
      timestamp: now(),
      summary: { text: 'Read 3 files and wrote 1 file' },
      precedingToolUseIds: ['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4'],
    };
    expect(msg.type).toBe('tool_use_summary');
    expect(msg.precedingToolUseIds).toHaveLength(4);
  });

  it('supports empty precedingToolUseIds', () => {
    const msg: ToolUseSummaryMessage = {
      type: 'tool_use_summary',
      uuid: uuid(),
      timestamp: now(),
      summary: null,
      precedingToolUseIds: [],
    };
    expect(msg.precedingToolUseIds).toHaveLength(0);
    expect(msg.summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TombstoneMessage
// ---------------------------------------------------------------------------
describe('TombstoneMessage', () => {
  it('can be constructed', () => {
    const msg: TombstoneMessage = {
      type: 'tombstone',
      uuid: uuid(),
      timestamp: now(),
      message: { partial: true, content: 'Incomplete response...' },
    };
    expect(msg.type).toBe('tombstone');
    expect(msg.message).toBeDefined();
  });

  it('message can be any type (unknown)', () => {
    const msg: TombstoneMessage = {
      type: 'tombstone',
      uuid: uuid(),
      timestamp: now(),
      message: 'string message',
    };
    expect(msg.message).toBe('string message');
  });
});

// ---------------------------------------------------------------------------
// Message union — discriminated union narrowing
// ---------------------------------------------------------------------------
describe('Message union', () => {
  function makeAllVariants(): Message[] {
    return [
      {
        type: 'user',
        uuid: uuid(),
        timestamp: now(),
        message: { role: 'user', content: 'Hello' },
      },
      {
        type: 'assistant',
        uuid: uuid(),
        timestamp: now(),
        message: {
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          id: uuid(),

          model: 'test-model',
          stop_reason: 'end_turn',

          usage: makeUsage(),
          content: [{ type: 'text', text: 'Response.' }],
        },
      },
      {
        type: 'system',
        uuid: uuid(),
        timestamp: now(),
        subtype: 'init',
        content: 'Initialized.',
        level: 'info',
      },
      {
        type: 'progress',
        uuid: uuid(),
        timestamp: now(),
        data: { step: 1 },
      },
      {
        type: 'attachment',
        uuid: uuid(),
        timestamp: now(),
        attachment: { type: 'hook_success' },
      },
      {
        type: 'tool_use_summary',
        uuid: uuid(),
        timestamp: now(),
        summary: 'Summary',
        precedingToolUseIds: ['toolu_a'],
      },
      {
        type: 'tombstone',
        uuid: uuid(),
        timestamp: now(),
        message: null,
      },
    ];
  }

  it('all 7 variants can be collected in a Message[]', () => {
    const messages = makeAllVariants();
    expect(messages).toHaveLength(7);
  });

  it('discriminated union narrows correctly via switch', () => {
    const messages = makeAllVariants();
    const narrowed: string[] = [];

    for (const msg of messages) {
      switch (msg.type) {
        case 'user':
          expect(msg.message.role).toBe('user');
          narrowed.push('user');
          break;
        case 'assistant':
          expect(msg.message.id).toBeDefined();
          expect(msg.message.content).toBeDefined();
          narrowed.push('assistant');
          break;
        case 'system':
          expect(msg.subtype).toBe('init');
          expect(msg.level).toBe('info');
          narrowed.push('system');
          break;
        case 'progress':
          expect(msg.data).toEqual({ step: 1 });
          narrowed.push('progress');
          break;
        case 'attachment':
          expect(msg.attachment.type).toBe('hook_success');
          narrowed.push('attachment');
          break;
        case 'tool_use_summary':
          expect(msg.precedingToolUseIds).toHaveLength(1);
          narrowed.push('tool_use_summary');
          break;
        case 'tombstone':
          expect(msg.message).toBeNull();
          narrowed.push('tombstone');
          break;
        default:
          throw new Error(`Unexpected message type: ${String(msg)}`);
      }
    }

    expect(narrowed).toEqual([
      'user',
      'assistant',
      'system',
      'progress',
      'attachment',
      'tool_use_summary',
      'tombstone',
    ]);
  });

  it('common MessageBase fields are accessible without narrowing', () => {
    const messages = makeAllVariants();
    for (const msg of messages) {
      expect(typeof msg.uuid).toBe('string');
      expect(typeof msg.timestamp).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// MessageType
// ---------------------------------------------------------------------------
describe('MessageType', () => {
  it('includes all 7 expected values', () => {
    const allTypes: MessageType[] = [
      'user',
      'assistant',
      'system',
      'progress',
      'attachment',
      'tool_use_summary',
      'tombstone',
    ];
    expect(allTypes).toHaveLength(7);

    // Each value is a valid MessageType
    for (const t of allTypes) {
      expect(typeof t).toBe('string');
    }
  });

  it('can be used to index into a record', () => {
    const labels: Record<MessageType, string> = {
      user: 'User',
      assistant: 'Assistant',
      system: 'System',
      progress: 'Progress',
      attachment: 'Attachment',
      tool_use_summary: 'Tool Use Summary',
      tombstone: 'Tombstone',
    };
    expect(Object.keys(labels)).toHaveLength(7);
    expect(labels.user).toBe('User');
    expect(labels.tombstone).toBe('Tombstone');
  });
});
