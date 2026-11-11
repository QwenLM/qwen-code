/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { useModel } from '../contexts/ConfigContext.js';
import {
  getPreferredContextWindow,
  getPreferredReasoningEffort,
} from '../../utils/modelPreference.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PartListUnion } from '@google/genai';
import {
  checkExhaustive,
  CoreEvent,
  coreEvents,
  materializePastedContents,
  parseReasoningEffortLevel,
  ToolConfirmationOutcome,
  type Config,
  type Message,
  type PermissionMode,
  type PermissionModeChangeTelemetryContext,
  type ReasoningEffortLevel,
  type ToolConfirmationPayload,
} from '@qwen-code/core';
import type {
  SessionHandle,
  SessionApproval,
  SessionAccessState,
  SessionModeChoice,
  SessionState,
  SessionUpdate,
} from '../../session/session.js';
import type { SessionModelInfo } from '../../session/sessionModels.js';
import {
  StreamingState,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
} from '../types.js';
import { createCliSessionBridge } from './cliSessionBridge.js';
import { getMessageHistoryPolicy } from './messageHistoryPolicy.js';
import {
  approvalDisplay,
  getSessionDisplayState,
  historyDisplay,
} from './sessionDisplayState.js';
import { partToContentBlocks, extractTextFromBlocks } from './sessionInput.js';
import type { SessionUiBinding } from './prepareSessionUi.js';
import type { SessionSubmitOptions } from '../../session/sessionPort.js';
import type { SubmitUserInputOptions } from '../hooks/localSession.shared.js';
import { useOptionalPermissionQueueStore } from '../permissions/PermissionQueueContext.js';
import type { PermissionQueueStore } from '../permissions/permissionQueueStore.js';

const inactiveUiSession = createCliSessionBridge({
  initialState: getSessionDisplayState(),
  addHistoryItem: () => {},
});
const INACTIVE_ACCESS: SessionAccessState = {
  status: 'disconnected',
  sessionId: null,
  error: null,
};

/** Projects semantic session facts into the existing terminal UI. */
export function useSession({
  enabled,
  config,
  binding,
  addHistoryItem,
  restoreData,
}: {
  enabled: boolean;
  config: Config;
  binding?: SessionUiBinding;
  restoreData?: unknown;
  addHistoryItem: (item: HistoryItemWithoutId) => void;
}) {
  const active = enabled && binding !== undefined;
  const session = active ? binding.session : undefined;
  const initial = session?.getState();
  const [activity, setActivity] = useState(initial?.activity);
  const listedModel = useModel(config);
  const initialMode = initial?.permissionMode ?? config.getPermissionMode();
  const [sessionState, setSessionState] = useState(
    initial?.access ?? INACTIVE_ACCESS,
  );
  const [sessionTitle, setSessionTitle] = useState(initial?.title ?? null);
  const [currentModel, setCurrentModel] = useState(
    initial?.model ?? config.getModel() ?? '',
  );
  // Programmatic switches (auth activation, SDK) bypass requestModelChange;
  // keep the displayed session model in sync with the live config.
  useEffect(() => {
    const onModelChanged = (event: { sessionId: string }) => {
      if (event.sessionId !== config.getSessionId()) return;
      const next = config.getModel();
      if (next) setCurrentModel(next);
    };
    coreEvents.on(CoreEvent.ModelChanged, onModelChanged);
    return () => {
      coreEvents.off(CoreEvent.ModelChanged, onModelChanged);
    };
  }, [config]);
  const [currentReasoningEffort, setCurrentReasoningEffort] = useState<
    ReasoningEffortLevel | undefined
  >(
    initial?.reasoningEffort ??
      getPreferredReasoningEffort(config, listedModel),
  );
  const [currentContextWindow, setCurrentContextWindow] = useState<
    number | undefined
  >(initial?.contextWindow ?? getPreferredContextWindow(config, listedModel));
  const [currentPermissionMode, setCurrentPermissionMode] =
    useState<PermissionMode>(initialMode);
  const [availableModels, setAvailableModelsState] = useState<
    SessionModelInfo[]
  >(() => [...(initial?.models ?? [])]);
  const modelsRef = useRef(availableModels);
  const setAvailableModels = useCallback(
    (models: readonly SessionModelInfo[]) => {
      const values = [...models];
      modelsRef.current = values;
      setAvailableModelsState(values);
    },
    [],
  );
  const [availablePermissionModes, setAvailablePermissionModesState] = useState<
    SessionModeChoice[]
  >(() => [...(initial?.modeChoices ?? [])]);
  const modesRef = useRef(availablePermissionModes);
  const setAvailablePermissionModes = useCallback(
    (modes: readonly SessionModeChoice[]) => {
      const values = [...modes];
      modesRef.current = values;
      setAvailablePermissionModesState(values);
    },
    [],
  );
  const uiSession = active ? binding.uiSession : inactiveUiSession;
  const addHistoryItemRef = useRef(addHistoryItem);
  useEffect(() => {
    addHistoryItemRef.current = addHistoryItem;
  }, [addHistoryItem]);
  const {
    pendingAssistantText,
    pendingApprovalCount,
    workerStatus: activityStatus,
    pendingHistoryItems,
    activeModelQueue,
    thought,
  } = useSyncExternalStore(uiSession.subscribe, uiSession.getSnapshot);
  // Preserve the original render cache, including updates batched before send settles.
  const streamingState = useMemo(
    () =>
      uiSession.getStreamingState({
        pendingApprovalCount,
        pendingAssistantText,
        workerStatus: activityStatus,
      }),
    [uiSession, pendingApprovalCount, pendingAssistantText, activityStatus],
  );
  const permissionStore = useOptionalPermissionQueueStore();
  const promptDisposers = useRef(new Map<string, () => void>());
  const updateApprovals = useCallback(
    (
      update:
        | IndividualToolCallDisplay[]
        | ((
            previous: IndividualToolCallDisplay[],
          ) => IndividualToolCallDisplay[]),
    ) => uiSession.apply({ type: 'approval_tools', update }),
    [uiSession],
  );
  const dismissPrompt = useCallback((id: string) => {
    const dispose = promptDisposers.current.get(id);
    promptDisposers.current.delete(id);
    dispose?.();
  }, []);
  const removeApproval = useCallback(
    (id: string) => {
      updateApprovals((previous) =>
        previous.filter((tool) => tool.correlationId !== id),
      );
      dismissPrompt(id);
    },
    [updateApprovals, dismissPrompt],
  );
  const presentApproval = useCallback(
    (approval: SessionApproval) => {
      if (
        binding?.kind === 'local' ||
        !permissionStore ||
        !session ||
        !approval.prompt
      )
        return;
      // The local executor may already own this exact request in the UI queue.
      if (permissionStore.getById(approval.id)) return;
      const dispose = presentSessionApproval(
        approval,
        permissionStore,
        (outcome, payload) => {
          removeApproval(approval.id);
          void session
            .respondToApproval(approval.id, outcome, payload)
            .catch((error: unknown) =>
              uiSession.apply({
                type: 'request_error',
                text: error instanceof Error ? error.message : String(error),
              }),
            );
        },
      );
      promptDisposers.current.set(approval.id, dispose);
    },
    [binding?.kind, permissionStore, session, removeApproval, uiSession],
  );
  const applySnapshot = useCallback(
    (state: SessionState, restoring: boolean) => {
      setSessionState(state.access);
      setActivity(state.activity);
      setSessionTitle(state.title);
      setCurrentModel(state.model);
      setCurrentReasoningEffort(state.reasoningEffort);
      setCurrentContextWindow(state.contextWindow);
      setCurrentPermissionMode(state.permissionMode);
      if (!restoring) setAvailableModels(state.models);
      setAvailablePermissionModes(state.modeChoices);
      if (restoring)
        uiSession.initialize(getSessionDisplayState(state, binding?.kind));
      updateApprovals(
        binding?.kind === 'local' ? [] : state.approvals.map(approvalDisplay),
      );
      for (const id of promptDisposers.current.keys()) {
        if (!state.approvals.some((approval) => approval.id === id))
          dismissPrompt(id);
      }
      for (const approval of state.approvals) presentApproval(approval);
    },
    [
      setAvailableModels,
      setAvailablePermissionModes,
      uiSession,
      presentApproval,
      updateApprovals,
      dismissPrompt,
      binding?.kind,
    ],
  );
  const consumeUpdate = useCallback(
    (update: SessionUpdate) => {
      switch (update.type) {
        case 'snapshot':
          applySnapshot(update.state, update.reason === 'restore');
          break;
        case 'access':
          setSessionState(update.state);
          break;
        case 'title':
          setSessionTitle(update.title);
          break;
        case 'settings': {
          const settings = update.settings;
          if (settings.model) setCurrentModel(settings.model);
          if ('reasoningEffort' in settings)
            setCurrentReasoningEffort(settings.reasoningEffort ?? undefined);
          if ('contextWindow' in settings)
            setCurrentContextWindow(settings.contextWindow ?? undefined);
          if (settings.permissionMode)
            setCurrentPermissionMode(settings.permissionMode);
          break;
        }
        case 'models':
          setAvailableModels(update.models);
          break;
        case 'mode_choices':
          setAvailablePermissionModes(update.choices);
          break;
        case 'approval':
          if (binding?.kind === 'local') break;
          if (update.replace) dismissPrompt(update.approval.id);
          updateApprovals((previous) => {
            const next = approvalDisplay(update.approval);
            if (
              !update.replace &&
              previous.some((item) => item.correlationId === update.approval.id)
            )
              return previous;
            return [
              ...previous.filter(
                (item) => item.correlationId !== update.approval.id,
              ),
              next,
            ];
          });
          presentApproval(update.approval);
          break;
        case 'approval_removed':
          removeApproval(update.id);
          break;
        case 'approvals_cleared':
          updateApprovals([]);
          for (const id of promptDisposers.current.keys()) dismissPrompt(id);
          break;
        case 'delivery':
          uiSession.prepareHistory(getMessageHistoryPolicy(update.source));
          break;
        case 'history':
          if (update.kind === 'display_pending') break;
          // Native history is already committed to the same UI history owner.
          if (binding?.kind === 'local' && update.kind !== 'pending') break;
          if (update.kind === 'append')
            uiSession.apply({
              type: 'display_history',
              change: {
                type: 'append',
                item: historyDisplay([update.record])[0],
              },
            });
          else
            uiSession.apply({
              type: 'display_history',
              change: {
                type: update.kind,
                items: historyDisplay(update.records),
              },
            });
          break;
        default:
          checkExhaustive(update);
      }
    },
    [
      applySnapshot,
      setAvailableModels,
      setAvailablePermissionModes,
      updateApprovals,
      presentApproval,
      removeApproval,
      dismissPrompt,
      uiSession,
      binding?.kind,
    ],
  );
  useEffect(() => {
    if (!enabled || !binding) return;
    const unbindHistory = binding.bindHistoryWriter((item) =>
      addHistoryItemRef.current(item),
    );
    const stopDisplay = uiSession.observeSession();
    return () => {
      stopDisplay();
      unbindHistory();
    };
  }, [enabled, binding, uiSession]);
  const restoredInput = useRef(restoreData);
  useEffect(() => {
    if (!enabled || !session) return;
    let cancelled = false;
    const prompts = promptDisposers.current;
    const stop = session.observeUpdates(consumeUpdate);
    void (async () => {
      if (restoredInput.current !== restoreData) {
        await session.restore(restoreData);
        if (cancelled) return;
        restoredInput.current = restoreData;
      }
      if (!cancelled && binding?.kind !== 'local') await session.start();
    })().catch(() => {}); // Access failures are delivered as session state.
    return () => {
      cancelled = true;
      stop();
      for (const id of prompts.keys()) dismissPrompt(id);
    };
  }, [
    enabled,
    session,
    consumeUpdate,
    restoreData,
    dismissPrompt,
    binding?.kind,
  ]);
  const previousPermissionMode = useRef(initialMode);
  useEffect(() => {
    if (
      !enabled ||
      binding?.kind === 'local' ||
      currentPermissionMode === previousPermissionMode.current
    )
      return;
    const previous = previousPermissionMode.current;
    previousPermissionMode.current = currentPermissionMode;
    coreEvents.emitPermissionModeChanged(
      config.getSessionId(),
      currentPermissionMode,
      previous,
    );
  }, [enabled, binding?.kind, currentPermissionMode, config]);
  const submitQuery = useCallback(
    async (
      query: PartListUnion,
      options?: SessionSubmitOptions &
        Pick<SubmitUserInputOptions, 'userMessage' | 'contentBlocks'>,
    ) => {
      if (!session) return;
      const pasted =
        binding?.kind !== 'local' && options?.pastedContents
          ? await materializePastedContents(options.pastedContents)
          : undefined;
      const content =
        options?.contentBlocks?.map((block) => ({ ...block })) ??
        partToContentBlocks(query, pasted);
      if (!content.length) return;
      await uiSession.submitMessage(
        {
          id:
            options?.userMessage?.uuid ??
            options?.queuedCommands?.[0]?.uuid ??
            `user:${randomUUID()}`,
          text: extractTextFromBlocks(content),
          content,
        },
        binding?.kind === 'local'
          ? {
              ...options,
              timestamp: options?.userMessage?.timestamp ?? options?.timestamp,
            }
          : { hideFromDisplay: options?.hideFromDisplay },
        addHistoryItem,
      );
    },
    [session, uiSession, addHistoryItem, binding?.kind],
  );
  const cancelOngoingRequest = useCallback(
    (source?: string, origin?: string) => {
      // Passing options marks a local UI interrupt: cancel the whole turn
      // instead of only rejecting a pending permission prompt.
      if (session)
        uiSession.interrupt(addHistoryItem, {
          source: source ?? 'unknown',
          origin: origin ?? 'programmatic',
        });
    },
    [session, uiSession, addHistoryItem],
  );
  const requestModelChange = useCallback(
    async (
      model: string,
      effort?: ReasoningEffortLevel | string,
      contextWindow?: number,
      options?: Parameters<SessionHandle['setModel']>[3],
    ) => {
      if (!session) return;
      const parsed = parseReasoningEffortLevel(effort);
      if (binding?.kind === 'local') {
        return session.setModel(model, parsed, contextWindow, options);
      }
      if (!model) return;
      const previous = {
        model: currentModel,
        effort: currentReasoningEffort,
        context: currentContextWindow,
      };
      setCurrentModel(model);
      if (parsed !== undefined) setCurrentReasoningEffort(parsed);
      if (contextWindow !== undefined) setCurrentContextWindow(contextWindow);
      try {
        return await session.setModel(model, parsed, contextWindow);
      } catch (error) {
        setCurrentModel(previous.model);
        setCurrentReasoningEffort(previous.effort);
        setCurrentContextWindow(previous.context);
        throw error;
      }
    },
    [
      session,
      binding?.kind,
      currentModel,
      currentReasoningEffort,
      currentContextWindow,
    ],
  );
  const requestContextWindowChange = useCallback(
    async (value?: number) => {
      if (!session) return;
      const previous = currentContextWindow;
      setCurrentContextWindow(value);
      try {
        await session.setContextWindow(value);
      } catch (error) {
        setCurrentContextWindow(previous);
        throw error;
      }
    },
    [session, currentContextWindow],
  );
  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode, context?: PermissionModeChangeTelemetryContext) => {
      if (!session) return Promise.resolve();
      const previous = currentPermissionMode;
      setCurrentPermissionMode(mode);
      try {
        const pending =
          context === undefined
            ? session.setPermissionMode(mode)
            : session.setPermissionMode(mode, context);
        return pending.catch((error: unknown) => {
          setCurrentPermissionMode(previous);
          throw error;
        });
      } catch (error) {
        setCurrentPermissionMode(previous);
        throw error;
      }
    },
    [session, currentPermissionMode],
  );
  const requestApplyFlagSettings = useCallback(
    async (settings: Record<string, unknown>) => {
      await session?.applySettings(settings);
    },
    [session],
  );
  const persistSessionTitle = useCallback(
    async (title: string) => {
      await session?.setTitle(title);
    },
    [session],
  );
  const endSession = useCallback(
    async (reason?: string) => {
      await session?.end(reason);
    },
    [session],
  );
  const requestModelRefresh = useCallback(async () => {
    if (!session) return [];
    const models = await session.refreshModels();
    setAvailableModels(models);
    return models;
  }, [session, setAvailableModels]);
  const getAvailableModels = useCallback(
    () => (session ? modelsRef.current : []),
    [session],
  );
  const getAvailablePermissionModes = useCallback(
    () => (session ? modesRef.current : []),
    [session],
  );
  const getMessages = useCallback(
    () => session?.getMessages() ?? [],
    [session],
  );
  const getConversationMessages = useCallback(
    () => session?.getConversationMessages() ?? [],
    [session],
  );
  const setMessages = useCallback(
    (update: (previous: Message[]) => Message[]) =>
      session?.setMessages(update),
    [session],
  );
  const replaceMessages = useCallback(
    async (messages: Message[]) => session?.replaceMessages(messages),
    [session],
  );
  const releaseSession = useCallback(() => {
    void session?.release().catch(() => {});
  }, [session]);
  const resumeSession = useCallback(async () => {
    const access = (await session?.resume()) ?? INACTIVE_ACCESS;
    setSessionState(access);
    return access;
  }, [session]);
  const recordSupplementaryHistoryItem = useCallback(async () => {}, []);
  const recordMessage = useCallback(async () => {}, []);
  const runManualCompress = useCallback(
    async () => ({
      newHistory: null,
      info: {
        originalTokenCount: null,
        newTokenCount: null,
        compressionStatus: null,
      },
    }),
    [],
  );
  // Keep UI waiting/rollback behavior at the operation boundary, not in Config.
  const sessionHandle = useMemo<SessionHandle | undefined>(
    () =>
      session
        ? {
            getState: () => session.getState(),
            observe: (listener) => session.observe(listener),
            observeUpdates: (listener) => session.observeUpdates(listener),
            submitMessage: (...args) => session.submitMessage(...args),
            interrupt: (options) => session.interrupt(options),
            restore: (input) => session.restore(input),
            start: () => session.start(),
            release: () => session.release(),
            resume: () => session.resume(),
            end: (reason) => session.end(reason),
            getMessages: () => session.getMessages(),
            getConversationMessages: () => session.getConversationMessages(),
            setMessages: (update) => session.setMessages(update),
            replaceMessages: (messages) => session.replaceMessages(messages),
            setModel: requestModelChange,
            setContextWindow: requestContextWindowChange,
            applySettings: requestApplyFlagSettings,
            setPermissionMode: handlePermissionModeChange,
            setTitle: persistSessionTitle,
            refreshModels: requestModelRefresh,
            respondToApproval: (id, outcome, payload) =>
              session.respondToApproval(id, outcome, payload),
            describeOperationError: (operation, message) =>
              session.describeOperationError(operation, message),
          }
        : undefined,
    [
      session,
      requestModelChange,
      requestContextWindowChange,
      requestApplyFlagSettings,
      handlePermissionModeChange,
      persistSessionTitle,
      requestModelRefresh,
    ],
  );
  const getIsResponding = useCallback(
    () =>
      session?.getState().activity?.isResponding ?? uiSession.getIsResponding(),
    [session, uiSession],
  );
  const displayStreamingState = activity
    ? activity.status === 'waiting_for_confirmation'
      ? StreamingState.WaitingForConfirmation
      : activity.status === 'responding'
        ? StreamingState.Responding
        : StreamingState.Idle
    : streamingState;
  return {
    sessionHandle,
    sessionState: active ? sessionState : INACTIVE_ACCESS,
    sessionTitle: active ? sessionTitle : null,
    streamingState: active ? displayStreamingState : StreamingState.Idle,
    isModelTurnActive:
      active &&
      (activity?.isModelTurnActive ?? streamingState !== StreamingState.Idle),
    pendingHistoryItems: active ? pendingHistoryItems : [],
    activeModelQueue: active ? activeModelQueue : null,
    thought: active ? (activity ? activity.thought : thought) : null,
    currentModel: active ? currentModel : (config.getModel() ?? ''),
    currentReasoningEffort: active
      ? currentReasoningEffort
      : getPreferredReasoningEffort(config, listedModel),
    currentContextWindow: active
      ? currentContextWindow
      : getPreferredContextWindow(config, listedModel),
    currentPermissionMode: active
      ? currentPermissionMode
      : config.getPermissionMode(),
    availableModels: active ? availableModels : [],
    getAvailableModels,
    requestModelRefresh,
    availablePermissionModes: active ? availablePermissionModes : [],
    getAvailablePermissionModes,
    submitQuery,
    cancelOngoingRequest,
    requestModelChange,
    requestContextWindowChange,
    requestApplyFlagSettings,
    handlePermissionModeChange,
    persistSessionTitle,
    endSession,
    getIsResponding,
    getMessages,
    getConversationMessages,
    setMessages,
    replaceMessages,
    releaseSession,
    resumeSession,
    recordSupplementaryHistoryItem,
    recordMessage,
    runManualCompress,
  };
}

function presentSessionApproval(
  approval: SessionApproval,
  store: PermissionQueueStore,
  respond: (
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => void,
): () => void {
  return store.presentProxied(
    {
      toolUseId: approval.id,
      toolName: approval.name,
      input: approval.input ?? {},
      reason: {
        message: '',
        attribution: { type: 'other', reason: approval.prompt?.reason ?? '' },
      },
      skippable: approval.prompt?.skippable ?? false,
    },
    {
      approve: (amended, scope) =>
        respond(
          scope === 'persist'
            ? ToolConfirmationOutcome.ProceedPersist
            : scope === 'session'
              ? ToolConfirmationOutcome.ProceedSession
              : ToolConfirmationOutcome.ProceedOnce,
          amended as ToolConfirmationPayload | undefined,
        ),
      reject: () => respond(ToolConfirmationOutcome.Cancel),
      abort: () => respond(ToolConfirmationOutcome.Cancel),
    },
    approval.details,
  );
}
