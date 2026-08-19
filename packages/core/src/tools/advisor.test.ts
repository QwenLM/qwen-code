/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { AdvisorTool, ADVISOR_SYSTEM_INSTRUCTION } from './advisor.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';
import { Kind } from './tools.js';

const mockRunSideQuery = vi.hoisted(() => vi.fn());

vi.mock('../utils/sideQuery.js', () => ({
  runSideQuery: mockRunSideQuery,
}));

function makeConfig(options: {
  advisorModel?: string;
  advisorMaxUses?: number;
  history?: Content[];
}): Config {
  const history =
    options.history ??
    ([
      {
        role: 'user',
        parts: [
          { text: 'please fix the bug' },
          { text: 'hidden thought', thought: true },
          {
            inlineData: {
              mimeType: 'image/png',
              displayName: 'screenshot.png',
              data: 'raw-bytes',
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'I found the likely area.' },
          { functionCall: { name: ToolNames.ADVISOR, args: {} } },
        ],
      },
    ] as Content[]);

  return {
    getAdvisorModel: () => options.advisorModel,
    getAdvisorMaxUses: () => options.advisorMaxUses,
    getGeminiClient: () => ({
      getChat: () => ({
        getGenerationConfig: () => ({
          systemInstruction: { parts: [{ text: 'executor system' }] },
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
        }),
        getHistory: () => history,
      }),
    }),
  } as unknown as Config;
}

describe('AdvisorTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSideQuery.mockResolvedValue({ text: 'check the edge case' });
  });

  it('declares the native Advisor contract', async () => {
    const tool = new AdvisorTool(makeConfig({ advisorModel: 'advisor-model' }));

    expect(tool.name).toBe(ToolNames.ADVISOR);
    expect(tool.displayName).toBe('Advisor');
    expect(tool.kind).toBe(Kind.Think);
    expect(tool.isOutputMarkdown).toBe(true);
    expect(tool.canUpdateOutput).toBe(false);
    expect(tool.shouldDefer).toBe(false);
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });

    const invocation = tool.build({});
    expect(invocation.toolLocations()).toEqual([]);
    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    expect(() => tool.build({ extra: true } as never)).toThrow();
  });

  it('runs Advisor as a no-tools side query with sanitized evidence', async () => {
    const config = makeConfig({ advisorModel: 'advisor-model' });
    const tool = new AdvisorTool(config);
    const signal = new AbortController().signal;

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(signal),
    );

    expect(mockRunSideQuery).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        model: 'advisor-model',
        systemInstruction: ADVISOR_SYSTEM_INSTRUCTION,
        abortSignal: signal,
        promptId: 'side-query:advisor:prompt-1:1',
        skipOutputLanguagePreference: true,
        maxAttempts: 1,
        failClosed: true,
      }),
    );
    const [, options] = mockRunSideQuery.mock.calls[0];
    expect(options).not.toHaveProperty('tools');
    const evidenceText = options.contents[0].parts[0].text;
    const evidence = JSON.parse(evidenceText);
    expect(evidence.executorSystemInstruction).toEqual({
      parts: [{ text: 'executor system' }],
    });
    expect(evidence.executorToolDeclarations).toEqual([
      { functionDeclarations: [{ name: 'read_file' }] },
    ]);
    expect(evidence.transcript).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'please fix the bug' },
          {
            inlineData: {
              mimeType: 'image/png',
              displayName: 'screenshot.png',
              data: '<binary omitted>',
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'I found the likely area.' }],
      },
    ]);
    expect(evidence.marker).toEqual({
      type: 'advisor_consultation',
      promptId: 'prompt-1',
    });
    expect(result.error).toBeUndefined();
    expect(String(result.llmContent)).toContain('<advisor_feedback>');
    expect(result.returnDisplay).toBe('check the edge case');
  });

  it('propagates user cancellation instead of returning a tool error', async () => {
    const config = makeConfig({ advisorModel: 'advisor-model' });
    const tool = new AdvisorTool(config);
    const controller = new AbortController();
    const abortError = new Error('user cancelled');
    mockRunSideQuery.mockImplementationOnce(() => {
      controller.abort(abortError);
      return Promise.reject(abortError);
    });

    await expect(
      promptIdContext.run('prompt-1', () =>
        tool.build({}).execute(controller.signal),
      ),
    ).rejects.toBe(abortError);
  });

  it('stops waiting when cancellation fires before Advisor responds', async () => {
    const config = makeConfig({ advisorModel: 'advisor-model' });
    const tool = new AdvisorTool(config);
    const controller = new AbortController();
    const abortError = new Error('user cancelled');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    mockRunSideQuery.mockImplementationOnce(() => {
      markStarted();
      return new Promise(() => undefined);
    });

    const execution = promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(controller.signal),
    );
    await started;
    controller.abort(abortError);

    await expect(execution).rejects.toBe(abortError);
  });

  it('includes prior tool calls and tool results in the evidence transcript', async () => {
    const config = makeConfig({
      advisorModel: 'advisor-model',
      history: [
        {
          role: 'user',
          parts: [{ text: 'inspect package.json first' }],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
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
                id: 'call-1',
                name: 'read_file',
                response: { output: '{"name":"qwen-code"}' },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            { text: 'package metadata is available.' },
            { functionCall: { name: ToolNames.ADVISOR, args: {} } },
          ],
        },
      ],
    });
    const tool = new AdvisorTool(config);

    await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    const [, options] = mockRunSideQuery.mock.calls[0];
    const evidence = JSON.parse(options.contents[0].parts[0].text);
    expect(evidence.transcript).toEqual([
      {
        role: 'user',
        parts: [{ text: 'inspect package.json first' }],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-1',
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
              id: 'call-1',
              name: 'read_file',
              response: { output: '{"name":"qwen-code"}' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'package metadata is available.' }],
      },
    ]);
  });

  it('returns disabled without calling the provider when Advisor is off', async () => {
    const tool = new AdvisorTool(makeConfig({ advisorModel: undefined }));

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(mockRunSideQuery).not.toHaveBeenCalled();
    expect(result.error?.message).toContain('code="disabled"');
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(String(result.llmContent)).toContain('code="disabled"');
  });

  it('limits Advisor consultations per prompt id', async () => {
    const tool = new AdvisorTool(
      makeConfig({ advisorModel: 'advisor-model', advisorMaxUses: 1 }),
    );

    await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );
    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(mockRunSideQuery).toHaveBeenCalledTimes(1);
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(String(result.llmContent)).toContain('code="max_uses_exceeded"');
  });

  it('returns missing_prompt_context without calling the provider', async () => {
    const tool = new AdvisorTool(makeConfig({ advisorModel: 'advisor-model' }));

    const result = await tool.build({}).execute(new AbortController().signal);

    expect(mockRunSideQuery).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toContain(
      'code="missing_prompt_context"',
    );
  });

  it('consumes configured uses before failed requests and resets for a new prompt', async () => {
    mockRunSideQuery.mockRejectedValueOnce(new Error('temporary failure'));
    const tool = new AdvisorTool(
      makeConfig({ advisorModel: 'advisor-model', advisorMaxUses: 1 }),
    );

    await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );
    const second = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );
    const third = await promptIdContext.run('prompt-2', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(mockRunSideQuery).toHaveBeenCalledTimes(2);
    expect(String(second.llmContent)).toContain('code="max_uses_exceeded"');
    expect(third.error).toBeUndefined();
  });

  it('maps empty Advisor responses to invalid_response', async () => {
    mockRunSideQuery.mockRejectedValueOnce(
      new Error('Advisor returned an empty response.'),
    );
    const tool = new AdvisorTool(makeConfig({ advisorModel: 'advisor-model' }));

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(String(result.llmContent)).toContain('code="invalid_response"');
  });

  it.each([
    [
      'provider_auth',
      Object.assign(new Error('credentials rejected'), { status: 401 }),
    ],
    ['model_not_found', new Error('model advisor-model not found')],
  ] as const)('maps provider failures to %s', async (code, error) => {
    mockRunSideQuery.mockRejectedValueOnce(error);
    const tool = new AdvisorTool(makeConfig({ advisorModel: 'advisor-model' }));

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(String(result.llmContent)).toContain(`code="${code}"`);
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
  });

  it('rejects sibling tool calls in the current model response', async () => {
    const tool = new AdvisorTool(
      makeConfig({
        advisorModel: 'advisor-model',
        history: [
          {
            role: 'model',
            parts: [
              { functionCall: { name: ToolNames.ADVISOR, args: {} } },
              { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
            ],
          },
        ],
      }),
    );

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(mockRunSideQuery).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toContain('code="invalid_call_order"');
  });
});
