/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  createToolResultMessage,
  createSystemMessage,
  transcriptToMessage,
  transcriptInputToModelBlock,
  toolResultPartToTranscriptBlock,
} from '../conversions.js';
import type { ModelMessage } from '../../../provider/event/modelCompleteEvent.js';
import type { ToolResultBlock } from '../../../core/tool-result.js';
import type { ToolResultContentPart } from '../../../tools/tool-result-message.js';
import type { NonNullableUsage } from '../../schemas/common.js';
import type { TranscriptMessage } from '../entry.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_USAGE: NonNullableUsage = {
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 20,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
};

const TEST_ASSEMBLED: ModelMessage = {
  messageId: 'msg-123',

  model: 'test-model',
  stopReason: 'end_turn' as const,

  usage: ((value) => ({
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cacheReadInputTokens: value.cache_read_input_tokens,
    cacheCreationInputTokens: value.cache_creation_input_tokens,
  }))({ ...TEST_USAGE }),
  blocks: [{ type: 'text' as const, text: 'Hello' }],
};

// ---------------------------------------------------------------------------
// createAssistantMessage
// ---------------------------------------------------------------------------

describe('createAssistantMessage', () => {
  it('generates a uuid and timestamp', () => {
    const result = createAssistantMessage(TEST_ASSEMBLED);

    expect(result.uuid).toBeDefined();
    expect(result.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.timestamp).toBeDefined();
    // ISO 8601 check
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('完整保留标准模型消息，并将计量元数据放在宿主', () => {
    const result = createAssistantMessage(
      TEST_ASSEMBLED,
      undefined,
      undefined,
      TEST_USAGE,
    );

    expect(result.type).toBe('assistant');
    expect(result.message.id).toBe('msg-123');
    expect(result.message).not.toBe(TEST_ASSEMBLED);
    expect(result.message.role).toBe('assistant');
    expect(result.message.type).toBe('message');
    expect(result.message).not.toHaveProperty('blocks');
    expect(result).not.toHaveProperty('usage');
    expect(result.message.model).toBe('test-model');
    expect(result.message.stop_reason).toBe('end_turn');
    expect(result.message.stop_sequence).toBeNull();
    expect(result.message.usage).toEqual(TEST_USAGE);
    expect(result.message.content).toEqual([
      { type: 'text', text: 'Hello', citations: null },
    ]);
    expect(result.message.container).toBeNull();
    expect(result.message.context_management).toBeNull();
  });

  it('sets requestId when provided', () => {
    const result = createAssistantMessage(TEST_ASSEMBLED, 'req-abc');

    expect(result.requestId).toBe('req-abc');
  });

  it('leaves requestId undefined when not provided', () => {
    const result = createAssistantMessage(TEST_ASSEMBLED);

    expect(result.requestId).toBeUndefined();
  });

  it('keeps host response identity separate from upstream payload and message uuid', () => {
    const first = createAssistantMessage(
      TEST_ASSEMBLED,
      'request-1',
      undefined,
      undefined,
      'response-group-1',
    );
    const second = createAssistantMessage(
      TEST_ASSEMBLED,
      'request-1',
      undefined,
      undefined,
      'response-group-1',
    );
    expect(first.responseGroupId).toBe('response-group-1');
    expect(second.responseGroupId).toBe(first.responseGroupId);
    expect(second.uuid).not.toBe(first.uuid);
    expect(first.message.id).toBe(TEST_ASSEMBLED.messageId);
    expect(first.message).not.toHaveProperty('responseGroupId');
    expect(createAssistantMessage(TEST_ASSEMBLED)).not.toHaveProperty(
      'responseGroupId',
    );
  });

  it('preserves content blocks exactly', () => {
    const assembled: ModelMessage = {
      ...TEST_ASSEMBLED,
      blocks: [
        { type: 'text' as const, text: 'block 1' },
        { type: 'text' as const, text: 'block 2' },
      ],
    };

    const result = createAssistantMessage(assembled);

    expect(result.message.content).toHaveLength(2);
    expect(result.message.content[0]).toEqual({
      type: 'text',
      text: 'block 1',
      citations: null,
    });
    expect(result.message.content[1]).toEqual({
      type: 'text',
      text: 'block 2',
      citations: null,
    });
  });
});

describe('createAssistantAPIErrorMessage', () => {
  it('persists display metadata for locale-aware resume rendering', () => {
    const result = createAssistantAPIErrorMessage({
      content: 'Dynamic content-filtered message',
      error: 'unknown',
      displayErrorCode: 406,
      errorFallbackMessage: 'Session blocked',
      isContentFilteredMessage: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        isApiErrorMessage: true,
        isContentFilteredMessage: true,
        displayErrorCode: 406,
        errorFallbackMessage: 'Session blocked',
        message: expect.objectContaining({
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Dynamic content-filtered message' }],
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createUserMessage
// ---------------------------------------------------------------------------

describe('createUserMessage', () => {
  it('creates a UserMessage with content as string', () => {
    const result = createUserMessage('Hello world');

    expect(result.type).toBe('user');
    expect(result.message.role).toBe('user');
    expect(result.message.content).toBe('Hello world');
  });

  it('generates uuid and timestamp by default', () => {
    const result = createUserMessage('test');

    expect(result.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('allows uuid and timestamp to be overridden via options', () => {
    const result = createUserMessage('test', {
      uuid: 'custom-uuid',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(result.uuid).toBe('custom-uuid');
    expect(result.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('passes through transcript flags, permissionMode, and origin', () => {
    const result = createUserMessage('test', {
      isMeta: true,
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      permissionMode: 'auto',
      origin: { kind: 'human' },
    });

    expect(result.isMeta).toBe(true);
    expect(result.isVisibleInTranscriptOnly).toBe(true);
    expect(result.isCompactSummary).toBe(true);
    expect(result.permissionMode).toBe('auto');
    expect(result.origin).toEqual({ kind: 'human' });
  });

  it('preserves the exact original human input when provided', () => {
    const result = createUserMessage('expanded prompt', {
      humanInput: {
        text: '/skill   keep\n  formatting',
        mode: 'prompt',
      },
    });

    expect(result.humanInput).toEqual({
      text: '/skill   keep\n  formatting',
      mode: 'prompt',
    });
  });

  it('omits the human input snapshot by default', () => {
    expect(createUserMessage('plain prompt').humanInput).toBeUndefined();
  });

  it('persists the selected business model without adding it to model messages', () => {
    const user = createUserMessage('prompt', {
      requestSetId: 'task-1',
      businessModelKey: 'ultimate',
    });
    expect(JSON.parse(JSON.stringify(user)).businessModelKey).toBe('ultimate');
    expect(user.message).not.toHaveProperty('businessModelKey');
    expect(createUserMessage('old prompt')).not.toHaveProperty(
      'businessModelKey',
    );
  });

  it('preserves the Task correlation id when provided', () => {
    expect(
      createUserMessage('prompt', { requestSetId: 'task-1' }).requestSetId,
    ).toBe('task-1');
  });
});

// ---------------------------------------------------------------------------
// createToolResultMessage
// ---------------------------------------------------------------------------

describe('createToolResultMessage', () => {
  const toolResults: ToolResultBlock[] = [
    {
      type: 'tool_result',
      tool_use_id: 'tu_123',
      content: 'some result text',
      is_error: false,
    },
    {
      type: 'tool_result',
      tool_use_id: 'tu_456',
      content: 'error output',
      is_error: true,
    },
  ];

  it('creates a UserMessage with content as ToolResultBlockParam[]', () => {
    const result = createToolResultMessage(toolResults, 'assistant-uuid');

    expect(result.type).toBe('user');
    expect(result.message.role).toBe('user');
    expect(Array.isArray(result.message.content)).toBe(true);

    const content = result.message.content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }>;
    expect(content).toHaveLength(2);
  });

  it('sets sourceToolAssistantUUID to assistantUuid', () => {
    const result = createToolResultMessage(toolResults, 'assistant-uuid');

    expect(result.sourceToolAssistantUUID).toBe('assistant-uuid');
  });

  it('preserves structured toolUseResult metadata on the user message', () => {
    const result = createToolResultMessage(
      [
        {
          ...toolResults[0],
          toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
        },
      ],
      'assistant-uuid',
    );

    expect(result.toolUseResult).toEqual({
      stdout: 'ok',
      stderr: '',
      interrupted: false,
    });
  });

  it('keeps replacement paths aligned without changing semantic or model output', () => {
    const result = createToolResultMessage(
      [
        toolResults[0],
        {
          ...toolResults[1],
          toolUseResult: ['arbitrary', 'payload'],
          readOutputReplacement: '/actual.txt',
        },
      ],
      'assistant-uuid',
    );
    const persisted = JSON.parse(JSON.stringify(result));
    expect(persisted.readOutputReplacement).toEqual([null, '/actual.txt']);
    expect(persisted.toolUseResult[1]).toEqual(['arbitrary', 'payload']);
    expect(persisted.message.content[1]).not.toHaveProperty(
      'readOutputReplacement',
    );
    expect(
      createToolResultMessage(toolResults, 'assistant-uuid'),
    ).not.toHaveProperty('readOutputReplacement');
  });

  it('persists MCP host metadata beside a single semantic result', () => {
    const result = createToolResultMessage(
      [
        {
          ...toolResults[0],
          toolUseResult: [{ type: 'text', text: 'semantic' }],
          mcpMeta: {
            _meta: { ui: { resourceUri: 'ui://example/app' } },
            structuredContent: { value: 1 },
          },
        },
      ],
      'assistant-uuid',
    );

    expect(result.toolUseResult).toEqual([{ type: 'text', text: 'semantic' }]);
    expect(result.mcpMeta).toEqual({
      _meta: { ui: { resourceUri: 'ui://example/app' } },
      structuredContent: { value: 1 },
    });
  });

  it('preserves sparse mcpMeta positions for parallel tool calls', () => {
    const result = createToolResultMessage(
      [
        toolResults[0],
        {
          ...toolResults[1],
          mcpMeta: { structuredContent: { value: 2 } },
        },
      ],
      'assistant-uuid',
    );

    expect(result.mcpMeta).toEqual([null, { structuredContent: { value: 2 } }]);
  });

  it('preserves sparse toolUseResult positions for parallel tool calls', () => {
    const result = createToolResultMessage(
      [
        {
          ...toolResults[0],
          toolUseResult: undefined,
        },
        {
          ...toolResults[1],
          toolUseResult: { stdout: 'late', stderr: '', interrupted: false },
        },
      ],
      'assistant-uuid',
    );

    expect(result.toolUseResult).toEqual([
      undefined,
      { stdout: 'late', stderr: '', interrupted: false },
    ]);
  });

  it('preserves denial kind metadata without adding it to API content blocks', () => {
    const result = createToolResultMessage(
      [
        {
          ...toolResults[1],
          toolDenialKind: 'user-rejected',
          userFeedback: 'Use a different approach',
        },
      ],
      'assistant-uuid',
    );

    expect(result.toolDenialKind).toBe('user-rejected');
    expect(result.userFeedback).toBe('Use a different approach');
    expect(result.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_456',
        content: 'error output',
        is_error: true,
      },
    ]);
  });

  it('preserves sparse denial kinds for parallel tool calls', () => {
    const result = createToolResultMessage(
      [
        toolResults[0],
        {
          ...toolResults[1],
          toolDenialKind: 'permission-rule',
          userFeedback: 'Try another tool',
        },
      ],
      'assistant-uuid',
    );

    expect(result.toolDenialKind).toEqual([undefined, 'permission-rule']);
    expect(result.userFeedback).toEqual([undefined, 'Try another tool']);
  });

  it('工具域正文在会话边界转换，再从会话进入模型请求且不修改源内容', () => {
    const parts = Object.freeze([
      Object.freeze({
        type: 'text' as const,
        text: 'before',
        cacheControl: Object.freeze({ type: 'ephemeral' as const, ttl: '5m' }),
      }),
      Object.freeze({
        type: 'image' as const,
        source: Object.freeze({
          type: 'base64' as const,
          mediaType: 'image/png',
          data: 'abc',
        }),
        cacheControl: Object.freeze({ type: 'ephemeral' as const, ttl: '1h' }),
      }),
      Object.freeze({
        type: 'image' as const,
        source: Object.freeze({
          type: 'url' as const,
          url: 'https://assets.example.test/tool.png',
        }),
      }),
    ] as const) satisfies readonly ToolResultContentPart[];
    const expected = [
      {
        type: 'text',
        text: 'before',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'image',
        source: { type: 'url', url: 'https://assets.example.test/tool.png' },
      },
    ];
    expect(parts.map(toolResultPartToTranscriptBlock)).toEqual(expected);
    const message = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'image-call',
          content: parts,
          is_error: true,
        },
      ],
      'assistant-image',
    );
    if (typeof message.message.content === 'string')
      throw new Error('应生成工具结果块');
    const block = message.message.content[0];
    if (block.type !== 'tool_result' || typeof block.content === 'string') {
      throw new Error('应保留工具结果内容数组');
    }
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'image-call',
      content: expected,
      is_error: true,
    });
    expect(block.content.map(transcriptInputToModelBlock)).toEqual(parts);
    expect(block.content[0]).not.toBe(parts[0]);
    expect(block.content[1]).not.toBe(parts[1]);
    expect(parts[1].source).toEqual({
      type: 'base64',
      mediaType: 'image/png',
      data: 'abc',
    });
    expect(parts[0]).toHaveProperty('cacheControl.ttl', '5m');
  });

  it('maps each result to a tool_result block and only marks errors', () => {
    const result = createToolResultMessage(toolResults, 'assistant-uuid');

    const content = result.message.content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;

    expect(content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_123',
      content: 'some result text',
    });
    expect(content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_456',
      content: 'error output',
      is_error: true,
    });
  });

  it('generates uuid and timestamp', () => {
    const result = createToolResultMessage(toolResults, 'assistant-uuid');

    expect(result.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});

// ---------------------------------------------------------------------------
// createSystemMessage
// ---------------------------------------------------------------------------

describe('createSystemMessage', () => {
  it('sets type, subtype, content, and level', () => {
    const result = createSystemMessage('init', 'Session started', 'info');

    expect(result.type).toBe('system');
    expect(result.subtype).toBe('init');
    expect(result.content).toBe('Session started');
    expect(result.level).toBe('info');
  });

  it('defaults level to info when not provided', () => {
    const result = createSystemMessage('status', 'All good');

    expect(result.level).toBe('info');
  });

  it('allows level to be set to error', () => {
    const result = createSystemMessage('error', 'Something failed', 'error');

    expect(result.level).toBe('error');
  });

  it('generates uuid and timestamp', () => {
    const result = createSystemMessage('informational', 'test');

    expect(result.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});

// ---------------------------------------------------------------------------
// transcriptToMessage
// ---------------------------------------------------------------------------

describe('transcriptToMessage', () => {
  const baseEntry: TranscriptMessage = {
    type: 'user',
    uuid: 'entry-uuid',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'Hello' },
    cwd: '/home/user',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
    parentUuid: 'parent-uuid',
    logicalParentUuid: 'logical-parent-uuid',
    isSidechain: true,
  };

  it('strips parentUuid, logicalParentUuid, and isSidechain', () => {
    const result = transcriptToMessage(baseEntry);

    expect(result).not.toHaveProperty('parentUuid');
    expect(result).not.toHaveProperty('logicalParentUuid');
    expect(result).not.toHaveProperty('isSidechain');
  });

  it('preserves all other fields', () => {
    const result = transcriptToMessage(baseEntry);

    expect(result.type).toBe('user');
    expect(result.uuid).toBe('entry-uuid');
    expect(result.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(result.cwd).toBe('/home/user');
    expect(result.sessionId).toBe('session-1');
    expect(result.version).toBe('1.0.0');

    // Check that message content is preserved
    expect(
      (result as { message: { role: string; content: string } }).message,
    ).toEqual({
      role: 'user',
      content: 'Hello',
    });
  });

  it('preserves persisted assistant response groups when resuming history', () => {
    const assistant = createAssistantMessage(
      TEST_ASSEMBLED,
      undefined,
      undefined,
      undefined,
      'persisted-response-group',
    );
    const resumed = transcriptToMessage({
      ...baseEntry,
      ...assistant,
    } as TranscriptMessage);
    expect(resumed).toMatchObject({
      type: 'assistant',
      uuid: assistant.uuid,
      responseGroupId: 'persisted-response-group',
      message: { id: TEST_ASSEMBLED.messageId },
    });
  });

  it('preserves optional fields like gitBranch and agentId', () => {
    const entryWithOptionals: TranscriptMessage = {
      ...baseEntry,
      gitBranch: 'main',
      agentId: 'agent-1',
    };

    const result = transcriptToMessage(entryWithOptionals);

    expect(result.gitBranch).toBe('main');
    expect(result.agentId).toBe('agent-1');
  });
});
