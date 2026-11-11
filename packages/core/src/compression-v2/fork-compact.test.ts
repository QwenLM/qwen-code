/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  testModelProviderManager,
  testProviderModelResolution,
  testCompressionConfig,
} from './provider-test-helpers.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompressionStatus } from '../core/turn-events.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { coreEvents } from '../utils/events.js';
import { recordCompletedRequest, clearSessionCredits } from '../services/session-state-usage.js';

import {
  classifyClientError,
  ModelInferenceError,
} from '../provider/modelInferenceError.js';
import { ClientError } from '../client/clientError.js';
import { EmptyAssistantCompletionError } from '../model-request/empty-assistant-completion.js';
import { CustomProviderAccessError } from '../config/custom-provider-access.js';
import { createEmptyCompressionPipelineState } from './state-store.js';
import { runForkCompact, runPartialForkCompact } from './fork-compact.js';
import { makeAssistant, makeUser } from './test-helpers.js';
import type { AssistantMessage, Message } from './message-types.js';
import type { CompressionStageContext } from './types.js';

vi.mock('../core/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

function createContext(): CompressionStageContext {
  const manager = testModelProviderManager();
  const history = [
    makeUser([{ type: 'text', text: 'Investigate compact failures.' }]),
    makeAssistant([
      {
        type: 'text',
        text: 'I will inspect the compact path.',
      },
    ]),
    makeUser([{ type: 'text', text: 'Continue.' }]),
  ];

  return {
    input: {
      modelResolution: testProviderModelResolution('test-model'),
      modelProviderManager: manager,
      history,
      requestPrefixMessages: [],
      promptTokenCount: 1000,
      systemPrompt: [{ type: 'text', text: 'system prompt' }],
      tools: [],
      promptId: 'prompt-1',
      force: true,
      trigger: 'manual',
      autoCompactTracking: { consecutiveFailures: 0 },
      config: {
        ...testCompressionConfig(manager),
        getApprovedPlanPath: () => undefined,
        getMemoryContextManager: () => undefined,
        getParentToolSchemas: () => [],
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
      } as unknown as CompressionStageContext['input']['config'],
      target: 'main',
      rootSessionId: 'root-session-main',
      sessionScopeId: 'session-main',
    },
    state: createEmptyCompressionPipelineState(),
    boundary: {
      startIndex: 0,
      prefixContents: [],
      contents: history,
      source: 'initial_history',
    },
    fullHistory: history,
    workingHistory: history,
  };
}

function createQuotaError(code: string | number = '112') {
  return Object.assign(new Error('quota exhausted'), {
    code,
    httpStatus: 403,
    status: 403,
  });
}

function createTenMessageContext(): CompressionStageContext {
  const response = (
    marker: string,
    groupId: string,
    toolName: string,
    callId: string,
  ): AssistantMessage => ({
    ...makeAssistant([
      { type: 'tool_use', id: callId, name: toolName, input: { marker } },
    ]),
    responseGroupId: groupId,
  });
  const result = (marker: string, callId: string) =>
    makeUser([{ type: 'tool_result', tool_use_id: callId, content: marker }]);
  const history: Message[] = [
    makeUser('M1: inspect the calculator without editing it'),
    response('M2: read calculator', 'response-1', 'Read', 'read-1'),
    result('M3: calculator source', 'read-1'),
    response('M4: search tests', 'response-2', 'Grep', 'grep-1'),
    result('M5: matching calculator tests', 'grep-1'),
    response('M6: run tests', 'response-3', 'Bash', 'bash-1'),
    result('M7: twelve tests passed', 'bash-1'),
    makeUser('M8: continue checking negative numbers without editing'),
    response('M9: read negative-number source', 'response-4', 'Read', 'read-2'),
    result('M10: negative-number source', 'read-2'),
  ].map((message, index) => ({ ...message, uuid: `M${index + 1}` }));
  const context = createContext();
  context.input.history = history;
  context.boundary.contents = history;
  context.fullHistory = history;
  context.workingHistory = history;
  return context;
}

describe('fork compact requests', () => {
  it('does not replace a missing Provider code with an outer lifecycle code', async () => {
    const failure = new ModelInferenceError('Provider failed', {
      kind: 'server',
      status: 503,
      phase: 'before_output',
    });
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Lifecycle failed', { cause: failure }), {
        code: 'http_error',
        status: 403,
      }),
    );
    const result = await runForkCompact(createContext());
    expect(result.info).not.toHaveProperty('errorCode');
    expect(result.info).not.toHaveProperty('displayErrorCode');
    expect(result.info.providerStatus).toBe(503);
  });

  beforeEach(() => {
    vi.mocked(runForkedAgent).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('summarizes M1-M8 without sending the preserved M9/M10 tool pair to the fork', async () => {
    const context = createTenMessageContext();
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent:
        '<analysis>ok</analysis><summary>calculator checked</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(context);

    expect(runForkedAgent).toHaveBeenCalledOnce();
    const forkContext =
      vi.mocked(runForkedAgent).mock.calls[0]![0].forkContextMessages;
    const serialized = JSON.stringify(forkContext);
    for (let index = 1; index <= 8; index++) {
      expect(serialized).toContain(`M${index}:`);
    }
    expect(serialized).not.toContain('M9:');
    expect(serialized).not.toContain('M10:');
    expect(serialized).not.toContain('read-2');
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).toHaveLength(4);
    expect(result.newHistory![0]).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { messagesSummarized: 8 },
    });
    expect(result.newHistory![1]).toMatchObject({
      type: 'user',
      isCompactSummary: true,
    });
    expect(result.newHistory![2]).toBe(context.workingHistory[8]);
    expect(result.newHistory![3]).toBe(context.workingHistory[9]);
  });

  it('preserves every assistant block and both tool results in the latest response group', async () => {
    const context = createTenMessageContext();
    const firstCall = context.workingHistory[8] as AssistantMessage;
    const secondCall: AssistantMessage = {
      ...makeAssistant([
        {
          type: 'tool_use',
          id: 'bash-2',
          name: 'Bash',
          input: { marker: 'latest second call' },
        },
      ]),
      responseGroupId: firstCall.responseGroupId,
      message: {
        ...firstCall.message,
        content: [
          {
            type: 'tool_use',
            id: 'bash-2',
            name: 'Bash',
            input: { marker: 'latest second call' },
          },
        ],
      },
    };
    const textBlock: AssistantMessage = {
      ...makeAssistant([{ type: 'text', text: 'latest response explanation' }]),
      responseGroupId: firstCall.responseGroupId,
      message: {
        ...firstCall.message,
        content: [{ type: 'text', text: 'latest response explanation' }],
      },
    };
    const secondResult = makeUser([
      {
        type: 'tool_result',
        tool_use_id: 'bash-2',
        content: 'latest second result',
      },
    ]);
    const preserved = [
      textBlock,
      firstCall,
      secondCall,
      context.workingHistory[9]!,
      secondResult,
    ];
    context.workingHistory = [
      ...context.workingHistory.slice(0, 8),
      ...preserved,
    ];
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent:
        '<analysis>ok</analysis><summary>calculator checked</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(context);

    const serialized = JSON.stringify(
      vi.mocked(runForkedAgent).mock.calls[0]![0].forkContextMessages,
    );
    expect(serialized).toContain('M8:');
    expect(serialized).not.toContain('latest response explanation');
    expect(serialized).not.toContain('read-2');
    expect(serialized).not.toContain('bash-2');
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).toHaveLength(2 + preserved.length);
    preserved.forEach((message, index) => {
      expect(result.newHistory![index + 2]).toBe(message);
    });
    expect(result.newHistory![0]).toMatchObject({
      compactMetadata: { messagesSummarized: 8 },
    });
  });

  it('keeps full-summary recovery available when the opening response is the only response group', async () => {
    const context = createTenMessageContext();
    context.workingHistory = context.workingHistory.slice(0, 3);
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent:
        '<analysis>ok</analysis><summary>calculator source read</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(context);

    const serialized = JSON.stringify(
      vi.mocked(runForkedAgent).mock.calls[0]![0].forkContextMessages,
    );
    expect(serialized).toContain('M1:');
    expect(serialized).toContain('M2:');
    expect(serialized).toContain('M3:');
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).toHaveLength(2);
    expect(result.newHistory![0]).toMatchObject({
      compactMetadata: { messagesSummarized: 3 },
    });
  });

  it.each([
    { value: undefined, preserved: true },
    { value: 'false', preserved: true },
    { value: '0', preserved: true },
    { value: 'invalid', preserved: true },
    { value: 'true', preserved: true },
    { value: '1', preserved: true },
  ])(
    'segments by default regardless of the obsolete QODER_SEGMENTED_COMPACTION=$value',
    async ({ value, preserved }) => {
      vi.stubEnv('QODER_SEGMENTED_COMPACTION', value);
      const context = createTenMessageContext();
      vi.mocked(runForkedAgent).mockResolvedValueOnce({
        messages: [],
        totalUsage: cloneUsage(),
        textContent:
          '<analysis>ok</analysis><summary>calculator checked</summary>',
      } as Awaited<ReturnType<typeof runForkedAgent>>);

      const result = await runForkCompact(context);

      expect(runForkedAgent).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(
        vi.mocked(runForkedAgent).mock.calls[0]![0].forkContextMessages,
      );
      const summarized = preserved ? 8 : 10;
      for (let index = 1; index <= 10; index++) {
        if (index <= summarized) {
          expect(serialized).toContain(`M${index}:`);
        } else {
          expect(serialized).not.toContain(`M${index}:`);
        }
      }
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).toHaveLength(preserved ? 4 : 2);
      expect(result.newHistory![0]).toMatchObject({
        subtype: 'compact_boundary',
        compactMetadata: { messagesSummarized: summarized },
      });
      expect(result.newHistory![1]).toMatchObject({
        type: 'user',
        isCompactSummary: true,
        message: {
          content: preserved
            ? [
                expect.objectContaining({ type: 'text' }),
                {
                  type: 'text',
                  text: 'The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.',
                },
              ]
            : [expect.objectContaining({ type: 'text' })],
        },
      });
      if (preserved) {
        expect(result.newHistory![2]).toBe(context.workingHistory[8]);
        expect(result.newHistory![3]).toBe(context.workingHistory[9]);
      }
    },
  );

  it('keeps synchronous segmentation enabled when the obsolete environment variable changes', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      messages: [],
      totalUsage: cloneUsage(),
      textContent:
        '<analysis>ok</analysis><summary>calculator checked</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    for (const [call, enabled] of [false, true, false].entries()) {
      vi.stubEnv('QODER_SEGMENTED_COMPACTION', String(enabled));
      const context = createTenMessageContext();

      const result = await runForkCompact(context);

      expect(runForkedAgent).toHaveBeenCalledTimes(call + 1);
      const serialized = JSON.stringify(
        vi.mocked(runForkedAgent).mock.calls[call]![0].forkContextMessages,
      );
      expect(serialized).toContain('M8:');
      for (const marker of ['M9:', 'M10:']) {
        expect(serialized).not.toContain(marker);
      }
      expect(result.newHistory).toHaveLength(4);
      expect(result.newHistory![2]).toBe(context.workingHistory[8]);
      expect(result.newHistory![3]).toBe(context.workingHistory[9]);
    }
  });

  it('uses the exact parent request prefix instead of re-reading Config', async () => {
    const context = createContext();
    const getUserContext = vi.fn(() => ({
      autoMemory: 'stale native memory',
    }));
    const getMemoryContextManager = vi.fn(() => ({ getUserContext }));
    context.input.config = {
      ...context.input.config,
      getMemoryContextManager,
    } as unknown as CompressionStageContext['input']['config'];
    context.input.requestPrefixMessages = [
      makeUser([{ type: 'text', text: 'exact SDK-aware prefix' }]),
    ];
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: '<analysis>ok</analysis><summary>usable summary</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    await runForkCompact(context);

    const forkContext =
      vi.mocked(runForkedAgent).mock.calls[0]?.[0].forkContextMessages;
    expect(JSON.stringify(forkContext)).toContain('exact SDK-aware prefix');
    expect(JSON.stringify(forkContext)).not.toContain('stale native memory');
    expect(getMemoryContextManager).not.toHaveBeenCalled();
    expect(getUserContext).not.toHaveBeenCalled();
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: context.input.systemPrompt,
        toolChoice: 'none',
      }),
    );
    const compactPrompt = vi.mocked(runForkedAgent).mock.calls[0]?.[0].prompt;
    expect(compactPrompt).toContain('internal compaction instruction');
    expect(compactPrompt).toContain(
      'Do NOT include this message in "All user messages"',
    );
  });

  it('does not re-read Config memory when the parent request prefix is empty', async () => {
    const context = createContext();
    const getUserContext = vi.fn(() => ({
      agentsMd: 'main-session-only memory',
    }));
    const getMemoryContextManager = vi.fn(() => ({ getUserContext }));
    context.input.config = {
      ...context.input.config,
      getMemoryContextManager,
    } as unknown as CompressionStageContext['input']['config'];
    context.workingHistory = [
      makeUser([{ type: 'text', text: 'subagent-owned context' }]),
      ...context.workingHistory,
    ];
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: '<analysis>ok</analysis><summary>usable summary</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    await runForkCompact(context);

    const forkContext =
      vi.mocked(runForkedAgent).mock.calls[0]?.[0].forkContextMessages;
    const serializedForkContext = JSON.stringify(forkContext);
    expect(serializedForkContext).toContain('subagent-owned context');
    expect(serializedForkContext.split('subagent-owned context')).toHaveLength(
      2,
    );
    expect(serializedForkContext).not.toContain('main-session-only memory');
    expect(getMemoryContextManager).not.toHaveBeenCalled();
    expect(getUserContext).not.toHaveBeenCalled();
  });

  it('forwards custom context to the compact fork', async () => {
    const context = createContext();
    const customContext = { tenant: 'pds', request_scope: 'compact-test' };
    context.input.customContext = customContext;
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: '<analysis>ok</analysis><summary>usable summary</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    await runForkCompact(context);

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ customContext }),
    );
  });

  it('classifies full fork request failures separately from empty summaries', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(createQuotaError());

    const result = await runForkCompact(createContext());

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('quota_exhausted');
    expect(result.info.providerStatus).toBe(403);
    expect(result.info.errorCode).toBe('112');
  });

  it('classifies numeric quota provider codes', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(createQuotaError(112));

    const result = await runForkCompact(createContext());

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('quota_exhausted');
    expect(result.info.errorCode).toBe('112');
  });

  it('does not treat a third-party HTTP 403 with code 122 as Qoder quota', async () => {
    const context = createContext();
    const selection = context.input.modelResolution;
    context.input.modelResolution = {
      ...selection,
      model: { ...selection.model, source: 'third-party' },
    };
    const cause = new ClientError('HTTP 403', {
      statusCode: 403,
      responseBody: JSON.stringify({ error: { code: '122', message: 'Forbidden' } }),
    });
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      new ModelInferenceError(cause.message, {
        ...classifyClientError(cause),
        phase: 'before_output',
        cause,
      }),
    );

    const result = await runForkCompact(context);

    expect(result.info).toMatchObject({
      failureReason: 'auth_error',
      providerStatus: 403,
      providerSource: 'third-party',
      errorCode: '122',
    });
  });

  it('maps a semantic model refusal to dynamic error code 406', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Content filtered'), {
        code: 'MODEL_REFUSAL',
        error_code: 'MODEL_REFUSAL',
      }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.displayErrorCode).toBe(406);
    expect(result.info.errorFallbackMessage).toBe('Content filtered');
    expect(result.info.failureReason).toBe('provider_error');
    expect(result.info.errorCode).toBe('406');
  });

  it('uses a recognized ResultCode when no raw provider code is available', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Request rejected'), { status: 416 }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.failureReason).toBe('provider_error');
    expect(result.info.errorCode).toBe('416');
    expect(result.info.providerStatus).toBe(416);
  });

  it('uses the transport code when provider and ResultCode are unavailable', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Transport failed'), { code: 'invalid_request' }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.failureReason).toBe('provider_error');
    expect(result.info.errorCode).toBe('invalid_request');
  });

  it('classifies free-trial quota exhaustion', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(createQuotaError('114'));

    const result = await runForkCompact(createContext());

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('quota_exhausted');
    expect(result.info.errorCode).toBe('114');
  });

  it('classifies partial fork request failures the same way', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(createQuotaError());

    const result = await runPartialForkCompact(createContext(), {
      direction: 'up_to',
      pivotIndex: 1,
    });

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('quota_exhausted');
    expect(result.info.providerStatus).toBe(403);
    expect(result.info.errorCode).toBe('112');
  });

  it('keeps empty model output on the existing empty-summary status', async () => {
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      textContent: '',
    } as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(createContext());

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.info.failureReason).toBe('empty_summary');
  });

  it.each([false, true])(
    'preserves reasoning-only model completions in failure_reason (wrapped=%s)',
    async (wrapped) => {
      const error = new EmptyAssistantCompletionError({
        reason: 'reasoning_only',
        finishReason: 'end_turn',
        contentBlockCount: 1,
        reasoningBlockCount: 1,
        textCharacterCount: 0,
        model: 'test-model',
        transport: 'responses',
      });
      vi.mocked(runForkedAgent).mockRejectedValueOnce(
        wrapped
          ? new ModelInferenceError('empty completion', {
              kind: 'unknown',
              phase: 'after_output',
              code: error.code,
              cause: error,
            })
          : error,
      );

      const result = await runForkCompact(createContext());

      expect(result.newHistory).toBeNull();
      expect(result.info.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
      );
      expect(result.info.failureReason).toBe('reasoning_only');
    },
  );

  it('preserves nested custom-provider access failures', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Model request failed'), {
        cause: new CustomProviderAccessError('denied'),
      }),
    );

    const result = await runForkCompact(createContext());

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('provider_access');
  });

  describe.each(['full', 'partial'] as const)('%s summary cleanup', (mode) => {
    async function compact(textContent: string) {
      vi.mocked(runForkedAgent).mockResolvedValueOnce({
        messages: [],
        totalUsage: { input_tokens: 0, output_tokens: 0 },
        textContent,
      } as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

      const context = createContext();
      return mode === 'full'
        ? runForkCompact(context)
        : runPartialForkCompact(context, { direction: 'up_to', pivotIndex: 1 });
    }

    it.each([
      [
        '<summary>paired summary</summary>',
        'Summary:\npaired summary',
        'summary_parse_paired',
      ],
      ['plain summary', 'plain summary', 'summary_parse_plain'],
      [
        '<summary>unfinished summary',
        '<summary>unfinished summary',
        'summary_parse_open_only',
      ],
      [
        'summary without opening tag</summary>',
        'summary without opening tag</summary>',
        'summary_parse_close_only',
      ],
      [
        '<analysis>scratchpad</analysis>usable summary',
        'usable summary',
        'summary_parse_plain',
      ],
    ])(
      'accepts usable output without paired tags: %s',
      async (raw, expected, failureReason) => {
        const result = await compact(raw);

        expect(result.info.compressionStatus).toBe(
          CompressionStatus.COMPRESSED,
        );
        expect(result.summaryParseReason).toBe(failureReason);
        expect(result.newHistory).not.toBeNull();
        expect(result.compactSummary).toBe(expected);
        expect(JSON.stringify(result.newHistory)).toContain(
          expected.replaceAll('\n', '\\n'),
        );
      },
    );

    it.each([
      ['<analysis>draft</analysis>', '', 'summary_parse_plain'],
      [
        '<analysis>unfinished draft',
        '<analysis>unfinished draft',
        'summary_parse_plain',
      ],
      ['<summary> </summary>', 'Summary:', 'summary_parse_paired'],
      [
        '<analysis>draft</analysis><summary></summary>',
        'Summary:',
        'summary_parse_paired',
      ],
      [
        '<analysis>draft</analysis><summary>Keep `<analysis>` and `<summary>`. Pending: fix A</summary>',
        'Summary:\nKeep `<analysis>` and `<summary>`. Pending: fix A',
        'summary_parse_paired',
      ],
    ])(
      'accepts nonempty raw output with permissive formatting: %s',
      async (raw, expected, parseReason) => {
        const result = await compact(raw);
        expect(result.info.compressionStatus).toBe(
          CompressionStatus.COMPRESSED,
        );
        expect(result.info.failureReason).toBeUndefined();
        expect(result.summaryParseReason).toBe(parseReason);
        expect(result.compactSummary).toBe(expected);
        expect(result.newHistory).not.toBeNull();
        expect(JSON.stringify(result.newHistory)).toContain(
          expected.replaceAll('\n', '\\n'),
        );
      },
    );

    it('rejects whitespace-only raw output', async () => {
      const result = await compact(' \n ');
      expect(result.newHistory).toBeNull();
      expect(result.info.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
      );
      expect(result.info.failureReason).toBe('empty_summary');
    });
  });

  it('preserves reactive trigger and owner on progress events', async () => {
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      textContent:
        '<analysis>internal reasoning</analysis><summary>usable summary</summary>',
    } as unknown as Awaited<ReturnType<typeof runForkedAgent>>);
    const context = createContext();
    context.input.trigger = 'reactive';
    const progressSpy = vi.spyOn(coreEvents, 'emitCompressionProgress');

    try {
      await runForkCompact(context);

      expect(progressSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'summarizing',
          trigger: 'reactive',
          sessionScopeId: 'session-main',
          target: 'main',
        }),
      );
      expect(progressSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'post_processing',
          trigger: 'reactive',
          sessionScopeId: 'session-main',
          target: 'main',
        }),
      );
    } finally {
      progressSpy.mockRestore();
    }
  });

  it('observes actual fork request ids and usage without changing the result', async () => {
    const usageEvents: unknown[] = [];
    const onUsage = (event: unknown) => usageEvents.push(event);
    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        requestId: 'compact-request-failed',
        modelRequestIds: ['compact-request-failed'],
        modelRequests: [],
        modelRequestResults: [],
        totalUsage: { ...cloneUsage(), credits: 0.25 },
        durationMs: 400,
        success: false,
      });
      throw new Error(
        'Prompt is too long: 120000 tokens exceeds the limit 100000',
      );
    });
    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      const totalUsage = {
        ...cloneUsage(),
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
        credits: 1.5,
        billable: true,
      };
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        requestId: 'compact-request-1',
        modelRequestIds: ['compact-request-1'],
        modelRequests: [
          {
            requestId: 'compact-request-1',
            model: params.model ?? params.config.getModel(),
            ttftMs: 200,
            durationMs: 500,
            usage: totalUsage,
            thinkingTokens: 12,
            finishReason: 'end_turn',
          },
        ],
        modelRequestResults: [],
        totalUsage,
        durationMs: 900,
        success: true,
      });
      return {
        messages: [],
        totalUsage,
        textContent:
          '<analysis>internal reasoning</analysis><summary>usable summary</summary>',
      };
    });

    const context = createContext();
    context.input.onCompactUsage = onUsage;
    const result = await runForkCompact(context);

    expect(usageEvents).toMatchObject([
      {
        sessionId: 'root-session-main',
        modelRequestIds: ['compact-request-failed'],
        usage: { credits: 0.25 },
      },
      {
        sessionId: 'root-session-main',
        modelRequestIds: ['compact-request-1'],
        usage: { credits: 1.5 },
      },
    ]);

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
  });

  it('exposes billed usage when compression fails without a boundary', async () => {
    clearSessionCredits('root-session-main');
    const usageEvents: unknown[] = [];
    const onUsage = (event: unknown) => usageEvents.push(event);
    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      recordCompletedRequest({
        sessionId: 'root-session-main',
        requestId: 'failed-request',
        model: params.model ?? params.config.getModel(),
        usage: { credits: 0.5, billable: true },
      });
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        modelRequestIds: ['failed-request'],
        modelRequests: [],
        modelRequestResults: [],
        totalUsage: cloneUsage(),
        durationMs: 10,
        success: false,
      });
      throw new Error('request failed');
    });
    try {
      const context = createContext();
      context.input.onCompactUsage = onUsage;
      const result = await runForkCompact(context);
      expect(result.newHistory).toBeNull();
      expect(usageEvents).toMatchObject([
        { modelRequestIds: ['failed-request'], usage: { credits: 0.5 } },
      ]);
    } finally {
      clearSessionCredits('root-session-main');
    }
  });

  it('retries prompt-too-long compaction without inline media', async () => {
    const context = createContext();
    context.workingHistory = [
      {
        type: 'attachment',
        uuid: 'image-attachment',
        timestamp: '2026-08-31T00:00:00.000Z',
        attachment: {
          type: 'image_file',
          filename: '/tmp/screenshot.png',
          displayPath: 'screenshot.png',
          mediaType: 'image/png',
          originalSize: 20_000_000,
          base64: 'large-base64-payload',
        },
      },
      ...context.workingHistory,
    ];
    vi.mocked(runForkedAgent)
      .mockRejectedValueOnce(new Error('Input is too long'))
      .mockResolvedValueOnce({
        messages: [],
        totalUsage: { input_tokens: 0, output_tokens: 0 },
        textContent: '<analysis>ok</analysis><summary>usable summary</summary>',
      } as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(runForkedAgent).toHaveBeenCalledTimes(2);

    const firstContext =
      vi.mocked(runForkedAgent).mock.calls[0]?.[0].forkContextMessages;
    const retryContext =
      vi.mocked(runForkedAgent).mock.calls[1]?.[0].forkContextMessages;
    expect(JSON.stringify(firstContext)).toContain('large-base64-payload');
    expect(JSON.stringify(retryContext)).toContain('[image]');
    expect(JSON.stringify(retryContext)).not.toContain('large-base64-payload');
  });

  it('retries media-too-large compaction without inline media', async () => {
    const context = createContext();
    context.workingHistory = [
      {
        type: 'attachment',
        uuid: 'image-attachment',
        timestamp: '2026-08-31T00:00:00.000Z',
        attachment: {
          type: 'image_file',
          filename: '/tmp/screenshot.png',
          displayPath: 'screenshot.png',
          mediaType: 'image/png',
          originalSize: 20_000_000,
          base64: 'large-base64-payload',
        },
      },
      ...context.workingHistory,
    ];
    const mediaError = Object.assign(new Error('Error in upstream response'), {
      details: JSON.stringify({
        code: 'media_too_large',
        message: 'Too much media in request',
      }),
    });
    vi.mocked(runForkedAgent)
      .mockRejectedValueOnce(mediaError)
      .mockResolvedValueOnce({
        messages: [],
        totalUsage: { input_tokens: 0, output_tokens: 0 },
        textContent: '<analysis>ok</analysis><summary>usable summary</summary>',
      } as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(runForkedAgent).toHaveBeenCalledTimes(2);
    const retryContext =
      vi.mocked(runForkedAgent).mock.calls[1]?.[0].forkContextMessages;
    expect(JSON.stringify(retryContext)).toContain('[image]');
    expect(JSON.stringify(retryContext)).not.toContain('large-base64-payload');
  });

  it('links media removal and PTL truncation to their actual summary forks', async () => {
    const context = createContext();
    context.workingHistory = [
      {
        type: 'attachment',
        uuid: 'image-trace',
        timestamp: '2026-08-31T00:00:00.000Z',
        attachment: {
          type: 'image_file',
          filename: '/tmp/image.png',
          displayPath: 'image.png',
          mediaType: 'image/png',
          originalSize: 100,
          base64: 'inline-image-payload',
        },
      },
      ...context.workingHistory,
    ];
    const original = [...context.workingHistory];
    vi.mocked(runForkedAgent)
      .mockRejectedValueOnce(
        Object.assign(new Error('Too much media in request'), {
          code: 'media_too_large',
          status: 413,
        }),
      )
      .mockRejectedValueOnce(new Error('Prompt is too long'))
      .mockResolvedValueOnce({
        messages: [],
        totalUsage: cloneUsage(),
        textContent: '<summary>usable summary</summary>',
      });

    const result = await runForkCompact(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    const contexts = vi
      .mocked(runForkedAgent)
      .mock.calls.map(([params]) => JSON.stringify(params.forkContextMessages));
    expect(contexts[0]).toContain('inline-image-payload');
    expect(contexts[1]).not.toContain('inline-image-payload');
    expect(contexts[1]).toContain('Investigate compact failures.');
    expect(contexts[2]).not.toContain('Investigate compact failures.');
    expect(context.workingHistory).toEqual(original);
  });

  it('stops media recovery on a non-recoverable error', async () => {
    const context = createContext();
    context.workingHistory = [
      {
        type: 'attachment',
        uuid: 'image-stop',
        timestamp: '2026-08-31T00:00:00.000Z',
        attachment: {
          type: 'image_file',
          filename: '/tmp/image.png',
          displayPath: 'image.png',
          mediaType: 'image/png',
          originalSize: 100,
          base64: 'inline-image-payload',
        },
      },
      ...context.workingHistory,
    ];
    vi.mocked(runForkedAgent).mockRejectedValueOnce(createQuotaError());
    const result = await runForkCompact(context);
    expect(result.info.failureReason).toBe('quota_exhausted');
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
  });

  it('returns media-too-large from the existing request classifier', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Error in upstream response'), {
        details: JSON.stringify({ code: 'request_too_large' }),
      }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('media_too_large');
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
  });

  it('passes the selected direct model and complete configuration without rebuilding credentials', async () => {
    const context = createContext();
    const compactModel = {
      ...testProviderModelResolution('openai/compact-model').model,
      source: 'openai',
      connection: {
        model: 'compact-upstream',
        provider: 'openai',
        parameters: { api_key: 'sk-compact' },
      },
    };
    const selected = {
      model: compactModel,
      config: {
        sampling: { temperature: 0.7, topP: 0.9, topK: 20 },
        reasoning: {
          effort: 'high' as const,
          thinking: { type: 'enabled' as const, budgetTokens: 8192 },
          preserve: false,
        },
        context: { maxOutputTokens: 16_384, contextWindow: 128_000 },
      },
    };
    const policyLabels = { taskId: 'compact-task', subTask: 'compact-label' };
    context.input.policyLabels = policyLabels;
    vi.mocked(context.input.modelProviderManager.select).mockResolvedValue(
      selected,
    );
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: '<summary>usable summary</summary>',
    } as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(context.input.modelProviderManager.select).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runForkedAgent).mock.calls[0][0];
    expect(params.model).toBe(compactModel.key);
    expect(params.compactSelection).toBe(selected);
    expect(params.policyLabels).toBe(policyLabels);
    expect(params).toMatchObject({
      sessionId: 'root-session-main',
      sessionScopeId: 'session-main',
      toolChoice: 'none',
      skipCacheWrite: true,
    });
    for (const field of [
      'customModelOverride',
      'generation',
      'thinkingBudget',
      'reasoningEffort',
      'contextWindow',
    ]) {
      expect(params).not.toHaveProperty(field);
    }
  });

  it.each([
    undefined,
    { type: 'disabled' },
    { type: 'enabled', budgetTokens: 8192 },
  ] as const)(
    'forwards the complete same-model snapshot with thinking %j',
    async (thinking) => {
      const context = createContext();
      const parent = testProviderModelResolution('test-model', {
        sampling: { temperature: 1, topP: 0.95, topK: 20 },
        reasoning: {
          effort: 'high',
          preserve: false,
          ...(thinking ? { thinking } : {}),
        },
        context: { maxOutputTokens: 16_384, contextWindow: 128_000 },
      });
      context.input.modelResolution = parent;
      vi.mocked(runForkedAgent).mockResolvedValueOnce({
        messages: [],
        totalUsage: cloneUsage(),
        textContent: '<summary>usable summary</summary>',
      } as Awaited<ReturnType<typeof runForkedAgent>>);

      expect((await runForkCompact(context)).info.compressionStatus).toBe(
        CompressionStatus.COMPRESSED,
      );
      const params = vi.mocked(runForkedAgent).mock.calls[0][0];
      expect(params.compactSelection).toBe(parent);
      expect(params.compactSelection?.config.reasoning?.thinking).toEqual(
        thinking,
      );
      expect(params).not.toHaveProperty('thinkingBudget');
      expect(params).not.toHaveProperty('generation');
    },
  );

  it.each([
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    new Error('Operation cancelled by user'),
  ])(
    'rethrows lazy compact resolver cancellation without starting the fork',
    async (cancellationError) => {
      const context = createContext();
      vi.mocked(context.input.modelProviderManager.select).mockRejectedValue(
        cancellationError,
      );

      await expect(runForkCompact(context)).rejects.toBe(cancellationError);
      expect(runForkedAgent).not.toHaveBeenCalled();
    },
  );

  it('keeps an in-flight fork running until it returns a usable summary', async () => {
    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      expect(params.signal?.aborted).toBe(false);
      return {
        messages: [],
        totalUsage: cloneUsage(),
        textContent: '<summary>usable summary</summary>',
      } as Awaited<ReturnType<typeof runForkedAgent>>;
    });
    const result = await runForkCompact(createContext());

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
  });

  it('rethrows user cancellation instead of classifying it as a provider failure', async () => {
    const abortError = new Error('Operation cancelled by user');
    abortError.name = 'AbortError';
    vi.mocked(runForkedAgent).mockRejectedValueOnce(abortError);

    await expect(runForkCompact(createContext())).rejects.toBe(abortError);
  });

  it('propagates parent cancellation to an in-flight fork', async () => {
    const controller = new AbortController();
    const context = createContext();
    context.input.abortSignal = controller.signal;
    let childSignal: AbortSignal | undefined;
    vi.mocked(runForkedAgent).mockImplementationOnce(
      (params) =>
        new Promise((_resolve, reject) => {
          childSignal = params.signal;
          params.signal?.addEventListener(
            'abort',
            () => reject(params.signal?.reason),
            { once: true },
          );
        }),
    );

    const compact = runForkCompact(context);
    const rejection = compact.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(childSignal).toBeDefined();
    });
    controller.abort();

    await expect(rejection).resolves.toMatchObject({
      name: 'AbortError',
    });
    expect(childSignal?.aborted).toBe(true);
  });

  it('classifies local programming errors separately from provider failures', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      new TypeError('config.getWorkspaceContext is not a function'),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
    );
    expect(result.info.failureReason).toBe('local_error');
  });

  it('classifies HTTP rate limits as transient request failures', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { status: 429 }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.failureReason).toBe('rate_limited');
  });

  it('classifies HTTP 5xx failures as server errors', async () => {
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Internal server error'), {
        code: 'http_error',
        status: 503,
      }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.failureReason).toBe('server_error');
  });

  it('classifies exhausted prompt-too-long recovery as one request failure', async () => {
    vi.mocked(runForkedAgent).mockRejectedValue(
      new Error('Prompt is too long: 120000 tokens exceeds the limit 100000'),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.failureReason).toBe('prompt_too_long');
    expect(runForkedAgent).toHaveBeenCalledTimes(2);
  });

  it('classifies a nested maximum context length error as prompt-too-long', async () => {
    const body = JSON.stringify({
      code: 'provider_error',
      message: 'Error in upstream response',
      details: JSON.stringify({
        error: {
          code: 'invalid_request_error',
          message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1052983 tokens (1004983 in the messages, 48000 in the completion).",
        },
      }),
    });
    vi.mocked(runForkedAgent).mockRejectedValue(
      Object.assign(new Error(`Qoder API error: BAD_REQUEST - ${body}`), {
        code: 'http_error',
        status: 400,
      }),
    );

    const result = await runForkCompact(createContext());

    expect(result.info.failureReason).toBe('prompt_too_long');
    expect(runForkedAgent).toHaveBeenCalledTimes(2);
  });

  it('accepts a paired full-fork summary', async () => {
    vi.mocked(runForkedAgent).mockImplementationOnce(async () => ({
      messages: [],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      textContent: '<analysis>ok</analysis><summary>usable summary</summary>',
    }) as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(createContext());

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.summaryParseReason).toBe('summary_parse_paired');
    expect(result.info.failureReason).toBeUndefined();
    expect(result.newHistory).not.toBeNull();
  });

  it('classifies empty fork output as an empty summary', async () => {
    vi.mocked(runForkedAgent).mockImplementationOnce(async () => ({
      messages: [],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      textContent: '',
    }) as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runForkCompact(createContext());

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.info.failureReason).toBe('empty_summary');
  });
});
