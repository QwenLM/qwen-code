/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { withSessionSelection } from '../test-utils/request-model.js';


import { testRequestConfig } from '../test-utils/model-resolution.js';
import type { Config } from '../config/config.js';
import { testModelResolution } from '../test-utils/model-resolution.js';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from './agent-loop.js';
import {
  runSideQuestion,
  SIDE_QUESTION_SYSTEM_REMINDER,
} from './side-question.js';
import { wrapWithParentToolSchemas } from '../agents/fork-subagent.js';

vi.mock('./agent-loop.js', () => ({
  query: vi.fn(() =>
    (async function* () {
      yield {
        type: 'assistant' as const,
        message: { content: [] },
      };
      return {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        durationMs: 1,
      };
    })(),
  ),
}));

function sideQuestionConfig(getModelPolicy?: Config['getModelPolicy']): Config {
  const manager = {
    listModels: async () => [],
    getModel: async (key: string) => testModelResolution(key).model,
    select: vi.fn(),
  };
  const config = {
    ...testRequestConfig(),
    getModel: () => 'session-model',
    getSessionId: () => 'side-question-test',
    getModelPolicy,
    getModelProviderManager: () => manager,
  } as unknown as Config;
  const scoped = withSessionSelection(manager, config);
  vi.spyOn(scoped, 'select');
  config.getModelProviderManager = () => scoped as unknown as ReturnType<Config['getModelProviderManager']>;
  return config;
}

vi.mock('../agents/fork-subagent.js', () => ({
  wrapWithParentToolSchemas: vi.fn(() => ({})),
}));

describe('runSideQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('forwards the request customContext to the side-question query', async () => {
    const customContext = Object.freeze({ tenant: 'alpha' });
    await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'What changed?',
      customContext,
    });

    expect(vi.mocked(query).mock.calls[0]?.[0].customContext).toEqual(
      customContext,
    );
  });

  it('leaves selection to query without forwarding session defaults or a preselected result', async () => {
    const config = sideQuestionConfig();
    const result = await runSideQuestion({
      sessionId: 'side-question-test',
      config,
      question: 'What changed?',
    });
    const options = vi.mocked(query).mock.calls[0]![0];
    expect(options).not.toHaveProperty('modelOverride');
    expect(options).not.toHaveProperty('modelResolution');
    expect(options.compactSelection).toBeUndefined();
    expect(options.parentSelection).toBeUndefined();
    expect(config.getModelProviderManager().select).not.toHaveBeenCalled();
    expect(result.synthetic).toBe(false);
  });

  it('forwards the side-question purpose and workspace directories', async () => {
    const config = sideQuestionConfig();
    const workdirs = ['/repo-a', '/repo-b'];
    const workspaceContext = config.getWorkspaceContext();
    vi.spyOn(workspaceContext, 'getDirectories').mockReturnValue(workdirs);
    vi.spyOn(config, 'getWorkspaceContext').mockReturnValue(workspaceContext);
    await runSideQuestion({
      sessionId: 'side-question-test',
      config,
      question: 'What changed?',
    });
    const options = vi.mocked(query).mock.calls[0]![0];
    expect(options.modelPurpose).toBe('side_question');
    expect(options.workdirs).toBe(workdirs);
  });

  it('replays the cache-safe parent request as one unit', async () => {
    const systemPrompt = [
      { type: 'text' as const, text: 'exact parent system prompt' },
    ];
    const toolSchemas = [
      {
        name: 'Write',
        description: 'Recovery-aware parent Write schema',
        parameters: { type: 'object' },
      },
    ];
    const forkContextMessages = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Parent question' }],
      },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Parent answer' }],
      },
    ];
    const modelResolution = testModelResolution('resolved-parent-model', {
      reasoningEffort: 'high',
      contextWindow: 200_000,
      config: {
        context: { contextWindow: 200_000, maxOutputTokens: 8192 },
        reasoning: { thinking: { type: 'enabled', budgetTokens: 4096 } },
        sampling: { temperature: 0.2 },
      },
    });

    await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'What changed?',
      cacheSafeQuerySnapshot: {
        modelResolution,
        systemPrompt,
        forkContextMessages,
        model: 'resolved-parent-model',
        toolSchemas,
        maxOutputTokens: 8192,
        thinkingBudget: 4096,
        reasoningEffort: 'high',
        generation: { temperature: 0.2 },
        contextWindow: 200_000,
      },
      systemPrompt: [{ type: 'text', text: 'stale system prompt' }],
      parentToolSchemas: [
        {
          name: 'Write',
          description: 'Stale raw Write schema',
          parameters: {},
        },
      ],
      messages: [
        {
          type: 'user',
          uuid: 'stale-runtime-message',
          timestamp: '2026-09-14T00:00:00.000Z',
          message: { role: 'user', content: 'Stale runtime history' },
        },
      ],
      history: [
        {
          question: 'Earlier side question',
          response: 'Earlier side answer',
        },
      ],
    });

    expect(wrapWithParentToolSchemas).toHaveBeenCalledWith(toolSchemas);
    const options = vi.mocked(query).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      modelPurpose: 'side_question',
      querySource: 'side_question',
      systemPrompt,
      maxTurns: 1,
      toolChoice: 'none',
      skipCacheWrite: true,
      parentSelection: modelResolution,
    });
    expect(options?.messages).toBeUndefined();
    expect(options?.preProjectedMessages).toEqual([
      ...forkContextMessages,
      {
        role: 'user',
        content: [{ type: 'text', text: 'Earlier side question' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier side answer' }],
      },
    ]);
    expect(options?.parentSelection).toBe(modelResolution);
    expect(options).not.toHaveProperty('modelResolution');
    expect(options?.compactSelection).toBeUndefined();
    expect(options).not.toHaveProperty('modelOverride');
    expect(options).not.toHaveProperty('modelSelection');
  });

  it('forwards the parent system prompt blocks without flattening them', async () => {
    const systemPrompt = [
      { type: 'text' as const, text: 'stable' },
      { type: 'text' as const, text: 'dynamic' },
    ];

    await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'What changed?',
      systemPrompt,
    });

    expect(vi.mocked(query).mock.calls[0]?.[0].systemPrompt).toBe(systemPrompt);
  });

  it('appends side-question history after the main conversation', async () => {
    const mainConversation = {
      type: 'user' as const,
      uuid: 'main-user',
      timestamp: '2026-08-15T00:00:00.000Z',
      message: { role: 'user' as const, content: 'Implement the cache.' },
    };

    await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'Where is it implemented?',
      messages: [mainConversation],
      history: [
        {
          question: 'What are we implementing?',
          response: 'A session cache.',
          fallback_notice: 'A fallback model produced this response.',
        },
      ],
    });

    const options = vi.mocked(query).mock.calls[0]?.[0];
    expect(options?.messages?.[0]).toBe(mainConversation);
    expect(options?.messages?.[1]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'What are we implementing?' },
    });
    expect(options?.messages?.[2]).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'session-model',
        content: [
          {
            type: 'text',
            text: 'A session cache.\n\nA fallback model produced this response.',
          },
        ],
      },
    });
  });

  it('wraps the question in the side-question reminder', async () => {
    await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'What changed?',
    });

    const options = vi.mocked(query).mock.calls[0]?.[0];
    expect(options?.prompt).toBe(
      `${SIDE_QUESTION_SYSTEM_REMINDER}\n\nWhat changed?`,
    );
    expect(SIDE_QUESTION_SYSTEM_REMINDER).toContain('NEVER say things like');
    expect(SIDE_QUESTION_SYSTEM_REMINDER).toContain(
      'The main agent is NOT interrupted',
    );
  });

  it('joins assistant text blocks with blank lines', async () => {
    vi.mocked(query).mockImplementationOnce(
      () =>
        queryYielding([
          assistant([
            { type: 'text', text: 'First part.' },
            { type: 'text', text: 'Second part.' },
          ]),
        ]) as never,
    );

    const result = await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'Explain',
    });

    expect(result).toMatchObject({
      textContent: 'First part.\n\nSecond part.',
      synthetic: false,
    });
  });

  it('shows an API error alone instead of appending it to partial text', async () => {
    vi.mocked(query).mockImplementationOnce(
      () =>
        queryYielding(
          [
            assistant([{ type: 'text', text: 'Partial answer' }]),
            {
              ...assistant([
                { type: 'text', text: 'Rate limited by provider' },
              ]),
              isApiErrorMessage: true,
            },
          ],
          { reason: 'error' },
        ) as never,
    );

    const result = await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'Explain',
    });

    expect(result).toMatchObject({
      textContent: '(API error: Rate limited by provider)',
      synthetic: true,
    });
  });

  it('falls back to the terminal error when no assistant message arrives', async () => {
    vi.mocked(query).mockImplementationOnce(
      () =>
        queryYielding([], {
          reason: 'error',
          error: new Error('socket hang up'),
        }) as never,
    );

    const result = await runSideQuestion({
      sessionId: 'side-question-test',
      config: sideQuestionConfig(),
      question: 'Explain',
    });

    expect(result).toMatchObject({
      textContent: '(API error: socket hang up)',
      synthetic: true,
    });
  });
});

function assistant(content: Array<{ type: 'text'; text: string }>) {
  return { type: 'assistant' as const, message: { content } };
}

function queryYielding(
  events: unknown[],
  terminal: { reason?: string; error?: Error } = {},
) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
    return {
      reason: 'end_turn',
      numTurns: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      durationMs: 1,
      ...terminal,
    };
  })();
}
