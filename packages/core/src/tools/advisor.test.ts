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

const mockRunForkedAgent = vi.hoisted(() => vi.fn());
const mockTokenLimit = vi.hoisted(() => vi.fn(() => 1_000_000));

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: mockRunForkedAgent,
}));

vi.mock('../core/tokenLimits.js', () => ({
  tokenLimit: mockTokenLimit,
}));

const ADVISOR_REVIEW = {
  verdict: 'Check the edge case.',
  risks: 'The current plan may miss retries.',
  missingEvidence: 'No failing test output was shown.',
  recommendation: 'Add a focused regression test.',
};

const ADVISOR_FORKED_RESULT = {
  text: JSON.stringify(ADVISOR_REVIEW),
  jsonResult: ADVISOR_REVIEW,
  usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
  model: 'advisor-model',
};

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
    getModel: () => 'executor-model',
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
    mockTokenLimit.mockReturnValue(1_000_000);
    mockRunForkedAgent.mockResolvedValue(ADVISOR_FORKED_RESULT);
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

  it('runs Advisor as a no-tools forked agent with sanitized evidence', async () => {
    const config = makeConfig({ advisorModel: 'advisor-model' });
    const tool = new AdvisorTool(config);
    const signal = new AbortController().signal;

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(signal),
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        model: 'advisor-model',
        abortSignal: signal,
        promptId: 'side-query:advisor:prompt-1:1',
        disableModelFallbacks: true,
        jsonSchema: expect.objectContaining({
          required: ['verdict', 'risks', 'missingEvidence', 'recommendation'],
        }),
      }),
    );
    const [options] = mockRunForkedAgent.mock.calls[0];
    expect(options.cacheSafeParams).toMatchObject({
      history: [],
      model: 'executor-model',
      version: 0,
    });
    expect(options.cacheSafeParams.generationConfig).toEqual({
      systemInstruction: ADVISOR_SYSTEM_INSTRUCTION,
    });
    expect(options.cacheSafeParams.generationConfig).not.toHaveProperty(
      'tools',
    );
    const evidenceText = options.userMessage;
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
    expect(result.llmContent).toContain('## Verdict');
    expect(result.returnDisplay).toEqual({
      type: 'advisor_review',
      ...ADVISOR_REVIEW,
    });
  });

  it('propagates user cancellation instead of returning a tool error', async () => {
    const config = makeConfig({ advisorModel: 'advisor-model' });
    const tool = new AdvisorTool(config);
    const controller = new AbortController();
    const abortError = new Error('user cancelled');
    mockRunForkedAgent.mockImplementationOnce(() => {
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
    mockRunForkedAgent.mockImplementationOnce(() => {
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

    const [options] = mockRunForkedAgent.mock.calls[0];
    const evidence = JSON.parse(options.userMessage);
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

  it('truncates oversized text values before sending evidence', async () => {
    const longOutput = 'x'.repeat(12_050);
    const config = makeConfig({
      advisorModel: 'advisor-model',
      history: [
        {
          role: 'user',
          parts: [{ text: 'inspect the generated output' }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'run_shell_command',
                response: { output: longOutput },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            { text: 'The output is large.' },
            { functionCall: { name: ToolNames.ADVISOR, args: {} } },
          ],
        },
      ],
    });

    await promptIdContext.run('prompt-1', () =>
      new AdvisorTool(config).build({}).execute(new AbortController().signal),
    );

    const [options] = mockRunForkedAgent.mock.calls[0];
    const evidence = JSON.parse(options.userMessage);
    const output =
      evidence.transcript[1].parts[0].functionResponse.response.output;
    expect(output).toContain('<truncated 50 chars>');
    expect(output).not.toBe(longOutput);
  });

  it('omits oldest transcript entries to fit the Advisor model context', async () => {
    mockTokenLimit.mockReturnValue(32_768);
    const history: Content[] = Array.from({ length: 20 }, (_, index) => ({
      role: 'user',
      parts: [{ text: `old-${index}-${'x'.repeat(12_000)}` }],
    }));
    history.push(
      {
        role: 'user',
        parts: [{ text: 'keep the most recent evidence' }],
      },
      {
        role: 'model',
        parts: [
          { text: 'Ready to ask Advisor.' },
          { functionCall: { name: ToolNames.ADVISOR, args: {} } },
        ],
      },
    );

    const config = makeConfig({ advisorModel: 'small-advisor-model', history });

    await promptIdContext.run('prompt-1', () =>
      new AdvisorTool(config).build({}).execute(new AbortController().signal),
    );

    const [options] = mockRunForkedAgent.mock.calls[0];
    const evidenceText = options.userMessage;
    const evidence = JSON.parse(evidenceText);
    expect(evidenceText.length).toBeLessThanOrEqual(32_768 * 4 * 0.75);
    expect(evidence.truncation.omittedTranscriptEntries).toBeGreaterThan(0);
    expect(evidenceText).toContain('keep the most recent evidence');
  });

  it('returns disabled without calling the provider when Advisor is off', async () => {
    const tool = new AdvisorTool(makeConfig({ advisorModel: undefined }));

    const result = await promptIdContext.run('prompt-1', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
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

    expect(mockRunForkedAgent).toHaveBeenCalledTimes(1);
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(String(result.llmContent)).toContain('code="max_uses_exceeded"');
  });

  it('returns missing_prompt_context without calling the provider', async () => {
    const tool = new AdvisorTool(makeConfig({ advisorModel: 'advisor-model' }));

    const result = await tool.build({}).execute(new AbortController().signal);

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toContain(
      'code="missing_prompt_context"',
    );
  });

  it('does not consume configured uses for failed requests', async () => {
    mockRunForkedAgent.mockRejectedValueOnce(new Error('temporary failure'));
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
    const fourth = await promptIdContext.run('prompt-2', () =>
      tool.build({}).execute(new AbortController().signal),
    );

    expect(mockRunForkedAgent).toHaveBeenCalledTimes(3);
    expect(second.error).toBeUndefined();
    expect(third.error).toBeUndefined();
    expect(String(fourth.llmContent)).toContain('code="max_uses_exceeded"');
  });

  it('maps invalid Advisor responses to invalid_response', async () => {
    mockRunForkedAgent.mockResolvedValueOnce({
      ...ADVISOR_FORKED_RESULT,
      jsonResult: { verdict: '' },
    });
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
    mockRunForkedAgent.mockRejectedValueOnce(error);
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

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toContain('code="invalid_call_order"');
  });
});
