/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequestTokenAnchor } from '../../../../core/src/utils/request-token-count.js';
import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countRequestTokens,
  cloneUsage,
  modelMessageToAssistantPayload,
  loadLatestSessionUsage,
  createUserMessage,
  createToolResultMessage,
  createSystemMessage,
  createAttachmentMessage,
  FileAttachment,
  systemPromptFromText,
} from '@qwen-code/core';
import type {
  Config,
  Message,
  Model,
  ModelTextBlock,
  ModelToolUseBlock,
  ModelStreamTool,
  UserMessage,
  SessionMetrics,
  SkillSource,
} from '@qwen-code/core';
import {
  collectContextUsage,
  type ContextUsageSessionInput,
} from './contextUsageCollector.js';
import { projectContextUsageForSdk } from './contextUsageProjection.js';

const coreMocks = vi.hoisted(() => ({
  loadLatestSessionUsage: vi.fn(async () => null),
  getSystemContext: vi.fn(async () => ({ memory: 'project context' })),
  buildSystemPromptForTurn: vi.fn(async () => 'built system prompt'),
  buildModelStreamTools: vi.fn(() => [
    { name: 'Read', description: 'Read a file', parameters: {} },
  ]),
  getRawContextWindowSize: vi.fn(
    (_model: Model | undefined, resolvedContextWindow?: number) =>
      resolvedContextWindow ?? 100_000,
  ),
  getSummaryReserveTokens: vi.fn(() => 10_000),
  getAutoCompactThresholdForContextWindow: vi.fn(
    (effectiveContextWindow: number) =>
      Math.max(0, effectiveContextWindow - 10_000),
  ),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, ...coreMocks };
});

type ConfigFixtureOptions = {
  rawContextWindowTokens?: number;
  contextManagementEnabled?: boolean;
  displayableSkills?: Array<{
    name: string;
    description?: string;
    whenToUse?: string;
    source?: SkillSource;
  }>;
};

function toolSchema(name: string): ModelStreamTool {
  return { name, description: `${name} tool`, parameters: {} };
}

function makeConfig(options: ConfigFixtureOptions = {}): Config {
  const {
    rawContextWindowTokens = 100_000,
    contextManagementEnabled = true,
    displayableSkills = [],
  } = options;
  const manager = {
    getMainModel: vi.fn(async () => testListedModel('test-model')),
    getModel: vi.fn(
      async (_key: string): Promise<Model | undefined> => undefined,
    ),
    listModels: vi.fn(async () => []),
  };
  return {
    getModel: vi.fn(() => 'test-model'),
    getModelProviderManager: () => manager,
    getSessionArtifactProjectRoot: vi.fn(() => '/workspace'),
    getSessionId: vi.fn(() => 'token-test-session'),
    getEffectiveContextWindow: vi.fn(() => rawContextWindowTokens),
    getWorkingDir: vi.fn(() => '/workspace'),
    getPromptAssembler: vi.fn(() => ({})),
    getCustomSystemPrompt: vi.fn(() => undefined),
    getAppendSystemPrompt: vi.fn(() => undefined),
    getToolRegistry: vi.fn(() => ({
      getFunctionDeclarations: vi.fn(() => [
        { name: 'Read', description: 'Read a file' },
      ]),
    })),
    getSkillManager: vi.fn(() => ({
      getSkills: vi.fn(() => [
        { name: 'hidden-skill', description: 'must not be included' },
      ]),
      getDisplayableSkills: vi.fn(() => displayableSkills),
    })),
    isContextManagementEnabled: vi.fn(() => contextManagementEnabled),
  } as unknown as Config;
}

function assistantMessageWithUsage(
  inputTokens: number,
  systemText = 'cached system prompt',
  model = 'test-model',
  content: Array<ModelTextBlock | ModelToolUseBlock> = [
    { type: 'text', text: 'assistant text' },
  ],
) {
  // 锚点绑定会话正文：生产侧同样用 assistant.message.content 做响应指纹。
  const message = modelMessageToAssistantPayload({
    messageId: 'response',
    model,
    usage: {
      inputTokens,
      outputTokens: 0,
      cacheReadInputTokens: 9_999,
    },
    blocks: content,
  });
  return {
    type: 'assistant' as const,
    uuid: 'response',
    timestamp: '2026-01-01T00:00:00.000Z',
    requestTokenAnchor: createRequestTokenAnchor({
      model,
      messages: [],
      systemPrompt: systemPromptFromText(systemText),
      tools: [toolSchema('Read')],
      projectionOptions: { targetModel: model },
    })(message.content),
    message,
  };
}

function userTextMessage(text: string): UserMessage {
  return createUserMessage([{ type: 'text', text }]);
}

function humanPromptMessage(text: string): UserMessage {
  return createUserMessage(text, { humanInput: { text, mode: 'prompt' } });
}

function duplicateReadMessages(path: string): Message[] {
  return ['first result', 'second result'].flatMap((text, index) => {
    const id = `read-${index + 1}`;
    const assistant = assistantMessageWithUsage(0, '', 'test-model', [
      { type: 'tool_use', id, name: 'Read', input: { file_path: path } },
    ]);
    assistant.uuid = `assistant-${id}`;
    assistant.message.id = assistant.uuid;
    return [
      assistant,
      createToolResultMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: text,
            is_error: false,
          },
        ],
        assistant.uuid,
      ),
    ];
  });
}

function metrics({
  calls = 0,
  ok = 0,
  failed = 0,
  added = 0,
  removed = 0,
}: {
  calls?: number;
  ok?: number;
  failed?: number;
  added?: number;
  removed?: number;
} = {}): SessionMetrics {
  return {
    models: {},
    tools: {
      totalCalls: calls,
      totalSuccess: ok,
      totalFail: failed,
      totalDurationMs: 0,
      totalDecisions: {
        accept: 0,
        reject: 0,
        modify: 0,
        auto_accept: 0,
      },
      byName: {},
    },
    files: {
      totalLinesAdded: added,
      totalLinesRemoved: removed,
    },
  } as SessionMetrics;
}

function emptySessionInput(): ContextUsageSessionInput {
  return { metrics: metrics() };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('collectContextUsage', () => {
  it('uses verified request usage without adding cache-read tokens', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [assistantMessageWithUsage(12_345)],
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    expect(snapshot.tokenUsage).toBe(12_345);
  });

  it('uses the selected model window after switching without a new request', async () => {
    const config = makeConfig({ rawContextWindowTokens: 200_000 });
    const currentModel = testListedModel('ultimate');
    vi.mocked(config.getModelProviderManager().getMainModel).mockResolvedValue(
      currentModel,
    );
    const messages = [
      assistantMessageWithUsage(100_000, 'cached system prompt', 'fast'),
    ];
    const snapshot = await collectContextUsage({
      config,
      messages,
      requestSnapshot: {
        model: 'fast',
        contextWindow: 1_000_000,
        modelResolution: { model: testListedModel('fast'), config: {} },
      },
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    expect(config.getModelProviderManager().getMainModel).toHaveBeenCalledOnce();
    expect(config.getModelProviderManager().getModel).not.toHaveBeenCalled();
    expect(config.getModel).not.toHaveBeenCalled();
    expect(config.getEffectiveContextWindow).toHaveBeenCalledWith(
      currentModel,
      'ultimate',
    );
    expect(coreMocks.getSummaryReserveTokens).toHaveBeenCalledWith(currentModel);
    expect(snapshot.model).toBe('ultimate');
    expect(snapshot.rawContextWindowTokens).toBe(200_000);
    const expectedUsage = countRequestTokens({
      model: 'ultimate',
      messages,
      systemPrompt: systemPromptFromText('cached system prompt'),
      tools: [toolSchema('Read')],
    });
    expect(expectedUsage.source).toBe('estimate');
    expect(snapshot.tokenUsage).toBe(expectedUsage.tokens);
    expect(snapshot.tokenUsage).toBeLessThan(100_000);
    expect(snapshot.autoCompactThresholdTokens).toBe(180_000);
    expect(snapshot.autoCompactBufferTokens).toBe(20_000);
    expect(
      snapshot.categories
        .filter(
          (category) =>
            category.type !== 'free_space' && category.type !== 'auto_compact',
        )
        .reduce((sum, category) => sum + category.tokens, 0),
    ).toBeCloseTo(snapshot.tokenUsage, 8);
  });

  it('reflects window preference changes for the same model without a new request', async () => {
    const config = makeConfig({ rawContextWindowTokens: 200_000 });
    const listed = testListedModel('test-model');
    vi.mocked(config.getModelProviderManager().getMainModel).mockResolvedValue(
      listed,
    );
    const input = {
      config,
      messages: [assistantMessageWithUsage(100_000)],
      requestSnapshot: {
        model: listed.key,
        contextWindow: 400_000,
        modelResolution: { model: listed, config: {} },
      },
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    };

    const initial = await collectContextUsage(input);
    vi.mocked(config.getEffectiveContextWindow).mockReturnValue(1_000_000);
    const expanded = await collectContextUsage(input);
    vi.mocked(config.getEffectiveContextWindow).mockReturnValue(200_000);
    const reset = await collectContextUsage(input);

    expect(initial.rawContextWindowTokens).toBe(200_000);
    expect(expanded.rawContextWindowTokens).toBe(1_000_000);
    expect(reset.rawContextWindowTokens).toBe(200_000);
    expect(initial.tokenUsage).toBe(100_000);
    expect(expanded.tokenUsage).toBe(100_000);
    expect(reset.tokenUsage).toBe(100_000);
    const sdkInitial = projectContextUsageForSdk(initial);
    const sdkExpanded = projectContextUsageForSdk(expanded);
    const sdkReset = projectContextUsageForSdk(reset);
    expect(sdkInitial.model).toBe('test-model');
    expect(sdkInitial.contextWindow.usedPercentage).toBe(50);
    expect(sdkExpanded.contextWindow.usedPercentage).toBe(10);
    expect(sdkReset.contextWindow.usedPercentage).toBe(50);
    expect(sdkInitial.autoCompact.thresholdPercentage).toBe(90);
    expect(sdkExpanded.autoCompact.thresholdPercentage).toBe(98);
    expect(coreMocks.getRawContextWindowSize).toHaveBeenCalledWith(
      listed,
      200_000,
    );
    expect(coreMocks.getSummaryReserveTokens).toHaveBeenCalledWith(listed);
  });

  it('reads the authoritative main model from the session manager', async () => {
    const config = makeConfig();
    const listed = testListedModel('test-model');
    vi.mocked(config.getModelProviderManager().getMainModel).mockResolvedValue(
      listed,
    );
    await collectContextUsage({
      config,
      messages: [],
      session: emptySessionInput(),
    });

    expect(config.getModelProviderManager().getMainModel).toHaveBeenCalledOnce();
    expect(config.getModelProviderManager().getModel).not.toHaveBeenCalled();
    expect(config.getModel).not.toHaveBeenCalled();
    expect(config.getEffectiveContextWindow).toHaveBeenCalledWith(
      listed,
      'test-model',
    );
    expect(coreMocks.getRawContextWindowSize).toHaveBeenCalledWith(
      listed,
      100_000,
    );
  });

  it('propagates main-model lookup errors without falling back to the request snapshot', async () => {
    const config = makeConfig();
    vi.mocked(config.getModelProviderManager().getMainModel).mockRejectedValue(
      new Error('main model unavailable'),
    );
    await expect(
      collectContextUsage({
        config,
        messages: [],
        requestSnapshot: { model: 'old-model', contextWindow: 1_000_000 },
        session: emptySessionInput(),
      }),
    ).rejects.toThrow('main model unavailable');
    expect(config.getModel).not.toHaveBeenCalled();
    expect(config.getModelProviderManager().getModel).not.toHaveBeenCalled();
  });

  it('scales overestimated categories down to measured model usage', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig({
        displayableSkills: [
          {
            name: '技能',
            description: '中文描述'.repeat(100),
            source: 'project',
          },
        ],
      }),
      messages: [assistantMessageWithUsage(10_000, '系统提示'.repeat(5_000))],
      cachedRenderedSystemPrompt: '系统提示'.repeat(5_000),
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    const displayedMessageTokens =
      snapshot.tokenStats.humanMessages +
      snapshot.tokenStats.assistantMessages +
      snapshot.tokenStats.thinkingTokens +
      [...snapshot.tokenStats.attachments.values()].reduce(
        (sum, tokens) => sum + tokens,
        0,
      );
    const displayedUsedTokens =
      snapshot.systemPromptTokens +
      snapshot.toolSchemaTokens +
      snapshot.skillFrontmatterTokens +
      displayedMessageTokens +
      snapshot.tokenStats.other;
    const categoryUsedTokens = snapshot.categories
      .filter(
        (category) =>
          category.type !== 'free_space' && category.type !== 'auto_compact',
      )
      .reduce((sum, category) => sum + category.tokens, 0);
    const categoryUsedPercentage = snapshot.categories
      .filter(
        (category) =>
          category.type !== 'free_space' && category.type !== 'auto_compact',
      )
      .reduce((sum, category) => sum + category.percentage, 0);
    const totalPercentage = snapshot.categories.reduce(
      (sum, category) => sum + category.percentage,
      0,
    );

    expect(displayedUsedTokens).toBeCloseTo(10_000, 8);
    expect(snapshot.systemPromptTokens).toBeLessThan(26_000);
    expect(categoryUsedTokens).toBeCloseTo(10_000, 8);
    expect(categoryUsedPercentage).toBeCloseTo(10, 1);
    expect(totalPercentage).toBeCloseTo(100, 1);
    expect(
      snapshot.skillDetails.reduce((sum, skill) => sum + skill.tokens, 0),
    ).toBeCloseTo(snapshot.skillFrontmatterTokens, 8);
  });

  it('keeps known estimates unchanged and assigns the measured gap to other', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [assistantMessageWithUsage(5_000, 'x'.repeat(400))],
      cachedRenderedSystemPrompt: 'x'.repeat(400),
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    const otherCategory = snapshot.categories.find(
      (category) => category.type === 'other',
    );
    const usedCategoryTokens = snapshot.categories
      .filter(
        (category) =>
          category.type !== 'free_space' && category.type !== 'auto_compact',
      )
      .reduce((sum, category) => sum + category.tokens, 0);

    expect(snapshot.systemPromptTokens).toBe(100);
    expect(otherCategory?.tokens).toBeGreaterThan(0);
    expect(usedCategoryTokens).toBeCloseTo(5_000, 8);
  });

  it('counts attachments but not local command output as message context', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [
        createAttachmentMessage(
          new FileAttachment({
            type: 'file',
            filename: '/workspace/a.ts',
            displayPath: 'a.ts',
            content: 'attached context',
          }),
        ),
        createSystemMessage('local_command_output', 'x'.repeat(4_000)),
      ],
      cachedRenderedSystemPrompt: '',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    const messagesCategory = snapshot.categories.find(
      (category) => category.type === 'messages',
    );
    const usedCategoryTokens = snapshot.categories
      .filter(
        (category) =>
          category.type !== 'free_space' && category.type !== 'auto_compact',
      )
      .reduce((sum, category) => sum + category.tokens, 0);

    expect(snapshot.tokenStats.localCommandOutputs).toBe(1_000);
    expect(messagesCategory?.tokens).toBe(
      snapshot.tokenStats.total - snapshot.tokenStats.other,
    );
    expect(usedCategoryTokens).toBe(snapshot.tokenUsage);
  });

  it('limits the displayed autocompact reserve to the remaining window', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [assistantMessageWithUsage(90_000)],
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    const autoCompactCategory = snapshot.categories.find(
      (category) => category.type === 'auto_compact',
    );
    const categorizedTokens = snapshot.categories.reduce(
      (sum, category) => sum + category.tokens,
      0,
    );

    expect(snapshot.autoCompactBufferTokens).toBe(20_000);
    expect(autoCompactCategory?.tokens).toBe(10_000);
    expect(categorizedTokens).toBeCloseTo(100_000, 8);
  });

  it('re-estimates a resumed compacted history when fresh telemetry is unavailable', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [
        {
          ...createSystemMessage('compact_boundary', ''),
          timestamp: '2026-01-01T00:00:01.000Z',
          compactMetadata: {
            trigger: 'manual',
            preTokens: 90_000,
            postTokens: 1,
          },
        },
        userTextMessage('short compact summary'),
        assistantMessageWithUsage(90_000),
        userTextMessage('later turn '.repeat(100)),
      ],
      cachedRenderedSystemPrompt: 'x'.repeat(4_000),
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    expect(snapshot.systemPromptTokens).toBeGreaterThan(900);
    expect(snapshot.tokenUsage).toBeGreaterThanOrEqual(
      snapshot.systemPromptTokens,
    );
    expect(snapshot.tokenUsage).toBeLessThan(90_000);
  });

  it.each(['model', 'prompt', 'tools', 'history'])(
    're-estimates the displayed total after %s changes',
    async (change) => {
      const response = assistantMessageWithUsage(1000);
      const model = change === 'model' ? 'new-model' : 'test-model';
      const systemPrompt = systemPromptFromText(
        change === 'prompt' ? '中'.repeat(40000) : 'cached system prompt',
      );
      const tools = change === 'tools' ? [] : [toolSchema('Read')];
      const messages =
        change === 'history'
          ? [createUserMessage('中'.repeat(40000)), response]
          : [response];
      const expected = countRequestTokens({
        model,
        messages,
        systemPrompt,
        tools,
      });
      const config = makeConfig();
      vi.mocked(config.getModelProviderManager().getMainModel).mockResolvedValue(
        testListedModel(model),
      );
      const snapshot = await collectContextUsage({
        config,
        messages,
        requestSnapshot: {
          model,
          contextWindow: 100000,
          systemPrompt,
          toolSchemas: tools,
          requestPrefixMessages: [],
        },
        session: emptySessionInput(),
      });
      expect(expected.source).toBe('estimate');
      expect(snapshot.tokenUsage).toBe(expected.tokens);
      expect(snapshot.tokenUsage).not.toBe(1000);
    },
  );

  it('includes response output and appended content in the next request total', async () => {
    const response = assistantMessageWithUsage(1000);
    response.message.usage!.output_tokens = 200;
    const messages = [response, createUserMessage('abcd')];
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages,
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });
    expect(snapshot.tokenUsage).toBe(1201);
  });

  it('reuses persisted usage only when bound to the resumed response', async () => {
    const response = assistantMessageWithUsage(1000);
    response.requestTokenAnchor.requestId = 'persisted-response';
    const usage = {
      ...cloneUsage(),
      ...response.message.usage,
      output_tokens: 200,
      request_id: 'persisted-response',
    };
    const resumed = {
      ...response,
      message: { ...response.message, usage: undefined },
    };
    vi.mocked(loadLatestSessionUsage).mockResolvedValueOnce(usage);
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [resumed],
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });
    expect(snapshot.tokenUsage).toBe(1200);
    vi.mocked(loadLatestSessionUsage).mockResolvedValueOnce({
      ...usage,
      request_id: 'unrelated-response',
    });
    const unrelated = await collectContextUsage({
      config: makeConfig(),
      messages: [resumed],
      cachedRenderedSystemPrompt: 'cached system prompt',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });
    expect(unrelated.tokenUsage).toBeLessThan(100);
  });

  it('counts the exact request prefix and overhead when no measurement exists', async () => {
    const prefix = [createUserMessage('x'.repeat(40_000))];
    const systemPrompt = systemPromptFromText('fixed system prompt');
    const snapshot = await collectContextUsage({
      config: makeConfig(),
      messages: [],
      requestSnapshot: {
        model: 'test-model',
        contextWindow: 100_000,
        requestPrefixMessages: prefix,
        systemPrompt,
        toolSchemas: [],
      },
      session: emptySessionInput(),
    });
    expect(snapshot.tokenUsage).toBe(
      countRequestTokens({
        model: 'test-model',
        messages: prefix,
        systemPrompt,
        tools: [],
      }).tokens,
    );
    expect(snapshot.toolSchemaTokens).toBe(0);
  });

  it('does not rebuild a first-turn prompt while estimating schemas', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig({
        displayableSkills: [
          {
            name: 'project-skill',
            description: 'project description',
            whenToUse: 'during tests',
            source: 'project',
          },
        ],
      }),
      messages: [],
      session: emptySessionInput(),
    });

    expect(coreMocks.getSystemContext).not.toHaveBeenCalled();
    expect(coreMocks.buildSystemPromptForTurn).not.toHaveBeenCalled();
    expect(snapshot.systemPromptTokens).toBe(0);
    expect(snapshot.toolSchemaTokens).toBeGreaterThan(0);
    expect(snapshot.tokenUsage).toBe(
      snapshot.systemPromptTokens +
        snapshot.toolSchemaTokens +
        snapshot.skillFrontmatterTokens,
    );
  });

  it('keeps TUI category order and serializes skills, duplicates and session metrics', async () => {
    const messages = [
      humanPromptMessage('one'),
      humanPromptMessage('two'),
      humanPromptMessage('three'),
      ...duplicateReadMessages('/workspace/a.ts'),
    ];
    const snapshot = await collectContextUsage({
      config: makeConfig({
        rawContextWindowTokens: 100_000,
        displayableSkills: [
          { name: 'small', description: 'x', source: 'user' },
          {
            name: 'large',
            description: 'x'.repeat(400),
            source: 'project',
          },
        ],
      }),
      messages,
      cachedRenderedSystemPrompt: 'x'.repeat(400),
      cachedParentToolSchemas: [toolSchema('Read')],
      session: {
        metrics: metrics({ calls: 5, ok: 4, failed: 1, added: 9, removed: 2 }),
      },
    });

    expect(snapshot.categories.map((item) => item.type)).toEqual([
      'system_prompt',
      'system_tools',
      'skills',
      'messages',
      'free_space',
      'auto_compact',
    ]);
    expect(snapshot.skillDetails.map((skill) => skill.name)).toEqual([
      'large',
      'small',
    ]);
    expect(snapshot.skillDetails.map((skill) => skill.source)).toEqual([
      'project',
      'user',
    ]);
    expect(snapshot.duplicateFileReads).toEqual([
      expect.objectContaining({ path: '/workspace/a.ts', count: 2 }),
    ]);
    expect(snapshot.session).toEqual({
      messageCount: messages.length,
      promptCount: 3,
      toolCalls: { total: 5, succeeded: 4, failed: 1 },
      linesChanged: { added: 9, removed: 2 },
    });
  });

  it('returns safe zero percentages for a zero-size context window', async () => {
    const snapshot = await collectContextUsage({
      config: makeConfig({ rawContextWindowTokens: 0 }),
      messages: [],
      cachedRenderedSystemPrompt: ' ',
      cachedParentToolSchemas: [toolSchema('Read')],
      session: emptySessionInput(),
    });

    expect(snapshot.categories.every((item) => item.percentage === 0)).toBe(
      true,
    );
    expect(snapshot.categories.map((item) => item.type)).toEqual([
      'system_prompt',
      'system_tools',
      'free_space',
    ]);
  });
});
