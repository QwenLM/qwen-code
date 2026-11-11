/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useSessionResume } from './useSessionResume.js';
import type {
  Config,
  SessionResumeData,
  Message,
  Model,
} from '@qwen-code/core';
import {
  coreEvents,
  uiTelemetryService,
  createUserMessage,
  createAssistantMessage,
  cloneUsage,
  CoreEvent,
  CoreToolCallStatus,
  loadLatestSessionUsage,
  SessionEndReason,
  TranscriptRepository,
} from '@qwen-code/core';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { HistoryItemWithoutId } from '../types.js';
import * as subagentResume from '../../utils/subagentResume.js';
import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';

const mockApplyWorktreeStartupRequest = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock('../../utils/worktreeStartupRequest.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../utils/worktreeStartupRequest.js')
    >();
  return {
    ...actual,
    applyWorktreeStartupRequest: mockApplyWorktreeStartupRequest,
  };
});

type LegacyResumeMessage =
  | {
      id: string;
      timestamp?: string;
      content: string;
      type: 'user';
    }
  | {
      id: string;
      timestamp?: string;
      content: string;
      type: 'gemini';
    };

type LegacyResumeConversation = {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: LegacyResumeMessage[];
};

const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    uiTelemetryService: {
      clear: vi.fn(),
      hydrateFromMessages: vi.fn(),
      getLastPromptTokenCount: vi.fn().mockReturnValue(0),
      setLastPromptTokenCount: vi.fn(),
    },
    loadLatestSessionUsage: vi.fn(),
  };
});

describe('useSessionResume', () => {
  const mockFireSessionEndEvent = vi.fn().mockResolvedValue(undefined);
  const manager = {
    getModel: vi.fn(async (key: string) =>
      testListedModel(key, {
        available_context_windows: [128000, 200000, 256000],
        max_input_tokens: 256000,
      }),
    ),
    listModels: vi.fn<() => Promise<Model[]>>(async () => []),
    getModelConfig: vi.fn(() => undefined),
    setModelConfig: vi.fn(() => true),
  };
  const mockConfig = {
    setSessionId: vi.fn(),
    getModel: vi.fn().mockReturnValue('current-model'),
    getCliModel: vi.fn().mockReturnValue(undefined),
    getCliReasoningEffort: vi.fn().mockReturnValue(undefined),
    getCliContextWindow: vi.fn().mockReturnValue(undefined),
    getModelProviderManager: () => manager,
    getModelRequestIdentity: () => 'test-account',
    getAvailableContextWindows: vi.fn().mockReturnValue([128000, 200000]),
    setModel: vi.fn(),
    getProjectRoot: vi.fn().mockReturnValue('/project'),
    getWorkingDir: vi.fn().mockReturnValue('/project'),
    getWorktreeSettings: vi.fn<Config['getWorktreeSettings']>(),
    getSessionArtifactProjectRoot: vi.fn().mockReturnValue('/artifact-project'),
    setSessionArtifactWorktreeStates: vi.fn(),
    getActiveSessionTranscriptPath: () =>
      '/artifact-bucket/current-session.jsonl',
    getTargetDir: vi.fn().mockReturnValue('/project'),
    getWorkspaceContext: vi.fn().mockReturnValue({
      addDirectories: vi.fn().mockReturnValue({ added: [], failed: [] }),
    }),
    storage: {
      getProjectRoot: vi.fn().mockReturnValue('/project'),
      getPlansDir: vi.fn().mockReturnValue('/plans'),
    },
    getSessionId: vi.fn().mockReturnValue('current-session'),
    getHookSystem: vi.fn().mockReturnValue({
      fireSessionEndEvent: mockFireSessionEndEvent,
    }),
    persistSessionTitle: vi.fn(async () => undefined),
    planStateManager: {
      copyPlanForResume: vi.fn().mockResolvedValue(undefined),
    },
  };

  const createMockHistoryManager = (): UseHistoryManagerReturn => ({
    history: [],
    addItem: vi.fn(),
    updateItem: vi.fn(),
    clearItems: vi.fn(),
    loadHistory: vi.fn(),
    loadHistoryItems: vi.fn(),
  });

  let mockHistoryManager: UseHistoryManagerReturn;

  const mockRequestTranscriptReplacement = vi.fn();
  const mockSetQuittingMessages = vi.fn();
  const mockReplaceMessages = vi.fn();

  const toMessages = (conversation: LegacyResumeConversation): Message[] =>
    conversation.messages.reduce<Message[]>((messages, message, index) => {
      const timestamp = message.timestamp ?? `2025-01-01T00:00:0${index}Z`;

      if (message.type === 'user') {
        const convertedMessage = createUserMessage(
          typeof message.content === 'string' ? message.content : '',
        );
        convertedMessage.sessionId = conversation.sessionId;
        convertedMessage.uuid = message.id;
        convertedMessage.timestamp = timestamp;
        messages.push(convertedMessage);
        return messages;
      }

      if (message.type === 'gemini') {
        const usage = cloneUsage();
        usage.input_tokens = 1;
        usage.output_tokens = 1;
        const convertedMessage = createAssistantMessage(
          {
            messageId: `assistant-${message.id}`,

            model: 'test-model',
            stopReason: 'end_turn',

            usage: { inputTokens: 1, outputTokens: 1 },
            blocks: [
              {
                type: 'text',
                text:
                  typeof message.content === 'string' ? message.content : '',
              },
            ],
          },
          undefined,
          undefined,
          usage,
        );
        convertedMessage.sessionId = conversation.sessionId;
        convertedMessage.uuid = message.id;
        convertedMessage.timestamp = timestamp;
        messages.push(convertedMessage);
      }

      return messages;
    }, []);

  const mockRefreshContextTokenCount = vi.fn(async () => {});
  const getDefaultProps = () => ({
    config: mockConfig as unknown as Config,
    historyManager: mockHistoryManager,
    requestTranscriptReplacement: mockRequestTranscriptReplacement,
    isRuntimeReady: true,
    setQuittingMessages: mockSetQuittingMessages,
    resumedSessionData: undefined,
    isStartupHeld: false,
    replaceMessages: mockReplaceMessages,
    refreshContextTokenCount: mockRefreshContextTokenCount,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.getWorktreeSettings.mockReturnValue(undefined);
    mockConfig.getSessionId.mockReturnValue('current-session');
    mockFireSessionEndEvent.mockResolvedValue(undefined);
    mockConfig.getModel.mockReturnValue('current-model');
    mockConfig.getCliModel.mockReturnValue(undefined);
    mockConfig.getCliReasoningEffort.mockReturnValue(undefined);
    mockConfig.getCliContextWindow.mockReturnValue(undefined);
    manager.getModelConfig.mockReturnValue(undefined);
    mockConfig.getAvailableContextWindows.mockReturnValue([128000, 200000]);
    vi.mocked(loadLatestSessionUsage).mockResolvedValue(null);
    mockHistoryManager = createMockHistoryManager();
    mockReplaceMessages.mockImplementation(
      async (_messages, sessionId, options) => {
        if (options?.setConfigSessionId && sessionId) {
          mockConfig.setSessionId(sessionId);
        }
      },
    );
  });

  it('delegates cross-project resume before touching the outgoing runtime and keeps input blocked', async () => {
    const replacement = deferred<boolean>();
    const onProjectResume = vi.fn(() => replacement.promise);
    const data = {
      sessionId: 'selected',
      originalCwd: '/another-project',
      sessionPath: '/legacy/selected.jsonl',
      messages: [],
    };
    const { result, unmount } = await renderHook(() =>
      useSessionResume({
        ...getDefaultProps(),
        onProjectResume,
      }),
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.loadHistoryForResume([], data);
    });
    expect(result.current.isResuming).toBe(true);
    expect(mockReplaceMessages).not.toHaveBeenCalled();
    expect(onProjectResume).toHaveBeenCalledWith(data, expect.any(Object));
    await act(async () => {
      replacement.resolve(true);
      await pending;
    });
    unmount();
  });

  it('reuses the resource runtime when only worktreeCwd differs', async () => {
    const onProjectResume = vi.fn();
    mockConfig.getProjectRoot.mockReturnValueOnce(
      '/project/.qwen/worktrees/active',
    );
    const { result, unmount } = await renderHook(() =>
      useSessionResume({
        ...getDefaultProps(),
        onProjectResume,
      }),
    );
    await act(async () => {
      await result.current.loadHistoryForResume([], {
        sessionId: 'selected',
        originalCwd: '/project',
        messages: [],
      });
    });
    expect(onProjectResume).not.toHaveBeenCalled();
    expect(mockReplaceMessages).toHaveBeenCalled();
    unmount();
  });

  it('includes the resolved legacy subdirectory and a subsequently entered checkout in session artifact roots', async () => {
    const sessionId = 'selected';
    const sessionPath = '/artifact-bucket/selected.jsonl';
    const repository = new TranscriptRepository();
    const loaded = repository.resolveBuffer(
      sessionPath,
      Buffer.from(
        JSON.stringify({
          type: 'user',
          uuid: 'first',
          parentUuid: null,
          isSidechain: false,
          sessionId,
          cwd: '/artifact-project',
          userType: 'external',
          version: '1.0.0',
          timestamp: '2026-10-10T00:00:00Z',
          message: { role: 'user', content: 'hello' },
        }) + '\n',
      ),
      { sessionId },
    );
    const resumedData: SessionResumeData = {
      sessionId,
      sessionPath,
      messages: [...loaded.messages],
      worktreeSession: {
        sessionId,
        originalCwd: '/artifact-project',
        worktreePath: '/checkout-a',
        worktreeName: 'a',
        lifecycle: 'attached',
      },
      transcriptReadState: repository.createResumeReadState(loaded, sessionId),
    };
    mockReplaceMessages.mockImplementationOnce(async () => {
      mockConfig.getSessionId.mockReturnValue(sessionId);
      mockConfig.getWorktreeSettings.mockReturnValue({
        originalCwd: '/artifact-project',
        path: '/checkout-a',
        worktreeCwd: '/checkout-a/app',
        name: 'a',
        baseSha: '',
        lifecycle: 'attached',
      });
    });
    mockApplyWorktreeStartupRequest.mockImplementationOnce(async () => {
      mockConfig.getWorktreeSettings.mockReturnValue({
        originalCwd: '/artifact-project',
        path: '/checkout-b',
        worktreeCwd: '/checkout-b/app',
        name: 'b',
        baseSha: '',
        lifecycle: 'attached',
      });
    });
    const { result, unmount } = await renderHook(() =>
      useSessionResume(getDefaultProps()),
    );
    await act(async () => {
      await result.current.loadHistoryForResume([], resumedData, {
        worktreeStartupRequest: {
          kind: 'create',
          name: 'b',
          originalCwd: '/artifact-project',
        },
      });
    });
    expect(mockConfig.setSessionArtifactWorktreeStates).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ worktreeCwd: '/checkout-a/app' }),
        expect.objectContaining({ worktreeCwd: '/checkout-b/app' }),
      ]),
    );
    unmount();
  });

  it('persists the requested title only after the target writer has resumed', async () => {
    const { result, unmount } = await renderHook(() =>
      useSessionResume(getDefaultProps()),
    );
    mockReplaceMessages.mockImplementationOnce(async () => {
      expect(mockConfig.persistSessionTitle).not.toHaveBeenCalled();
    });
    await act(async () => {
      await result.current.loadHistoryForResume(
        [],
        { sessionId: 'selected', messages: [] },
        {
          initialSessionTitle: 'Resumed title',
        },
      );
    });
    expect(mockConfig.persistSessionTitle).toHaveBeenCalledWith(
      'Resumed title',
    );
    unmount();
  });

  it.each([false, true])(
    'blocks automatic input from the first ready render through historical resume (explicit worktree: %s)',
    async (enterWorktree) => {
      const replacement = deferred<void>();
      const worktree = deferred<undefined>();
      mockReplaceMessages.mockReturnValueOnce(replacement.promise);
      if (enterWorktree) {
        mockApplyWorktreeStartupRequest.mockReturnValueOnce(worktree.promise);
      }
      const submitted = vi.fn();
      const props = {
        ...getDefaultProps(),
        resumedSessionData: { sessionId: 'historical', messages: [] },
        worktreeStartupRequest: enterWorktree
          ? { kind: 'create' as const, name: 'next', originalCwd: '/project' }
          : undefined,
      };
      const { result, rerender, unmount } = await renderHook(
        ({ ready }: { ready: boolean }) => {
          const state = useSessionResume({ ...props, isRuntimeReady: ready });
          // 自动 Prompt 和队列在后续 effect 中消费同一就绪条件，不能只检查重渲染后的状态。
          useEffect(() => {
            if (ready && !state.isResuming) submitted();
          }, [ready, state.isResuming]);
          return state;
        },
        { initialProps: { ready: false } },
      );
      try {
        rerender({ ready: true });
        await waitFor(() => expect(mockReplaceMessages).toHaveBeenCalled());
        expect(submitted).not.toHaveBeenCalled();
        await act(async () => replacement.resolve());
        if (enterWorktree) {
          await waitFor(() =>
            expect(mockApplyWorktreeStartupRequest).toHaveBeenCalled(),
          );
          expect(submitted).not.toHaveBeenCalled();
          await act(async () => worktree.resolve(undefined));
        }
        await waitFor(() => expect(result.current.isResuming).toBe(false));
        expect(submitted).toHaveBeenCalled();
      } finally {
        await act(async () => {
          replacement.resolve();
          worktree.resolve(undefined);
          await replacement.promise;
          await worktree.promise;
        });
        unmount();
      }
    },
  );

  it('defers initial model restoration until runtime and startup gates open and keeps input blocked through catalog readiness', async () => {
    const modelsReady = deferred<Model[]>();
    manager.listModels.mockReturnValueOnce(modelsReady.promise);
    mockConfig.setModel.mockImplementationOnce(async (model: string) => {
      mockConfig.getModel.mockReturnValue(model);
      return true;
    });
    const submitted = vi.fn();
    const onInitialResumeComplete = vi.fn();
    const resumedSessionData: SessionResumeData = {
      sessionId: 'historical-session',
      messages: [],
      model: 'historical-model',
      generation: { temperature: 0.6 },
      reasoningEffort: 'high',
      contextWindow: 200000,
    };
    const { result, rerender, unmount } = await renderHook(
      ({ ready, held }: { ready: boolean; held: boolean }) => {
        const state = useSessionResume({
          ...getDefaultProps(),
          isRuntimeReady: ready,
          isStartupHeld: held,
          resumedSessionData,
          onInitialResumeComplete,
        });
        useEffect(() => {
          if (
            ready &&
            !held &&
            !state.isResuming &&
            !state.isAutomaticInputBlocked
          ) {
            submitted();
          }
        }, [ready, held, state.isResuming, state.isAutomaticInputBlocked]);
        return state;
      },
      { initialProps: { ready: false, held: true } },
    );
    try {
      expect(result.current.isResuming).toBe(true);
      expect(manager.listModels).not.toHaveBeenCalled();
      rerender({ ready: true, held: true });
      expect(mockReplaceMessages).not.toHaveBeenCalled();
      expect(manager.listModels).not.toHaveBeenCalled();
      rerender({ ready: true, held: false });
      await waitFor(() => expect(manager.listModels).toHaveBeenCalledOnce());
      expect(result.current.isResuming).toBe(true);
      expect(mockConfig.setModel).not.toHaveBeenCalled();
      expect(submitted).not.toHaveBeenCalled();

      await act(async () => {
        modelsReady.resolve([testListedModel('historical-model')]);
      });
      await waitFor(() => expect(result.current.isResuming).toBe(false));
      expect(mockConfig.setModel).toHaveBeenCalledWith(
        'historical-model',
        true,
      );
      expect(manager.setModelConfig).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'historical-model' }),
        expect.objectContaining({
          sampling: expect.objectContaining({ temperature: 0.6 }),
        }),
        undefined,
      );
      expect(manager.setModelConfig).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'historical-model' }),
        { reasoning: { effort: 'high' } },
        undefined,
      );
      expect(manager.setModelConfig).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'historical-model' }),
        { context: { contextWindow: 200000 } },
        undefined,
      );
      expect(onInitialResumeComplete).toHaveBeenCalledWith(true);
      expect(submitted).toHaveBeenCalledOnce();
      expect(
        manager.setModelConfig.mock.invocationCallOrder.at(-1),
      ).toBeLessThan(submitted.mock.invocationCallOrder[0]);
    } finally {
      await act(async () => modelsReady.resolve([]));
      unmount();
    }
  });

  describe('loadHistoryForResume', () => {
    it('should return a loadHistoryForResume callback', async () => {
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      expect(result.current.loadHistoryForResume).toBeInstanceOf(Function);
    });

    it('reports the resumed custom title after the runtime switch', async () => {
      const onResumedCustomTitle = vi.fn();
      const { result } = await renderHook(() =>
        useSessionResume({ ...getDefaultProps(), onResumedCustomTitle }),
      );

      await act(async () => {
        await result.current.loadHistoryForResume([], {
          sessionId: 'named-session',
          messages: [],
          customTitle: 'hello-world',
        });
      });

      expect(onResumedCustomTitle).toHaveBeenCalledTimes(1);
      expect(onResumedCustomTitle).toHaveBeenCalledWith(
        'hello-world',
        'named-session',
      );
      expect(mockReplaceMessages.mock.invocationCallOrder[0]).toBeLessThan(
        onResumedCustomTitle.mock.invocationCallOrder[0],
      );
    });

    it('reports an undefined custom title for an unnamed session', async () => {
      const onResumedCustomTitle = vi.fn();
      const { result } = await renderHook(() =>
        useSessionResume({ ...getDefaultProps(), onResumedCustomTitle }),
      );

      await act(async () => {
        await result.current.loadHistoryForResume([], {
          sessionId: 'unnamed-session',
          messages: [],
        });
      });

      expect(onResumedCustomTitle).toHaveBeenCalledWith(
        undefined,
        'unnamed-session',
      );
    });

    it('does not report a custom title when the runtime switch fails', async () => {
      const onResumedCustomTitle = vi.fn();
      mockReplaceMessages.mockRejectedValueOnce(new Error('switch failed'));
      const { result } = await renderHook(() =>
        useSessionResume({ ...getDefaultProps(), onResumedCustomTitle }),
      );

      let didResume = true;
      await act(async () => {
        didResume = await result.current.loadHistoryForResume([], {
          sessionId: 'named-session',
          messages: [],
          customTitle: 'hello-world',
        });
      });

      expect(didResume).toBe(false);
      expect(onResumedCustomTitle).not.toHaveBeenCalled();
    });

    it('should clear history and add items when loading history', async () => {
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: 'Hello' },
        { type: 'gemini', text: 'Hi there!' },
      ];

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      let didResume = false;
      await act(async () => {
        didResume = await result.current.loadHistoryForResume(
          uiHistory,
          resumedData,
        );
      });

      expect(didResume).toBe(true);
      expect(mockConfig.setSessionArtifactWorktreeStates).toHaveBeenCalledWith(
        undefined,
      );
      expect(mockConfig.setSessionId).toHaveBeenCalledWith('test-123');
      expect(uiTelemetryService.hydrateFromMessages).toHaveBeenCalledWith(
        'test-123',
        [],
      );
      expect(mockSetQuittingMessages).toHaveBeenCalledWith(null);
      // Resume bulk-loads the merged history in one state update instead of
      // clearItems() + per-item addItem() calls.
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledTimes(1);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledWith([
        { type: 'user', text: 'Hello' },
        { type: 'gemini', text: 'Hi there!' },
      ]);
      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(mockRequestTranscriptReplacement).toHaveBeenCalledTimes(1);
      expect(mockReplaceMessages).toHaveBeenCalledWith([], 'test-123', {
        restoreExistingSession: true,
        sourceSessionId: undefined,
        fileHistorySnapshots: undefined,
        persistFileHistoryToTranscript: undefined,
        copyFileHistoryBackups: undefined,
        sessionPath: undefined,
        setConfigSessionId: true,
        targetWorkspaceDirectories: undefined,
        transcriptProjectRoot: undefined,
        worktreeSession: undefined,
      });
    });

    it('fires SessionEnd before command-driven branch resume switches runtime state', async () => {
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );
      const resumedData: SessionResumeData = {
        sessionId: 'branch-session',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData, {
          endOutgoingSession: true,
        });
      });

      expect(mockFireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Resume,
      );
      expect(mockFireSessionEndEvent.mock.invocationCallOrder[0]).toBeLessThan(
        mockReplaceMessages.mock.invocationCallOrder[0],
      );
    });

    it('applies a startup worktree request once after the resumed writer switch', async () => {
      const worktreeStartupRequest = {
        kind: 'create' as const,
        name: 'explicit',
        originalCwd: '/project',
      };
      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          worktreeStartupRequest,
        }),
      );
      const resumedData: SessionResumeData = {
        sessionId: 'target-session',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockApplyWorktreeStartupRequest).toHaveBeenCalledExactlyOnceWith(
        mockConfig,
        worktreeStartupRequest,
      );
      expect(mockReplaceMessages.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplyWorktreeStartupRequest.mock.invocationCallOrder[0],
      );
    });

    it('applies a startup worktree request after provisioning a new session writer', async () => {
      const worktreeStartupRequest = {
        kind: 'create' as const,
        name: 'initial-worktree',
        originalCwd: '/project',
      };

      await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          worktreeStartupRequest,
        }),
      );

      await waitFor(() => {
        expect(mockApplyWorktreeStartupRequest).toHaveBeenCalledOnce();
      });
      expect(mockReplaceMessages).toHaveBeenCalledWith([], 'current-session', {
        restoreExistingSession: false,
        persistFileHistoryToTranscript: undefined,
        copyFileHistoryBackups: undefined,
      });
      expect(mockApplyWorktreeStartupRequest).toHaveBeenCalledWith(
        mockConfig,
        worktreeStartupRequest,
      );
      expect(mockReplaceMessages.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplyWorktreeStartupRequest.mock.invocationCallOrder[0],
      );
    });

    it('blocks input until an initial startup worktree request settles', async () => {
      const worktreeOperation = deferred<undefined>();
      mockApplyWorktreeStartupRequest.mockReturnValueOnce(
        worktreeOperation.promise,
      );
      const worktreeStartupRequest = {
        kind: 'create' as const,
        name: 'initial-worktree',
        originalCwd: '/project',
      };

      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          worktreeStartupRequest,
        }),
      );

      const wasBlockedBeforeWorktreeSettled = result.current.isResuming;
      await waitFor(() => {
        expect(mockApplyWorktreeStartupRequest).toHaveBeenCalledOnce();
      });

      await act(async () => {
        worktreeOperation.resolve(undefined);
        await worktreeOperation.promise;
      });

      await waitFor(() => {
        expect(result.current.isResuming).toBe(false);
      });
      expect(wasBlockedBeforeWorktreeSettled).toBe(true);
    });

    it('unblocks input and reports feedback when an initial startup worktree request fails', async () => {
      const worktreeError = new Error('worktree unavailable');
      const worktreeOperation = deferred<undefined>();
      mockApplyWorktreeStartupRequest.mockReturnValueOnce(
        worktreeOperation.promise,
      );
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const worktreeStartupRequest = {
        kind: 'create' as const,
        name: 'initial-worktree',
        originalCwd: '/project',
      };

      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          worktreeStartupRequest,
        }),
      );

      await waitFor(() => {
        expect(mockApplyWorktreeStartupRequest).toHaveBeenCalledOnce();
      });
      await act(async () => {
        worktreeOperation.reject(worktreeError);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(emitFeedbackSpy).toHaveBeenCalledWith(
          'warning',
          expect.stringContaining('Automatic input is paused'),
          worktreeError,
        );
        expect(result.current.isResuming).toBe(false);
        expect(result.current.isAutomaticInputBlocked).toBe(true);
      });
    });

    it('reports a failed startup worktree request once after the session has resumed', async () => {
      const worktreeError = new Error('worktree unavailable');
      mockApplyWorktreeStartupRequest.mockRejectedValueOnce(worktreeError);
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const worktreeStartupRequest = {
        kind: 'create' as const,
        name: 'feature',
        originalCwd: '/project',
      };
      const resumedData: SessionResumeData = {
        sessionId: 'target-session',
        messages: [],
      };
      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          worktreeStartupRequest,
          resumedSessionData: resumedData,
        }),
      );

      await waitFor(() => {
        expect(mockApplyWorktreeStartupRequest).toHaveBeenCalledOnce();
        expect(emitFeedbackSpy).toHaveBeenCalledWith(
          'warning',
          expect.stringContaining('Automatic input is paused'),
          worktreeError,
        );
        expect(result.current.isResuming).toBe(false);
        expect(result.current.isAutomaticInputBlocked).toBe(true);
      });
    });

    it('restores the resumed transcript model when no CLI model override is set', async () => {
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-model-restore',
        messages: [],
        model: 'large-context-model',
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockConfig.setModel).toHaveBeenCalledWith(
        'large-context-model',
        true,
      );
    });

    it('keeps the CLI model override when resuming a transcript model', async () => {
      mockConfig.getCliModel.mockReturnValue('explicit-cli-model');

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-model-skip',
        messages: [],
        model: 'large-context-model',
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockConfig.setModel).not.toHaveBeenCalled();
    });

    it('restores the resumed context window when no CLI override is set', async () => {
      mockConfig.getAvailableContextWindows.mockReturnValue([128000, 256000]);

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-context-restore',
        messages: [],
        contextWindow: 256000,
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(manager.setModelConfig).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'current-model' }),
        { context: { contextWindow: 256000 } },
        undefined,
      );
    });

    it('keeps the CLI context window override when resuming', async () => {
      mockConfig.getCliContextWindow.mockReturnValue('128000');

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-context-skip',
        messages: [],
        contextWindow: 256000,
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(manager.setModelConfig).not.toHaveBeenCalled();
    });

    it('recounts after installing history and restoring the model instead of using boundary tokens', async () => {
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );
      mockRefreshContextTokenCount.mockImplementationOnce(async () => {
        expect(mockReplaceMessages).toHaveBeenCalled();
        expect(mockConfig.setModel).toHaveBeenCalledWith(
          'restored-model',
          true,
        );
      });
      await act(async () => {
        await result.current.loadHistoryForResume([], {
          sessionId: 'post-compact-resume',
          model: 'restored-model',
          messages: [
            {
              type: 'system',
              subtype: 'compact_boundary',
              uuid: 'boundary',
              timestamp: '2026-01-01T00:00:00.000Z',
              compactMetadata: {
                trigger: 'manual',
                preTokens: 90000,
                postTokens: 1,
              },
            } as Message,
          ],
        });
      });
      expect(mockRefreshContextTokenCount).toHaveBeenCalledOnce();
      expect(loadLatestSessionUsage).not.toHaveBeenCalled();
      expect(
        uiTelemetryService.setLastPromptTokenCount,
      ).not.toHaveBeenCalledWith(1);
    });

    it('keeps a committed resume usable when prompt counting cannot be refreshed', async () => {
      mockRefreshContextTokenCount.mockRejectedValueOnce(
        new Error('prompt unavailable'),
      );
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );
      let restored = false;
      await act(async () => {
        restored = await result.current.loadHistoryForResume([], {
          sessionId: 'refresh-failed',
          messages: [],
        });
      });
      expect(restored).toBe(true);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalled();
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        0,
      );
    });

    it('should not load history if runtime is not ready', async () => {
      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          isRuntimeReady: false,
        }),
      );

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: 'Hello' },
      ];
      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      let didResume = true;
      await act(async () => {
        didResume = await result.current.loadHistoryForResume(
          uiHistory,
          resumedData,
        );
      });

      expect(didResume).toBe(false);
      expect(mockHistoryManager.clearItems).not.toHaveBeenCalled();
      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(mockHistoryManager.loadHistoryItems).not.toHaveBeenCalled();
      expect(mockReplaceMessages).not.toHaveBeenCalled();
      expect(mockConfig.setSessionId).not.toHaveBeenCalled();
      expect(uiTelemetryService.hydrateFromMessages).not.toHaveBeenCalled();
    });

    it('should handle empty history arrays', async () => {
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      let didResume = false;
      await act(async () => {
        didResume = await result.current.loadHistoryForResume([], resumedData);
      });

      expect(didResume).toBe(true);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledTimes(1);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledWith([]);
      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(mockRequestTranscriptReplacement).toHaveBeenCalledTimes(1);
      expect(mockReplaceMessages).toHaveBeenCalledWith([], 'test-123', {
        restoreExistingSession: true,
        sourceSessionId: undefined,
        fileHistorySnapshots: undefined,
        persistFileHistoryToTranscript: undefined,
        copyFileHistoryBackups: undefined,
        sessionPath: undefined,
        setConfigSessionId: true,
        targetWorkspaceDirectories: undefined,
        transcriptProjectRoot: undefined,
        worktreeSession: undefined,
      });
      expect(mockConfig.setSessionId).toHaveBeenCalledWith('test-123');
      expect(uiTelemetryService.hydrateFromMessages).toHaveBeenCalledWith(
        'test-123',
        [],
      );
    });

    it('returns false when replaceMessages fails', async () => {
      mockReplaceMessages.mockRejectedValueOnce(new Error('resume failed'));
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      let didResume = true;
      await act(async () => {
        didResume = await result.current.loadHistoryForResume([], resumedData);
      });

      expect(didResume).toBe(false);
      expect(emitFeedbackSpy).toHaveBeenCalledWith(
        'error',
        'Failed to resume session. Please try again.',
        expect.any(Error),
      );
    });

    it('returns true when interface refresh fails after the runtime switch commits', async () => {
      const refreshError = new Error('terminal refresh failed');
      mockRequestTranscriptReplacement.mockImplementationOnce(() => {
        throw refreshError;
      });
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );
      const resumedData: SessionResumeData = {
        sessionId: 'committed-session',
        messages: [],
      };

      let didResume = false;
      await act(async () => {
        didResume = await result.current.loadHistoryForResume([], resumedData);
      });

      expect(didResume).toBe(true);
      expect(mockConfig.setSessionId).toHaveBeenCalledWith('committed-session');
      expect(emitFeedbackSpy).toHaveBeenCalledWith(
        'warning',
        'The session resumed, but the interface could not finish refreshing.',
        refreshError,
      );
    });

    it('returns true when post-commit feedback rendering also fails', async () => {
      const refreshError = new Error('history rendering failed');
      const feedbackError = new Error('warning rendering failed');
      mockHistoryManager.loadHistoryItems = vi.fn(() => {
        throw refreshError;
      });
      const feedbackListener = vi.fn(() => {
        throw feedbackError;
      });
      coreEvents.on(CoreEvent.UserFeedback, feedbackListener);
      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );
      const resumedData: SessionResumeData = {
        sessionId: 'committed-session',
        messages: [],
      };
      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: 'Hello' },
      ];

      let didResume = false;
      try {
        await act(async () => {
          didResume = await result.current.loadHistoryForResume(
            uiHistory,
            resumedData,
          );
        });
      } finally {
        coreEvents.off(CoreEvent.UserFeedback, feedbackListener);
      }

      expect(didResume).toBe(true);
      expect(mockConfig.setSessionId).toHaveBeenCalledWith('committed-session');
      expect(feedbackListener).toHaveBeenCalledTimes(1);
    });

    it('uses the source session when loading a forked session', async () => {
      const loadSubagentHistorySpy = vi
        .spyOn(subagentResume, 'loadResumedSubagentHistory')
        .mockResolvedValueOnce([]);
      const mockPlanStateManager = {
        copyPlanForResume: vi.fn().mockResolvedValue(undefined),
      };
      const configWithPlans = {
        ...mockConfig,
        storage: {
          getPlansDir: vi.fn().mockReturnValue('/plans'),
        },
        getSessionId: vi.fn().mockReturnValue('fork-target'),
        planStateManager: mockPlanStateManager,
      };

      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          config: configWithPlans as unknown as Config,
        }),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'fork-target',
        sourceSessionId: 'source-session',
        sessionPath: '/artifact-bucket/fork-target.jsonl',
        sourceSessionPath: '/legacy-bucket/source-session.jsonl',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockReplaceMessages).toHaveBeenCalledWith([], 'fork-target', {
        restoreExistingSession: true,
        sourceSessionId: 'source-session',
        fileHistorySnapshots: undefined,
        persistFileHistoryToTranscript: undefined,
        copyFileHistoryBackups: undefined,
        sessionPath: '/artifact-bucket/fork-target.jsonl',
        setConfigSessionId: true,
        targetWorkspaceDirectories: undefined,
        transcriptProjectRoot: undefined,
      });
      expect(loadSubagentHistorySpy).toHaveBeenCalledWith(
        '/artifact-project',
        'source-session',
        '/legacy-bucket/source-session.jsonl',
      );
      expect(mockPlanStateManager.copyPlanForResume).toHaveBeenCalledWith(
        [],
        'source-session',
        'fork-target',
        '/plans',
      );
    });

    it('skips file-history persistence when resuming a prewritten fork transcript', async () => {
      vi.spyOn(
        subagentResume,
        'loadResumedSubagentHistory',
      ).mockResolvedValueOnce([]);
      const mockPlanStateManager = {
        copyPlanForResume: vi.fn().mockResolvedValue(undefined),
      };
      const configWithPlans = {
        ...mockConfig,
        storage: {
          getPlansDir: vi.fn().mockReturnValue('/plans'),
        },
        getSessionId: vi.fn().mockReturnValue('fork-target'),
        planStateManager: mockPlanStateManager,
      };
      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          config: configWithPlans as unknown as Config,
        }),
      );
      const snapshots = [{ messageId: 'm1', trackedFileBackups: {} }] as never;

      const resumedData: SessionResumeData = {
        sessionId: 'fork-target',
        sourceSessionId: 'source-session',
        sessionPath: '/artifact-bucket/fork-target.jsonl',
        sourceSessionPath: '/legacy-bucket/source-session.jsonl',
        forkTranscriptPath: '/artifact-bucket/fork-target.jsonl',
        messages: [],
        fileHistorySnapshots: snapshots,
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockReplaceMessages).toHaveBeenCalledWith(
        [],
        'fork-target',
        expect.objectContaining({
          fileHistorySnapshots: snapshots,
          persistFileHistoryToTranscript: false,
          copyFileHistoryBackups: false,
        }),
      );
    });

    it('passes restored directories to the writer transaction without changing the outgoing workspace', async () => {
      const mockAddDirectories = vi
        .fn()
        .mockReturnValue({ added: [], failed: [] });
      const mockWorkspaceContext = {
        addDirectories: mockAddDirectories,
      };
      const configWithWorkspace = {
        ...mockConfig,
        getWorkspaceContext: vi.fn().mockReturnValue(mockWorkspaceContext),
      };

      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          config: configWithWorkspace as unknown as Config,
        }),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
        directories: ['/restored/dir1', '/restored/dir2'],
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockAddDirectories).not.toHaveBeenCalled();
      expect(mockReplaceMessages).toHaveBeenCalledWith([], 'test-123', {
        restoreExistingSession: true,
        sourceSessionId: undefined,
        fileHistorySnapshots: undefined,
        persistFileHistoryToTranscript: undefined,
        copyFileHistoryBackups: undefined,
        sessionPath: undefined,
        setConfigSessionId: true,
        targetWorkspaceDirectories: ['/restored/dir1', '/restored/dir2'],
        transcriptProjectRoot: undefined,
        worktreeSession: undefined,
      });
    });

    it('should not call addDirectories when no directories in resumed session', async () => {
      const mockAddDirectories = vi.fn();
      const mockWorkspaceContext = {
        addDirectories: mockAddDirectories,
      };
      const configWithWorkspace = {
        ...mockConfig,
        getWorkspaceContext: vi.fn().mockReturnValue(mockWorkspaceContext),
      };

      const { result } = await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          config: configWithWorkspace as unknown as Config,
        }),
      );

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume([], resumedData);
      });

      expect(mockAddDirectories).not.toHaveBeenCalled();
    });

    it('anchors resumed subagent history after the matching tool group', async () => {
      vi.spyOn(
        subagentResume,
        'loadResumedSubagentHistory',
      ).mockResolvedValueOnce([
        {
          agentName: 'Explorer',
          parentToolUseId: 'toolu-agent-1',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explorer',
            recentActivity: [],
            state: 'completed',
            result: 'Workspace inspected.',
          },
        },
      ]);

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: '用一个subagent看下当前文件夹里有什么' },
        {
          type: 'tool_group',
          tools: [
            {
              callId: 'toolu-agent-1',
              name: 'Agent',
              description: '',
              resultDisplay: undefined,
              status: CoreToolCallStatus.Success,
              confirmationDetails: undefined,
            },
          ],
        },
        { type: 'gemini', text: '当前目录是一个 monorepo。' },
      ];

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume(uiHistory, resumedData);
      });

      const loadedItems = (
        mockHistoryManager.loadHistoryItems as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0];
      expect(loadedItems).toHaveLength(3);
      expect(loadedItems[0]).toEqual(uiHistory[0]);
      expect(loadedItems[1]).toEqual(
        expect.objectContaining({
          type: 'tool_group',
          tools: [
            expect.objectContaining({
              callId: 'toolu-agent-1',
              kind: 'agent',
              resultDisplay: expect.objectContaining({
                isSubagentProgress: true,
                agentName: 'Explorer',
                state: 'completed',
                result: 'Workspace inspected.',
              }),
            }),
          ],
        }),
      );
      expect(loadedItems[2]).toEqual(uiHistory[2]);
    });

    it('keeps cancelled parent Agent results as errors while attaching resumed subagent details', async () => {
      vi.spyOn(
        subagentResume,
        'loadResumedSubagentHistory',
      ).mockResolvedValueOnce([
        {
          agentName: 'Explorer',
          parentToolUseId: 'toolu-agent-1',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explorer',
            recentActivity: [
              {
                id: 'read-package',
                type: 'tool_call',
                status: 'completed',
                content: 'Read',
                displayName: 'Read',
                description: 'package.json',
              },
            ],
            state: 'completed',
            result: 'Workspace inspected.',
          },
        },
      ]);

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: '演示一下并行 subagent' },
        {
          type: 'tool_group',
          tools: [
            {
              callId: 'toolu-agent-1',
              name: 'Agent',
              description: '',
              resultDisplay: REJECT_MESSAGE,
              status: CoreToolCallStatus.Error,
              confirmationDetails: undefined,
            },
          ],
        },
      ];

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume(uiHistory, resumedData);
      });

      const loadedItems = (
        mockHistoryManager.loadHistoryItems as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0];
      expect(loadedItems).toHaveLength(2);
      expect(loadedItems[0]).toEqual(uiHistory[0]);
      expect(loadedItems[1]).toEqual(
        expect.objectContaining({
          type: 'tool_group',
          tools: [
            expect.objectContaining({
              callId: 'toolu-agent-1',
              kind: 'agent',
              status: CoreToolCallStatus.Error,
              resultDisplay: expect.objectContaining({
                isSubagentProgress: true,
                agentName: 'Explorer',
                state: 'completed',
                result: 'Workspace inspected.',
              }),
              subagentHistory: [
                expect.objectContaining({
                  id: 'read-package',
                  status: 'completed',
                }),
              ],
            }),
          ],
        }),
      );
    });

    it('preserves adjacent resumed Agent tool groups as separate transcript entries', async () => {
      vi.spyOn(
        subagentResume,
        'loadResumedSubagentHistory',
      ).mockResolvedValueOnce([
        {
          agentName: 'Explorer',
          parentToolUseId: 'toolu-agent-1',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explorer',
            recentActivity: [],
            state: 'completed',
            result: '技术栈已检查。',
          },
        },
        {
          agentName: 'Explorer',
          parentToolUseId: 'toolu-agent-2',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explorer',
            recentActivity: [],
            state: 'cancelled',
            result: 'Operation cancelled by user',
          },
        },
        {
          agentName: 'Explorer',
          parentToolUseId: 'toolu-agent-3',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explorer',
            recentActivity: [],
            state: 'cancelled',
            result: 'Operation cancelled by user',
          },
        },
      ]);

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const createCancelledAgentGroup = (
        callId: string,
      ): HistoryItemWithoutId => ({
        type: 'tool_group',
        tools: [
          {
            callId,
            name: 'Agent',
            description: '',
            resultDisplay: REJECT_MESSAGE,
            status: CoreToolCallStatus.Error,
            confirmationDetails: undefined,
          },
        ],
      });

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: '演示一下并行 subagent' },
        { type: 'gemini', text: '我会同时启动 3 个 Explore 子代理。' },
        createCancelledAgentGroup('toolu-agent-1'),
        createCancelledAgentGroup('toolu-agent-2'),
        createCancelledAgentGroup('toolu-agent-3'),
      ];

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume(uiHistory, resumedData);
      });

      const loadedItems = (
        mockHistoryManager.loadHistoryItems as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0];
      expect(loadedItems).toHaveLength(5);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledTimes(1);
      expect(loadedItems[2]).toEqual(
        expect.objectContaining({
          type: 'tool_group',
          tools: [
            expect.objectContaining({
              callId: 'toolu-agent-1',
              status: CoreToolCallStatus.Error,
              resultDisplay: expect.objectContaining({
                state: 'completed',
              }),
            }),
          ],
        }),
      );
      expect(loadedItems[3]).toEqual(
        expect.objectContaining({
          type: 'tool_group',
          tools: [
            expect.objectContaining({
              callId: 'toolu-agent-2',
              status: CoreToolCallStatus.Error,
              resultDisplay: expect.objectContaining({
                state: 'cancelled',
              }),
            }),
          ],
        }),
      );
      expect(loadedItems[4]).toEqual(
        expect.objectContaining({
          type: 'tool_group',
          tools: [
            expect.objectContaining({
              callId: 'toolu-agent-3',
              status: CoreToolCallStatus.Error,
              resultDisplay: expect.objectContaining({
                state: 'cancelled',
              }),
            }),
          ],
        }),
      );
    });

    it('does not append resumed subagent history when the parent tool group is missing from resumed ui history', async () => {
      vi.spyOn(
        subagentResume,
        'loadResumedSubagentHistory',
      ).mockResolvedValueOnce([
        {
          agentName: 'Explorer',
          parentToolUseId: 'toolu-agent-1',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explorer',
            recentActivity: [],
            state: 'completed',
            result: 'Workspace inspected.',
          },
        },
      ]);

      const { result } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: '继续' },
        { type: 'gemini', text: '当前目录是一个 monorepo。' },
      ];

      const resumedData: SessionResumeData = {
        sessionId: 'test-123',
        messages: [],
      };

      await act(async () => {
        await result.current.loadHistoryForResume(uiHistory, resumedData);
      });

      const loadedItems = (
        mockHistoryManager.loadHistoryItems as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0];
      expect(loadedItems).toEqual(uiHistory);
    });
  });

  describe('callback stability', () => {
    it('should maintain stable loadHistoryForResume reference across renders', async () => {
      const { result, rerender } = await renderHook(() =>
        useSessionResume(getDefaultProps()),
      );

      const initialCallback = result.current.loadHistoryForResume;

      rerender();

      expect(result.current.loadHistoryForResume).toBe(initialCallback);
    });

    it('should update callback when config changes', async () => {
      const { result, rerender } = await renderHook(
        ({ config }: { config: Config }) =>
          useSessionResume({
            ...getDefaultProps(),
            config,
          }),
        {
          initialProps: { config: mockConfig as unknown as Config },
        },
      );

      const initialCallback = result.current.loadHistoryForResume;

      const newMockConfig = {};

      rerender({ config: newMockConfig as unknown as Config });

      expect(result.current.loadHistoryForResume).not.toBe(initialCallback);
    });
  });

  describe('automatic resume on mount', () => {
    it('should not resume when resumedSessionData is not provided', async () => {
      await renderHook(() => useSessionResume(getDefaultProps()));

      expect(mockHistoryManager.clearItems).not.toHaveBeenCalled();
      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(mockReplaceMessages).not.toHaveBeenCalled();
    });

    it('should not resume when user is authenticating', async () => {
      const conversation: LegacyResumeConversation = {
        sessionId: 'auto-resume-123',
        projectHash: 'project-123',
        startTime: '2025-01-01T00:00:00Z',
        lastUpdated: '2025-01-01T01:00:00Z',
        messages: [
          {
            id: 'msg-1',
            timestamp: '2025-01-01T00:01:00Z',
            content: 'Test message',
            type: 'user',
          },
        ],
      };

      await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          resumedSessionData: {
            sessionId: conversation.sessionId,
            messages: toMessages(conversation),
          },
          isStartupHeld: true,
        }),
      );

      expect(mockHistoryManager.clearItems).not.toHaveBeenCalled();
      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(mockReplaceMessages).not.toHaveBeenCalled();
    });

    it('should not resume when runtime is not ready', async () => {
      const conversation: LegacyResumeConversation = {
        sessionId: 'auto-resume-123',
        projectHash: 'project-123',
        startTime: '2025-01-01T00:00:00Z',
        lastUpdated: '2025-01-01T01:00:00Z',
        messages: [
          {
            id: 'msg-1',
            timestamp: '2025-01-01T00:01:00Z',
            content: 'Test message',
            type: 'user',
          },
        ],
      };

      await renderHook(() =>
        useSessionResume({
          ...getDefaultProps(),
          resumedSessionData: {
            sessionId: conversation.sessionId,
            messages: toMessages(conversation),
          },
          isRuntimeReady: false,
        }),
      );

      expect(mockHistoryManager.clearItems).not.toHaveBeenCalled();
      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(mockReplaceMessages).not.toHaveBeenCalled();
    });

    it('should automatically resume session when resumedSessionData is provided', async () => {
      const conversation: LegacyResumeConversation = {
        sessionId: 'auto-resume-123',
        projectHash: 'project-123',
        startTime: '2025-01-01T00:00:00Z',
        lastUpdated: '2025-01-01T01:00:00Z',
        messages: [
          {
            id: 'msg-1',
            timestamp: '2025-01-01T00:01:00Z',
            content: 'Hello from resumed session',
            type: 'user',
          },
          {
            id: 'msg-2',
            timestamp: '2025-01-01T00:02:00Z',
            content: 'Welcome back!',
            type: 'gemini',
          },
        ],
      };

      await act(async () => {
        await renderHook(() =>
          useSessionResume({
            ...getDefaultProps(),
            resumedSessionData: {
              sessionId: conversation.sessionId,
              messages: toMessages(conversation),
            },
          }),
        );
      });

      await waitFor(() => {
        expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalled();
      });

      expect(mockConfig.setSessionId).toHaveBeenCalledWith('auto-resume-123');
      expect(uiTelemetryService.hydrateFromMessages).toHaveBeenCalledWith(
        conversation.sessionId,
        toMessages(conversation),
      );
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledTimes(1);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledWith([
        { type: 'user', text: 'Hello from resumed session' },
        { type: 'gemini', text: 'Welcome back!' },
      ]);
      expect(mockRequestTranscriptReplacement).toHaveBeenCalledTimes(1);
      expect(mockReplaceMessages).toHaveBeenCalledTimes(1);
    });

    it('should only resume once even if props change', async () => {
      const conversation: LegacyResumeConversation = {
        sessionId: 'auto-resume-123',
        projectHash: 'project-123',
        startTime: '2025-01-01T00:00:00Z',
        lastUpdated: '2025-01-01T01:00:00Z',
        messages: [
          {
            id: 'msg-1',
            timestamp: '2025-01-01T00:01:00Z',
            content: 'Test message',
            type: 'user',
          },
        ],
      };

      let rerenderFunc: (props: {
        requestTranscriptReplacement: () => void;
      }) => void;
      await act(async () => {
        const { rerender } = await renderHook(
          ({
            requestTranscriptReplacement,
          }: {
            requestTranscriptReplacement: () => void;
          }) =>
            useSessionResume({
              ...getDefaultProps(),
              requestTranscriptReplacement,
              resumedSessionData: {
                sessionId: conversation.sessionId,
                messages: toMessages(conversation),
              },
            }),
          {
            initialProps: {
              requestTranscriptReplacement:
                mockRequestTranscriptReplacement as () => void,
            },
          },
        );
        rerenderFunc = rerender;
      });

      await waitFor(() => {
        expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalled();
      });

      const loadHistoryItemsCallCount = (
        mockHistoryManager.loadHistoryItems as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      // Rerender with a different transcript replacement callback.
      const newRequestTranscriptReplacement = vi.fn();
      await act(async () => {
        rerenderFunc({
          requestTranscriptReplacement: newRequestTranscriptReplacement,
        });
      });

      // Should not resume again
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledTimes(
        loadHistoryItemsCallCount,
      );
    });

    it('should convert session messages correctly during auto-resume', async () => {
      const conversation: LegacyResumeConversation = {
        sessionId: 'auto-resume-with-tools',
        projectHash: 'project-123',
        startTime: '2025-01-01T00:00:00Z',
        lastUpdated: '2025-01-01T01:00:00Z',
        messages: [
          {
            id: 'msg-1',
            timestamp: '2025-01-01T00:01:00Z',
            content: '/help',
            type: 'user',
          },
          {
            id: 'msg-2',
            timestamp: '2025-01-01T00:02:00Z',
            content: 'Regular message',
            type: 'user',
          },
        ],
      };

      await act(async () => {
        await renderHook(() =>
          useSessionResume({
            ...getDefaultProps(),
            resumedSessionData: {
              sessionId: conversation.sessionId,
              messages: toMessages(conversation),
            },
          }),
        );
      });

      await waitFor(() => {
        expect(mockReplaceMessages).toHaveBeenCalled();
      });

      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledTimes(1);
      expect(mockHistoryManager.loadHistoryItems).toHaveBeenCalledWith([
        { type: 'user', text: '/help' },
        { type: 'user', text: 'Regular message' },
      ]);
    });
  });
});
