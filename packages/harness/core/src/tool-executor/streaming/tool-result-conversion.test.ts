/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { PartListUnion } from '@google/genai';
import { testListedModel } from '../../test-utils/listed-model.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import type { ToolResult } from '../../tools/tools.js';
import type { ToolExecutionResult } from './tool-execution-result.js';
import { convertToolResultToCompletedToolCall } from './pre-execution-gate.js';
import { completedToolCallToResult } from './tool-result-conversion.js';
import {
  createAssistantMessage,
  createToolResultMessage,
} from '../../protocol/transcript/conversions.js';
import {
  convertMessages,
  normalizeMessagesForAPI,
} from '../../protocol/provider/request-converter.js';
import { buildChatCompletionsStreamReq } from '../../provider/transport/impl/chat-completions-factory/request/chatCompletionsStreamReqFactory.js';
import { buildMessagesStreamReq } from '../../provider/transport/impl/messages-factory/request/messagesStreamReqFactory.js';
import { buildResponsesStreamReq } from '../../provider/transport/impl/responses-factory/request/responsesStreamReqFactory.js';

const visionModel = testListedModel('vision-model', { is_vl: true });
const tool = new MockTool({ name: 'Read' });
const image = { inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } };
const imageContent = {
  type: 'image',
  source: { type: 'base64', data: 'aW1hZ2U=', mediaType: 'image/png' },
};

function makeExecution(
  llmContent: PartListUnion,
  overrides: Partial<ToolResult> = {},
): ToolExecutionResult {
  return {
    request: {
      callId: 'read-image',
      name: 'Read',
      args: { file_path: '/test/image.png' },
      prompt_id: 'prompt',
    },
    tool,
    invocation: tool.build({}),
    result: { llmContent, returnDisplay: 'Read image', ...overrides },
    error: undefined,
    cancelled: false,
    durationMs: 1,
  };
}

function convert(execution: ToolExecutionResult, vision = true) {
  const completed = convertToolResultToCompletedToolCall(
    execution,
    'root',
    vision ? visionModel : testListedModel('text-model'),
  );
  return completedToolCallToResult(completed);
}

describe('tool result multimodal conversion', () => {
  it('preserves Read image data nested by the vision-model conversion', () => {
    const semanticResult = { type: 'image', file: { base64: 'aW1hZ2U=' } };
    const execution = makeExecution([image], { toolUseResult: semanticResult });
    const completed = convertToolResultToCompletedToolCall(
      execution,
      'root',
      visionModel,
    );
    expect(completed.response.responseParts[0].functionResponse?.parts).toEqual([
      image,
    ]);
    expect(completed.resultMessages).toBeUndefined();
    expect(completedToolCallToResult(completed)).toMatchObject({
      tool_use_id: 'read-image',
      content: [
        { type: 'text', text: 'Binary content provided (1 item(s)).' },
        imageContent,
      ],
      toolUseResult: semanticResult,
      is_error: false,
    });
  });

  it('keeps text and every image in order without deduplicating equal data', () => {
    expect(convert(makeExecution([{ text: 'caption' }, image, image])).content)
      .toEqual([{ type: 'text', text: 'caption' }, imageContent, imageContent]);
  });

  it('continues to preserve sibling inlineData for the non-nested path', () => {
    expect(convert(makeExecution([image]), false).content).toEqual([
      { type: 'text', text: 'Binary content provided (1 item(s)).' },
      imageContent,
    ]);
  });

  it('preserves fileData siblings alongside nested images', () => {
    expect(
      convert(
        makeExecution([
          image,
          { fileData: { mimeType: 'image/jpeg', fileUri: 'https://test/image.jpg' } },
        ]),
      ).content,
    ).toEqual([
      { type: 'text', text: 'Binary content provided (2 item(s)).' },
      imageContent,
      { type: 'image', source: { type: 'url', url: 'https://test/image.jpg' } },
    ]);
  });

  it('uses the same unsupported-media placeholder for nested and sibling data', () => {
    const execution = makeExecution([
      { inlineData: { data: 'audio', mimeType: 'audio/wav' } },
    ]);
    const nested = convert(execution).content;
    const sibling = convert(execution, false).content;
    expect(nested).toEqual(sibling);
    expect(nested).not.toEqual('Binary content provided (1 item(s)).');
    expect(JSON.stringify(nested)).not.toContain('"type":"image"');
  });

  it('handles nested fileData and empty inline data without inventing images', () => {
    const completed = convertToolResultToCompletedToolCall(
      makeExecution('caption'),
      'root',
      visionModel,
    );
    completed.response.responseParts[0].functionResponse!.parts = [
      { inlineData: { data: '', mimeType: 'image/png' } },
      { fileData: { mimeType: 'image/jpeg', fileUri: 'https://test/image.jpg' } },
    ];
    expect(completedToolCallToResult(completed).content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'url', url: 'https://test/image.jpg' } },
    ]);
  });

  it('carries Read images through transcript conversion into all three wire formats', () => {
    const result = convert(makeExecution([image]));
    const assistant = createAssistantMessage({
      messageId: 'assistant',
      model: visionModel.key,
      blocks: [{ type: 'tool_use', id: 'read-image', name: 'Read', input: {} }],
    });
    const history = [assistant, createToolResultMessage([result], assistant.uuid)];
    const request = {
      resolution: { model: visionModel, config: {} },
      prompt: { messages: convertMessages(normalizeMessagesForAPI(history)) },
    };
    const url = 'data:image/png;base64,aW1hZ2U=';
    expect(buildChatCompletionsStreamReq(request).messages[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'read-image',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'image_url', image_url: { url } }),
      ]),
    });
    expect(buildMessagesStreamReq(request).messages[1]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'read-image',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
            }),
          ]),
        }),
      ]),
    });
    expect(buildResponsesStreamReq(request).input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'read-image',
          output: expect.arrayContaining([{ type: 'input_image', image_url: url }]),
        }),
      ]),
    );
  });

  it('does not restore semantic images absent from finalized model output', () => {
    expect(
      convert(
        makeExecution('budgeted output', {
          toolUseResult: { type: 'image', file: { base64: 'unbudgeted' } },
        }),
      ).content,
    ).toBe('budgeted output');
  });

  it('preserves text-only output, empty-output fallback and semantic errors', () => {
    expect(convert(makeExecution('plain text')).content).toBe('plain text');
    expect(convert(makeExecution('')).content).toBe('(Read completed with no output)');
    expect(convert(makeExecution('denied', { isError: true }))).toMatchObject({
      content: 'denied',
      is_error: true,
    });
  });

  it('preserves cancellation and execution-error behavior', () => {
    const execution = makeExecution([image]);
    const error = new Error('Read failed');
    expect(convert({ ...execution, result: undefined, error })).toMatchObject({
      content: 'Error: Read failed',
      is_error: true,
    });
    const cancelled = convert({ ...execution, cancelled: true });
    expect(cancelled.is_error).toBe(true);
    expect(typeof cancelled.content).toBe('string');
  });
});
