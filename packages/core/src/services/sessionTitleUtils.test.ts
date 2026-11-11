/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  createAssistantMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import {
  resolveTitleBusiness,
  generateRemoteSessionTitleForMessages,
  generateSessionTitleForCurrentSession,
} from './sessionTitleUtils.js';

const { mockReadForResume, mockGenerateTitle } = vi.hoisted(() => ({
  mockReadForResume: vi.fn(),
  mockGenerateTitle: vi.fn(),
}));

vi.mock('./sessionTitleService.js', () => ({
  SessionTitleService: vi.fn().mockImplementation(() => ({
    generateTitle: mockGenerateTitle,
  })),
}));

describe('sessionTitleUtils', () => {
  const SESSION_ID = 'session-ai-1';
  const SESSION_PATH = `/tmp/${SESSION_ID}.jsonl`;
  const USER_UUID = 'user-ai-1';
  const LEAF_UUID = 'leaf-ai-1';

  let mockConfig: Config;

  function createEmptyLoadResult(
    overrides: Partial<{
      customTitles: Map<string, string>;
      aiTitles: Map<string, string>;
      leafUuid: string;
      messages: Array<ReturnType<typeof createUserMessage>>;
    }> = {},
  ) {
    const assistant = createAssistantMessage({
      messageId: 'assistant-ai-1',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: ((value) => ({
        inputTokens: value.input_tokens,
        outputTokens: value.output_tokens,
        cacheReadInputTokens: value.cache_read_input_tokens,
        cacheCreationInputTokens: value.cache_creation_input_tokens,
      }))(cloneUsage()),
      blocks: [{ type: 'text', text: 'I found the auth bug.' }],
    });

    return {
      metadata: {
        customTitles: overrides.customTitles ?? new Map<string, string>(),
        aiTitles: overrides.aiTitles ?? new Map<string, string>(),
      },
      writerState: { mainParentUuid: overrides.leafUuid ?? LEAF_UUID },
      messages: overrides.messages ?? [
        {
          ...createUserMessage('Fix auth flow', {
            origin: { kind: 'human' },
            requestSetId: 'title-business',
            businessModelKey: 'ultimate',
          }),
          uuid: USER_UUID,
        },
        {
          ...assistant,
          uuid: LEAF_UUID,
        },
      ],
    };
  }

  function createMockWriter(
    overrides: {
      sessionId?: string;
      sessionPath?: string;
      recordAiTitle?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const recordAiTitle =
      overrides.recordAiTitle ?? vi.fn().mockResolvedValue(undefined);
    return {
      recordAiTitle,
      getSessionId: vi.fn().mockReturnValue(overrides.sessionId ?? SESSION_ID),
      getSessionFilePath: vi
        .fn()
        .mockReturnValue(overrides.sessionPath ?? SESSION_PATH),
    };
  }

  function buildArgs(
    writer: ReturnType<typeof createMockWriter>,
    signal: AbortSignal = new AbortController().signal,
  ) {
    return {
      config: mockConfig,
      writer: writer as never,
      leafUuidAtSubmit: LEAF_UUID,
      signal,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadForResume.mockReset();
    mockGenerateTitle.mockReset();

    mockConfig = {
      getSessionId: vi.fn().mockReturnValue(SESSION_ID),
      getModel: vi.fn().mockReturnValue('qwen-max'),
      getTranscriptStore: vi.fn().mockReturnValue({
        repository: vi.fn().mockReturnValue({
          readForResume: mockReadForResume,
        }),
      }),
    } as unknown as Config;

    mockReadForResume.mockResolvedValue(createEmptyLoadResult());
    mockGenerateTitle.mockResolvedValue('Fix auth flow on mobile');
  });

  it('bounds both reads and releases admission before model generation', async () => {
    mockGenerateTitle.mockImplementationOnce(async () => {
      const options = mockReadForResume.mock.calls[0][1];
      expect(options.attempt.signal.aborted).toBe(true);
      return 'Bounded title';
    });
    const writer = createMockWriter();
    await generateSessionTitleForCurrentSession(buildArgs(writer));
    expect(mockReadForResume).toHaveBeenCalledTimes(2);
    for (const [, options] of mockReadForResume.mock.calls) {
      expect(options).toMatchObject({
        sessionId: SESSION_ID,
        consistency: 'flush-pending',
      });
      expect(options.attempt.signal.aborted).toBe(true);
    }
    expect(writer.recordAiTitle).toHaveBeenCalledWith('Bounded title');
  });

  it('writes the generated ai-title on the happy path', async () => {
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession(buildArgs(writer));

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1);
    expect(mockGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        currentModel: 'qwen-max',
      }),
    );
    expect(writer.recordAiTitle).toHaveBeenCalledWith(
      'Fix auth flow on mobile',
    );
  });

  it('generates and publishes a title from the first prompt before an assistant response exists', async () => {
    mockReadForResume.mockResolvedValue(null);
    const writer = createMockWriter();
    const onTitleWritten = vi.fn();

    await generateSessionTitleForCurrentSession({
      config: mockConfig,
      writer: writer as never,
      businessInfo: { id: 'first-turn-business', version: '1.0.0' },
      description: 'Fix the mobile authentication flow',
      signal: new AbortController().signal,
      onTitleWritten,
    });

    expect(mockGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        businessInfo: expect.objectContaining({ id: 'first-turn-business' }),
        description: 'Fix the mobile authentication flow',
        currentModel: 'qwen-max',
      }),
    );
    expect(writer.recordAiTitle).toHaveBeenCalledWith(
      'Fix auth flow on mobile',
    );
    expect(onTitleWritten).toHaveBeenCalledWith(
      'Fix auth flow on mobile',
      'fresh-ai',
    );
  });

  it('skips automatic title generation when no owning business can be identified', async () => {
    mockReadForResume.mockResolvedValue(null);
    await generateSessionTitleForCurrentSession({
      config: mockConfig,
      writer: createMockWriter() as never,
      description: 'An unattributed prompt',
      signal: new AbortController().signal,
    });
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('does not replace a custom title when generating from the first prompt', async () => {
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({
        customTitles: new Map([[SESSION_ID, 'User title']]),
      }),
    );
    const writer = createMockWriter();
    const onTitleWritten = vi.fn();

    await generateSessionTitleForCurrentSession({
      config: mockConfig,
      writer: writer as never,
      description: 'Fix the mobile authentication flow',
      signal: new AbortController().signal,
      onTitleWritten,
    });

    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
    expect(onTitleWritten).toHaveBeenCalledWith(
      'User title',
      'existing-custom',
    );
  });

  it('skips current-session title generation until a model assistant response exists', async () => {
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({
        leafUuid: USER_UUID,
        messages: [
          {
            ...createUserMessage('Fix auth flow', {
              origin: { kind: 'human' },
              requestSetId: 'title-business',
              businessModelKey: 'ultimate',
            }),
            uuid: USER_UUID,
          },
        ],
      }),
    );
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession({
      ...buildArgs(writer),
      leafUuidAtSubmit: USER_UUID,
    });

    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
  });

  it('republishes an existing custom title without regenerating', async () => {
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({
        customTitles: new Map([[SESSION_ID, 'User title']]),
      }),
    );
    const writer = createMockWriter();
    const onTitleWritten = vi.fn();

    await generateSessionTitleForCurrentSession({
      ...buildArgs(writer),
      onTitleWritten,
    });

    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
    expect(onTitleWritten).toHaveBeenCalledWith(
      'User title',
      'existing-custom',
    );
  });

  it('republishes an existing ai-title without regenerating by default', async () => {
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({
        aiTitles: new Map([[SESSION_ID, 'Prior AI title']]),
      }),
    );
    const writer = createMockWriter();
    const onTitleWritten = vi.fn();

    await generateSessionTitleForCurrentSession({
      ...buildArgs(writer),
      onTitleWritten,
    });

    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
    expect(onTitleWritten).toHaveBeenCalledWith(
      'Prior AI title',
      'existing-ai',
    );
  });

  it('treats existing ai-title content as opaque metadata', async () => {
    const existingTitle =
      '<tool_call> <function=list_files> <path> .</path> </function> </tool_call>';
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({
        aiTitles: new Map([[SESSION_ID, existingTitle]]),
      }),
    );
    const writer = createMockWriter();
    const onTitleWritten = vi.fn();

    await generateSessionTitleForCurrentSession({
      ...buildArgs(writer),
      onTitleWritten,
    });

    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
    expect(onTitleWritten).toHaveBeenCalledWith(existingTitle, 'existing-ai');
  });

  it('regenerates when overwrite is allowed', async () => {
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({
        aiTitles: new Map([[SESSION_ID, 'Prior AI title']]),
      }),
    );
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession({
      ...buildArgs(writer),
      allowOverwriteAiTitle: true,
    });

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1);
    expect(writer.recordAiTitle).toHaveBeenCalledWith(
      'Fix auth flow on mobile',
    );
  });

  it('skips when the writer session does not match the config session', async () => {
    const writer = createMockWriter({ sessionId: 'stale-session' });

    await generateSessionTitleForCurrentSession(buildArgs(writer));

    expect(mockReadForResume).not.toHaveBeenCalled();
    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
  });

  it('skips when the conversation leaf has already advanced', async () => {
    mockReadForResume.mockResolvedValueOnce(
      createEmptyLoadResult({ leafUuid: 'advanced-leaf' }),
    );
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession(buildArgs(writer));

    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
  });

  it('skips when a title lands during generation', async () => {
    mockReadForResume
      .mockResolvedValueOnce(createEmptyLoadResult())
      .mockResolvedValueOnce(
        createEmptyLoadResult({
          aiTitles: new Map([[SESSION_ID, 'Concurrent title']]),
        }),
      );
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession(buildArgs(writer));

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1);
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
  });

  it('does not overwrite opaque ai-title content that lands during generation', async () => {
    mockReadForResume
      .mockResolvedValueOnce(createEmptyLoadResult())
      .mockResolvedValueOnce(
        createEmptyLoadResult({
          aiTitles: new Map([
            [
              SESSION_ID,
              '<tool_call> <function=list_files> <path> .</path> </function> </tool_call>',
            ],
          ]),
        }),
      );
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession(buildArgs(writer));

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1);
    expect(writer.recordAiTitle).not.toHaveBeenCalled();
  });

  it('writes when the transcript leaf advances during title generation', async () => {
    mockReadForResume
      .mockResolvedValueOnce(createEmptyLoadResult())
      .mockResolvedValueOnce(
        createEmptyLoadResult({ leafUuid: 'advanced-leaf' }),
      );
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession(buildArgs(writer));

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1);
    expect(writer.recordAiTitle).toHaveBeenCalledWith(
      'Fix auth flow on mobile',
    );
  });

  it('skips when aborted before the write', async () => {
    const controller = new AbortController();
    controller.abort();
    const writer = createMockWriter();

    await generateSessionTitleForCurrentSession(
      buildArgs(writer, controller.signal),
    );

    expect(writer.recordAiTitle).not.toHaveBeenCalled();
  });

  it('never throws when the title service rejects', async () => {
    mockGenerateTitle.mockRejectedValueOnce(new Error('title failure'));
    const writer = createMockWriter();

    await expect(
      generateSessionTitleForCurrentSession(buildArgs(writer)),
    ).resolves.toBeUndefined();
  });

  it('generates remote titles through the dedicated session title service', async () => {
    const assistant = createAssistantMessage({
      messageId: 'remote-assistant-1',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: ((value) => ({
        inputTokens: value.input_tokens,
        outputTokens: value.output_tokens,
        cacheReadInputTokens: value.cache_read_input_tokens,
        cacheCreationInputTokens: value.cache_creation_input_tokens,
      }))(cloneUsage()),
      blocks: [{ type: 'text', text: 'I found the auth bug.' }],
    });

    const title = await generateRemoteSessionTitleForMessages({
      config: mockConfig,
      messages: [
        {
          uuid: 'remote-user-1',
          type: 'user',
          timestamp: '2026-04-14T00:00:00.000Z',
          origin: { kind: 'human' },
          requestSetId: 'title-business',
          businessModelKey: 'ultimate',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Fix auth flow' }],
          },
        },
        {
          ...assistant,
          uuid: 'remote-assistant-1',
          timestamp: '2026-04-14T00:00:01.000Z',
        },
      ],
    });

    expect(title).toBe('Fix auth flow on mobile');
    expect(mockGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ type: 'user' }),
          expect.objectContaining({ type: 'assistant' }),
        ]),
        businessInfo: expect.objectContaining({
          id: 'title-business',
          model_key: 'ultimate',
        }),
        promptId: 'remote-title-generation',
        maxWords: 8,
        maxAttempts: 1,
        currentModel: 'qwen-max',
      }),
    );
  });

  it('does not substitute the current model for an old title business without a snapshot', async () => {
    const load = createEmptyLoadResult();
    const owner = load.messages.find((message) => message.type === 'user');
    if (owner?.type === 'user') delete owner.businessModelKey;
    await generateRemoteSessionTitleForMessages({
      config: mockConfig,
      messages: load.messages,
    });
    const business = mockGenerateTitle.mock.calls[0][0].businessInfo;
    expect(business.id).toBe('title-business');
    expect(business).not.toHaveProperty('model_key');
  });

  it('does not generate remote titles before a model assistant response exists', async () => {
    const title = await generateRemoteSessionTitleForMessages({
      config: mockConfig,
      messages: [
        createUserMessage('Fix auth flow', { origin: { kind: 'human' } }),
      ],
    });

    expect(title).toBeNull();
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('does not treat the remote-control connected boundary as a model response', async () => {
    const remoteControlAssistant = createAssistantMessage({
      messageId: 'remote-control-assistant',

      model: 'lite',
      stopReason: 'end_turn',

      usage: ((value) => ({
        inputTokens: value.input_tokens,
        outputTokens: value.output_tokens,
        cacheReadInputTokens: value.cache_read_input_tokens,
        cacheCreationInputTokens: value.cache_creation_input_tokens,
      }))(cloneUsage()),
      blocks: [{ type: 'text', text: 'Remote Control Connected' }],
    });

    const title = await generateRemoteSessionTitleForMessages({
      config: mockConfig,
      messages: [
        createUserMessage('Fix auth flow', { origin: { kind: 'human' } }),
        remoteControlAssistant,
      ],
    });

    expect(title).toBeNull();
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('returns null for remote title generation when there is no visible conversation', async () => {
    const title = await generateRemoteSessionTitleForMessages({
      config: mockConfig,
      messages: [],
    });

    expect(title).toBeNull();
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });
});

describe('control title business attribution', () => {
  it('按消息 ID 解析附件和换行正文，重复正文不改变原轮次归属', async () => {
    const first = createUserMessage('分析截图\n附件引用：/tmp/example.png', {
      uuid: 'user-a', requestSetId: 'turn-a',
      businessIdentity: { id: 'turn-a', product: 'app', type: 'agent', model_key: 'ultimate' },
    });
    const second = createUserMessage('分析截图\n附件引用：/tmp/example.png', {
      uuid: 'user-b', requestSetId: 'turn-b',
      businessIdentity: { id: 'turn-b', product: 'app', type: 'code_review', model_key: 'auto' },
    });
    const messages = JSON.parse(JSON.stringify([first, second]));
    expect(await resolveTitleBusiness('session', messages, '分析截图', first.uuid))
      .toMatchObject(first.businessIdentity!);
    expect(await resolveTitleBusiness('session', messages, '分析截图', second.uuid))
      .toMatchObject(second.businessIdentity!);
    expect(await resolveTitleBusiness('session', messages, '分析截图', 'missing')).toBeUndefined();
    delete first.businessIdentity;
    expect(await resolveTitleBusiness('session', [first], '分析截图', first.uuid)).toBeUndefined();
  });

  function owner(text: string, id: string, model: string) {
    const message = createUserMessage(text);
    message.requestSetId = id;
    message.businessModelKey = model;
    return message;
  }
  it('无 ID 兼容调用继承唯一匹配消息的完整业务快照', async () => {
    const message = createUserMessage('review this change', {
      requestSetId: 'original-turn',
      businessIdentity: { id: 'original-turn', product: 'app', type: 'code_review', model_key: 'ultimate' },
    });
    expect(await resolveTitleBusiness('session', [message], 'review this change'))
      .toMatchObject(message.businessIdentity!);
  });
  it('keeps an old title on its original turn after another model is selected', async () => {
    const messages = [
      owner('first', 'business-a', 'ultimate'),
      owner('second', 'business-b', 'auto'),
    ];
    expect(
      await resolveTitleBusiness('session', messages, 'first'),
    ).toMatchObject({ id: 'business-a', model_key: 'ultimate' });
    expect(
      await resolveTitleBusiness('session', messages, 'second'),
    ).toMatchObject({ id: 'business-b', model_key: 'auto' });
  });
  it('falls back to the first executed user message when attachment text differs after a follow-up', async () => {
    const messages = [
      owner('分析图片 附件：颜色样例.png', 'first-turn', 'ultimate'),
      owner('继续', 'follow-up', 'auto'),
    ];
    expect(
      await resolveTitleBusiness('session', messages, '分析图片\n请简要回答'),
    ).toMatchObject({ id: 'first-turn', model_key: 'ultimate' });
  });

  it('uses the first executed user message for ambiguous text matches', async () => {
    const messages = [
      owner('same', 'a', 'ultimate'),
      owner('same', 'b', 'auto'),
    ];
    expect(
      await resolveTitleBusiness('session', messages, 'same'),
    ).toMatchObject({ id: 'a', model_key: 'ultimate' });
    expect(
      await resolveTitleBusiness('session', messages, 'unknown'),
    ).toMatchObject({ id: 'a', model_key: 'ultimate' });
  });

  it('excludes metadata, non-human input and messages without business IDs from fallback', async () => {
    const excluded = [
      { ...owner('metadata', 'meta', 'auto'), isMeta: true },
      {
        ...owner('system input', 'system', 'auto'),
        origin: { kind: 'system' },
      },
      createUserMessage('not executed'),
    ];
    expect(
      await resolveTitleBusiness(
        'session',
        [
          ...excluded,
          owner('first', 'first-turn', 'ultimate'),
          owner('second', 'second-turn', 'auto'),
        ],
        'display text',
      ),
    ).toMatchObject({ id: 'first-turn', model_key: 'ultimate' });
    expect(
      await resolveTitleBusiness('session', excluded, 'display text'),
    ).toBeUndefined();
    expect(await resolveTitleBusiness('session', [], 'first')).toBeUndefined();
  });

  it('preserves the latest-turn behavior when no description is supplied', async () => {
    expect(
      await resolveTitleBusiness('session', [
        owner('first', 'first-turn', 'ultimate'),
        owner('second', 'second-turn', 'auto'),
      ]),
    ).toMatchObject({ id: 'second-turn', model_key: 'auto' });
  });
});
