/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { AdvisorTool, ADVISOR_SYSTEM_INSTRUCTION } from './advisor.js';
import { ToolNames } from './tool-names.js';
import { Kind } from './tools.js';

const mockRunForkedAgent = vi.hoisted(() => vi.fn());

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: mockRunForkedAgent,
}));

const review = {
  verdict: 'The approach is sound.',
  risks: 'Retries are not covered.',
  missingEvidence: 'No failing test output was shown.',
  recommendation: 'Add one focused regression test.',
};

function makeConfig(history?: Content[]): Config {
  return {
    getModel: () => 'executor-model',
    getAdvisorModel: () => 'advisor-model',
    getContentGeneratorConfig: () => undefined,
    getFastModel: () => undefined,
    getAllConfiguredModels: () => [],
    getGeminiClient: () => ({
      getChat: () => ({
        getGenerationConfig: () => ({
          systemInstruction: { parts: [{ text: 'executor system' }] },
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
        }),
        getHistory: () =>
          history ??
          ([
            { role: 'user', parts: [{ text: 'fix the bug' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'read-1',
                    name: 'read_file',
                    args: { path: 'package.json' },
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'read-1',
                    name: 'read_file',
                    response: { output: '{"name":"qwen-code"}' },
                  },
                },
              ],
            },
            {
              role: 'model',
              parts: [
                { text: 'I inspected the package.' },
                { text: 'hidden reasoning', thought: true },
                {
                  inlineData: { mimeType: 'image/png', data: 'raw-bytes' },
                },
                { functionCall: { name: ToolNames.ADVISOR, args: {} } },
                { text: 'text after the call must not be forwarded' },
              ],
            },
          ] as Content[]),
      }),
    }),
  } as unknown as Config;
}

describe('AdvisorTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunForkedAgent.mockResolvedValue({
      text: JSON.stringify(review),
      jsonResult: review,
      usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
      model: 'advisor-model',
    });
  });

  it('declares an empty, no-permission tool contract', async () => {
    const tool = new AdvisorTool(makeConfig());

    expect(tool.name).toBe(ToolNames.ADVISOR);
    expect(tool.kind).toBe(Kind.Think);
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    await expect(tool.build({}).getDefaultPermission()).resolves.toBe('allow');
    expect(() => tool.build({ extra: true } as never)).toThrow();
  });

  it('uses the configured model with full sanitized evidence and no tools', async () => {
    let source: string | undefined;
    mockRunForkedAgent.mockImplementationOnce(async () => {
      source = subagentNameContext.getStore();
      return {
        text: JSON.stringify(review),
        jsonResult: review,
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
        model: 'advisor-model',
      };
    });
    const signal = new AbortController().signal;
    const config = makeConfig();

    const result = await new AdvisorTool(config).build({}).execute(signal);

    expect(source).toBe('advisor');
    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        model: 'advisor-model',
        abortSignal: signal,
        disableModelFallbacks: true,
        jsonSchema: expect.objectContaining({
          required: ['verdict', 'risks', 'missingEvidence', 'recommendation'],
        }),
        cacheSafeParams: {
          generationConfig: {
            systemInstruction: ADVISOR_SYSTEM_INSTRUCTION,
          },
          history: [],
          model: 'executor-model',
          version: 0,
        },
      }),
    );
    const input = JSON.parse(
      mockRunForkedAgent.mock.calls[0][0].userMessage,
    ) as Record<string, unknown>;
    expect(input['executorSystemInstruction']).toEqual({
      parts: [{ text: 'executor system' }],
    });
    expect(JSON.stringify(input['executorToolDeclarations'])).toContain(
      'read_file',
    );
    const transcript = JSON.stringify(input['transcript']);
    expect(transcript).toContain('fix the bug');
    expect(transcript).toContain('functionCall');
    expect(transcript).toContain('functionResponse');
    expect(transcript).toContain('I inspected the package.');
    expect(transcript).toContain('<binary omitted>');
    expect(transcript).not.toContain('hidden reasoning');
    expect(transcript).not.toContain('text after the call');
    expect(transcript).not.toContain('"name":"advisor"');
    expect(result).toEqual({
      llmContent: expect.stringContaining('## Verdict'),
      returnDisplay: {
        type: 'advisor_review',
        model: 'advisor-model',
        ...review,
      },
    });
    expect(String(result.llmContent)).toContain('## Recommendation');
  });

  it('returns provider and schema failures to the executor without throwing', async () => {
    mockRunForkedAgent.mockRejectedValueOnce(new Error('provider unavailable'));
    const tool = new AdvisorTool(makeConfig());

    const providerFailure = await tool
      .build({})
      .execute(new AbortController().signal);
    expect(providerFailure.error?.message).toBe('provider unavailable');
    expect(providerFailure.llmContent).toContain('Continue the task');

    mockRunForkedAgent.mockResolvedValueOnce({
      text: '{}',
      jsonResult: {},
      usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
      model: 'advisor-model',
    });
    const schemaFailure = await tool
      .build({})
      .execute(new AbortController().signal);
    expect(schemaFailure.error?.message).toContain('invalid structured output');
  });

  it('does not fall back to the executor when the Advisor model no longer resolves', async () => {
    const config = {
      ...makeConfig(),
      getAdvisorModel: () => 'fast',
    } as Config;

    const result = await new AdvisorTool(config)
      .build({})
      .execute(new AbortController().signal);

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(result.error?.message).toBe('Advisor model is no longer available.');
  });

  it('accepts structured Advisor JSON returned as text', async () => {
    mockRunForkedAgent.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(review)}\n\`\`\``,
      jsonResult: undefined,
      usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
      model: 'advisor-model',
    });

    const result = await new AdvisorTool(makeConfig())
      .build({})
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toEqual({
      type: 'advisor_review',
      model: 'advisor-model',
      ...review,
    });
  });

  it('recovers an array-wrapped review from the text fallback', async () => {
    mockRunForkedAgent.mockResolvedValueOnce({
      text: JSON.stringify([review]),
      jsonResult: [review],
      usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
      model: 'advisor-model',
    });

    const result = await new AdvisorTool(makeConfig())
      .build({})
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toEqual({
      type: 'advisor_review',
      model: 'advisor-model',
      ...review,
    });
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    const abortError = new Error('cancelled');
    mockRunForkedAgent.mockImplementationOnce(() => {
      controller.abort(abortError);
      return Promise.reject(abortError);
    });

    await expect(
      new AdvisorTool(makeConfig()).build({}).execute(controller.signal),
    ).rejects.toBe(abortError);
  });
});
