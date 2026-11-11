/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  UserMessage,
} from '../protocol/transcript/message.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type {
  ModelContentBlock,
  ModelMessage,
} from '../provider/event/modelCompleteEvent.js';
import type {
  ModelReasoningMetadata,
  ModelStreamEvent,
} from '../provider/event/modelStreamEvent.js';
import type { ModelInputContentBlock } from '../provider/modelStreamRequest.js';
import {
  ENV_EXPOSE_REQUEST_ID,
  ENV_EXPOSE_TOKEN_USAGE,
} from '../config/brand.js';
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  modelInputToTranscriptBlock,
} from '../protocol/transcript/conversions.js';
import {
  cloneUsageForSdkOutput,
  projectCompactUsageForSdk,
  cloneUsageForSdkResult,
  projectMessageOriginForSdk,
  projectModelMessageForSdk,
  projectModelStreamEventForSdk,
  splitAssistantForSdk,
  splitUserForSdk,
} from './headless-projection.js';

afterEach(() => {
  delete process.env[ENV_EXPOSE_REQUEST_ID];
  delete process.env[ENV_EXPOSE_TOKEN_USAGE];
});

describe('projectCompactUsageForSdk', () => {
  it.each(['true', 'false'])('only exposes ratio and credits with token visibility %s', (visible) => {
    process.env[ENV_EXPOSE_TOKEN_USAGE] = visible;
    expect(projectCompactUsageForSdk({
      ...cloneUsage(), input_tokens: 100, context_usage_ratio: 0.2, credits: 0,
    })).toEqual({ context_usage_ratio: 0.2, credits: 0 });
    expect(projectCompactUsageForSdk(cloneUsage())).toEqual({});
  });
});

describe('projectMessageOriginForSdk', () => {
  it('keeps public peer provenance while omitting internal transport fields', () => {
    expect(
      projectMessageOriginForSdk({
        kind: 'peer',
        from: 'reviewer',
        senderTaskId: 'task-7',
        name: 'Reviewer',
        body: 'ready',
        transport: 'uds',
        msgId: 'message-7',
        fromMode: 'bypass',
        hopChain: ['root', 'reviewer'],
        attachmentCount: 2,
        selfSent: false,
      }),
    ).toEqual({
      kind: 'peer',
      from: 'reviewer',
      senderTaskId: 'task-7',
      name: 'Reviewer',
      body: 'ready',
    });
  });

  it('does not expose coordinator provenance', () => {
    expect(projectMessageOriginForSdk({ kind: 'coordinator' })).toBeUndefined();
  });
});

function makeAssistant(
  requestId?: string,
  nestedRequestId: unknown = requestId,
): AssistantMessage {
  return createAssistantMessage(
    {
      messageId: 'assistant-request-id',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: { inputTokens: 0, outputTokens: 0 },
      blocks: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ],
    },
    requestId,
    undefined,
    Object.assign(cloneUsage(), { request_id: nestedRequestId }),
  );
}

describe('projectModelStreamEventForSdk', () => {
  it.each([false, true])(
    '在出口生成消息外壳并按开关暴露用量：%s',
    (exposed) => {
      process.env[ENV_EXPOSE_TOKEN_USAGE] = String(exposed);
      const event: ModelStreamEvent = {
        type: 'message_start',
        message: {
          id: 'message-1',
          role: 'assistant',
          model: 'test-model',
          usage: {
            inputTokens: 100,
            outputTokens: 0,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 30,
          },
        },
      };
      const before = structuredClone(event);
      expect(projectModelStreamEventForSdk(event, 'request-1')).toMatchObject({
        type: 'message_start',
        message: {
          id: 'message-1',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: exposed ? 100 : 0,
            output_tokens: 0,
            cache_read_input_tokens: exposed ? 20 : 0,
            cache_creation_input_tokens: exposed ? 30 : 0,
            request_id: 'request-1',
          },
        },
      });
      expect(event).toEqual(before);
      expect(event.message).not.toHaveProperty('content');
    },
  );

  it('仅在出口补齐未上报用量，保留明确零值和停止原因', () => {
    process.env[ENV_EXPOSE_TOKEN_USAGE] = 'true';
    expect(
      projectModelStreamEventForSdk({
        type: 'message_start',
        message: { id: 'message-1', role: 'assistant', model: 'test-model' },
      }),
    ).toMatchObject({
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const event: ModelStreamEvent = {
      type: 'message_delta',
      delta: { stopReason: 'tool_use' },
      usage: { inputTokens: 100, outputTokens: 0 },
    };
    expect(projectModelStreamEventForSdk(event, 'request-1')).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null, container: null },
      usage: { input_tokens: 100, output_tokens: 0, request_id: 'request-1' },
    });
    expect(
      projectModelStreamEventForSdk({
        type: 'message_delta',
        delta: { stopReason: 'end_turn' },
      }),
    ).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 } });
  });

  it('在块出口转换思考元数据并保留密文、原始下标和工具身份', () => {
    const reasoning: ModelReasoningMetadata = {
      id: 'reasoning-1',
      status: 'completed',
      summary: [{ type: 'summary_text', text: '思考摘要' }],
    };
    const events: ModelStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 2,
        contentBlock: { type: 'text', text: '' },
      },
      {
        type: 'content_block_start',
        index: 4,
        contentBlock: { type: 'thinking', thinking: '', reasoning },
      },
      {
        type: 'content_block_start',
        index: 6,
        contentBlock: {
          type: 'redacted_thinking',
          data: 'ciphertext',
          reasoning,
        },
      },
      {
        type: 'content_block_start',
        index: 8,
        contentBlock: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: {},
        },
      },
      { type: 'content_block_stop', index: 4, reasoning },
    ];
    const before = structuredClone(events);
    const projected = events.map((event) =>
      projectModelStreamEventForSdk(event),
    );
    expect(projected).toEqual([
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '', citations: null },
      },
      {
        type: 'content_block_start',
        index: 4,
        content_block: {
          type: 'thinking',
          thinking: '',
          signature: '',
          reasoning_item: reasoning,
        },
      },
      {
        type: 'content_block_start',
        index: 6,
        content_block: {
          type: 'redacted_thinking',
          data: 'ciphertext',
          reasoning_item: reasoning,
        },
      },
      {
        type: 'content_block_start',
        index: 8,
        content_block: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: {},
        },
      },
      { type: 'content_block_stop', index: 4, reasoning_item: reasoning },
    ]);
    expect(projected[1]).not.toBe(events[1]);
    expect(events).toEqual(before);
    expect(events[1]).not.toHaveProperty('content_block.reasoning_item');
  });

  it('原样交付四种增量与关消息事件，不共享可变引用', () => {
    const events: ModelStreamEvent[] = [
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: '正文' },
      },
      {
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'thinking_delta', thinking: '思考' },
      },
      {
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'signature_delta', signature: 'signature' },
      },
      {
        type: 'content_block_delta',
        index: 8,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
      { type: 'content_block_stop', index: 8 },
      { type: 'message_stop' },
    ];
    for (const event of events) {
      const projected = projectModelStreamEventForSdk(event);
      expect(projected).toEqual(event);
      expect(projected).not.toBe(event);
    }
  });
});

describe('projectModelMessageForSdk', () => {
  it('只在出口投影四种完成块及宿主 MCP 身份，保留顺序且不修改输入', () => {
    const reasoning: ModelReasoningMetadata = {
      id: 'reasoning-1',
      status: 'completed',
      summary: [{ type: 'summary_text', text: '思考摘要' }],
    };
    const toolInput = { arguments: { id: 'demo-001' } };
    const blocks: ModelContentBlock[] = [];
    blocks[2] = { type: 'text', text: '正文' };
    blocks[4] = { type: 'thinking', thinking: '思考', reasoning };
    blocks[6] = { type: 'redacted_thinking', data: 'ciphertext', reasoning };
    blocks[8] = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'mcp_call',
      input: toolInput,
      inputJson: '{"arguments":{"id":"demo-001"}}',
    };
    const message: ModelMessage = {
      messageId: 'message-1',
      model: 'test-model',
      blocks,
      stopReason: 'tool_use',
    };
    const identities = {
      'tool-1': { serverName: '转换服务', toolName: '文档格式转换_查询' },
    };
    const before = structuredClone(message);
    const projected = projectModelMessageForSdk(message, undefined, identities);
    expect(projected.message).toMatchObject({
      id: 'message-1',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      container: null,
      context_management: null,
    });
    expect(projected.message.content).toEqual([
      { type: 'text', text: '正文', citations: null },
      {
        type: 'thinking',
        thinking: '思考',
        signature: '',
        reasoning_item: reasoning,
      },
      {
        type: 'redacted_thinking',
        data: 'ciphertext',
        reasoning_item: reasoning,
      },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'mcp_call',
        input: { arguments: { id: 'demo-001' } },
        mcpInfo: identities['tool-1'],
      },
    ]);
    for (const block of projected.message.content) {
      if ('reasoning_item' in block) {
        expect(block.reasoning_item).not.toBe(reasoning);
      }
      if (block.type === 'tool_use') {
        expect(block.input).not.toBe(toolInput);
        if ('mcpInfo' in block) {
          expect(block.mcpInfo).not.toBe(identities['tool-1']);
        }
        expect(block).not.toHaveProperty('inputJson');
      }
    }
    expect(message).toEqual(before);
    expect(blocks[4]).not.toHaveProperty('signature');
    expect(blocks[8]).not.toHaveProperty('mcpInfo');
  });

  it.each([false, true])(
    '按开关输出模型 token 和宿主请求身份：%s',
    (exposed) => {
      process.env[ENV_EXPOSE_TOKEN_USAGE] = String(exposed);
      process.env[ENV_EXPOSE_REQUEST_ID] = String(exposed);
      const message: ModelMessage = {
        messageId: 'message-1',
        model: 'test-model',
        blocks: [],
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
        },
      };
      const projected = projectModelMessageForSdk(message, 'request-1');
      expect(projected.message.usage).toMatchObject({
        input_tokens: exposed ? 100 : 0,
        output_tokens: exposed ? 20 : 0,
        cache_read_input_tokens: exposed ? 30 : 0,
        cache_creation_input_tokens: exposed ? 40 : 0,
        request_id: 'request-1',
      });
      expect(projected.request_id).toBe(exposed ? 'request-1' : undefined);
      expect(projected.message.stop_reason).toBeNull();
      expect(message).not.toHaveProperty('request_id');
      expect(message.usage).not.toHaveProperty('request_id');
    },
  );

  it('保留已有签名，未上报用量只在出口补零，不从模型块读取宿主身份', () => {
    const message: ModelMessage = {
      messageId: 'message-1',
      model: 'test-model',
      blocks: [
        { type: 'thinking', thinking: '思考', signature: 'signature-1' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      ],
    };
    const projected = projectModelMessageForSdk(message);
    expect(projected.message.content[0]).toMatchObject({
      signature: 'signature-1',
    });
    expect(projected.message.content[1]).not.toHaveProperty('mcpInfo');
    expect(projected.message.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(message).not.toHaveProperty('usage');
  });
});

describe('usage projection', () => {
  it('keeps request credits while masking tokens', () => {
    delete process.env[ENV_EXPOSE_TOKEN_USAGE];
    const usage = Object.assign(cloneUsage(), {
      input_tokens: 100,
      output_tokens: 20,
      request_id: 'request-1',
      billable: true,
      credits: 1.25,
      original_credits: 2.5,
    });

    expect(cloneUsageForSdkOutput(usage)).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      request_id: 'request-1',
      billable: true,
      credits: 1.25,
      original_credits: 2.5,
    });
  });

  it('removes request credits metadata from session-level result usage', () => {
    const usage = Object.assign(cloneUsage(), {
      billable: true,
      credits: 1.25,
      original_credits: 2.5,
    });

    const result = cloneUsageForSdkResult(usage);
    expect(result).not.toHaveProperty('billable');
    expect(result).not.toHaveProperty('credits');
    expect(result).not.toHaveProperty('original_credits');
  });
});

describe('splitAssistantForSdk', () => {
  it.each(['mcp__demo__u_611aec98eddc', 'mcp_call'])(
    'preserves original MCP identity in serialized %s calls',
    (name) => {
      const assistant = makeAssistant();
      const block = {
        type: 'tool_use' as const,
        id: 'mcp-call',
        name,
        inputJson: '{"id":"demo-001"}',
        input:
          name === 'mcp_call'
            ? {
                toolName: 'mcp__demo__u_611aec98eddc',
                arguments: { id: 'demo-001' },
              }
            : { id: 'demo-001' },
      };
      const identities = {
        'mcp-call': { serverName: '转换服务', toolName: '文档格式转换_查询' },
      };
      const persisted = createAssistantMessage(
        {
          messageId: assistant.message.id,
          model: assistant.message.model,
          stopReason: 'tool_use',
          blocks: [block],
          usage: ((value) => ({
            inputTokens: value.input_tokens,
            outputTokens: value.output_tokens,
            cacheReadInputTokens: value.cache_read_input_tokens,
            cacheCreationInputTokens: value.cache_creation_input_tokens,
          }))(cloneUsage()),
        },
        'request-mcp',
        identities,
      );
      identities['mcp-call'].toolName = '后续变更';
      const before = structuredClone(persisted);
      const [projected] = splitAssistantForSdk(persisted, 'session');
      expect(projected.message.content).toEqual([
        {
          type: block.type,
          id: block.id,
          name: block.name,
          input: block.input,
          mcpInfo: { serverName: '转换服务', toolName: '文档格式转换_查询' },
        },
      ]);
      expect(projected.message.content[0]).not.toHaveProperty('inputJson');
      expect(projected).not.toHaveProperty('mcpToolIdentities');
      expect(projected.message.content[0]).not.toBe(block);
      expect(persisted).toEqual(before);
      expect(persisted.message.content[0]).toHaveProperty(
        'inputJson',
        block.inputJson,
      );
      expect(persisted).not.toHaveProperty('mcpToolIdentities');
      expect(persisted.message.content[0]).not.toBe(
        projected.message.content[0],
      );
      expect(block).not.toHaveProperty('mcpInfo');
      expect(JSON.parse(JSON.stringify(projected)).message.content).toEqual(
        projected.message.content,
      );
    },
  );

  it.each([undefined, 'parent-call'])(
    '拆分后仍按调用 ID 关联身份，父调用为 %s',
    (parentId) => {
      const assistant = makeAssistant();
      assistant.parent_tool_use_id = parentId;
      assistant.message = {
        ...assistant.message,
        content: [
          { type: 'text', text: '正文' },
          {
            type: 'tool_use',
            id: 'first',
            name: 'mcp_call',
            input: {},
            inputJson: '{}',
            mcpInfo: { serverName: '转换服务', toolName: '查询' },
          },
          { type: 'tool_use', id: 'second', name: 'Read', input: {} },
        ],
      };
      const projected = splitAssistantForSdk(assistant, 'session');
      expect(projected).toHaveLength(parentId ? 2 : 3);
      const calls = projected
        .flatMap((event) => event.message.content)
        .filter((block) => block.type === 'tool_use');
      expect(calls[0]).toMatchObject({
        id: 'first',
        mcpInfo: { serverName: '转换服务', toolName: '查询' },
      });
      expect(calls[1]).not.toHaveProperty('mcpInfo');
      expect(calls[0]).not.toHaveProperty('inputJson');
    },
  );

  it('preserves the previous shape by default', () => {
    const projected = splitAssistantForSdk(
      makeAssistant('model-request-123'),
      'fallback-session',
    );

    expect(projected).toHaveLength(2);
    for (const message of projected) {
      expect(message).not.toHaveProperty('request_id');
      expect(message.message.usage).toHaveProperty(
        'request_id',
        'model-request-123',
      );
    }
  });

  it('adds the top-level id and keeps nested usage when enabled', () => {
    process.env[ENV_EXPOSE_REQUEST_ID] = '  TrUe  ';
    const projected = splitAssistantForSdk(
      makeAssistant('model-request-123'),
      'fallback-session',
    );

    expect(projected.map((message) => message.request_id)).toEqual([
      'model-request-123',
      'model-request-123',
    ]);
    for (const message of projected) {
      expect(message.message.usage).toHaveProperty(
        'request_id',
        'model-request-123',
      );
    }
  });

  it.each(['false', '1'])('does not add a top-level id for %s', (value) => {
    process.env[ENV_EXPOSE_REQUEST_ID] = value;
    const [message] = splitAssistantForSdk(
      makeAssistant('model-request-123'),
      'fallback-session',
    );
    expect(message).not.toHaveProperty('request_id');
    expect(message?.message.usage).toHaveProperty(
      'request_id',
      'model-request-123',
    );
  });

  it('falls back to nested usage when the runtime id is absent', () => {
    process.env[ENV_EXPOSE_REQUEST_ID] = 'true';
    const [message] = splitAssistantForSdk(
      makeAssistant(undefined, 'nested-request'),
      'fallback-session',
    );
    expect(message?.request_id).toBe('nested-request');
    expect(message?.message.usage).toHaveProperty(
      'request_id',
      'nested-request',
    );
  });

  it('does not invent an id for a synthetic API error', () => {
    process.env[ENV_EXPOSE_REQUEST_ID] = 'true';
    const [message] = splitAssistantForSdk(
      createAssistantAPIErrorMessage({
        content: 'Request failed',
        error: 'server_error',
      }),
      'fallback-session',
    );
    expect(message).not.toHaveProperty('request_id');
  });
});

describe('splitUserForSdk', () => {
  it.each([
    [1, undefined],
    [1, false],
    [1, true],
    [2, undefined],
    [2, false],
    [2, true],
  ] as const)(
    'preserves task-notification identity when splitting %i content blocks with isMeta=%s',
    (blockCount, isMeta) => {
      const event: UserMessage = {
        type: 'user',
        uuid: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-09-07T00:00:00.000Z',
        isMeta,
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content: Array.from({ length: blockCount }, () => ({
            type: 'text' as const,
            text: '<task-notification><event>ready</event></task-notification>',
          })),
        },
      };

      const messages = splitUserForSdk(event, 'session-monitor');

      expect(messages).toHaveLength(blockCount);
      for (const message of messages) {
        expect(message).toMatchObject({
          type: 'user',
          isSynthetic: true,
          origin: { kind: 'task-notification' },
        });
      }
    },
  );

  it.each([
    ['without an origin', undefined],
    ['with an internal origin', { kind: 'coordinator' }],
  ])('does not infer task-notification origin %s', (_caseName, origin) => {
    const event: UserMessage = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-09-07T00:00:00.000Z',
      ...(origin === undefined ? {} : { origin }),
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<task-notification><event>ready</event></task-notification>',
          },
        ],
      },
    };

    const [message] = splitUserForSdk(event, 'session-monitor');

    expect(message).not.toHaveProperty('origin');
  });

  it('projects full Edit results to the compact SDK shape', () => {
    const event: UserMessage = {
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-09-04T00:00:00.000Z',
      sessionId: 'session-edit',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-edit',
            content: 'Updated /workspace/example.ts',
          },
        ],
      },
      toolUseResult: {
        filePath: '/workspace/example.ts',
        oldString: 'old',
        newString: 'new',
        originalFile: 'old'.repeat(6 * 1024 * 1024),
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-old', '+new'],
          },
        ],
        userModified: false,
        replaceAll: false,
      },
    };

    const [projected] = splitUserForSdk(event, 'fallback-session');
    expect(projected).toMatchObject({
      tool_use_result: {
        success: true,
        file_path: '/workspace/example.ts',
        additions: 1,
        deletions: 1,
      },
    });
    expect(
      (projected as Record<string, unknown>)['tool_use_result'],
    ).not.toHaveProperty('originalFile');
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThan(
      16 * 1024 * 1024,
    );
  });

  it('does not reinterpret MCP results that resemble file tool results', () => {
    const fileShapedResult = {
      filePath: '/workspace/example.ts',
      oldString: 'old',
      newString: 'new',
      originalFile: 'old',
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    };
    const event: UserMessage = {
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-09-04T00:00:00.000Z',
      sessionId: 'session-mcp-file-shape',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-mcp',
            content: 'MCP result',
          },
        ],
      },
      toolUseResult: fileShapedResult,
      mcpMeta: { structuredContent: { source: 'mcp' } },
    };

    expect(splitUserForSdk(event, 'fallback-session')[0]).toMatchObject({
      tool_use_result: {
        content: fileShapedResult,
        structuredContent: { source: 'mcp' },
      },
    });
  });

  it('在 SDK 出口保留会话媒体字段且不修改历史', () => {
    const event: UserMessage = {
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-08-28T00:00:00.000Z',
      sessionId: 'session-image-sources',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aW1hZ2U=',
            },
          },
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.test/uploaded-image.png',
            },
          },
        ],
      },
    };

    const projected = splitUserForSdk(event, 'fallback-session');

    expect(
      projected.map((message) =>
        message.type === 'user' ? message.message.content[0] : undefined,
      ),
    ).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
      },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.test/uploaded-image.png' },
      },
    ]);
    expect(event.message.content).toMatchObject([
      { source: { media_type: 'image/png' } },
      { source: { type: 'url' } },
    ]);
  });

  it.each([undefined, '5m', '1h'])(
    '在文本、图片和工具结果出口保留缓存元数据且不修改只读输入：%s',
    (ttl) => {
      const cacheControl = Object.freeze({ type: 'ephemeral' as const, ttl });
      const blocks: readonly ModelInputContentBlock[] = Object.freeze([
        Object.freeze({ type: 'text', text: '正文', cacheControl }),
        Object.freeze({
          type: 'image',
          source: Object.freeze({
            type: 'base64',
            mediaType: 'image/png',
            data: 'aW1hZ2U=',
          }),
          cacheControl,
        }),
        Object.freeze({
          type: 'image',
          source: Object.freeze({
            type: 'url',
            url: 'https://example.test/image.png',
          }),
          cacheControl,
        }),
      ]);
      const cache_control = { type: 'ephemeral', ...(ttl ? { ttl } : {}) };
      const expectedBlocks = [
        { type: 'text', text: '正文', cache_control },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
          cache_control,
        },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.test/image.png' },
          cache_control,
        },
      ];
      const event = createUserMessage(blocks.map(modelInputToTranscriptBlock));
      const before = structuredClone(event);
      const projected = splitUserForSdk(event, 'session-cache');
      expect(
        projected.map((message) =>
          message.type === 'user' ? message.message.content : undefined,
        ),
      ).toEqual(expectedBlocks.map((block) => [block]));

      const toolResult: UserMessage = {
        ...event,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-cache',
              content: blocks.map(modelInputToTranscriptBlock),
            },
          ],
        },
      };
      expect(splitUserForSdk(toolResult, 'session-cache')[0]).toMatchObject({
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-cache',
              content: expectedBlocks,
            },
          ],
        },
      });
      expect(event).toEqual(before);
      for (let index = 0; index < blocks.length; index++) {
        const message = projected[index];
        if (
          message.type !== 'user' ||
          typeof message.message.content === 'string'
        ) {
          throw new Error('应输出结构化 SDK 用户消息');
        }
        const wireBlock = message.message.content[0];
        expect(wireBlock).not.toBe(blocks[index]);
        expect(wireBlock).not.toHaveProperty('cacheControl');
        if (wireBlock.type === 'image') {
          const inputBlock = blocks[index];
          if (inputBlock.type !== 'image') throw new Error('应保留图片顺序');
          expect(wireBlock.source).not.toBe(inputBlock.source);
        }
      }
    },
  );

  it('不将 SDK 不支持的缓存 TTL 静默改为另一种 TTL', () => {
    const event = createUserMessage([
      {
        type: 'text',
        text: '正文',
        cache_control: { type: 'ephemeral', ttl: '30m' },
      },
    ]);
    expect(() => splitUserForSdk(event, 'session-cache')).toThrow(
      'Unsupported SDK cache TTL: 30m',
    );
  });

  it('图片降级为文本时仍保留缓存元数据', () => {
    const event = createUserMessage([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/svg+xml',
          data: 'PHN2Zz4=',
        },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(splitUserForSdk(event, 'session-cache')[0]).toMatchObject({
      message: {
        content: [
          {
            type: 'text',
            text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    });
  });

  it('preserves an image inside the tool_result user event', () => {
    const event: UserMessage = {
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-07-16T12:00:00.000Z',
      sessionId: 'session-image',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-image',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aW1hZ2U=',
                },
              },
            ],
          },
        ],
      },
      toolUseResult: {
        type: 'image',
        file: {
          base64: 'aW1hZ2U=',
          type: 'image/png',
          originalSize: 5,
        },
      },
    };

    expect(splitUserForSdk(event, 'fallback-session')).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-image',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'aW1hZ2U=',
                  },
                },
              ],
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'session-image',
        uuid: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-07-16T12:00:00.000Z',
        isSynthetic: false,
        tool_use_result: {
          type: 'image',
          file: {
            base64: 'aW1hZ2U=',
            type: 'image/png',
            originalSize: 5,
          },
        },
      },
    ]);
  });

  it('keeps a single MCP semantic array intact and merges its host metadata', () => {
    const semanticResult = [
      { type: 'text' as const, text: 'app payload' },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
    ];
    const event: UserMessage = {
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-08-19T12:00:00.000Z',
      sessionId: 'session-mcp',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-mcp',
            content: 'app payload',
          },
        ],
      },
      toolUseResult: semanticResult,
      mcpMeta: {
        _meta: { ui: { resourceUri: 'ui://example/app' } },
        structuredContent: { id: 7 },
      },
    };

    expect(splitUserForSdk(event, 'fallback-session')[0]).toMatchObject({
      tool_use_result: {
        content: semanticResult,
        _meta: { ui: { resourceUri: 'ui://example/app' } },
        structuredContent: { id: 7 },
      },
    });
  });

  it('projects non-execution metadata by tool id without marking execution failures', () => {
    const event: UserMessage = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-08-13T12:00:00.000Z',
      sessionId: 'session-tools',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-ran',
            content: 'Execution failed',
            is_error: true,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-policy',
            content: 'Permission denied',
            is_error: true,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-user',
            content: 'User rejected',
            is_error: true,
          },
        ],
      },
      toolUseResult: [undefined, { status: 'denied' }, undefined],
      toolDenialKind: [undefined, 'permission-rule', 'user-rejected'],
      userFeedback: [undefined, undefined, 'Use a different approach'],
    };

    const messages = splitUserForSdk(event, 'fallback-session');

    expect(messages).toHaveLength(3);
    expect(messages[0]).not.toHaveProperty('tool_result_meta');
    expect(messages[0]).not.toHaveProperty('tool_use_result');
    expect(messages[1]).toMatchObject({
      tool_use_result: { status: 'denied' },
      tool_result_meta: [
        {
          id: 'tool-policy',
          non_execution_kind: 'permission-rule',
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      tool_result_meta: [
        {
          id: 'tool-user',
          non_execution_kind: 'user-rejected',
          user_feedback: 'Use a different approach',
        },
      ],
    });
  });
});
