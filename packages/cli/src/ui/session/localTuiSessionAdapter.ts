/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  generateRemoteSessionTitleForMessages,
  parseSdkInputBlock,
  parseReasoningEffortLevel,
  applyExplicitModelChange,
  runLogger,
  buildConfirmationDetails,
  breakerConfirmationDetails,
  resolveCurrentPlanPath,
  EXIT_PLAN_MODE_TOOL_NAME,
  DEFAULT_OUTPUT_STYLE_NAME,
  type Config,
  type AiTitleOrigin,
  type Model,
  type SessionResumeData,
  type QueryEvent,
  type ToolCallSnapshotSubscriber,
} from '@qwen-code/core';
import type {
  LocalSessionHandle,
  SessionExecutionState,
  SessionExecutionUpdate,
} from '../../session/localSession.js';
import type { SessionModelInfo } from '../../session/sessionModels.js';
import type {
  SessionApproval,
  SessionHandle,
  SessionState,
  SessionUpdate,
} from '../../session/session.js';
import { createSessionMessageChannel } from '../../session/sessionMessageChannel.js';
import type {
  SessionPort,
  SessionMessageSource,
} from '../../session/sessionPort.js';
import type {
  LocalTuiSessionOrchestratorResult,
  RuntimeProjectionController,
} from '../hooks/localSession.shared.js';
import {
  MessageType,
  StreamingState,
  type HistoryItem,
  type HistoryItemWithoutId,
} from '../types.js';
import {
  getPreferredReasoningEffort,
  getPreferredContextWindow,
  setModelPreference,
} from '../../utils/modelPreference.js';
import { projectSessionListedModels } from '../../session/buildSessionModelList.js';
import {
  computeAvailablePermissionModes,
  mapSdkPermissionMode,
} from '../../session/permissionMode.js';
import type { useLocalTuiSessionOrchestrator } from '../hooks/useLocalTuiSessionOrchestrator.js';
import { extractDisplayableUserContent } from '../utils/userMessageContent.js';
import type { PermissionQueueStore } from '../permissions/permissionQueueStore.js';
import {
  createSessionArtifactRuntime,
  type SessionArtifactRuntime,
} from '../../session/artifacts/sessionArtifactRuntime.js';
import type { LoadedSettings } from '../../config/settings.js';
import { withExitPlanContent } from '../../utils/exitPlanModeDetails.js';
import { settleToolConfirmation } from '../../utils/settleToolConfirmation.js';
import { applyIndependentPlanMode } from '../../session/permissionMode.js';

type LocalUserMessage = Parameters<
  NonNullable<
    Parameters<typeof useLocalTuiSessionOrchestrator>[0]['onLocalUserMessage']
  >
>[0];

/** Native sources owned by the existing executor, before session/UI conversion. */
export interface LocalTuiSessionSource {
  config: Config;
  settings?: LoadedSettings;
  runtime: Pick<
    LocalTuiSessionOrchestratorResult,
    | 'toolRegistry'
    | 'submitQuery'
    | 'submitUserInput'
    | 'dispose'
    | 'getMessages'
    | 'getConversationMessages'
    | 'setMessages'
    | 'replaceMessages'
    | 'cancelOngoingRequest'
    | 'handlePermissionModeChange'
    | 'getIsResponding'
    | 'activeModelQueue'
  >;
  projection: RuntimeProjectionController;
  history?: readonly HistoryItem[];
  displayPendingHistory?: readonly HistoryItemWithoutId[];
  setSystemPrompt?(prompt: string): void;
  setAppendSystemPrompt?(prompt: string): void;
  model?: Model;
  permissionQueue?: PermissionQueueStore | null;
  isReadyForInput: () => boolean;
  isClosed: () => boolean;
  restoreSession?: (data: SessionResumeData) => Promise<boolean>;
  systemPromptOverride?: string | null;
  appendSystemPrompt?: string | null;
}

const LIVE: SessionMessageSource = {
  delivery: 'live',
  hasDisplayHistory: true,
};

/** Adapts the existing local TUI executor. It owns observations, never an input queue. */
export class LocalTuiSessionAdapter implements LocalSessionHandle {
  private readonly messages = createSessionMessageChannel({
    pendingAssistantText: '',
    activityStatus: 'idle',
  });
  private readonly updates = new Set<(update: SessionUpdate) => void>();
  private readonly executionListeners = new Set<
    (update: SessionExecutionUpdate) => void
  >();
  private readonly executionQueue: SessionExecutionUpdate[] = [];
  private readonly submittedInputIds = new Set<string>();
  private notifyingExecution = false;
  private automaticTitle = true;
  get automaticTitleEnabled(): boolean {
    return this.automaticTitle;
  }
  private released = true;
  private bindingRevision = 0;
  private ended = false;
  private endTask: Promise<void> | undefined;
  private artifacts?: SessionArtifactRuntime;
  private artifactSessionId?: string;
  private artifactsReady?: Promise<SessionArtifactRuntime>;
  private artifactTail: Promise<void> = Promise.resolve();
  private executionTail: Promise<void> = Promise.resolve();
  private models: readonly SessionModelInfo[] = [];
  private permissionItems:
    | ReturnType<PermissionQueueStore['getSnapshot']>
    | undefined;
  private approvals: readonly SessionApproval[] = [];
  private stopPermissionObservation: (() => void) | undefined;
  private permissionQueue: PermissionQueueStore | null | undefined;
  private modelRevision = 0;
  private settingsRevision = 0;
  private pendingHistory:
    | {
        items: HistoryItemWithoutId[];
        queue: LocalTuiSessionSource['runtime']['activeModelQueue'];
        records: HistoryItemWithoutId[];
      }
    | undefined;
  private lastState: SessionState | undefined;
  private lastExecution: SessionExecutionState | undefined;
  constructor(
    private readonly config: Config,
    private readonly readSource: () => LocalTuiSessionSource | null,
  ) {}

  private source(allowInactive = false): LocalTuiSessionSource {
    const source = this.readSource();
    if (!source || source.config !== this.config)
      throw new Error('Local session binding has changed');
    if (!allowInactive) {
      if (this.ended) throw new Error('Local session has ended');
      if (this.released) throw new Error('Local session binding is released');
      if (source.isClosed()) throw new Error('Local session has ended');
    }
    return source;
  }

  readonly generateTitle: LocalSessionHandle['generateTitle'] = async () => {
    const source = this.source();
    const sessionId = this.config.getSessionId();
    const revision = this.bindingRevision;
    const identity = this.config.getModelRequestIdentity();
    const title = await generateRemoteSessionTitleForMessages({
      config: this.config,
      messages: source.runtime.getConversationMessages(),
    });
    return !this.released &&
      !this.ended &&
      revision === this.bindingRevision &&
      sessionId === this.config.getSessionId() &&
      identity === this.config.getModelRequestIdentity()
      ? title
      : null;
  };

  private resetArtifactsIfSessionChanged(): void {
    const sessionId = this.config.getSessionId();
    if (sessionId === this.artifactSessionId) return;
    this.artifactSessionId = sessionId;
    this.artifacts = undefined;
    this.artifactsReady = undefined;
    this.artifactTail = Promise.resolve();
    this.executionTail = Promise.resolve();
  }

  readonly getArtifacts: LocalSessionHandle['getArtifacts'] = async () => {
    const source = this.source();
    const sessionId = this.config.getSessionId();
    this.resetArtifactsIfSessionChanged();
    this.artifactsReady ??= (async () => {
      const artifacts = (this.artifacts ??= createSessionArtifactRuntime(
        this.config,
      ));
      this.artifactTail = artifacts
        .initialize(source.runtime.getConversationMessages())
        .then(() => undefined);
      await this.artifactTail;
      return artifacts;
    })();
    const artifacts = await this.artifactsReady;
    await this.artifactTail;
    this.source();
    if (
      sessionId !== this.config.getSessionId() ||
      artifacts !== this.artifacts
    )
      throw new Error('Local session changed while loading artifacts');
    return artifacts;
  };
  readonly describeApproval: LocalSessionHandle['describeApproval'] = async (
    id,
  ) => {
    const source = this.source();
    const prompt = source.permissionQueue?.getById(id);
    if (!prompt) return undefined;
    let details =
      prompt.confirmationDetails ?? breakerConfirmationDetails(prompt.reason);
    const tool = this.config.toolRegistry.getTool(prompt.toolName);
    if (!details && tool)
      details = await buildConfirmationDetails(
        tool,
        prompt.input,
        prompt.reason.message,
        prompt.toolName === EXIT_PLAN_MODE_TOOL_NAME
          ? resolveCurrentPlanPath(this.config)
          : undefined,
        this.config.getTargetDir(),
        this.config,
      );
    return source.permissionQueue?.getById(id) === prompt
      ? withExitPlanContent(details)
      : undefined;
  };
  readonly readSettings: LocalSessionHandle['readSettings'] = async () => {
    const source = this.source();
    const model = this.config.getModel();
    const identity = this.config.getModelRequestIdentity();
    const sessionId = this.config.getSessionId();
    const listed = await this.config.getModelProviderManager().getModel(model);
    let styles: string[];
    try {
      styles = Object.keys(await this.config.getAvailableOutputStyles());
    } catch {
      styles = [DEFAULT_OUTPUT_STYLE_NAME];
    }
    this.source();
    if (
      this.config.getModel() !== model ||
      this.config.getModelRequestIdentity() !== identity ||
      this.config.getSessionId() !== sessionId
    )
      throw new Error('Local session changed while reading settings');
    const snapshot = source.settings?.getSnapshot();
    return {
      ...(snapshot
        ? {
            sources: {
              user: snapshot.user.settings,
              project: snapshot.project.settings,
              local: snapshot.local.settings,
              flag: snapshot.flag.settings,
            },
          }
        : {}),
      effective: {
        ...(snapshot?.merged ?? {}),
        ultracode: this.config.getUltracode(),
      },
      applied: {
        effort: getPreferredReasoningEffort(this.config, listed) ?? null,
        ultracode: this.config.isUltracodeActive(listed),
      },
      outputStyle:
        this.config.getOutputStyle?.()?.name ?? DEFAULT_OUTPUT_STYLE_NAME,
      outputStyles: styles,
    };
  };
  get toolRegistry(): LocalSessionHandle['toolRegistry'] {
    return this.source().runtime.toolRegistry;
  }
  get toolCallSnapshots(): ToolCallSnapshotSubscriber {
    return this.config.toolCallSnapshots;
  }
  readonly getExecutionState = (): SessionExecutionState => {
    if (this.ended)
      return {
        canSubmitMessage: false,
        isResponding: false,
        pendingToolCalls: [],
      };
    const source = this.source(true);
    if (source.isClosed())
      return {
        canSubmitMessage: false,
        isResponding: false,
        pendingToolCalls: [],
      };
    return {
      canSubmitMessage:
        source.isReadyForInput() &&
        source.projection.getStreamingState() === StreamingState.Idle &&
        !source.runtime.getIsResponding(),
      isResponding: source.runtime.getIsResponding(),
      pendingToolCalls: source.projection.getToolCalls(),
    };
  };
  readonly getState = (): SessionState => {
    const source = this.source(true);
    const projection = source.projection.getSnapshot();
    const queue = source.runtime.activeModelQueue;
    if (
      this.pendingHistory?.items !== projection.pendingHistoryItems ||
      this.pendingHistory.queue !== queue
    ) {
      this.pendingHistory = {
        items: projection.pendingHistoryItems,
        queue,
        records: queue
          ? [
              { type: MessageType.MODEL_QUEUE, modelQueue: queue },
              ...projection.pendingHistoryItems,
            ]
          : projection.pendingHistoryItems,
      };
    }
    const items = source.permissionQueue?.getSnapshot();
    if (items !== this.permissionItems) {
      this.permissionItems = items;
      this.approvals = (items ?? []).map((prompt) => ({
        id: prompt.toolUseId,
        callId: prompt.toolUseId,
        name: prompt.toolName,
        input: prompt.input,
        description: prompt.reason.message,
        details: prompt.confirmationDetails,
        permissionPrompt: {
          toolUseId: prompt.toolUseId,
          toolName: prompt.toolName,
          input: prompt.input,
          reason: prompt.reason,
          suggestions: prompt.suggestions,
          agentId: prompt.agentId,
          skippable: prompt.skippable,
          persistable: prompt.persistable,
        },
        prompt: { reason: prompt.reason.message, skippable: prompt.skippable },
      }));
    }
    return {
      activity: {
        status: projection.streamingState,
        isModelTurnActive: projection.isModelTurnActive,
        isResponding: source.runtime.getIsResponding(),
        thought: projection.thought,
      },
      planMode: this.config.planStateManager?.isActive ?? false,
      model: this.config.getModel(),
      reasoningEffort: getPreferredReasoningEffort(this.config, source.model),
      contextWindow: getPreferredContextWindow(this.config, source.model),
      permissionMode: this.config.getPermissionMode(),
      title: this.config.topicState.getTopic() ?? null,
      modeChoices: computeAvailablePermissionModes(this.config).flatMap(
        (mode) => {
          if (mode === 'plan') return ['plan'];
          const value = mapSdkPermissionMode(mode);
          return value ? [value] : [];
        },
      ),
      initialMessages: {
        pendingAssistantText:
          projection.pendingHistoryItems.find(
            (item) => item.type === MessageType.GEMINI,
          )?.text ?? '',
        activityStatus:
          projection.streamingState === StreamingState.Idle
            ? 'idle'
            : 'running',
      },
      initialHistory:
        source.history as unknown as SessionState['initialHistory'],
      pendingHistory: this.pendingHistory
        .records as unknown as SessionState['pendingHistory'],
      displayPendingHistory:
        source.displayPendingHistory as SessionState['displayPendingHistory'],
      historyAvailable: source.history !== undefined,
      systemPrompt: source.systemPromptOverride ?? undefined,
      appendSystemPrompt: source.appendSystemPrompt ?? undefined,
      models: this.models,
      access: {
        status:
          this.released || this.ended || source.isClosed()
            ? 'disconnected'
            : 'connected',
        sessionId: this.config.getSessionId(),
        error: null,
      },
      approvals: this.approvals,
    };
  };
  readonly observe: SessionPort['observe'] = (listener) => {
    let initializing = true;
    const stop = this.messages.observe((change) => {
      if (initializing) listener(change);
      else {
        try {
          listener(change);
        } catch (error) {
          runLogger.warn('[local-session] message observer failed', error);
        }
      }
    });
    initializing = false;
    return stop;
  };
  readonly observeUpdates: SessionHandle['observeUpdates'] = (listener) => {
    this.updates.add(listener);
    try {
      listener({ type: 'snapshot', state: this.getState(), reason: 'observe' });
    } catch (error) {
      this.updates.delete(listener);
      throw error;
    }
    return () => {
      this.updates.delete(listener);
    };
  };
  readonly observeExecution: LocalSessionHandle['observeExecution'] = (
    listener,
  ) => {
    let initializing = true;
    const pending: SessionExecutionUpdate[] = [];
    const receive = (update: SessionExecutionUpdate) => {
      if (initializing) pending.push(update);
      else listener(update);
    };
    this.executionListeners.add(receive);
    try {
      listener({ type: 'snapshot', state: this.getExecutionState() });
      while (pending.length) listener(pending.shift()!);
      initializing = false;
    } catch (error) {
      this.executionListeners.delete(receive);
      throw error;
    }
    return () => {
      this.executionListeners.delete(receive);
      pending.length = 0;
    };
  };

  private publish(update: SessionUpdate): void {
    for (const listener of this.updates) {
      try {
        listener(update);
      } catch (error) {
        runLogger.warn('[local-session] state observer failed', error);
      }
    }
  }
  private publishExecution(update: SessionExecutionUpdate): void {
    const sessionId = this.config.getSessionId();
    if (!this.artifacts) {
      this.deliverExecution(update);
      return;
    }
    const recipients = [...this.executionListeners];
    const artifacts = this.artifacts;
    const artifactsReady = this.artifactTail;
    this.executionTail = this.executionTail
      .then(() => artifactsReady)
      .then(() => {
        if (
          sessionId === this.config.getSessionId() &&
          artifacts === this.artifacts
        )
          this.deliverExecution(update, recipients);
      })
      .catch((error: unknown) =>
        runLogger.debug('[session] Execution observation failed', error),
      );
  }
  private deliverExecution(
    update: SessionExecutionUpdate,
    recipients: Iterable<(update: SessionExecutionUpdate) => void> = this
      .executionListeners,
  ): void {
    this.executionQueue.push(update);
    if (this.notifyingExecution) return;
    this.notifyingExecution = true;
    try {
      while (this.executionQueue.length) {
        const next = this.executionQueue.shift()!;
        for (const listener of recipients) {
          try {
            if (this.executionListeners.has(listener)) listener(next);
          } catch (error) {
            runLogger.warn('[local-session] execution observer failed', error);
          }
        }
      }
    } finally {
      this.notifyingExecution = false;
    }
  }

  /** Called after the TUI commits its latest state, not while React renders. */
  sync(titleChange?: { title: string; origin?: AiTitleOrigin }): void {
    if (this.released || this.ended) return;
    const source = this.source();
    this.resetArtifactsIfSessionChanged();
    if (source.permissionQueue !== this.permissionQueue) {
      this.stopPermissionObservation?.();
      this.permissionQueue = source.permissionQueue;
      this.stopPermissionObservation = source.permissionQueue?.subscribe(() =>
        this.sync(),
      );
    }
    const state = this.getState();
    const previous = this.lastState;
    this.lastState = state;
    const restored =
      previous !== undefined &&
      previous.access.sessionId !== state.access.sessionId;
    if (!previous || restored) this.messages.restore(state.initialMessages);
    else if (
      previous.initialMessages.activityStatus !==
      state.initialMessages.activityStatus
    )
      this.messages.applyEvent({
        type: 'status',
        activityStatus: state.initialMessages.activityStatus,
        transition: true,
      });
    const metadataChanged =
      !previous ||
      restored ||
      (
        ['status', 'isModelTurnActive', 'isResponding', 'thought'] as const
      ).some((key) => previous.activity?.[key] !== state.activity?.[key]) ||
      (
        [
          'model',
          'planMode',
          'reasoningEffort',
          'contextWindow',
          'permissionMode',
          'title',
          'approvals',
          'models',
          'systemPrompt',
          'appendSystemPrompt',
        ] as const
      ).some((key) => previous[key] !== state[key]) ||
      previous.modeChoices.join() !== state.modeChoices.join();
    if (metadataChanged)
      this.publish({
        type: 'snapshot',
        state,
        reason: restored ? 'restore' : 'observe',
      });
    for (const approval of previous?.approvals ?? []) {
      if (!state.approvals.some((next) => next.id === approval.id))
        this.publish({ type: 'approval_removed', id: approval.id });
    }
    if (
      previous?.initialHistory !== state.initialHistory &&
      state.initialHistory
    ) {
      const old = previous?.initialHistory;
      if (
        old &&
        old.length <= state.initialHistory.length &&
        old.every((item, index) => item === state.initialHistory![index])
      ) {
        for (const record of state.initialHistory.slice(old.length))
          this.publish({ type: 'history', kind: 'append', record });
      } else
        this.publish({
          type: 'history',
          kind: 'snapshot',
          records: state.initialHistory,
        });
    }
    if (previous?.pendingHistory !== state.pendingHistory) {
      this.publish({
        type: 'history',
        kind: 'pending',
        records: state.pendingHistory ?? [],
      });
    }
    if (
      titleChange &&
      (titleChange.origin !== undefined ||
        previous?.title !== titleChange.title)
    )
      this.publish({ type: 'title', ...titleChange });
    if (
      previous?.displayPendingHistory !== state.displayPendingHistory &&
      state.displayPendingHistory
    )
      this.publish({
        type: 'history',
        kind: 'display_pending',
        records: state.displayPendingHistory,
      });
    const execution = this.getExecutionState();
    if (
      !this.lastExecution ||
      this.lastExecution.canSubmitMessage !== execution.canSubmitMessage ||
      this.lastExecution.isResponding !== execution.isResponding ||
      this.lastExecution.pendingToolCalls !== execution.pendingToolCalls
    ) {
      this.lastExecution = execution;
      this.publishExecution({ type: 'snapshot', state: execution });
    }
  }

  handleLocalUserMessage(input: LocalUserMessage): void {
    if (this.released || this.ended || this.submittedInputIds.has(input.uuid))
      return;
    this.messages.applyEvent({
      type: 'input_prepared',
      source: LIVE,
      message: {
        id: input.uuid,
        text: input.text,
        content: input.contentBlocks?.map((block) => ({ ...block })) ?? [
          { type: 'text', text: input.text },
        ],
      },
    });
  }

  handleQueryEvent(event: QueryEvent): void {
    if (this.released || this.ended) return;
    this.resetArtifactsIfSessionChanged();
    if (this.artifacts) {
      const artifacts = this.artifacts;
      this.artifactTail = this.artifactTail
        .then(() => {
          if (
            artifacts === this.artifacts &&
            this.artifactSessionId === this.config.getSessionId()
          )
            return artifacts.observeEvent(event);
          return undefined;
        })
        .then(() => undefined)
        .catch((error: unknown) =>
          runLogger.debug('[session] Artifact observation failed', error),
        );
    }
    this.publishExecution({ type: 'query_event', event });
    if ('parent_tool_use_id' in event && event.parent_tool_use_id) return;
    if (
      event.type === 'stream_event' &&
      event.event.type === 'content_block_delta'
    ) {
      const delta = event.event.delta;
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
        this.messages.applyEvent({
          type: 'assistant_stream',
          delta: {
            type: delta.type,
            text: delta.type === 'text_delta' ? delta.text : delta.thinking,
          },
          source: LIVE,
        });
      }
    } else if (event.type === 'request_start') {
      this.messages.applyEvent({
        type: 'status',
        activityStatus: 'running',
        transition: true,
      });
    } else if (event.type === 'assistant') {
      this.messages.applyEvent({
        type: 'assistant_message',
        endsTurn: event.message.stop_reason === 'end_turn',
        source: LIVE,
      });
    } else if (event.type === 'user') {
      this.messages.applyEvent({
        type: 'user_message',
        content: extractDisplayableUserContent(event.message.content),
        synthetic: event.isMeta === true,
        source: LIVE,
      });
    }
  }
  handleTurnComplete(): void {
    if (this.released || this.ended) return;
    this.messages.applyEvent({
      type: 'status',
      activityStatus: 'idle',
      transition: true,
    });
    this.publishExecution({ type: 'turn_complete' });
  }

  readonly submitMessage: SessionPort['submitMessage'] = async (
    message,
    options,
  ) => {
    const source = this.source();
    const bindingRevision = this.bindingRevision;
    const sessionId = this.config.getSessionId();
    const isBridgeInput = options?.origin?.kind === 'bridge';
    if (isBridgeInput && !this.getExecutionState().canSubmitMessage)
      throw new Error('Local session is not ready for input');
    if (!message.content.length) return;
    const content = message.content.map((block) => {
      const parsed = parseSdkInputBlock({
        ...block,
        cache_control: block['cache_control'] ?? block['cacheControl'],
      });
      if (!parsed)
        throw new TypeError('Unsupported local session input content');
      return parsed;
    });
    const richContent = content.some((block) => block.type === 'image')
      ? content
      : undefined;
    this.submittedInputIds.add(message.id);
    this.messages.applyEvent({ type: 'input_prepared', message, source: LIVE });
    this.messages.applyEvent({ type: 'send_started', messageId: message.id });
    try {
      if (!isBridgeInput) {
        await source.runtime.submitUserInput(message.text, {
          hideFromDisplay: options?.hideFromDisplay,
          userMessage: { uuid: message.id, timestamp: options?.timestamp },
          contentBlocks: richContent,
          pastedContents: options?.pastedContents,
          commandMode: options?.commandMode,
          queuedCommands: options?.queuedCommands,
          suppressWorkflowKeyword: options?.suppressWorkflowKeyword,
        });
      } else {
        await source.runtime.submitQuery(message.text, {
          hideFromDisplay: options?.hideFromDisplay,
          emitInputEvent: false,
          userMessage: { uuid: message.id, timestamp: options?.timestamp },
          contentBlocks: richContent,
          useInputProcessor: true,
          queuedCommands: [
            {
              prompt: richContent ?? message.text,
              preExpansionPrompt: message.text,
              commandMode: 'prompt',
              uuid: message.id,
              origin: options.origin,
              bridgeOrigin: true,
              skipSlashCommands: true,
            },
          ],
        });
      }
    } catch (error) {
      this.messages.applyEvent({
        type: 'send_failed',
        messageId: message.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.submittedInputIds.delete(message.id);
      this.messages.applyEvent({
        type: 'send_finished',
        messageId: message.id,
      });
      if (
        !this.released &&
        !this.ended &&
        this.bindingRevision === bindingRevision &&
        this.config.getSessionId() === sessionId &&
        this.readSource()?.config === this.config
      ) {
        // Read the executor: a returned input can be rejected, queued or running.
        this.messages.applyEvent({
          type: 'status',
          activityStatus: this.getExecutionState().isResponding
            ? 'running'
            : 'idle',
          transition: true,
        });
      }
    }
  };
  readonly interrupt: SessionPort['interrupt'] = async (options) => {
    const source = this.source();
    if (
      !options &&
      source.projection.getStreamingState() ===
        StreamingState.WaitingForConfirmation
    ) {
      const prompt = source.permissionQueue?.getSnapshot()[0];
      if (prompt) {
        prompt.reject();
        return;
      }
    }
    source.runtime.cancelOngoingRequest();
  };
  readonly start = async () => {
    const source = this.source(true);
    if (this.ended || source.isClosed())
      throw new Error('Local session has ended');
    if (!this.released) {
      this.sync();
      return;
    }
    this.released = false;
    this.lastState = undefined;
    this.lastExecution = undefined;
    this.sync();
  };
  readonly release = async () => {
    this.automaticTitle = true;
    if (this.released) return;
    this.released = true;
    this.bindingRevision++;
    this.stopPermissionObservation?.();
    this.stopPermissionObservation = undefined;
    this.permissionQueue = undefined;
    this.publish({
      type: 'access',
      state: {
        status: 'disconnected',
        sessionId: this.config.getSessionId(),
        error: null,
      },
    });
    this.messages.applyEvent({ type: 'connection_closed' });
  };
  readonly resume = async () => {
    await this.start();
    return this.getState().access;
  };
  readonly end = () => {
    this.endTask ??= (async () => {
      const source = this.source();
      this.ended = true;
      try {
        await source.runtime.dispose();
      } finally {
        await this.release();
      }
    })();
    return this.endTask;
  };
  readonly restore = async (input: unknown) => {
    const source = this.source();
    if (
      !input ||
      typeof input !== 'object' ||
      !('sessionId' in input) ||
      typeof input.sessionId !== 'string' ||
      !('messages' in input) ||
      !Array.isArray(input.messages)
    )
      throw new TypeError('Invalid local session restore data');
    if (
      !source.restoreSession ||
      !(await source.restoreSession(input as SessionResumeData))
    )
      throw new Error('Local session restore failed');
  };
  readonly getMessages = () => this.source(true).runtime.getMessages();
  readonly getConversationMessages = () =>
    this.source(true).runtime.getConversationMessages();
  readonly setMessages: SessionHandle['setMessages'] = (update) => {
    this.source().runtime.setMessages(update);
  };
  readonly replaceMessages = (
    messages: Parameters<SessionHandle['replaceMessages']>[0],
  ) => this.source().runtime.replaceMessages([...messages]);
  readonly setModel: SessionHandle['setModel'] = async (
    model,
    effort,
    contextWindow,
    options,
  ) => {
    this.source();
    if (!options && !model) return;
    const revision = ++this.modelRevision;
    const bindingRevision = this.bindingRevision;
    const identity = this.config.getModelRequestIdentity();
    const sessionId = this.config.getSessionId();
    const saved = options
      ? await this.config.setModel(model, options.sessionOnly)
      : await applyExplicitModelChange(this.config, model, {
          trigger: 'remote',
          isTemporary: true,
          persisted: false,
        });
    if (!options || effort !== undefined || contextWindow !== undefined) {
      if (
        this.released ||
        this.ended ||
        this.modelRevision !== revision ||
        this.bindingRevision !== bindingRevision ||
        this.readSource()?.config !== this.config ||
        this.config.getModel() !== model ||
        this.config.getModelRequestIdentity() !== identity ||
        this.config.getSessionId() !== sessionId
      ) {
        if (options) return false;
        throw new Error('会话目标已变化，模型更新已取消。');
      }
      await setModelPreference(
        this.config,
        {
          ...(effort !== undefined ? { reasoning: { effort } } : {}),
          ...(contextWindow !== undefined
            ? { context: { contextWindow } }
            : {}),
        },
        { model, persist: options?.sessionOnly === false },
      );
    }
    return options ? saved : undefined;
  };
  readonly setContextWindow: SessionHandle['setContextWindow'] = async (
    contextWindow,
  ) => {
    this.source();
    this.modelRevision++;
    await setModelPreference(this.config, { context: { contextWindow } });
  };
  readonly applySettings: SessionHandle['applySettings'] = async (
    settings,
    options,
  ) => {
    const source = this.source();
    const ownerRevision = this.bindingRevision;
    const ownerId = this.config.getSessionId();
    const ownerIdentity = this.config.getModelRequestIdentity();
    const assertOwner = () => {
      options?.signal?.throwIfAborted();
      this.source();
      if (
        ownerRevision !== this.bindingRevision ||
        ownerId !== this.config.getSessionId() ||
        ownerIdentity !== this.config.getModelRequestIdentity()
      )
        throw new Error('Local session changed while applying settings');
    };
    const allowed = new Set([
      'automaticTitleEnabled',
      'systemPrompt',
      'appendSystemPrompt',
      'reasoningEffort',
      'ultracode',
      'plan',
      'model',
      'contextWindow',
      'permissionMode',
    ]);
    const unsupported = Object.keys(settings).filter(
      (key) => !allowed.has(key),
    );
    if (unsupported.length)
      throw new TypeError(
        `Unsupported session settings: ${unsupported.join(', ')}`,
      );
    options?.signal?.throwIfAborted();
    for (const key of ['systemPrompt', 'appendSystemPrompt'] as const)
      if (key in settings && typeof settings[key] !== 'string')
        throw new TypeError(`${key} must be a string`);
    const automaticTitleEnabled = settings['automaticTitleEnabled'];
    if (
      'automaticTitleEnabled' in settings &&
      typeof automaticTitleEnabled !== 'boolean'
    )
      throw new TypeError('automaticTitleEnabled must be a boolean');
    const plan = settings['plan'];
    if ('plan' in settings && typeof plan !== 'boolean')
      throw new TypeError('plan must be a boolean');
    if (
      'ultracode' in settings &&
      settings['ultracode'] !== true &&
      settings['ultracode'] !== false &&
      settings['ultracode'] !== null
    )
      throw new TypeError('ultracode must be true, false, or null');
    if ('systemPrompt' in settings) {
      if (!source.setSystemPrompt)
        throw new Error('System prompt updates are unavailable');
      source.setSystemPrompt(settings['systemPrompt'] as string);
    }
    if ('appendSystemPrompt' in settings) {
      if (!source.setAppendSystemPrompt)
        throw new Error('Appended system prompt updates are unavailable');
      source.setAppendSystemPrompt(settings['appendSystemPrompt'] as string);
    }
    if ('model' in settings) {
      const requestedModel = settings['model'];
      if (typeof requestedModel !== 'string')
        throw new TypeError('model must be a string');
      await this.setModel(requestedModel, undefined, undefined, {
        sessionOnly: true,
      });
      assertOwner();
    }
    const requestedContextWindow = settings['contextWindow'];
    if (
      'contextWindow' in settings &&
      requestedContextWindow !== null &&
      (typeof requestedContextWindow !== 'number' ||
        !Number.isFinite(requestedContextWindow) ||
        requestedContextWindow <= 0)
    )
      throw new TypeError('Invalid context window');
    assertOwner();
    const revision = ++this.settingsRevision;
    const model = this.config.getModel();
    const identity = this.config.getModelRequestIdentity();
    const sessionId = this.config.getSessionId();
    const bindingRevision = this.bindingRevision;
    const assertCurrent = () => {
      options?.signal?.throwIfAborted();
      if (
        this.released ||
        this.ended ||
        this.readSource()?.config !== this.config ||
        bindingRevision !== this.bindingRevision ||
        revision !== this.settingsRevision ||
        model !== this.config.getModel() ||
        identity !== this.config.getModelRequestIdentity() ||
        sessionId !== this.config.getSessionId()
      )
        throw new Error('Local session changed while applying settings');
    };
    const listed =
      'ultracode' in settings
        ? await this.config.getModelProviderManager().getModel(model)
        : undefined;
    assertCurrent();
    if ('reasoningEffort' in settings || 'contextWindow' in settings) {
      const effort = settings['reasoningEffort'];
      if (
        'reasoningEffort' in settings &&
        effort !== null &&
        parseReasoningEffortLevel(effort) === undefined
      )
        throw new TypeError('Invalid reasoning effort');
      await setModelPreference(this.config, {
        ...('reasoningEffort' in settings
          ? {
              reasoning: {
                effort:
                  effort === null
                    ? undefined
                    : (effort as import('@qwen-code/core').ReasoningEffortLevel),
              },
            }
          : {}),
        ...('contextWindow' in settings
          ? {
              context: {
                contextWindow:
                  settings['contextWindow'] === null
                    ? undefined
                    : (settings['contextWindow'] as number),
              },
            }
          : {}),
      });
      assertCurrent();
    }
    if ('permissionMode' in settings) {
      await this.setPermissionMode(
        settings['permissionMode'] as Parameters<
          SessionHandle['setPermissionMode']
        >[0],
        { trigger: 'remote' },
      );
      assertCurrent();
    }
    if ('ultracode' in settings) {
      const value = settings['ultracode'];
      const setEffort = () => {
        if (listed)
          this.config
            .getModelProviderManager()
            .setModelConfig(listed, { reasoning: { effort: 'xhigh' } });
      };
      if (value === true) {
        setEffort();
        this.config.setUltracode(true);
      } else if (value === false) this.config.setUltracode(false);
      else {
        this.config.clearUltracodeOverride();
        if (this.config.getUltracode()) setEffort();
      }
    }
    if (typeof automaticTitleEnabled === 'boolean')
      this.automaticTitle = automaticTitleEnabled;
    if ('plan' in settings)
      applyIndependentPlanMode(this.config, settings['plan'] as boolean);
    this.sync();
  };
  readonly setPermissionMode: SessionHandle['setPermissionMode'] = (
    ...args
  ) => {
    let source: LocalTuiSessionSource;
    try {
      source = this.source();
    } catch (error) {
      return Promise.reject(error);
    }
    // Native shortcut validation must throw before its fallback is chosen.
    this.config.setPermissionMode(...args);
    const pending = source.runtime.handlePermissionModeChange(args[0]);
    this.sync();
    return pending;
  };
  readonly setTitle: SessionHandle['setTitle'] = async (title) => {
    this.source();
    await this.config.persistSessionTitle(title);
    this.sync({ title });
  };
  readonly refreshModels: SessionHandle['refreshModels'] = async () => {
    const source = this.source();
    const bindingRevision = this.bindingRevision;
    const sessionId = this.config.getSessionId();
    const model = this.config.getModel();
    const identity = this.config.getModelRequestIdentity();
    const models = projectSessionListedModels(
      await source.config
        .getModelProviderManager()
        .listModels({ skipCache: true }),
    );
    if (
      this.released ||
      this.ended ||
      bindingRevision !== this.bindingRevision ||
      this.readSource()?.config !== this.config ||
      sessionId !== this.config.getSessionId() ||
      model !== this.config.getModel() ||
      identity !== this.config.getModelRequestIdentity()
    ) {
      throw new Error('Local session changed while refreshing models');
    }
    this.models = models;
    this.publish({ type: 'models', models });
    return models;
  };
  readonly respondToApproval: SessionHandle['respondToApproval'] = async (
    id,
    outcome,
    payload,
    options,
  ) => {
    const prompt = this.source().permissionQueue?.getById(id);
    if (!prompt) return;
    settleToolConfirmation(prompt, {
      outcome,
      payload,
      rejectSource: options?.abort ? 'programmatic' : undefined,
    });
  };
  readonly describeOperationError: SessionHandle['describeOperationError'] = (
    operation,
    message,
  ) =>
    `Failed to ${operation === 'submit' ? 'submit local input' : 'interrupt local session'}: ${message}`;
}
