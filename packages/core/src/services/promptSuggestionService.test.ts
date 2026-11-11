/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { Message } from '../protocol/transcript/message.js';
import type { Config } from '../config/config.js';
import type { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';
import type { ModelStreamResponse } from '../provider/modelStreamResponse.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import { resolveSelectedModelConfig } from '../provider/model/modelConfig.js';
import {
  testProviderModel,
  testRequestConfig,
} from '../test-utils/model-resolution.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import { capturePromptSuggestionForkSource } from './promptSuggestionFork.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import {
  PREDICTION_FORK_REQUEST,
  onModelRequestScopeEnd,
} from '../model-request/request-scope.js';
import {
  clearSessionCredits,
  getSessionCreditsSnapshot,
  recordCompletedRequest,
} from './session-state-usage.js';

import {
  installConfigService,
  stopConfigService,
} from '../config-service/index.js';
import type {
  ConfigService,
  ConfigValueListener,
} from '../config-service/config-service.js';
import { PROMPT_SUGGESTION_FEATURE_GATE } from '../config-service/features/promptSuggestion.js';
import type { GetModelPolicyCallback } from '../core/model-policy.js';
import {
  PromptSuggestionService,
  shouldFilterSuggestion,
  tryGeneratePromptSuggestion,
} from './promptSuggestionService.js';
import {
  getSessionIdFromContext,
  customContextContext,
  getCustomContextFromContext,
  businessInfoContext,
  requestSetIdContext,
} from '../utils/sessionIdContext.js';

function assistantMessage(uuid: string, text = 'done'): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: uuid,

      model: 'test-model',
      stop_reason: 'end_turn',

      usage: cloneUsage(),
      content: [{ type: 'text', text }],
    },
  };
}

function splitAssistantTextMessage(
  uuid: string,
  responseId: string,
  text: string,
  isLastBlock: boolean,
): Message {
  const message = assistantMessage(uuid, text);
  if (message.type === 'assistant') {
    message.message = { ...message.message, id: responseId };
    message.message = {
      ...message.message,
      stop_reason: isLastBlock ? 'end_turn' : null,
      usage: isLastBlock ? message.message.usage : undefined,
    };
    if (!isLastBlock) {
      delete message.message.usage;
    }
  }
  return message;
}

function assistantToolUseMessage(
  uuid: string,
  toolUse: { id: string; name: string; input: Record<string, unknown> },
): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: uuid,

      model: 'test-model',
      stop_reason: 'tool_use',

      usage: cloneUsage(),
      content: [{ type: 'tool_use', ...toolUse }],
    },
  };
}

function assistantToolUseBatchMessage(
  uuid: string,
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
): Message {
  const message = assistantToolUseMessage(
    uuid,
    toolUses[0] ?? { id: `${uuid}-empty`, name: 'Unknown', input: {} },
  );
  if (message.type === 'assistant') {
    message.message = {
      ...message.message,
      content: toolUses.map((toolUse) => ({
        type: 'tool_use',
        ...toolUse,
      })),
    };
  }
  return message;
}

function userMessage(
  uuid: string,
  text: string,
  originKind: 'human' | 'bridge' = 'human',
): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    origin: { kind: originKind },
    message: {
      role: 'user',
      content: text,
    },
  };
}

function toolResultMessage(
  uuid: string,
  toolUseId: string,
  content: string,
  isError = false,
): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  };
}

function toolResultBatchMessage(
  uuid: string,
  results: Array<{ toolUseId: string; content: string; isError?: boolean }>,
): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolUseId,
        content: result.content,
        is_error: result.isError === true,
      })),
    },
  };
}

describe('promptSuggestionService', () => {
  let generateContent: ReturnType<
    typeof vi.fn<(request: ModelStreamRequest) => Promise<string>>
  >;
  let inference: ReturnType<typeof vi.fn<ModelProviderManager['inference']>>;
  let service: PromptSuggestionService;
  let config: Pick<Config, 'getModelProviderManager' | 'getModel'>;
  let select: ReturnType<typeof vi.fn<ModelProviderManager['select']>>;
  let baseSelection: ModelSelection;
  let gateValue: unknown;
  let gateListeners: Set<ConfigValueListener>;

  function updateGate(value: unknown): void {
    gateValue = value;
    for (const listener of gateListeners) listener(value);
  }

  const response = (
    text: string,
    usage?: ModelMessage['usage'],
  ): ModelStreamResponse => {
    const message: ModelMessage = {
      messageId: 'suggestion-response',
      usage,
      model: 'lite',
      stopReason: 'end_turn',
      blocks: [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text },
      ],
    };
    return {
      events: { async *[Symbol.asyncIterator]() {} },
      completed: Promise.resolve(message),
      partial: Promise.resolve({ ...message, openBlocks: new Map() }),
    };
  };

  function suggestionContext(): string {
    const request = generateContent.mock.calls[0]?.[0];
    const message = request?.prompt.messages.find(
      (message) => message.role === 'user',
    );
    if (!message || typeof message.content !== 'string') {
      throw new Error('应通过标准请求发送建议上下文');
    }
    return message.content;
  }

  beforeEach(() => {
    generateContent = vi.fn().mockResolvedValue('run the tests');
    inference = vi.fn(async (request: ModelStreamRequest) =>
      response(await generateContent(request)),
    );
    baseSelection = {
      model: {
        ...testProviderModel('lite'),
        limits: { maxContextTokens: 200_000, maxOutputTokens: 4096 },
      },
      config: { reasoning: { effort: 'none' } },
    };
    select = vi.fn(
      async (
        input: ModelSelectContext & { overrideSelection?: ModelSelection },
      ) => {
        const selection = input.overrideSelection ?? baseSelection;
        return {
          model: selection.model,
          config: resolveSelectedModelConfig(selection.model, selection.config),
        };
      },
    );
    config = {
      getModelProviderManager: () =>
        ({ select, inference }) as unknown as ModelProviderManager,
      getModel: () => 'auto',
    };
    service = new PromptSuggestionService(config);
    gateValue = undefined;
    gateListeners = new Set();
    const source: ConfigService = {
      start: async () => {},
      stop: async () => gateListeners.clear(),
      getValue: <T>(key: string) =>
        (key === PROMPT_SUGGESTION_FEATURE_GATE ? gateValue : undefined) as
          | T
          | undefined,
      onValueChange: (key, listener) => {
        if (key === PROMPT_SUGGESTION_FEATURE_GATE) gateListeners.add(listener);
        return () => {
          gateListeners.delete(listener);
        };
      },
      onError: () => () => {},
    };
    installConfigService(source);
  });

  afterEach(async () => {
    await stopConfigService();
    vi.useRealTimers();
  });

  describe('completed-turn prediction forks', () => {
    function setupFork(mode: 'shared' | 'legacy' = 'shared') {
      updateGate({
        enabled: true,
        unifiedRulesEnabled: mode === 'shared',
        forkEnabled: true,
      });
      const sessionId = 'fork-session';
      const promptId = 'source-prompt';
      const requestSetId = 'source-request-set';
      const snapshot: CacheSafeQuerySnapshot = {
        completedTurn: {
          sessionId,
          promptId,
          requestSetId,
          sourceSessionId: 'resumed-from',
          requestIdentity: {
            model: 'auto',
            identity: 'test-account',
            permission: 'default',
          },
        },
        modelResolution: baseSelection,
        model: baseSelection.model.key,
        systemPrompt: [{ type: 'text', text: 'exact parent system prompt' }],
        forkContextMessages: [
          { role: 'user', content: 'Edit only app.ts and verify the change.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'read', name: 'Read', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 'read', content: 'prior tool evidence' },
          {
            role: 'assistant',
            content: 'The change is ready for verification.',
          },
        ],
        lastAssistantUsage: cloneUsage(),
        toolSchemas: [{ name: 'Read' }, { name: 'Edit' }],
      };
      const cron = vi.fn(() => {
        throw new Error('prediction accessed Cron');
      });
      const currentSnapshot = vi.fn(() => snapshot);
      const hostCurrent = vi.fn(() => true);
      const forkConfig = {
        ...config,
        ...testRequestConfig(),
        hasModelProviderManager: () => true,
        getCacheSafeQuerySnapshot: currentSnapshot,
        getSessionId: () => sessionId,
        getPermissionMode: () => 'default',
        getCronManager: cron,
      } as unknown as Config;
      const capture = () =>
        capturePromptSuggestionForkSource(
          forkConfig,
          promptId,
          requestSetId,
          hostCurrent,
          { host: 'sdk' },
        );
      const request = {
        messages: [],
        businessInfo: Object.freeze({ version: '1', id: 'parent-business' }),
        sessionId,
        promptId,
        forkSource: capture(),
      };
      return {
        snapshot,
        currentSnapshot,
        hostCurrent,
        capture,
        request,
        cron,
        forkConfig,
      };
    }

    it.each([false, true])(
      'passes snapshot workdirs to fork selection and honors its rejection (blocked=%s)',
      async (blocked) => {
        const s = setupFork();
        const workdirs = ['/repo-a', '/repo-b'];
        s.snapshot.completedTurn!.workdirs = workdirs;
        if (blocked) {
          select.mockRejectedValueOnce(new Error('Model restricted by C4'));
        }
        const result = await service.tryGenerate(s.request);
        expect(select).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ purpose: 'suggestion', workdirs }),
        );
        if (blocked) {
          expect(result).toBeNull();
          expect(inference).not.toHaveBeenCalled();
        } else {
          expect(result?.suggestion).toBe('run the tests');
          expect(inference).toHaveBeenCalledOnce();
          expect(inference.mock.calls[0][0]).toMatchObject({
            qoder: { workdirs },
          });
        }
      },
    );

    describe('fork single-request safeguards', () => {
      function setupRequest() {
        const s = setupFork();
        service = new PromptSuggestionService(s.forkConfig);
        return s;
      }

      it('uses the parent context snapshot even when the ambient context changes', async () => {
        const s = setupRequest();
        const forkSource = capturePromptSuggestionForkSource(
          s.forkConfig,
          s.request.promptId,
          'source-request-set',
          s.hostCurrent,
        );
        inference.mockImplementationOnce(async (request) => {
          expect(getCustomContextFromContext()).toEqual({});
          expect(request).toMatchObject({ qoder: { customContext: {} } });
          return response('run the tests');
        });
        await customContextContext.run({ tenant: 'unrelated' }, async () => {
          expect(
            (await service.tryGenerate({ ...s.request, forkSource }))
              ?.suggestion,
          ).toBe('run the tests');
          expect(getCustomContextFromContext()).toEqual({
            tenant: 'unrelated',
          });
        });
        expect(inference).toHaveBeenCalledOnce();
      });

      it('has a local deadline even when directly invoked without a caller signal', async () => {
        vi.useFakeTimers();
        const s = setupRequest();
        inference.mockImplementationOnce(() => new Promise<never>(() => {}));
        const pending = runForkedAgent({
          mode: 'singleRequest',
          querySource: 'prompt_suggestion',
          config: s.forkConfig,
          selection: baseSelection,
          parent: {
            ...s.snapshot,
            completedTurn: {
              ...s.snapshot.completedTurn!,
              businessInfo: s.request.businessInfo,
            },
          },
          prompt: 'Predict the next user message',
          isCurrent: s.hostCurrent,
        });
        const failed = pending.catch((error: unknown) => error);
        await vi.waitFor(() => expect(inference).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await failed).toMatchObject({ name: 'TimeoutError' });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('attributes another single-request fork to its own source with suggestions disabled', async () => {
        const s = setupRequest();
        updateGate({ enabled: false, forkEnabled: false });
        const onCompleted = vi.fn();
        const result = await runForkedAgent({
          mode: 'singleRequest',
          querySource: 'generate_session_title',
          config: s.forkConfig,
          selection: baseSelection,
          parent: {
            ...s.snapshot,
            completedTurn: {
              ...s.snapshot.completedTurn!,
              businessInfo: s.request.businessInfo,
            },
          },
          prompt: 'Summarize the completed turn in a title',
          isCurrent: s.hostCurrent,
          onCompleted,
        });
        expect(inference).toHaveBeenCalledOnce();
        const [request] = inference.mock.calls[0];
        expect(request).toMatchObject({
          qoder: {
            business: { sub_task: 'title_generation' },
            identity: { requestId: expect.any(String) },
            taskRouting: { taskId: undefined },
          },
        });
        expect(result.textContent).toBe('run the tests');
        expect(onCompleted).toHaveBeenCalledOnce();
        const completion = onCompleted.mock.calls[0][0];
        expect(completion.success).toBe(true);
        expect(completion.modelRequestIds).toEqual([completion.requestId]);
        expect(request).toMatchObject({
          qoder: { identity: { requestId: completion.requestId } },
        });
      });

      it('bypasses agent model defaults, Skill matching, hooks, memory and Cron', async () => {
        const s = setupRequest();
        const external = vi.fn(() => {
          throw new Error('Prediction accessed execution machinery');
        });
        Object.defineProperties(s.forkConfig, {
          taskRegistry: { get: external },
          turnHookFactories: { get: external },
        });
        Object.assign(s.forkConfig, {
          getSkillManager: external,
          getHookSystem: external,
          getUserMemory: external,
        });
        expect((await service.tryGenerate(s.request))?.suggestion).toBe(
          'run the tests',
        );
        expect(external).not.toHaveBeenCalled();
        expect(s.cron).not.toHaveBeenCalled();
        expect(inference).toHaveBeenCalledOnce();
        expect(inference.mock.calls[0][0].prompt.toolChoice).toBe('none');
        expect(PREDICTION_FORK_REQUEST in inference.mock.calls[0][0]).toBe(
          true,
        );
      });

      it('bounds an inference acquisition that never responds to cancellation', async () => {
        vi.useFakeTimers();
        const s = setupRequest();
        inference.mockImplementationOnce(() => new Promise<never>(() => {}));
        const pending = service.tryGenerate(s.request);
        await vi.waitFor(() => expect(inference).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toBeNull();
        expect(inference.mock.calls[0][0].control?.signal?.aborted).toBe(true);
        expect(gateListeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('cancels and observes a late response after the caller has already left', async () => {
        const s = setupRequest();
        let finish!: (result: ModelStreamResponse) => void;
        inference.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const controller = new AbortController();
        const pending = service.tryGenerate({
          ...s.request,
          signal: controller.signal,
        });
        await vi.waitFor(() => expect(inference).toHaveBeenCalledOnce());
        controller.abort();
        expect(await pending).toBeNull();
        const cancel = vi.fn(() => new Promise<never>(() => {}));
        finish({
          ...response('late candidate'),
          completed: Promise.reject(new Error('late completion failure')),
          partial: Promise.reject(new Error('late partial failure')),
          cancel,
        });
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(inference).toHaveBeenCalledOnce();
        expect(gateListeners.size).toBe(0);
      });

      it('cancels a response when abort wins during acquisition handoff', async () => {
        const s = setupRequest();
        const controller = new AbortController();
        const cancel = vi.fn(() => new Promise<never>(() => {}));
        inference.mockImplementationOnce(() => {
          const acquisition = Promise.resolve({
            ...response('run tests'),
            cancel,
          });
          void acquisition.then(() => queueMicrotask(() => controller.abort()));
          return acquisition;
        });
        expect(
          await service.tryGenerate({
            ...s.request,
            signal: controller.signal,
          }),
        ).toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
        expect(inference).toHaveBeenCalledOnce();
      });

      it('bounds a stuck stream even when cancel and iterator return never settle', async () => {
        vi.useFakeTimers();
        const s = setupRequest();
        const cancel = vi.fn(() => new Promise<never>(() => {}));
        const next = vi.fn(() => new Promise<never>(() => {}));
        const close = vi.fn(() => new Promise<never>(() => {}));
        inference.mockResolvedValueOnce({
          events: { [Symbol.asyncIterator]: () => ({ next, return: close }) },
          completed: new Promise<never>(() => {}),
          partial: new Promise<never>(() => {}),
          cancel,
        });
        const pending = service.tryGenerate(s.request);
        await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(inference).toHaveBeenCalledOnce();
        expect(gateListeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('rejects a streamed Skill call before consuming the rest of the stream', async () => {
        const s = setupRequest();
        const cancel = vi.fn(() => new Promise<never>(() => {}));
        const close = vi.fn(() => new Promise<never>(() => {}));
        const next = vi.fn(async () => ({
          done: false as const,
          value: {
            type: 'content_block_start' as const,
            index: 0,
            contentBlock: {
              type: 'tool_use' as const,
              id: 'skill',
              name: 'Skill',
              input: {},
            },
          },
        }));
        inference.mockResolvedValueOnce({
          events: { [Symbol.asyncIterator]: () => ({ next, return: close }) },
          completed: new Promise<never>(() => {}),
          partial: new Promise<never>(() => {}),
          cancel,
        });
        expect(await service.tryGenerate(s.request)).toBeNull();
        expect(next).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(inference).toHaveBeenCalledOnce();
        expect(s.cron).not.toHaveBeenCalled();
      });

      it('does not wait for partial salvage after text delivery and a transport failure', async () => {
        const s = setupRequest();
        const cancel = vi.fn(() => new Promise<never>(() => {}));
        inference.mockResolvedValueOnce({
          ...response(''),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'content_block_start',
                index: 0,
                contentBlock: { type: 'text', text: '' },
              };
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'run tests' },
              };
              throw new Error('stream failed after committed text');
            },
          },
          completed: new Promise<never>(() => {}),
          partial: new Promise<never>(() => {}),
          cancel,
        });
        expect(await service.tryGenerate(s.request)).toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
        expect(inference).toHaveBeenCalledOnce();
      });

      it.each(['max_tokens', 'refusal', 'tool_use', 'mixed_tool'] as const)(
        'discards %s without a second inference',
        async (kind) => {
          const s = setupRequest();
          const result = response('run the tests');
          const message = await result.completed;
          inference.mockResolvedValueOnce({
            ...result,
            completed: Promise.resolve({
              ...message,
              stopReason: kind === 'mixed_tool' ? 'end_turn' : kind,
              blocks:
                kind === 'mixed_tool'
                  ? [
                      ...message.blocks,
                      { type: 'tool_use', id: 'tool', name: 'Edit', input: {} },
                    ]
                  : message.blocks,
            }),
          });
          expect(await service.tryGenerate(s.request)).toBeNull();
          expect(inference).toHaveBeenCalledOnce();
        },
      );

      it('bounds scope cleanup and never cleans up the parent request domain', async () => {
        vi.useFakeTimers();
        const s = setupRequest();
        const cleanup = vi.fn(() => new Promise<never>(() => {}));
        const unbind = onModelRequestScopeEnd(cleanup);
        try {
          const pending = requestSetIdContext.run('source-request-set', () =>
            service.tryGenerate(s.request),
          );
          await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await pending).toBeNull();
          expect(cleanup).toHaveBeenCalledExactlyOnceWith(
            'fork-session',
            expect.not.stringMatching(/^source-request-set$/),
          );
          expect(inference).toHaveBeenCalledOnce();
          expect(gateListeners.size).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          unbind();
        }
      });
    });

    it('reuses the exact prefix through the prediction fork, shares one candidate, and leaves the parent untouched', async () => {
      const s = setupFork();
      const parent = structuredClone(s.snapshot);
      const [first, duplicate] = await Promise.all([
        service.tryGenerate(s.request),
        service.tryGenerate(s.request),
      ]);
      expect(first?.suggestion).toBe('run the tests');
      expect(duplicate).toBe(first);
      expect(await service.tryGenerate(s.request)).toBe(first);
      s.currentSnapshot.mockReturnValue({ ...s.snapshot });
      expect(
        await service.tryGenerate({ ...s.request, forkSource: s.capture() }),
      ).toBeNull();
      expect(inference).toHaveBeenCalledOnce();
      expect(s.cron).not.toHaveBeenCalled();
      expect(s.snapshot).toEqual(parent);
      const req = inference.mock.calls[0][0];
      expect(PREDICTION_FORK_REQUEST in req).toBe(true);
      expect(req).toMatchObject({
        prompt: { tools: parent.toolSchemas, toolChoice: 'none' },
        qoder: {
          identity: {
            sessionId: s.request.sessionId,
            sourceSessionId: 'resumed-from',
            requestSetId: expect.not.stringMatching(/^source-request-set$/),
            requestId: expect.any(String),
          },
          business: { id: 'parent-business', sub_task: 'prompt_suggestion' },
          taskRouting: { taskId: 'agent_summary' },
          customContext: { host: 'sdk' },
        },
        resolution: {
          model: baseSelection.model,
          config: { context: { maxOutputTokens: 256 } },
        },
      });
      expect(req.prompt.messages[0].role).toBe('system');
      expect(JSON.stringify(req.prompt.messages[0])).toContain(
        'exact parent system prompt',
      );
      expect(req.prompt.messages.slice(1, -1)).toEqual(
        parent.forkContextMessages,
      );
      expect(req.prompt.messages.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringContaining(
          'Predict the single message this user is most likely to type next',
        ),
      });
    });

    it.each(['shared', 'legacy'] as const)(
      'filters the same fork response using %s rules',
      async (mode) => {
        const { request } = setupFork(mode);
        const question = 'Which regression test covers the adapter?';
        generateContent.mockResolvedValueOnce(question);
        const result = await service.tryGenerate(request);
        expect(result?.suggestion).toBe(
          mode === 'shared' ? question : undefined,
        );
        expect(inference).toHaveBeenCalledOnce();
        expect(PREDICTION_FORK_REQUEST in inference.mock.calls[0][0]).toBe(
          true,
        );
      },
    );

    it('uses the legacy host prompt on fork and does not redeliver it after switching to shared rules', async () => {
      const s = setupFork('legacy');
      const request = {
        ...s.request,
        systemPromptOverride: 'Legacy host rules',
      };
      expect((await service.tryGenerate(request))?.suggestion).toBe(
        'run the tests',
      );
      const req = inference.mock.calls[0][0];
      expect(PREDICTION_FORK_REQUEST in req).toBe(true);
      expect(req.prompt.messages.at(-1)).toMatchObject({
        role: 'user',
        content: 'Legacy host rules',
      });
      expect(req.resolution.config.context?.maxOutputTokens).toBe(64);
      updateGate({ enabled: true, mode: 'shared', forkEnabled: true });
      expect(await service.tryGenerate(request)).toBeNull();
      expect(inference).toHaveBeenCalledOnce();
    });

    it.each([
      'max_tokens',
      'refusal',
      'tool_use',
      'mixed_text_and_tool',
      'transport_error',
      'NO_SUGGESTION',
      'multiple_lines',
    ])(
      'discards %s and shares the empty result without a second inference',
      async (kind) => {
        const s = setupFork();
        inference.mockImplementationOnce(async () => {
          if (kind === 'transport_error') throw new Error('stream failed');
          const result = response(
            kind === 'NO_SUGGESTION'
              ? kind
              : kind === 'multiple_lines'
                ? 'first candidate\nsecond candidate'
                : 'run the tests',
          );
          const message = await result.completed;
          const final: ModelMessage = {
            ...message,
            stopReason:
              kind === 'refusal' || kind === 'max_tokens' || kind === 'tool_use'
                ? kind
                : ('end_turn' as const),
            blocks:
              kind === 'mixed_text_and_tool'
                ? [
                    ...message.blocks,
                    {
                      type: 'tool_use' as const,
                      name: 'Edit',
                      id: 'tool',
                      input: {},
                    },
                  ]
                : message.blocks,
          };
          return { ...result, completed: Promise.resolve<ModelMessage>(final) };
        });
        expect(await service.tryGenerate(s.request)).toBeNull();
        expect(await service.tryGenerate(s.request)).toBeNull();
        expect(inference).toHaveBeenCalledOnce();
        expect(s.cron).not.toHaveBeenCalled();
      },
    );

    it('skips mismatched checkpoints, missing tool results, and a changed session snapshot', async () => {
      const s = setupFork();
      expect(
        await service.tryGenerate({ ...s.request, forkSource: undefined }),
      ).toBeNull();
      expect(select).not.toHaveBeenCalled();
      expect(inference).not.toHaveBeenCalled();
      s.currentSnapshot.mockReturnValue({ ...s.snapshot });
      expect(await service.tryGenerate(s.request)).toBeNull();
      s.currentSnapshot.mockReturnValue({
        ...s.snapshot,
        completedTurn: undefined,
      });
      expect(s.capture()).toBeUndefined();
      s.currentSnapshot.mockReturnValue({
        ...s.snapshot,
        forkContextMessages: s.snapshot.forkContextMessages.filter(
          (message) => message.role !== 'tool',
        ),
      });
      expect(
        await service.tryGenerate({ ...s.request, forkSource: s.capture() }),
      ).toBeNull();
      expect(inference).not.toHaveBeenCalled();
    });

    it('discards a result if the host history changes during inference', async () => {
      const s = setupFork();
      inference.mockImplementationOnce(async () => {
        s.hostCurrent.mockReturnValue(false);
        return response('run the tests');
      });
      expect(await service.tryGenerate(s.request)).toBeNull();
      expect(inference).toHaveBeenCalledOnce();
    });

    it('attributes provider credits to the parent session exactly once, even for a filtered result', async () => {
      const s = setupFork();
      try {
        clearSessionCredits(s.request.sessionId);
        inference.mockImplementationOnce(async (request) => {
          const { qoder } = request as ModelStreamRequest & {
            qoder: { identity: { requestId: string; sessionId: string } };
          };
          recordCompletedRequest({
            ...qoder.identity,
            model: request.resolution.model.key,
            usage: { credits: 1.25, billable: true },
          });
          return response('NO_SUGGESTION', {
            inputTokens: 24,
            outputTokens: 3,
            cacheReadInputTokens: 16,
            cacheCreationInputTokens: 4,
          });
        });
        const pending = service.tryGenerate(s.request);
        const duplicate = service.tryGenerate(s.request);
        expect(await Promise.all([pending, duplicate])).toEqual([null, null]);
        expect(await service.tryGenerate(s.request)).toBeNull();
        expect(
          getSessionCreditsSnapshot(s.request.sessionId).totalCredits,
        ).toBe(1.25);
        expect(inference).toHaveBeenCalledOnce();
      } finally {
        clearSessionCredits(s.request.sessionId);
      }
    });

    it.each(['failed', 'cancelled'] as const)(
      'shares one %s prediction attempt between concurrent callers',
      async (status) => {
        const s = setupFork();
        const controller = new AbortController();
        inference.mockImplementationOnce(async () => {
          if (status === 'cancelled') controller.abort();
          throw new Error('Transport interrupted');
        });
        const request = { ...s.request, signal: controller.signal };
        expect(
          await Promise.all([
            service.tryGenerate(request),
            service.tryGenerate(request),
          ]),
        ).toEqual([null, null]);
        expect(await service.tryGenerate(s.request)).toBeNull();
        expect(inference).toHaveBeenCalledOnce();
      },
    );

    it('cancels an active fork on rollout rollback and caches the empty result', async () => {
      const s = setupFork();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      inference.mockImplementationOnce(async (request) => {
        ready();
        const result = response('run the tests');
        return {
          ...result,
          completed: new Promise<ModelMessage>((_resolve, reject) => {
            request.control!.signal!.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            );
          }),
        };
      });
      const pending = service.tryGenerate(s.request);
      await started;
      updateGate({ enabled: true, mode: 'shared' });
      expect(await pending).toBeNull();
      expect(inference.mock.calls[0][0].control?.signal?.aborted).toBe(true);
      updateGate({ enabled: true, mode: 'shared', forkEnabled: true });
      expect(await service.tryGenerate(s.request)).toBeNull();
      expect(inference).toHaveBeenCalledOnce();
    });

    it('lets a second consumer leave while the first continues receiving the shared result', async () => {
      const s = setupFork();
      let finish!: (text: string) => void;
      generateContent.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const first = service.tryGenerate(s.request);
      const controller = new AbortController();
      const second = service.tryGenerate({
        ...s.request,
        signal: controller.signal,
      });
      controller.abort();
      expect(await second).toBeNull();
      await vi.waitFor(() => expect(generateContent).toHaveBeenCalledOnce());
      finish('run the tests');
      expect((await first)?.suggestion).toBe('run the tests');
      expect(inference).toHaveBeenCalledOnce();
    });

    it('honors model policy and skips over-budget prompts before inference', async () => {
      const s = setupFork();
      const policyService = new PromptSuggestionService(config, async () => ({
        model: 'different',
      }));
      expect(await policyService.tryGenerate(s.request)).toBeNull();
      expect(select).not.toHaveBeenCalled();
      const other = setupFork();
      other.snapshot.modelResolution = {
        ...baseSelection,
        config: { context: { contextWindow: 260 } },
      };
      expect(await service.tryGenerate(other.request)).toBeNull();
      expect(inference).not.toHaveBeenCalled();
    });
  });

  it('uses a small utility request for prompt suggestions', async () => {
    const suggestion = await service.tryGenerate({
      messages: [
        userMessage('u1', 'fix the bug and run tests'),
        assistantMessage('a1', 'I fixed the bug.'),
        userMessage(
          'u2',
          'please continue\n\n<system-reminder>internal hint</system-reminder>',
        ),
        assistantMessage('a2', 'The next obvious step is running tests.'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(suggestion).toMatchObject({
      type: 'prompt_suggestion',
      suggestion: 'run the tests',
      session_id: 'session-1',
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: {
          model: expect.objectContaining({ key: 'lite' }),
          config: {
            reasoning: { effort: 'none' },
            context: { contextWindow: 200_000, maxOutputTokens: 64 },
            sampling: { temperature: 0.3 },
          },
        },
        prompt: {
          messages: [
            { role: 'system', content: expect.any(String) },
            {
              role: 'user',
              content: expect.stringContaining(
                'User: fix the bug and run tests',
              ),
            },
          ],
        },
        qoder: expect.objectContaining({
          identity: expect.objectContaining({ sessionId: 'session-1' }),
          taskRouting: expect.objectContaining({ taskId: 'agent_summary' }),
          business: expect.objectContaining({
            type: 'prompt_suggestion',
            sub_task: 'prompt_suggestion',
          }),
        }),
        control: { signal: expect.any(AbortSignal) },
      }),
    );

    const content = suggestionContext();
    expect(content).toContain('Assistant: I fixed the bug.');
    expect(content).toContain('User: please continue');
    expect(content).not.toContain('system-reminder');
    expect(content).not.toContain('internal hint');
  });

  it('先按用途选模，再经 select 确定建议配置后开始推理', async () => {
    await service.tryGenerate({
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenNthCalledWith(1, { purpose: 'suggestion' });
    expect(select).toHaveBeenNthCalledWith(2, {
      purpose: 'suggestion',
      overrideSelection: {
        model: baseSelection.model,
        config: {
          reasoning: { effort: 'none' },
          context: { contextWindow: 200_000, maxOutputTokens: 64 },
          sampling: { temperature: 0.3 },
        },
      },
    });
    expect(select.mock.invocationCallOrder[1]).toBeLessThan(
      inference.mock.invocationCallOrder[0],
    );
    expect(inference.mock.calls[0][0].resolution).toBe(
      await select.mock.results[1].value,
    );
  });

  it.each([{ model: 'sdk-suggestion' }])(
    'does not infer with a platform model when SDK requests an unsupported override: %j',
    async (policy) => {
      service = new PromptSuggestionService(
        config,
        vi.fn().mockResolvedValue(policy),
      );
      expect(
        await service.tryGenerate({
          messages: [assistantMessage('a1')],
          sessionId: 'session-1',
          promptId: 'prompt-1',
        }),
      ).toBeNull();
      expect(inference).not.toHaveBeenCalled();
    },
  );

  it('uses suggestion generation settings without adding fields to the selection result', async () => {
    baseSelection = {
      model: {
        ...testProviderModel('lite'),
        limits: { maxContextTokens: 200_000, maxOutputTokens: 16 },
      },
      config: { reasoning: { effort: 'none' } },
    };
    const before = structuredClone(baseSelection);
    await service.tryGenerate({
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });
    expect(inference).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: {
          model: baseSelection.model,
          config: {
            reasoning: { effort: 'none' },
            context: { contextWindow: 200_000, maxOutputTokens: 16 },
            sampling: { temperature: 0.3 },
          },
        },
      }),
    );
    expect(baseSelection).toEqual(before);
  });

  it('skips suggestion inference when SDK policy fails', async () => {
    service = new PromptSuggestionService(
      config,
      vi.fn().mockRejectedValue(new Error('DIRECT_EXECUTION_UNSUPPORTED')),
    );

    const suggestion = await service.tryGenerate({
      messages: [
        userMessage('u1', 'fix the bug'),
        assistantMessage('a1', 'The fix is ready.'),
      ],
      sessionId: 'session-policy',
      promptId: 'prompt-policy',
    });

    expect(suggestion).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps bridge-origin user text in the recent conversation', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', 'what is on my desktop?', 'bridge'),
        assistantMessage('a1', 'There is test.c on the desktop.'),
        userMessage('u2', 'open it', 'bridge'),
        assistantMessage('a2', 'It is a Hello World C program.'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('User: what is on my desktop?');
    expect(content).toContain('User: open it');
    expect(content).toContain('Assistant: It is a Hello World C program.');
  });

  it('preserves the legacy GUI prompt when no override is provided', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', 'finish the feature'),
        assistantMessage('a1'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const defaultRequest = generateContent.mock.calls[0]?.[0];
    const systemPrompt = defaultRequest?.prompt.messages[0];
    expect(systemPrompt?.role).toBe('system');
    expect(systemPrompt?.content).toContain(
      "You are the suggestion engine for an AI assistant's input box",
    );
    expect(systemPrompt?.content).toContain('Output: up to 3 suggestions');
    expect(systemPrompt?.content).not.toContain('exactly one suggestion');
  });

  it('fully replaces the default suggestion prompt when an override is provided', async () => {
    const override = 'CUSTOM TUI PROMPT ONLY';

    await service.tryGenerate({
      messages: [
        userMessage('u1', 'finish the feature'),
        assistantMessage('a1'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
      systemPromptOverride: `\n${override}\n`,
    });

    const overrideRequest = generateContent.mock.calls[0]?.[0];
    const systemPrompt = overrideRequest?.prompt.messages[0];
    expect(systemPrompt).toEqual({ role: 'system', content: override });
    expect(systemPrompt?.content).not.toContain(
      "You are the suggestion engine for an AI assistant's input box",
    );
  });

  it('pairs tool calls and keeps a bounded successful read result', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '看看这两个文件内容'),
        assistantToolUseMessage('a1', {
          id: 'toolu-read-c',
          name: 'Read',
          input: { file_path: '/tmp/test.c' },
        }),
        toolResultMessage(
          'u2',
          'toolu-read-c',
          '#include <stdio.h>\nint main() { printf("Hello"); }',
        ),
        assistantMessage('a2', 'test.c is a simple Hello World program.'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('Tool Read: {"file_path":"/tmp/test.c"} -> ok');
    expect(content).toContain('#include <stdio.h>');
  });

  it('keeps the latest user request and both ends of the final assistant reply', async () => {
    const messages: Message[] = [
      userMessage('u-current', '迁移这个项目，但先让我选择执行方式'),
    ];
    for (let index = 0; index < 6; index++) {
      const toolUseId = `toolu-read-${index}`;
      messages.push(
        assistantToolUseMessage(`a-tool-${index}`, {
          id: toolUseId,
          name: 'Read',
          input: { file_path: `/tmp/file-${index}.md` },
        }),
        toolResultMessage(
          `u-tool-${index}`,
          toolUseId,
          `raw file ${index} ${'content '.repeat(200)}`,
        ),
      );
    }
    messages.push(
      assistantMessage(
        'a-final',
        `已了解当前项目部署形态。${'中间部署分析。'.repeat(
          300,
        )}下一步选项：1. 直接迁移 2. 先写 Runbook 3. 继续讨论。请回复编号（1-3）。`,
      ),
    );

    await service.tryGenerate({
      messages,
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content.length).toBeLessThanOrEqual(4_000);
    expect(content).toContain('User: 迁移这个项目，但先让我选择执行方式');
    expect(content).toContain('Assistant: 已了解当前项目部署形态。');
    expect(content).toContain('[...middle truncated...]');
    expect(content).toContain('请回复编号（1-3）。');
    expect(content).not.toMatch(/^\[truncated\]/);
  });

  it('treats split text blocks with the same response id as one assistant reply', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '给我迁移选项'),
        splitAssistantTextMessage(
          'a1',
          'response-final',
          `FINAL_RESPONSE_HEAD ${'first block '.repeat(120)}`,
          false,
        ),
        splitAssistantTextMessage(
          'a2',
          'response-final',
          `${'second block '.repeat(120)}请回复编号（1-3）。`,
          true,
        ),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content.match(/Assistant: /g)).toHaveLength(1);
    expect(content).toContain('FINAL_RESPONSE_HEAD');
    expect(content).toContain('请回复编号（1-3）。');
  });

  it('keeps assistant messages without response ids separate', async () => {
    const firstAssistant = assistantMessage('a1', '第一条独立响应');
    const secondAssistant = assistantMessage('a2', '第二条独立响应');
    if (firstAssistant.type === 'assistant') {
      delete (firstAssistant.message as { id?: string }).id;
    }
    if (secondAssistant.type === 'assistant') {
      delete (secondAssistant.message as { id?: string }).id;
    }

    await service.tryGenerate({
      messages: [
        userMessage('u1', '继续处理'),
        firstAssistant,
        secondAssistant,
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content.match(/Assistant: /g)).toHaveLength(2);
    expect(content).toContain('第一条独立响应');
    expect(content).toContain('第二条独立响应');
  });

  it('pairs split parallel tool messages by tool use id', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '检查三个文件'),
        assistantToolUseMessage('a1', {
          id: 'toolu-a',
          name: 'Read',
          input: { file_path: '/tmp/a.md' },
        }),
        assistantToolUseMessage('a2', {
          id: 'toolu-b',
          name: 'Read',
          input: { file_path: '/tmp/b.md' },
        }),
        assistantToolUseMessage('a3', {
          id: 'toolu-c',
          name: 'Read',
          input: { file_path: '/tmp/c.md' },
        }),
        toolResultMessage(
          'r1',
          'toolu-a',
          `RESULT_A_HEAD ${'content-a '.repeat(100)} RESULT_A_TAIL`,
        ),
        toolResultMessage(
          'r2',
          'toolu-b',
          `RESULT_B_HEAD ${'content-b '.repeat(100)} RESULT_B_TAIL`,
        ),
        toolResultMessage(
          'r3',
          'toolu-c',
          `RESULT_C_HEAD ${'content-c '.repeat(100)} RESULT_C_TAIL`,
        ),
        assistantMessage('a4', '三个文件都已检查。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('Tool Read: {"file_path":"/tmp/a.md"} -> ok');
    expect(content).toContain('Tool Read: {"file_path":"/tmp/b.md"} -> ok');
    expect(content).toContain('Tool Read: {"file_path":"/tmp/c.md"} -> ok');
    expect(content).toContain('RESULT_A_HEAD');
    expect(content).toContain('RESULT_A_TAIL');
    expect(content).toContain('RESULT_B_HEAD');
    expect(content).toContain('RESULT_B_TAIL');
    expect(content).toContain('RESULT_C_HEAD');
    expect(content).toContain('RESULT_C_TAIL');
    expect(content).not.toContain('toolu-a');
  });

  it('pairs grouped and reordered tool result blocks by id', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '检查并更新配置'),
        assistantToolUseBatchMessage('a1', [
          {
            id: 'toolu-read',
            name: 'Read',
            input: { file_path: '/tmp/config.ts' },
          },
          {
            id: 'toolu-edit',
            name: 'Edit',
            input: { file_path: '/tmp/config.ts' },
          },
        ]),
        toolResultBatchMessage('r1', [
          {
            toolUseId: 'toolu-edit',
            content: 'old_string was not found',
            isError: true,
          },
          { toolUseId: 'toolu-read', content: 'raw config content' },
        ]),
        assistantMessage('a2', '读取成功，但编辑失败了。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain(
      'Tool Read: {"file_path":"/tmp/config.ts"} -> ok',
    );
    expect(content).toContain(
      'Tool Edit: {"file_path":"/tmp/config.ts"} -> error',
    );
    expect(content).toContain('old_string was not found');
    expect(content).toContain('raw config content');
  });

  it('keeps shell exit details without treating protocol completion as success', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '运行测试并检查配置'),
        assistantToolUseMessage('a1', {
          id: 'toolu-bash',
          name: 'Bash',
          input: { command: 'npm test' },
        }),
        toolResultMessage(
          'r1',
          'toolu-bash',
          `Output: ${'old output '.repeat(100)}2 tests failed\nExit Code: 1`,
        ),
        assistantToolUseMessage('a2', {
          id: 'toolu-edit',
          name: 'Edit',
          input: { file_path: '/tmp/config.ts' },
        }),
        toolResultMessage(
          'r2',
          'toolu-edit',
          `${'old error '.repeat(100)}old_string was not found`,
          true,
        ),
        assistantMessage('a3', '测试和编辑都失败了。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('Tool Bash: {"command":"npm test"} -> completed');
    expect(content).toContain('2 tests failed Exit Code: 1');
    expect(content).toContain(
      'Tool Edit: {"file_path":"/tmp/config.ts"} -> error',
    );
    expect(content).toContain('old_string was not found');
  });

  it('keeps a compact successful result for non-Read tools', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '帮我选择部署区域'),
        assistantToolUseMessage('a1', {
          id: 'toolu-ask',
          name: 'AskUserQuestion',
          input: { questions: [{ question: '部署到哪里？' }] },
        }),
        toolResultMessage(
          'r1',
          'toolu-ask',
          'Your questions have been answered: "部署到哪里？"="新加坡".',
        ),
        assistantMessage('a2', '我会按你的选择继续。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('Tool AskUserQuestion:');
    expect(content).toContain('-> ok; result:');
    expect(content).toContain('部署到哪里？"="新加坡');
  });

  it('keeps both ends when a read result exceeds its tool budget', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '看看配置文件'),
        assistantToolUseMessage('a1', {
          id: 'toolu-read',
          name: 'Read',
          input: { file_path: '/tmp/config.ts' },
        }),
        toolResultMessage(
          'r1',
          'toolu-read',
          `READ_RESULT_HEAD ${'middle content '.repeat(100)} READ_RESULT_TAIL`,
        ),
        assistantMessage('a2', '配置文件已经读取。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('READ_RESULT_HEAD');
    expect(content).toContain('[...middle truncated...]');
    expect(content).toContain('READ_RESULT_TAIL');
  });

  it('keeps an unmatched tool result as a graceful fallback', async () => {
    await service.tryGenerate({
      messages: [
        userMessage('u1', '继续处理刚才恢复的任务'),
        toolResultMessage(
          'r1',
          'toolu-missing-call',
          'restored tool output tail',
        ),
        assistantMessage('a1', '任务状态已经恢复。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    const content = suggestionContext();
    expect(content).toContain('Tool result toolu-missing-call -> ok');
    expect(content).toContain('restored tool output tail');
  });

  it('generates after the first assistant turn', async () => {
    const suggestion = await service.tryGenerate({
      messages: [
        userMessage('u1', '看看这两个文件内容'),
        assistantMessage('a1', 'test.c and test.py are both simple examples.'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(suggestion).toMatchObject({
      type: 'prompt_suggestion',
      suggestion: 'run the tests',
      session_id: 'session-1',
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('does not generate without recent conversation content', async () => {
    const suggestion = await service.tryGenerate({
      messages: [],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(suggestion).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('returns null when the utility response is filtered', async () => {
    generateContent.mockResolvedValueOnce('looks good');

    const suggestion = await service.tryGenerate({
      messages: [assistantMessage('a1'), assistantMessage('a2')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(suggestion).toBeNull();
  });

  it('uses the model provider from config in the public wrapper', async () => {
    const getModelProviderManager = vi.fn(config.getModelProviderManager);

    await tryGeneratePromptSuggestion({
      config: { ...config, getModelProviderManager },
      messages: [assistantMessage('a1'), assistantMessage('a2')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(getModelProviderManager).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('runs provider inference with the prompt suggestion session id', async () => {
    let requestSessionId: string | undefined;
    generateContent.mockImplementationOnce(async () => {
      requestSessionId = getSessionIdFromContext();
      return 'run the tests';
    });

    await service.tryGenerate({
      messages: [assistantMessage('a1'), assistantMessage('a2')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(requestSessionId).toBe('session-1');
  });

  it('fails open when the model provider is unavailable', async () => {
    const suggestion = await tryGeneratePromptSuggestion({
      config: {
        ...config,
        getModelProviderManager: vi.fn(() => {
          throw new Error('not ready');
        }),
      },
      messages: [assistantMessage('a1'), assistantMessage('a2')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });

    expect(suggestion).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('preserves ambient request and business attribution without mutating it', async () => {
    const business = {
      version: '1',
      id: 'parent-turn',
      product: 'app',
      type: 'code_review',
      model_key: 'auto',
    };
    await requestSetIdContext.run('parent-set', () =>
      businessInfoContext.run(business, () =>
        service.tryGenerate({
          messages: [assistantMessage('a1')],
          sessionId: 'session-1',
          promptId: 'prompt-1',
        }),
      ),
    );
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        qoder: expect.objectContaining({
          identity: { sessionId: 'session-1', requestSetId: 'parent-set' },
          business: { ...business, sub_task: 'prompt_suggestion' },
        }),
      }),
    );
    expect(business).not.toHaveProperty('sub_task');
  });

  it('cancels a pending provider response when the caller aborts', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    inference.mockImplementationOnce(async (request) => {
      const signal = request.control?.signal;
      requestSignal = signal;
      if (!signal) {
        throw new Error('应通过标准请求传递取消信号');
      }
      const completed = new Promise<ModelMessage>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
      controller.abort();
      return { ...response(''), completed };
    });
    expect(
      await service.tryGenerate({
        messages: [assistantMessage('a1')],
        sessionId: 'session-1',
        promptId: 'prompt-1',
        signal: controller.signal,
      }),
    ).toBeNull();
    expect(inference).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(controller.signal.reason);
  });

  it('skips policy lookup and inference when QCS disables suggestions', async () => {
    updateGate({ enabled: false });
    const getModelPolicy = vi.fn();
    service = new PromptSuggestionService(config, getModelPolicy);

    expect(
      await service.tryGenerate({
        messages: [assistantMessage('a1')],
        sessionId: 'session-1',
        promptId: 'prompt-1',
      }),
    ).toBeNull();
    expect(getModelPolicy).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
    expect(gateListeners.size).toBe(0);
  });

  it('enables only subsequent requests after a rollout change', async () => {
    updateGate(false);
    const params = {
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    };
    expect(await service.tryGenerate(params)).toBeNull();
    updateGate({ enabled: true });
    expect(await service.tryGenerate(params)).toMatchObject({
      type: 'prompt_suggestion',
      suggestion: 'run the tests',
    });
    expect(inference).toHaveBeenCalledOnce();
    expect(gateListeners.size).toBe(0);
  });

  it('cancels a pending policy lookup on hot disable without waiting for the host', async () => {
    const getModelPolicy = vi.fn<GetModelPolicyCallback>(
      () => new Promise<never>(() => {}),
    );
    service = new PromptSuggestionService(config, getModelPolicy);
    const pending = service.tryGenerate({
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });
    expect(getModelPolicy).toHaveBeenCalledOnce();
    const policySignal = getModelPolicy.mock.calls[0]?.[4] as AbortSignal;
    updateGate({ enabled: false });

    expect(await pending).toBeNull();
    expect(policySignal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
    expect(gateListeners.size).toBe(0);
  });

  it('cancels pending selection on hot disable before starting inference', async () => {
    let started!: () => void;
    const selectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    select.mockImplementationOnce(() => {
      started();
      return new Promise<never>(() => {});
    });
    const pending = service.tryGenerate({
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });
    await selectionStarted;
    updateGate({ enabled: false });

    expect(await pending).toBeNull();
    expect(select).toHaveBeenCalledOnce();
    expect(inference).not.toHaveBeenCalled();
    expect(gateListeners.size).toBe(0);
  });

  it('cancels a pending completion and never revives it after re-enabling', async () => {
    let finish!: (message: ModelMessage) => void;
    let started!: () => void;
    let requestSignal: AbortSignal | undefined;
    const inferenceStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    inference.mockImplementationOnce(async (request) => {
      requestSignal = request.control?.signal;
      const completed = new Promise<ModelMessage>((resolve) => {
        finish = resolve;
      });
      started();
      return { ...response(''), completed };
    });
    const pending = service.tryGenerate({
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });
    await inferenceStarted;
    updateGate({ enabled: false });
    updateGate({ enabled: true });

    expect(await pending).toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(gateListeners.size).toBe(0);
    finish({
      messageId: 'late-suggestion',
      model: 'lite',
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: 'run the tests' }],
    });
    expect(inference).toHaveBeenCalledOnce();
  });

  it('discards completed output when the source changes without a notification', async () => {
    generateContent.mockImplementationOnce(async () => {
      gateValue = { enabled: false };
      return 'run the tests';
    });
    expect(
      await service.tryGenerate({
        messages: [assistantMessage('a1')],
        sessionId: 'session-1',
        promptId: 'prompt-1',
      }),
    ).toBeNull();
    expect(inference).toHaveBeenCalledOnce();
    expect(gateListeners.size).toBe(0);
  });

  it('releases the rollout listener on success and failure', async () => {
    const params = {
      messages: [assistantMessage('a1')],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    };
    expect(await service.tryGenerate(params)).not.toBeNull();
    expect(gateListeners.size).toBe(0);
    inference.mockRejectedValueOnce(new Error('provider failed'));
    expect(await service.tryGenerate(params)).toBeNull();
    expect(gateListeners.size).toBe(0);
  });

  describe('shared recommendation rules', () => {
    const params = {
      messages: [
        userMessage('u1', '分析推荐配置的灰度方案，先不要修改代码'),
        assistantMessage('a1', '配置分析已完成，尚未比较两种灰度方案。'),
      ],
      sessionId: 'session-1',
      promptId: 'prompt-1',
    };

    beforeEach(() => updateGate({ enabled: true, mode: 'shared' }));

    it('uses identical shared rules for SDK and TUI without accepting legacy overrides', async () => {
      await service.tryGenerate(params);
      await service.tryGenerate({
        ...params,
        systemPromptOverride: 'CUSTOM TUI PROMPT WITH SECURITY SCAN GUIDANCE',
      });
      const sdkPrompt = generateContent.mock.calls[0][0].prompt.messages[0];
      const tuiPrompt = generateContent.mock.calls[1][0].prompt.messages[0];
      expect(sdkPrompt).toEqual(tuiPrompt);
      expect(sdkPrompt.content).toContain(
        'Newer evidence overrides older plans',
      );
      expect(sdkPrompt.content).toContain(
        'specific action or question, its object',
      );
      expect(sdkPrompt.content).toContain('analysis only, no edits');
      expect(sdkPrompt.content).toContain('already completed successfully');
      expect(sdkPrompt.content).toContain(
        'only a background completion notification',
      );
      expect(sdkPrompt.content).toContain('Do not duplicate its options');
      expect(sdkPrompt.content).toContain('do not force a coding workflow');
      expect(sdkPrompt.content).toContain(
        'follow-up question is a valid next user message',
      );
      expect(sdkPrompt.content).toContain('without contextual support');
      expect(sdkPrompt.content).toContain('Predict the single message');
      expect(sdkPrompt.content).toContain('most likely to type next');
      expect(sdkPrompt.content).toContain(
        'The user did not write this request',
      );
      expect(sdkPrompt.content).toContain("user's empty message composer");
      expect(sdkPrompt.content).toContain('accept it, edit it, or ignore it');
      expect(sdkPrompt.content).toContain('will not be sent automatically');
      expect(sdkPrompt.content).toContain(
        'Use the whole available conversation',
      );
      expect(sdkPrompt.content).toContain(
        'requirements needed to retain its meaning',
      );
      expect(sdkPrompt.content).toContain('Choose the strongest grounded move');
      expect(sdkPrompt.content).toContain('Uncertainty about exact wording');
      expect(sdkPrompt.content).toContain('at most 240 Unicode characters');
      expect(sdkPrompt.content).toContain(
        'exactly one natural user message on one line',
      );
      expect(sdkPrompt.content).not.toContain('up to 3');
      expect(sdkPrompt.content).toContain('output exactly NO_SUGGESTION');
      expect(sdkPrompt.content).not.toContain('CUSTOM TUI PROMPT');
      expect(sdkPrompt.content).not.toContain(
        'pick the one this particular user',
      );
      expect(sdkPrompt.content).not.toContain('- Questions');
    });

    it('changes only the recommendation output budget, not model, summary or attribution', async () => {
      const business = {
        version: '1',
        id: 'parent-turn',
        product: 'app',
        type: 'analysis',
        model_key: 'auto',
      };
      await requestSetIdContext.run('parent-set', () =>
        service.tryGenerate({ ...params, businessInfo: business }),
      );
      expect(select).toHaveBeenNthCalledWith(1, { purpose: 'suggestion' });
      expect(generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          resolution: {
            model: baseSelection.model,
            config: {
              reasoning: { effort: 'none' },
              context: { contextWindow: 200_000, maxOutputTokens: 256 },
              sampling: { temperature: 0.3 },
            },
          },
          qoder: expect.objectContaining({
            identity: { sessionId: 'session-1', requestSetId: 'parent-set' },
            taskRouting: expect.objectContaining({ taskId: 'agent_summary' }),
            business: { ...business, sub_task: 'prompt_suggestion' },
          }),
        }),
      );
      expect(suggestionContext()).toContain('先不要修改代码');
      expect(suggestionContext().length).toBeLessThanOrEqual(4_000);
      expect(business).not.toHaveProperty('sub_task');
    });

    it('cleans candidates and returns only the first valid message', async () => {
      generateContent.mockResolvedValueOnce(
        [
          'NO_SUGGESTION',
          '1. "比较两种灰度方案的风险，但先不要修改代码"',
          '- 比较两种灰度方案的风险，但先不要修改代码',
          'NO_SUGGESTION',
          '2. 哪种方案更容易回滚？',
          '哪种方案更容易回滚？',
          '3. 列出客户端和云端各自的验证范围',
          '4. 检查现有配置解析逻辑',
        ].join('\n'),
      );
      expect(await service.tryGenerate(params)).toMatchObject({
        type: 'prompt_suggestion',
        session_id: 'session-1',
        suggestion: '比较两种灰度方案的风险，但先不要修改代码',
        uuid: expect.any(String),
      });
    });

    it.each(['NO_SUGGESTION', '\n  \n', 'looks good\nLet me check the config'])(
      'returns no candidate for unusable output: %j',
      async (text) => {
        generateContent.mockResolvedValueOnce(text);
        expect(await service.tryGenerate(params)).toBeNull();
      },
    );

    it('keeps a single valid question without padding or truncating rejected lines', async () => {
      const question = '哪种方案更容易回滚？';
      generateContent.mockResolvedValueOnce(
        `${'检查'.repeat(121)}\n${question}`,
      );
      expect(await service.tryGenerate(params)).toMatchObject({
        suggestion: question,
      });
    });

    it.each(['legacy', 'shared'] as const)(
      'returns at most one cleaned suggestion in %s mode even when the model produces alternatives',
      async (mode) => {
        updateGate({ enabled: true, mode });
        generateContent.mockResolvedValueOnce(
          [
            'looks good',
            '1. "compare rollout risks without changing code"',
            '- compare rollout risks without changing code',
            '2. run the tests',
            '3. check the configuration',
          ].join('\n'),
        );
        const result = await service.tryGenerate(params);
        expect(result).toMatchObject({
          suggestion: 'compare rollout risks without changing code',
        });
        expect(result?.suggestion).not.toContain('\n');
      },
    );

    it('restores legacy prompt, budget and filters while retaining single-message output on rollback', async () => {
      updateGate({ enabled: true, mode: 'legacy' });
      generateContent.mockResolvedValueOnce(
        'what about tests?\nrun the tests\nrun the tests',
      );
      expect(await service.tryGenerate(params)).toMatchObject({
        suggestion: 'run the tests',
      });
      const request = generateContent.mock.calls[0][0];
      expect(request.resolution.config.context?.maxOutputTokens).toBe(64);
      expect(request.prompt.messages[0].content).toContain('- Questions');
      expect(request.prompt.messages[0].content).toContain(
        'Output: up to 3 suggestions',
      );
      await service.tryGenerate({
        ...params,
        systemPromptOverride: 'LEGACY TUI PROMPT',
      });
      expect(generateContent.mock.calls[1][0].prompt.messages[0].content).toBe(
        'LEGACY TUI PROMPT',
      );
    });

    it('does not start a shared request when the feature is disabled', async () => {
      updateGate({ enabled: false, mode: 'shared' });
      expect(await service.tryGenerate(params)).toBeNull();
      expect(select).not.toHaveBeenCalled();
      expect(inference).not.toHaveBeenCalled();
    });

    it.each(['legacy', 'shared'] as const)(
      'cancels a pending request when switching away from %s and does not revive it',
      async (mode) => {
        updateGate({ enabled: true, mode });
        let started!: () => void;
        const inferenceStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        let requestSignal: AbortSignal | undefined;
        let finish!: (message: ModelMessage) => void;
        inference.mockImplementationOnce(async (request) => {
          requestSignal = request.control?.signal;
          const completed = new Promise<ModelMessage>((resolve) => {
            finish = resolve;
          });
          started();
          return { ...response(''), completed };
        });
        const pending = service.tryGenerate(params);
        await inferenceStarted;
        updateGate({
          enabled: true,
          mode: mode === 'legacy' ? 'shared' : 'legacy',
        });
        updateGate({ enabled: true, mode });
        expect(await pending).toBeNull();
        expect(requestSignal?.aborted).toBe(true);
        expect(gateListeners.size).toBe(0);
        finish({
          messageId: 'late',
          model: 'lite',
          stopReason: 'end_turn',
          blocks: [{ type: 'text', text: 'run the tests' }],
        });
        expect(inference).toHaveBeenCalledOnce();
      },
    );

    it('discards a completed result when mode changes without notification', async () => {
      generateContent.mockImplementationOnce(async () => {
        gateValue = { enabled: true, mode: 'legacy' };
        return 'run the tests';
      });
      expect(await service.tryGenerate(params)).toBeNull();
      expect(gateListeners.size).toBe(0);
    });

    it.each([
      '比较客户端热更新和云端灰度的行为，但先不要修改推荐链路的任何代码',
      'check a b c d e f g h i j k l m n o p q r s t',
      'what caused the configuration mismatch?',
      '为什么热更新后旧请求仍然返回了推荐？',
      '检查'.repeat(120),
      '\u{20000}'.repeat(161),
      '\u{20000}'.repeat(240),
    ])(
      'accepts grounded-length requests and questions without word counting: %j',
      (text) => {
        expect(shouldFilterSuggestion(text, 'shared')).toBe(false);
      },
    );

    it.each([
      null,
      'NO_SUGGESTION',
      'NO_SUGGESTION (nothing more to do)',
      'silence is the best response',
      'API Error: invalid request',
      'Suggestion: check the configuration',
      'run tests. then commit.',
      '检查配置。然后修改代码。',
      '**check the configuration**',
      'looks good',
      'Let me check the configuration',
      '我先吃饭去',
      '检查配置!',
      '检查配置！',
      '检'.repeat(241),
      '\u{20000}'.repeat(241),
    ])('keeps shared safety and output-shape filters: %j', (text) => {
      expect(shouldFilterSuggestion(text, 'shared')).toBe(true);
    });
  });

  it('filters unusable suggestion text', () => {
    expect(shouldFilterSuggestion('looks good')).toBe(true);
    expect(shouldFilterSuggestion('No suggestion')).toBe(true);
    expect(shouldFilterSuggestion('what about tests?')).toBe(true);
    expect(shouldFilterSuggestion('run tests. then commit.')).toBe(true);
    expect(shouldFilterSuggestion('Let me run the tests')).toBe(true);
    expect(shouldFilterSuggestion('Suggestion: run tests')).toBe(true);
    expect(shouldFilterSuggestion('hello')).toBe(true);
    expect(shouldFilterSuggestion('NO_SUGGESTION')).toBe(true);
    expect(shouldFilterSuggestion('no_suggestion')).toBe(true);
    expect(shouldFilterSuggestion('NO_SUGGESTION (nothing more to do)')).toBe(
      true,
    );
    expect(shouldFilterSuggestion('no_suggestion - conversation ended')).toBe(
      true,
    );
    expect(shouldFilterSuggestion('那我就不出门了')).toBe(true);
    expect(shouldFilterSuggestion('我先吃饭去')).toBe(true);
    expect(shouldFilterSuggestion('好的')).toBe(true);
    expect(shouldFilterSuggestion('提交一下')).toBe(false);
    expect(shouldFilterSuggestion('跑一下 test.py')).toBe(false);
    expect(shouldFilterSuggestion('run test.py')).toBe(false);
  });
});
