/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话对话状态与 core `query()` 驱动器：持有消息历史、uuid 索引、turn 计数、
 * 用量与 attachment 上下文，把 `QueryEvent` 投影成 `SDKMessage`。
 * 手动压缩的帧序由 `turn/compactWireFrames.ts` 维护。
 */

import { randomUUID } from 'node:crypto';
import {
  applyPostCompact,
  bindCwdContext,
  bindSessionCreditsPersistence,
  buildModelProjectionOptions,
  buildStartupMemoryPrefix,
  clearSystemContext,
  cloneUsage,
  addAnthropicUsage,
  CompressionStatus,
  CONTENT_FILTERED_MESSAGE,
  ConversationRewindError,
  coreEvents,
  CoreEvent,
  createAttachmentContext,
  createCompactRequestResolver,
  modelConfigFromGeneration,
  createStartupMemoryContext,
  createTurnPromptResolver,
  enqueueHookOutput,
  ENV_EMIT_SESSION_STATE_EVENTS,
  executeConversationRewind,
  executeUserInput,
  extractUserVisiblePromptText,
  flushSessionUsage,
  isChainParticipant,
  isDurableQueryEvent,
  isReplayableUserMessage,
  isTaskTriggeringPrompt,
  planConversationRewind,
  planHistoricalConversationRewind,
  PROMPT_SECTION_ID,
  projectMessageOriginForSdk,
  query,
  createQueryEventBus,
  QueryLifecycleRunner,
  DEFAULT_LIFECYCLE_OBSERVER_TIMEOUT_MS,
  recordSessionUsage,
  restoreAttachmentTranscriptState,
  restoreInvokedSkillsFromTranscript,
  runWithCwdContext,
  seedStartupStaticMemoryFileReadState,
  sessionIdContext,
  SessionStateStore,
  stripThoughtSignaturesFromMessages,
  TranscriptRepository,
  capturePromptSuggestionForkSource,
  canGeneratePromptSuggestionFork,
  tryGeneratePromptSuggestion,
  getPromptSuggestionFeatureConfig,
  isPromptSuggestionPolicyCurrent,
  subscribePromptSuggestionFeatureGate,
  createQueryBusinessInfo,
  businessInfoContext,
  deriveOrigin,
  type BusinessInfo,
  parseReasoningEffortLevel,
  getCwd,
  runLogger,
  getClientMetadata,
  getVersion,
  HostActionStore,
  type AgentDefinitionLike,
  type AttachmentExternalContext,
  type AttachmentMessage,
  type AttachmentToolUseContext,
  type CacheSafeQuerySnapshot,
  type ChatCompressionInfo,
  type CommandMode,
  type CompressionPipeline,
  type Config,
  type ModelInputContentBlock,
  type ModelStreamUserContent,
  type ConversationRewindPlan,
  type CwdContext,
  type FileHistorySnapshot,
  type HookCoordinatorAdapter,
  type HookEventName,
  type Message,
  type MessageOrigin,
  type ModelPromptPatches,
  type ModelStreamTool,
  type PendingHookOutput,
  type ProcessInputResult,
  type PromptBuildResult,
  type PromptSurface,
  type QueryBusinessContext,
  type QueryEvent,
  type QueryLifecycleContext,
  type QueryLifecycleObserver,
  type NonNullableUsage,
  type SDKMessage,
  type SDKResultMessage,
  type SdkMemoryPromptState,
  type SelectedSkillInput,
  type SessionRuntimeRefreshOptions,
  type SystemPromptAssembler,
  type TaskTrigger,
  type Terminal,
  type ToolRegistryFactory,
  type TranscriptMessage,
  type TranscriptWriterHandle,
} from '@qwen-code/core';
import {
  getPreferredGeneration,
  getPreferredReasoningEffort,
} from '../../../utils/modelPreference.js';
import {
  accumulateDurableEvent,
  buildMaxTurnsErrorInfo,
  buildResultError,
  buildResultSuccess,
  buildSessionStateChanged,
  createResultAccumulator,
  drainPendingTaskSystemEvents,
  isChildScopedMessage,
  isTransientSystemMessage,
  noteRequestStart,
  projectQueryEvent,
  projectQueuedTaskNotification,
  terminalResultErrorMessage,
  terminalResultReason,
  type QueryProjectionContext,
  type ResultAccumulator,
} from './queryProjection.js';

// ---------------------------------------------------------------------------
// 配置与提交选项
// ---------------------------------------------------------------------------

/** slash 命令派发口。形状与 core 的 `QueryEngineSlashCommandHandler` 结构相同。 */
export type SessionSlashCommandHandler = (
  input: string,
  precedingInputBlocks: readonly ModelInputContentBlock[],
  imageContentBlocks: readonly ModelInputContentBlock[],
  attachmentMessages: AttachmentMessage[],
  context: {
    promptId: string;
    signal: AbortSignal;
    userMessageUuid: string;
  },
) => Promise<ProcessInputResult | false>;

/** 远端来源输入的安全门禁。 */
export type SessionBridgeSlashCommandHandler = (
  input: string,
) =>
  | Promise<{ allow: true } | { allow: false; message: string } | null>
  | { allow: true }
  | { allow: false; message: string }
  | null;

/** 回卷的就绪门禁：由调用方持有轮次修订号，回卷前断言会话空闲。 */
export interface SessionRewindGuard {
  getRevision(): number;
  assertReady(): void;
}

/** 一次提交的可选覆盖。 */
export interface SessionSubmitOptions {
  /** 本次提交覆盖默认模型。 */
  model?: string;
  /** fork 会话的运行时来源 session；只是调用级元数据，不落盘。 */
  sourceSessionId?: string;
  /** 透传给本次每个推理请求的不透明上下文。 */
  customContext?: Record<string, string>;
  /** 本次 prompt 的持久 user 消息元数据。 */
  userMessage?: {
    uuid?: string;
    timestamp?: string;
    requestSetId?: string;
  };
  /** 开启这一轮的 user 消息的来源标记。 */
  origin?: MessageOrigin;
  /** 每轮请求标识，贯穿 hook、工具、统计与模型追踪。 */
  promptId?: string;
  /** 外部中止信号，与会话内部控制器合并。 */
  signal?: AbortSignal;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  reasoningEffort?: ReturnType<typeof parseReasoningEffortLevel>;
  contextWindow?: number;
  /** result 之后尝试补发一条 prompt_suggestion。 */
  promptSuggestions?: boolean;
  /** false 表示只把处理后的 user 消息写进 transcript，不发起模型请求。 */
  shouldQuery?: boolean;
  /** 用户随本轮输入选中的 Skill，处理时作为直接用户意图激活。 */
  selectedSkills?: readonly SelectedSkillInput[];
  /** 内部请求来源，用于模型路由与诊断。 */
  querySource?: string;
  /** 投影/过滤之前的裸 `QueryEvent` 抽头。artifact 快照靠它观察。 */
  onRawQueryEvent?: (event: QueryEvent) => void;
  /** 标记来自 bridge（远端）的输入，用于安全门禁。 */
  bridgeOrigin?: boolean;
  /** 把开头的斜杠当字面模型输入。 */
  skipSlashCommands?: boolean;
  commandMode?: CommandMode;
  /** true 时产出的 UserMessage 对模型可见但对 TUI 隐藏。 */
  isMeta?: boolean;
  /** 本轮以 stopHookActive=true 开始（异步唤醒轮）。 */
  stopHookActive?: boolean;
/**
 * 宿主盖在 user 消息上的不透明元数据（含提交时间戳），原样透传给 query()。
 * 合成消息不携带；本层不做时钟域换算。
 */
  extra?: Record<string, unknown>;
  /**
   * 宿主附加的 请求头，只随本轮首个主模型请求（含重试）下发；
   * 合成消息不带，工具续跑与 subagent 也不继承。
   */
  extraHeaders?: Record<string, string>;
}

export interface SessionQueryRunnerConfig {
  /** 会话标识。 */
  sessionId: string;
  /** 拥有这个会话的产品面。 */
  promptSurface: Exclude<PromptSurface, 'local_tui'>;
  promptAssembler?: SystemPromptAssembler;
  /** `--system-prompt`：设置时覆盖 assembler 的默认产出。 */
  customSystemPrompt?: string;
  /** `--append-system-prompt`：追加在有效系统提示词之后。 */
  appendSystemPrompt?: string;
  /** 会话 agent 定义；设置时它的 getSystemPrompt() 取代 assembler 默认。 */
  mainThreadAgentDefinition?: AgentDefinitionLike;
  defaultModel: string;
  /**
   * 每次 `submitMessage` 的工具循环轮数上限。一次 turn = 一次模型请求 + 工具执行。
   * undefined 表示不设上限。
   */
  maxTurns?: number;
  transcriptWriter?: TranscriptWriterHandle;
  /**
   * 会话级 state store 工厂；缺省用本地加密 store，持久化策略由工厂落实。
   * 注入点让测试与参照实现使用同一个临时 store。
   */
  sessionStateStoreFactory?: (
    sessionId: string,
    options: { persist: boolean },
  ) => SessionStateStore;
  /** 盖在运行时 user 消息上的权限模式，用于 transcript 对齐。 */
  permissionMode?: string;
  compressionPipeline?: CompressionPipeline;
  config: Config;
  onSlashCommand?: SessionSlashCommandHandler;
  onBridgeSlashCommand?: SessionBridgeSlashCommandHandler;
  hookCoordinator: HookCoordinatorAdapter;
  /**
   * 工具 schema registry 工厂：由会话提供，绑定根 agent 的工具表。
   */
  toolRegistryFactory: ToolRegistryFactory;
  /** 要不要把流式增量投成 SDKPartialAssistantMessage。默认关。 */
  includePartialMessages?: boolean;
  /** 每轮构造 attachment 外部上下文的工厂。 */
  buildAttachmentExternalContext?: () => AttachmentExternalContext;
  /** 会话执行目录，同时记进 transcript 条目。默认 `Config.getWorkingDir()`。 */
  cwd?: string;
  /** 写进 TranscriptMessage 的应用版本。 */
  appVersion?: string;
  /** 在 query 边界（start / end / error）被通知的观察者。 */
  lifecycleObservers?: QueryLifecycleObserver[];
  /**
   * 内核捕获的原始错误（诊断用，不进 wire）。宿主可用于按输出格式补充诊断输出；
   * 缺省不上报。中止（Abort）不触发。
   */
  onQueryError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function countCompletedTurns(messages: readonly Message[]): number {
  return messages.filter(
    (message) =>
      message.type === 'user' && typeof message.message.content === 'string',
  ).length;
}

function findLastChainParticipantUuid(
  messages: readonly Message[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isChainParticipant(message)) return message.uuid;
  }
  return null;
}

/**
 * `fireQueryEndEvent` 的兜底：保证每个轮次恰好触发一次 QueryEnd，
 * 异常路径也带上正确的终止原因。
 */
function createQueryEndFallback(
  config: Config,
  requestSetId: string,
  initialModel: string,
) {
  let handled = false;
  let model = initialModel;
  let businessId: string | undefined;
  return {
    setModel(value: string): void {
      model = value;
    },
    setBusinessId(value: string | undefined): void {
      businessId = value;
    },
    claim(): void {
      handled = true;
    },
    async fire(reason: Terminal['reason']): Promise<void> {
      if (handled) return;
      handled = true;
      await config
        .getHookSystem?.()
        ?.fireQueryEndEvent(requestSetId, businessId, model, reason);
    },
  };
}

/**
 * 包一层 hook 协调器，只为把 `fireBefore` 的第三个参数按需省略。
 *
 * `fireBefore(promptId, prompt)` 与 `fireBefore(promptId, prompt, undefined)` 在下游
 * 不等价——协调器用 `arguments.length` 区分「没有图片」和「图片是 undefined」。
 */
function createSubmitHookCoordinator(
  hookCoordinator: HookCoordinatorAdapter,
): HookCoordinatorAdapter {
  return {
    fireBefore(promptId, prompt, imageUrls) {
      return imageUrls
        ? hookCoordinator.fireBefore(promptId, prompt, imageUrls)
        : hookCoordinator.fireBefore(promptId, prompt);
    },
    fireAfter(promptId, prompt, response, options) {
      return hookCoordinator.fireAfter(promptId, prompt, response, options);
    },
    drainPendingAsyncContext() {
      return hookCoordinator.drainPendingAsyncContext();
    },
    fireStopFailure(error, options, signal) {
      return hookCoordinator.fireStopFailure(error, options, signal);
    },
    dispose() {
      hookCoordinator.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// SessionQueryRunner
// ---------------------------------------------------------------------------

export class SessionQueryRunner {
  private readonly cwdContext: CwdContext;

  /**
   * 会话历史。**这个数组引用直接交给 `query()`**：agent loop 读它、本类往里追加，
   * 两边看的是同一份，所以 `query()` 能看到本轮刚追加的消息。
   */
  private messages: Message[];
  /** `messages` 的 uuid 索引，用来 O(1) 判断某条消息是否已经记过。 */
  private readonly messageUuids = new Set<string>();
  private sessionId: string;
  private turnCount = 0;
  private cumulativeUsage: NonNullableUsage;

  /** 在途提交的控制器。 */
  private activeAbortController: AbortController | undefined;
/** 本轮 prompt suggestion 的取消信号；新命令入队时取消，避免阻塞用户插话。 */
  private promptSuggestionController: AbortController | undefined;
  private readonly compressionAbortControllers = new Set<AbortController>();

  /** 最近一次渲染出的系统提示词，fork 子 agent 要拿它当父上下文。 */
  private lastPromptBuildResult: PromptBuildResult | undefined;
  /** 本轮的 schema registry，fork 的 useExactTools 要拿它的 schema。 */
  private lastToolRegistry: ReturnType<ToolRegistryFactory['create']> | undefined;
  private lastCacheSafeSnapshot: CacheSafeQuerySnapshot | null = null;
  private suggestionRuntimeRevision = 0;
  private suggestionPrefixRevision = 0;

  /**
   * 运行时系统提示词覆盖。
   * undefined = 不覆盖（用 assembler / customSystemPrompt）；'' = 显式替换成空正文
   * （强制前缀仍然生效）。
   */
  private systemPromptOverride: string | undefined;
  private runtimeAppendSystemPrompt: string | undefined;
  private sdkMemoryPromptState: SdkMemoryPromptState = Object.freeze({
    owner: 'native',
  });
  private sdkMemoryShapeKey = 0;
  /** SDK 提供的服务端提示词路由配置，作用于主请求。 */
  private modelRequestPatches: ModelPromptPatches | undefined;
  private lastTranscriptParentUuid: string | null = null;
  /** Bumped when the active branch changes so CodeMode reloads persisted state. */
  private conversationRevision = 0;
  private sessionStateStore: SessionStateStore;
  private sessionCreditsReady: Promise<void>;
  private disposeSessionCreditsPersistence: (() => Promise<void>) | undefined;

  /**
   * attachment 管线上下文。**跨轮长存**——readFileState LRU、已发过的 skill 名、delta
   * 哈希这些去重状态必须在提交之间保留，每轮重建会导致重复注入。
   */
  private attachmentCtx: AttachmentToolUseContext;

  private includePartialMessages: boolean;
  private readonly emitSessionStateEvents: boolean;

  private readonly runnerConfig: SessionQueryRunnerConfig;
  private readonly lifecycleRunner: QueryLifecycleRunner;
  private readonly repeatedToolCallAllowedKeys = new Set<string>();
  /** One event bus and query state store for every query of this session. */
  private readonly queryEvents = createQueryEventBus();
  private unsubSkillChange: (() => void) | null = null;
  private unsubPlanStateChange: (() => void) | null = null;
  /**
   * 进程级共享的 host_action 完成关联存储；首次 staging 时惰性创建。
   * daemon 内 stage 的关联供 SDK 拉起的一次性 CLI 进程读取。
   */
  private hostActionStore?: HostActionStore;

  constructor(config: SessionQueryRunnerConfig) {
    this.runnerConfig = config;
    const cwd = config.cwd ?? config.config.getWorkingDir();
    this.cwdContext = {
      cwd,
      originalCwd: cwd,
      onCwdChanged: (oldCwd, newCwd) =>
        config.config.getHookSystem?.()?.onCwdChanged(oldCwd, newCwd),
    };
    config.config.getHookSystem?.()?.updateFileWatcherCwd(cwd);
    this.lifecycleRunner = new QueryLifecycleRunner(
      config.lifecycleObservers ?? [],
      { timeoutMs: DEFAULT_LIFECYCLE_OBSERVER_TIMEOUT_MS, logger: runLogger },
    );
    this.sessionId = config.sessionId;
    this.messages = [];
    this.cumulativeUsage = cloneUsage();
    this.includePartialMessages = config.includePartialMessages ?? false;
    this.emitSessionStateEvents =
      process.env[ENV_EMIT_SESSION_STATE_EVENTS] === 'true';
    this.attachmentCtx = this.rebuildAttachmentContext(
      this.sessionId,
      this.messages,
    );
    this.sessionStateStore = this.openSessionStateStore(this.sessionId);
    this.sessionCreditsReady = this.bindSessionCreditsStore();

    // skill 文件变化时清掉「已发过的 skill 名」，下一轮的 attachment delta 才会重发清单。
    this.unsubSkillChange = config.config.onSkillChange(
      () => {
        this.attachmentCtx.sentSkillNames.clear();
      },
      { replay: false },
    );

    // fork 子 agent 通过这两个注册口够到父会话的历史、渲染好的系统提示词与工具 schema。
    config.config.registerForkContextAccessors({
      getConversationMessages: () => this.messages,
      getPromptBuildResult: () => this.lastPromptBuildResult,
      getParentToolSchemas: () => this.lastToolRegistry?.getSchema() ?? [],
      getCacheSafeQuerySnapshot: () => this.lastCacheSafeSnapshot,
    });
    config.config.registerSessionRuntimeBinding({
      refreshRuntimeContext: (options) => this.refreshRuntimeContext(options),
      getTranscriptPath: () =>
        this.runnerConfig.transcriptWriter?.getSessionFilePath(),
      synchronizeWorktreeRuntimeState: (state) => {
        // resume 与工具切换也可能发生在会话的 ALS 上下文之外，这里同步一次 cwd。
        this.cwdContext.cwd = this.runnerConfig.config.getWorkingDir();
        this.cwdContext.originalCwd = this.cwdContext.cwd;
        this.runnerConfig.transcriptWriter?.synchronizeWorktreeRuntimeState(
          state,
        );
      },
      recordWorktreeState: async (...args) => {
        if (!this.runnerConfig.transcriptWriter) {
          throw new Error(
            'Worktree state requires an active transcript writer.',
          );
        }
        await this.runnerConfig.transcriptWriter.recordWorktreeState(...args);
      },
      stripThoughtsFromConversationHistory: () => {
        this.invalidateCacheSafeSnapshot();
        this.messages = stripThoughtSignaturesFromMessages(this.messages);
        this.rebuildMessageUuids();
      },
      activeConversation: {
        revision: () => this.conversationRevision,
        readChain: () => this.readActiveChain(),
      },
      persistSessionTitle: async (title: string) => {
        this.runnerConfig.config.topicState?.setTopic?.(title, undefined);
        await this.runnerConfig.transcriptWriter?.recordCustomTitle(title);
      },
    });

    // plan 状态订阅（会话级事件，按本会话 sessionId 过滤）；实现与重订阅理由见
    // subscribePlanStateChange()。
    this.subscribePlanStateChange();

    runLogger.log('[session-runner] created', {
      sessionId: this.sessionId,
      model: config.defaultModel,
      includePartialMessages: this.includePartialMessages,
    });
  }

/**
 * 订阅 PlanStateChanged，驱动轮间 plan attachment。
 * coreEvents 是进程级总线，归属过滤必须用 onSessionEvent；退订放在 dispose，
 * resume 换 sessionId 后要重订阅。
 */
  private subscribePlanStateChange(): void {
    this.unsubPlanStateChange?.();
    const onPlanStateChanged = ({ active }: { active: boolean }) => {
      if (active) {
        this.attachmentCtx.planModeJustEntered = true;
        this.syncPlanFilePath();
      } else {
        this.attachmentCtx.planModeJustExited = true;
      }
    };
    this.unsubPlanStateChange = coreEvents.onSessionEvent(
      CoreEvent.PlanStateChanged,
      this.sessionId,
      onPlanStateChanged,
    );
  }

  // ===========================================================================
  // 提交
  // ===========================================================================

  /** 提交一条用户 prompt 并驱动整个 agent loop，产出 `SDKMessage` 流。 */
  async *submitMessage(
    prompt: ModelStreamUserContent,
    options?: SessionSubmitOptions,
  ): AsyncGenerator<SDKMessage> {
    const userMessageSubmittedAtMs = performance.now();
    const userMessageUuid = options?.userMessage?.uuid ?? randomUUID();
    const promptId = options?.promptId ?? randomUUID();
    const requestSetId = options?.userMessage?.requestSetId ?? randomUUID();
    const tracedOptions: SessionSubmitOptions = {
      ...options,
      promptId,
      userMessage: {
        ...options?.userMessage,
        uuid: userMessageUuid,
        requestSetId,
      },
    };
    const stream = this.submitMessageImpl(
      prompt,
      tracedOptions,
      requestSetId,
      userMessageSubmittedAtMs,
    );

// 每个终态 result 出门前 stage host_action 完成关联；进程级共享 store 供
// 一次性 CLI fallback 读取。best-effort，不影响 result 帧。
    for await (const message of bindCwdContext(this.cwdContext, stream)) {
      if (message.type === 'result') {
        await this.stageHostActionCorrelation(message, requestSetId);
      }
      yield message;
    }
  }

/**
 * 把一个终态 result 的完成关联写进进程级共享 HostActionStore。
 *
 * daemon 对每个会话无条件宣告 host_action，而 SDK 的 fallback 进程按
 * (session_id, parent_result_uuid) 从共享 store 读关联，所以每个 result 都要 stage。
 * 失败只记日志，不影响 result 帧。
 */
  private async stageHostActionCorrelation(
    result: SDKResultMessage,
    requestSetId: string,
  ): Promise<void> {
    // 关联键是 (session_id, result_uuid)；任一缺失就无法被一次性 CLI 命中，直接跳过。
    if (!result.uuid || !result.session_id) return;
    try {
      this.hostActionStore ??= new HostActionStore();
      const identity = getClientMetadata();
      const staged = await this.hostActionStore.stageCompletedResult({
        resultUuid: result.uuid,
        sessionId: result.session_id,
        requestSetId,
        originClientType: identity.client_type,
        originProduct: identity.business_product,
        originCliVersion: await getVersion(),
      });
      await this.hostActionStore.commitCompletedResult(staged);
    } catch (error) {
      runLogger.warn(
        '[session-runner] unable to stage host action correlation',
        error,
      );
    }
  }

  private async *submitMessageImpl(
    prompt: ModelStreamUserContent,
    options: SessionSubmitOptions,
    requestSetId: string,
    userMessageSubmittedAtMs: number,
  ): AsyncGenerator<SDKMessage> {
    await this.sessionCreditsReady;
    const selectedModelKey =
      options.model ??
      this.runnerConfig.config.getModel?.() ??
      this.runnerConfig.defaultModel;
    this.runnerConfig.config
      .getMcpClientManager?.()
      ?.settleMcpDeferral(
        this.runnerConfig.config.getEffectiveContextWindow?.(
          undefined,
          selectedModelKey,
        ),
      );
    const userMessageUuid = options.userMessage?.uuid ?? randomUUID();
    options = {
      ...options,
      userMessage: { ...options.userMessage, uuid: userMessageUuid },
    };
    const promptId = options.promptId ?? randomUUID();
    const firstModelRequestId = randomUUID();
    const promptText = extractUserVisiblePromptText(prompt);
    const agentQuerySource = options.querySource ?? 'sdk';
    const businessInfo = await createQueryBusinessInfo(
      this.sessionId,
      promptText,
      requestSetId,
      agentQuerySource,
      options.model ??
        this.runnerConfig.config.getModel?.() ??
        this.runnerConfig.defaultModel,
      this.runnerConfig.config.getBusinessType(),
    );
    const queryEnd = createQueryEndFallback(
      this.runnerConfig.config,
      requestSetId,
      options.model ??
        this.runnerConfig.config.getModel?.() ??
        this.runnerConfig.defaultModel,
    );

    // 把根会话 id 绑进异步上下文，子 agent 的模型调用不必逐层透传就能共享它。
    // 安全：每次 async generator 调用都有自己的 AsyncResource。
    sessionIdContext.enterWith(this.sessionId);
    const cancellation = this.beginCancellationScope({
      externalSignal: options.signal,
    });
    const { signal, suggestionSignal } = cancellation;
    const resultOrigin = projectMessageOriginForSdk(deriveOrigin(options));

    runLogger.log('[session-runner] submit start', {
      sessionId: this.sessionId,
      promptId,
      messages: this.messages.length,
    });

    try {
      yield* drainPendingTaskSystemEvents(this.sessionId);
      const queuedTaskNotification =
        resultOrigin?.kind === 'task-notification'
          ? projectQueuedTaskNotification(promptText, this.sessionId)
          : null;
      if (queuedTaskNotification) yield queuedTaskNotification;

      const fileHistory = this.runnerConfig.config.getFileHistoryManager();
      if (fileHistory) {
        fileHistory.setSessionId(this.sessionId);
        await fileHistory.makeSnapshot(userMessageUuid);
      }

      const toolRegistry = this.runnerConfig.toolRegistryFactory.create(
        promptId,
        userMessageUuid,
      );
      this.lastToolRegistry = toolRegistry;

      const rawExternalContext =
        this.runnerConfig.buildAttachmentExternalContext?.();
      const externalContext: AttachmentExternalContext | undefined =
        rawExternalContext ? { ...rawExternalContext } : undefined;
      this.syncPlanFilePath();

      const processed = await businessInfoContext.run(businessInfo, () =>
        executeUserInput(
          [
            {
              prompt,
              preExpansionPrompt: promptText,
              commandMode: options.commandMode ?? 'prompt',
              uuid: userMessageUuid,
              bridgeOrigin: options.bridgeOrigin,
              skipSlashCommands:
                options.skipSlashCommands === true ||
                options.bridgeOrigin === true
                  ? true
                  : undefined,
              isMeta: options.isMeta,
              origin: options.origin,
              // 选中 Skill 只能在批次首命令上（core executor 的位置校验）；
              // daemon 每次 submitMessage 只合成这一条命令，天然满足。
              selectedSkills: options.selectedSkills,
            },
          ],
          {
            attachmentCtx: this.attachmentCtx,
            config: this.runnerConfig.config,
            hookCoordinator: this.runnerConfig.hookCoordinator,
            sessionId: this.sessionId,
            cwd: getCwd(),
            isInitialTurn: this.turnCount === 0,
            messages: this.messages,
            externalContext,
            signal,
            promptId,
            taskId: requestSetId,
            querySource: agentQuerySource,
            onQuery: async () => {},
            onSlashCommand: this.runnerConfig.onSlashCommand
              ? (
                  input,
                  precedingInputBlocks,
                  imageContentBlocks,
                  attachmentMessages,
                ) =>
                  this.runnerConfig.onSlashCommand!(
                    input,
                    precedingInputBlocks,
                    imageContentBlocks,
                    attachmentMessages,
                    { promptId, signal, userMessageUuid },
                  )
              : undefined,
            onBridgeSlashCommand: this.runnerConfig.onBridgeSlashCommand,
          },
        ),
      );

      const shouldRunAgentQuery =
        processed.shouldQuery && options.shouldQuery !== false;
      const taskTrigger: TaskTrigger = isTaskTriggeringPrompt(
        processed.messages,
        userMessageUuid,
      )
        ? 'user_prompt'
        : 'continuation';
      const processedMessagesToProject = [...processed.messages];
      const processedEffort = parseReasoningEffortLevel(processed.effort);
      const processedResultText = processed.resultText;
      const processedResultIsError = processed.resultIsError;
      const processedTerminalReason = processed.terminalReason;
      const processedErrorCode = processed.errorCode;

      const appendStart = this.messages.length;
      const appendedUuids: string[] = [];
      for (const msg of processed.messages) {
        if (
          msg.type === 'user' &&
          !msg.isMeta &&
          (msg.requestSetId === requestSetId || msg.uuid === userMessageUuid)
        ) {
          msg.businessModelKey = businessInfo.model_key;
          msg.businessIdentity = {
            product: businessInfo.product,
            type: businessInfo.type,
            id: businessInfo.id,
            model_key: businessInfo.model_key,
          };
        }
        const existed = this.messageUuids.has(msg.uuid);
        this.appendMessage(msg);
        if (!existed) appendedUuids.push(msg.uuid);
      }
      const transcriptMessages = processed.messages.filter(isChainParticipant);
      if (transcriptMessages.length > 0) {
        // 用户消息写在驱动 query 之前：immediate 立即落盘，消掉首 token 前的
        // 100ms 批量定时器等待；助手/工具消息仍走批量写（避免写放大）。
        try {
          await this.recordTranscriptMessages(transcriptMessages, {
            immediate: true,
          });
        } catch (error) {
          // 落盘失败时本轮消息不能留在上下文：否则 transcript 里没有这一轮，
          // 下一轮却会把它当历史重放（含已声明的工具调用），造成副作用重复。
          this.messages.length = appendStart;
          for (const uuid of appendedUuids) this.messageUuids.delete(uuid);
          throw error;
        }
      }

      if (this.emitSessionStateEvents) {
        yield buildSessionStateChanged('running', this.sessionId);
      }
      for (const msg of processedMessagesToProject) {
        // 后台续跑的输入是 meta 消息，但宿主需要它的 origin 来识别新一轮。
        // 只放行当前提交的通知，其他内部上下文仍按普通回放规则过滤。
        const isSubmittedTaskNotification =
          resultOrigin?.kind === 'task-notification' &&
          msg.type === 'user' &&
          msg.origin?.kind === 'task-notification' &&
          msg.uuid === userMessageUuid;
        if (
          msg.type === 'user' &&
          !isSubmittedTaskNotification &&
          !isReplayableUserMessage(msg)
        ) {
          continue;
        }
        options.onRawQueryEvent?.(msg as QueryEvent);
        yield* projectQueryEvent(
          msg as QueryEvent,
          this.projectionContext(),
          () => {},
        );
      }

      let cumulativeResponseText = '';
      const resetCumulativeResponseText = () => {
        cumulativeResponseText = '';
      };
      const resultAcc = createResultAccumulator();

      let terminal: Terminal;
      if (shouldRunAgentQuery) {
        const effectiveModel =
          options.model ??
          processed.model ??
          this.runnerConfig.config.getModel?.() ??
          this.runnerConfig.defaultModel;
        const effectiveReasoningEffort =
          options.reasoningEffort ?? processedEffort;
        queryEnd.setModel(effectiveModel);

        await this.lifecycleRunner.notifyQueryStart(
          this.buildLifecycleContext(promptId, requestSetId, effectiveModel),
        );

        // hook、压缩与路由都在 query() 内部由传入的协作方处理，这里只驱动与投影。
        terminal = yield* this.driveQuery({
          businessInfo,
          prompt: promptText,
          promptId,
          preallocatedRequestSetId: requestSetId,
          userMessageSubmittedAtMs:
            taskTrigger === 'user_prompt' ? userMessageSubmittedAtMs : undefined,
          model: options.model ?? processed.model,
          reasoningEffort: effectiveReasoningEffort,
          allowedTools: processed.allowedTools,
          commandInvocationId: processed.commandInvocationId,
          toolRegistry,
          signal,
          options,
          resultAcc,
          onResponseText: (text) => {
            cumulativeResponseText += text;
          },
          onResponseTextReset: resetCumulativeResponseText,
          onToolResult: resetCumulativeResponseText,
          userMessage: options.userMessage,
          onCompressionCompleted: async (priorHistory, newHistory) =>
            this.applyPostCompact(priorHistory, newHistory),
          skipInitialUserMessage: true,
          skipBeforeHook: true,
          querySource: agentQuerySource,
          taskTrigger,
          initialModelRequestId: firstModelRequestId,
          onBusinessContextReady: (context) => {
            queryEnd.setBusinessId(context.businessId);
          },
          onAgentLoopSettled: queryEnd.claim,
        });

        await this.lifecycleRunner.notifyQueryEnd(
          terminal,
          this.buildLifecycleContext(promptId, requestSetId, effectiveModel),
        );
      } else {
        const blockingMessage = processedMessagesToProject.find(
          (message): message is Extract<Message, { type: 'system' }> =>
            message.type === 'system' &&
            message.subtype === 'error' &&
            message.content.includes('blocked by hook'),
        );
        const hookStopReason = processed.hookStop?.stopReason;
        terminal = {
          reason: blockingMessage ? 'error' : 'end_turn',
          ...(blockingMessage && { error: new Error(blockingMessage.content) }),
          ...(processed.hookStop
            ? {
                terminalDetail: 'hook_stopped' as const,
                ...(hookStopReason ? { hookStopReason } : {}),
              }
            : {}),
          numTurns: 0,
          usage: cloneUsage(),
          durationMs: 0,
        };
        queryEnd.claim();
      }

      if (terminal) {
        resultAcc.lastStopReason =
          terminal.modelStopReason ?? resultAcc.lastStopReason;
        this.cumulativeUsage = addAnthropicUsage(
          this.cumulativeUsage,
          terminal.usage,
        );
        this.turnCount += terminal.numTurns;
      }

      yield* drainPendingTaskSystemEvents(this.sessionId);
      await this.flushSessionUsageState();
      const terminalErrorMessage = terminalResultErrorMessage(terminal);
      if (terminal.reason === 'error') {
        yield buildResultError(
          'error_during_execution',
          {
            errors: [
              terminal.error?.message ??
                (terminal.modelStopReason === 'refusal'
                  ? CONTENT_FILTERED_MESSAGE
                  : 'Unknown error'),
            ],
            error: terminal.error,
            durationMs: terminal.durationMs,
            numTurns: terminal.numTurns,
            usage: terminal.usage,
            resultAcc,
            origin: resultOrigin,
          },
          this.sessionId,
        );
      } else if (terminal.reason === 'max_turns') {
        yield buildResultError(
          'error_max_turns',
          {
            ...buildMaxTurnsErrorInfo(
              terminal.numTurns,
              this.runnerConfig.maxTurns,
            ),
            durationMs: terminal.durationMs,
            numTurns: terminal.numTurns,
            usage: terminal.usage,
            resultAcc,
            origin: resultOrigin,
          },
          this.sessionId,
        );
      } else if (terminalErrorMessage) {
        yield buildResultError(
          'error_during_execution',
          {
            errors: [terminalErrorMessage],
            durationMs: terminal.durationMs,
            numTurns: terminal.numTurns,
            usage: terminal.usage,
            resultAcc,
            origin: resultOrigin,
            terminalReason: terminalResultReason(terminal),
          },
          this.sessionId,
        );
      } else if (!shouldRunAgentQuery && processedResultIsError) {
        yield buildResultError(
          'error_during_execution',
          {
            errors: [processedResultText ?? 'Unknown error'],
            durationMs: terminal.durationMs,
            numTurns: terminal.numTurns,
            usage: terminal.usage,
            resultAcc,
            origin: resultOrigin,
            terminalReason: processedTerminalReason,
            errorCode: processedErrorCode,
          },
          this.sessionId,
        );
      } else {
        const responseText = shouldRunAgentQuery
          ? cumulativeResponseText
          : (processedResultText ?? cumulativeResponseText);
        const revision = this.conversationRevision;
        const prefixRevision = this.suggestionPrefixRevision;
        const history = this.messages;
        const length = history.length;
        const tail = history.at(-1);
        const forkSource =
          shouldRunAgentQuery &&
          options.promptSuggestions &&
          canGeneratePromptSuggestionFork(terminal)
            ? capturePromptSuggestionForkSource(
                this.runnerConfig.config,
                promptId,
                requestSetId,
                () =>
                  revision === this.conversationRevision &&
                  prefixRevision === this.suggestionRuntimeRevision &&
                  this.messages === history &&
                  history.length === length &&
                  history.at(-1) === tail &&
                  !signal.aborted &&
                  !suggestionSignal.aborted,
                options.customContext,
              )
            : undefined;
        yield buildResultSuccess(
          responseText,
          terminal,
          resultAcc,
          this.sessionId,
          false,
          resultOrigin,
        );
        if (shouldRunAgentQuery && options.promptSuggestions) {
          const feature = getPromptSuggestionFeatureConfig();
          const controller = new AbortController();
          const unsubscribe = subscribePromptSuggestionFeatureGate((config) => {
            if (!isPromptSuggestionPolicyCurrent(feature, config))
              controller.abort();
          });
          const deliverySignal = AbortSignal.any([
            signal,
            suggestionSignal,
            controller.signal,
          ]);
          try {
            const suggestion = feature.enabled
              ? await tryGeneratePromptSuggestion({
                  businessInfo,
                  forkSource,
                  config: this.runnerConfig.config,
                  messages: this.messages,
                  sessionId: this.sessionId,
                  promptId,
                  signal: deliverySignal,
                })
              : null;
            const currentConfig = getPromptSuggestionFeatureConfig();
            if (
              suggestion &&
              !deliverySignal.aborted &&
              isPromptSuggestionPolicyCurrent(feature, currentConfig) &&
              (!feature.forkEnabled || forkSource?.isCurrent())
            ) {
              yield suggestion;
            }
          } finally {
            unsubscribe?.();
            // result 帧刻意在可选建议之前就快照了用量；之后产生的计量要在本次运行
            // 结束前补一次 flush。
            await this.flushSessionUsageState();
          }
        }
      }

      if (this.emitSessionStateEvents) {
        yield buildSessionStateChanged('idle', this.sessionId);
      }

      runLogger.log('[session-runner] submit done', {
        sessionId: this.sessionId,
        reason: terminal.reason,
        turns: terminal.numTurns,
        durationMs: terminal.durationMs,
        messages: this.messages.length,
      });
    } catch (err: unknown) {
      const aborted =
        signal.aborted || (err instanceof Error && err.name === 'AbortError');
      await queryEnd.fire(aborted ? 'abort' : 'error');
      const message = err instanceof Error ? err.message : String(err);
      runLogger.error('[session-runner] query failed', err);
      if (!aborted) this.runnerConfig.onQueryError?.(err);

      await this.lifecycleRunner.notifyQueryError(
        err,
        this.buildLifecycleContext(promptId, requestSetId, options.model),
      );

      await this.flushSessionUsageState();
      yield buildResultError(
        'error_during_execution',
        aborted
          ? {
              errors: ['Operation aborted'],
              durationMs: 0,
              numTurns: 0,
              origin: resultOrigin,
              terminalReason: 'aborted_streaming',
            }
          : {
              errors: [message],
              error: err,
              durationMs: 0,
              numTurns: 0,
              origin: resultOrigin,
            },
        this.sessionId,
      );

      if (this.emitSessionStateEvents) {
        yield buildSessionStateChanged('idle', this.sessionId);
      }
    } finally {
      await queryEnd.fire('abort');
      cancellation.end();
    }
  }

  // ===========================================================================
  // agent loop 驱动
  // ===========================================================================

  /** 驱动 core `query()` 并把 `QueryEvent` 投成 `SDKMessage`，返回本轮终态。 */
  private async *driveQuery(params: {
    businessInfo: Readonly<BusinessInfo>;
    prompt: ModelStreamUserContent;
    promptId: string;
    preallocatedRequestSetId: string;
    userMessageSubmittedAtMs?: number;
    model?: string;
    reasoningEffort?: SessionSubmitOptions['reasoningEffort'];
    allowedTools?: string[];
    commandInvocationId?: string;
    toolRegistry: ReturnType<ToolRegistryFactory['create']>;
    signal: AbortSignal;
    options: SessionSubmitOptions | undefined;
    resultAcc: ResultAccumulator;
    onResponseText: (text: string) => void;
    onResponseTextReset: () => void;
    onToolResult: () => void;
    userMessage?: SessionSubmitOptions['userMessage'];
    onCompressionCompleted?: (
      priorHistory: readonly Message[],
      newHistory: readonly Message[],
    ) => Promise<readonly Message[]>;
    skipInitialUserMessage?: boolean;
    /** 跳过 BeforeAgent hook，**不**跳过 PreToolUse。见 agent-loop.ts。 */
    skipBeforeHook?: boolean;
    querySource?: string;
    taskTrigger?: TaskTrigger;
    initialModelRequestId?: string;
    onBusinessContextReady?: (context: QueryBusinessContext) => void;
    onAgentLoopSettled?: () => void;
  }): AsyncGenerator<SDKMessage, Terminal> {
    const {
      prompt,
      promptId,
      preallocatedRequestSetId,
      userMessageSubmittedAtMs,
      model,
      reasoningEffort,
      allowedTools,
      commandInvocationId,
      toolRegistry,
      signal,
      options,
      resultAcc,
      onResponseText,
      onResponseTextReset,
      onToolResult,
      userMessage,
      onCompressionCompleted,
      skipInitialUserMessage,
      skipBeforeHook,
      querySource,
      taskTrigger,
      initialModelRequestId,
      onBusinessContextReady,
      onAgentLoopSettled,
    } = params;

    const resolveSystemPrompt = await this.createSystemPromptResolver();
    const startupMemoryContext = createStartupMemoryContext(
      this.runnerConfig.config,
    );

    this.invalidateCacheSafeSnapshot();
    // Select reads session defaults; only per-request overrides are forwarded.
    const generator = query({
      querySelection:
        model !== undefined ||
        reasoningEffort !== undefined ||
        options?.thinkingBudget !== undefined ||
        options?.maxOutputTokens !== undefined ||
        options?.contextWindow !== undefined
          ? {
              key: model,
              config: {
                reasoning: {
                  effort: reasoningEffort,
                  ...(options?.thinkingBudget !== undefined
                    ? {
                        thinking:
                          options.thinkingBudget > 0
                            ? {
                                type: 'enabled',
                                budgetTokens: options.thinkingBudget,
                              }
                            : { type: 'disabled' },
                      }
                    : {}),
                },
                context: {
                  maxOutputTokens: options?.maxOutputTokens,
                  contextWindow: options?.contextWindow,
                },
              },
            }
          : undefined,
      businessInfo: params.businessInfo,
      turnHookFactories: this.runnerConfig.config.turnHookFactories,
      prompt,
      sessionId: this.sessionId,
      signal,
      eventBus: this.queryEvents,
      resolveSystemPrompt,
      modelRequestPatches: this.modelRequestPatches,
      sourceSessionId: options?.sourceSessionId,
      customContext: options?.customContext,
      extraHeaders: options?.extraHeaders,
      messages: this.messages,
      promptId,
      preallocatedRequestSetId,
      userMessageSubmittedAtMs,
      onBusinessContextReady: (context) => {
        onBusinessContextReady?.(context);
        this.lifecycleRunner.notifyBusinessContextReady(context);
      },
      userMessage,
      skipInitialUserMessage,
      skipBeforeHook,
      toolRegistry,
      toolExecutor: this.runnerConfig.config.getToolExecutor(),
      maxTurns: this.runnerConfig.maxTurns,
      allowedTools,
      commandInvocationId,
      repeatedToolCallAllowedKeys: this.repeatedToolCallAllowedKeys,
      attachmentCtx: this.attachmentCtx,
      isAttachmentCommitted: (message) => this.messageUuids.has(message.uuid),
      permissionMode: this.runnerConfig.permissionMode,
      hookCoordinator: createSubmitHookCoordinator(
        this.runnerConfig.hookCoordinator,
      ),
      compressionPipeline: this.runnerConfig.compressionPipeline,
      onCompressionCompleted,
      config: this.runnerConfig.config,
      sessionStateStore: this.sessionStateStore,
      querySource,
      taskTrigger,
      startupMemoryContext,
      initialModelRequestId,
      stopHookActive: options?.stopHookActive,
      extra: options?.extra,
      onCacheSafeSnapshot: (snapshot) => {
        if (!snapshot.lastAssistantUsage) {
          this.suggestionPrefixRevision = this.suggestionRuntimeRevision;
        }
        this.lastCacheSafeSnapshot = snapshot;
      },
    });

    const projection = this.projectionContext();
    /**
     * 开了流式增量之后，每个 block 已经单独发过一条 SDKAssistantMessage；同一条消息的
     * 完整帧要压掉，否则宿主会看到重复内容。按 message.id → 已发出的 block index 记账。
     */
    const partialAssistantBlockIndexes = new Map<string, Set<number>>();

    const nextAgentLoopEvent = async () => {
      try {
        return await generator.next();
      } catch (error) {
        onAgentLoopSettled?.();
        throw error;
      }
    };

    let result: IteratorResult<QueryEvent, Terminal> | undefined;
    let projectionError: unknown;
    let hasProjectionError = false;
    try {
      result = await nextAgentLoopEvent();
      while (!result.done) {
        const queryEvent: QueryEvent = result.value;
        options?.onRawQueryEvent?.(queryEvent);

        if (queryEvent.type === 'request_start') {
          noteRequestStart(resultAcc);
        } else if (queryEvent.type === 'result_text_reset') {
          onResponseTextReset();
        } else if (isDurableQueryEvent(queryEvent)) {
          // uuid 已经记过（resume 回放、attachment 重放）：只投影，不重复计入历史与用量。
          if (
            queryEvent.uuid !== undefined &&
            this.messageUuids.has(queryEvent.uuid)
          ) {
            yield* projectQueryEvent(queryEvent, projection, onResponseText);
            result = await nextAgentLoopEvent();
            continue;
          }

          accumulateDurableEvent(resultAcc, queryEvent, onToolResult);

          if (
            !isTransientSystemMessage(queryEvent) &&
            !(
              (queryEvent.type === 'assistant' || queryEvent.type === 'user') &&
              isChildScopedMessage(queryEvent)
            )
          ) {
            this.appendMessage(queryEvent);
            if (queryEvent.type === 'assistant' && queryEvent.message.usage) {
              await this.recordAssistantUsage(queryEvent.message.usage);
            }
            await this.recordTranscriptMessages([queryEvent]);
          }
        }

        if (
          queryEvent.type === 'assistant_block' &&
          this.includePartialMessages &&
          queryEvent.message.messageId
        ) {
          const indexes =
            partialAssistantBlockIndexes.get(queryEvent.message.messageId) ??
            new Set<number>();
          indexes.add(queryEvent.index);
          partialAssistantBlockIndexes.set(
            queryEvent.message.messageId,
            indexes,
          );
        }
        // 中断的流只发出了部分块：带 partialStreamIndex 的 assistant 帧按块判重，
        // 否则同一消息里未完成的文本块会被已发出的块误判为重复。
        let supersededByPartialBlocks = false;
        if (
          queryEvent.type === 'assistant' &&
          this.includePartialMessages &&
          queryEvent.message.id
        ) {
          const streamedBlocks = partialAssistantBlockIndexes.get(
            queryEvent.message.id,
          );
          supersededByPartialBlocks =
            streamedBlocks !== undefined &&
            (queryEvent.partialStreamIndex === undefined ||
              streamedBlocks.has(queryEvent.partialStreamIndex));
        }
        if (!supersededByPartialBlocks) {
          yield* projectQueryEvent(queryEvent, projection, onResponseText);
        }

        result = await nextAgentLoopEvent();
      }

      const terminal = result.value;
      onAgentLoopSettled?.();
      return terminal;
    } catch (error) {
      hasProjectionError = true;
      projectionError = error;
      throw error;
    } finally {
      // 生成器必须显式收口：正常结束用 return()，投影抛错用 throw() 把错误送回
      // agent loop，让它有机会跑自己的 finally（工具清理、hook 结算）。
      if (!result?.done) {
        try {
          if (hasProjectionError) {
            await generator.throw(projectionError);
          } else {
            await generator.return(undefined as never);
          }
          onAgentLoopSettled?.();
        } catch (closeError) {
          if (hasProjectionError) {
            onAgentLoopSettled?.();
          } else {
            runLogger.debug('[session-runner] failed to close agent loop', {
              error: closeError,
            });
          }
        }
      }
    }
  }

  // ===========================================================================
  // 会话状态
  // ===========================================================================

  /**
   * resume：把物化 transcript 的历史灌回会话。
   *
   * 光有 transcript writer 不够——`acquireSessionWriter({filePath})` 只恢复去重 uuid
   * 集合、parent-uuid 游标与元数据，一条 Message 都不回给调用方。不灌历史，模型看不到
   * 任何已发生的轮次：磁盘上接得上，对话接不上。
   */
  async resume(
    savedMessages: Message[],
    sessionId: string,
    options?: {
      fileHistorySnapshots?: FileHistorySnapshot[];
      persistFileHistoryToTranscript?: boolean;
      copyFileHistoryBackups?: boolean;
      sourceSessionId?: string;
      strictFileHistoryRestore?: boolean;
    },
  ): Promise<void> {
    this.invalidateCacheSafeSnapshot();
    this.conversationRevision++;
    this.resetMcpDeferral();
    this.messages = [...savedMessages];
    this.rebuildMessageUuids();
    this.sessionId = sessionId;
    // 归属 id 换了就重建 PlanStateChanged 订阅：onSessionEvent 的过滤 id 在订阅时
    // 固定，沿用旧订阅会把新会话的 plan 事件全部漏掉（理由详见该方法注释）。
    this.subscribePlanStateChange();
    this.rebuildAttachmentContext(sessionId, savedMessages);
    // 与 QueryEngine.resume（query-engine.ts:1624）同形：把历史 invoked_skills 回填
    // SkillManager。缺了这一步，resume 后的会话在下次 compact 时不回填技能正文，
    // 技能演进复核与诊断也看不到已激活集合。只恢复数据，不执行 Skill / Hook。
    restoreInvokedSkillsFromTranscript(
      this.runnerConfig.config.getSkillManager(),
      savedMessages,
    );
    await this.disposeSessionCreditsPersistence?.();
    this.disposeSessionCreditsPersistence = undefined;
    this.sessionStateStore = this.openSessionStateStore(sessionId);
    this.sessionCreditsReady = this.bindSessionCreditsStore();
    await this.sessionCreditsReady;
    this.turnCount = countCompletedTurns(savedMessages);
    this.lastTranscriptParentUuid = findLastChainParticipantUuid(savedMessages);
    this.runnerConfig.config
      ?.getMemoryContextManager()
      ?.restoreJitPathsFromMessages(savedMessages);
    const fileHistory = this.runnerConfig.config.getFileHistoryManager();
    if (fileHistory) {
      fileHistory.setSessionId(sessionId);
      if (options?.fileHistorySnapshots) {
        await fileHistory.rehydrateFromResume({
          sourceSessionId: options.sourceSessionId ?? sessionId,
          snapshots: options.fileHistorySnapshots,
          persistToTranscript: options.persistFileHistoryToTranscript ?? false,
          copyBackupFiles: options.copyFileHistoryBackups ?? true,
          ...(options.strictFileHistoryRestore
            ? { strictBackupCopy: true }
            : {}),
        });
      } else {
        fileHistory.reset();
      }
    }
  }

  /**
   * 一次提交的中止武装：新的提交控制器、以及把外部触发的 abort 接进来的桥。
   * `end()` 负责把它们收掉，属于该次提交的 `finally`。
   */
  private beginCancellationScope(params: {
    externalSignal?: AbortSignal;
  }): {
    controller: AbortController;
    signal: AbortSignal;
    suggestionSignal: AbortSignal;
    end: () => void;
  } {
    const { externalSignal } = params;
    const controller = new AbortController();
    this.activeAbortController = controller;
    const suggestionController = new AbortController();
    this.promptSuggestionController = suggestionController;

    const signal = this.combineSignals(controller.signal, externalSignal);

    return {
      controller,
      signal,
      suggestionSignal: suggestionController.signal,
      end: () => {
        if (this.activeAbortController === controller) {
          this.activeAbortController = undefined;
        }
        if (this.promptSuggestionController === suggestionController) {
          this.promptSuggestionController = undefined;
        }
      },
    };
  }

  /** 用户已插话：立即中止本轮 prompt suggestion 的生成，别让新命令等它。 */
  cancelPromptSuggestion(): void {
    this.promptSuggestionController?.abort();
  }

  abort(): void {
    // 记录留在原处：`end()` 才负责收，而对已中止的控制器再 abort 是 no-op。
    this.activeAbortController?.abort();
    for (const controller of this.compressionAbortControllers) {
      controller.abort();
    }
    this.compressionAbortControllers.clear();
  }

  private combineSignals(
    internal: AbortSignal,
    external?: AbortSignal,
  ): AbortSignal {
    if (!external) return internal;
    const combined = new AbortController();
    const onAbort = () => combined.abort();
    if (internal.aborted || external.aborted) {
      combined.abort();
      return combined.signal;
    }
    internal.addEventListener('abort', onAbort, { once: true });
    external.addEventListener('abort', onAbort, { once: true });
    return combined.signal;
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  async getTitleSourceMessages(
    sourceUserMessageId: string,
  ): Promise<readonly Message[]> {
    if (this.messages.some((message) => message.uuid === sourceUserMessageId)) {
      return this.messages;
    }
    // 压缩会移走当前上下文里的原消息；从当前会话的历史分支找回，不能按最新 Turn 猜。
    const writer = this.runnerConfig.transcriptWriter;
    if (!writer) return this.messages;
    const historical = await this.resolveHistoricalSession(writer);
    return historical?.messages ?? this.messages;
  }

  hasPersistedMessageUuid(messageUuid: string): boolean {
    return (
      this.runnerConfig.transcriptWriter?.hasMessageUuid(messageUuid) ?? false
    );
  }

  getFileReadState() {
    return this.attachmentCtx.fileReadState;
  }

  /** 整体替换历史并重算派生状态。回卷提交与压缩后重建走这里。 */
  replaceMessages(messages: readonly Message[]): void {
    this.invalidateCacheSafeSnapshot();
    this.conversationRevision++;
    this.resetMcpDeferral();
    this.messages = [...messages];
    this.rebuildMessageUuids();
    this.rebuildAttachmentContext(this.sessionId, this.messages);
    this.turnCount = countCompletedTurns(this.messages);
    this.lastTranscriptParentUuid = findLastChainParticipantUuid(this.messages);
  }

  // ===========================================================================
  // 回卷
  // ===========================================================================

  async previewConversationRewind(
    targetUuid: string,
  ): Promise<ConversationRewindPlan> {
    const writer = this.runnerConfig.transcriptWriter;
    if (!writer) {
      throw new ConversationRewindError(
        'not-ready',
        'Conversation Rewind requires an active transcript writer.',
      );
    }
    return this.resolveConversationRewindPlan(targetUuid, writer);
  }

  async rewindConversation(
    targetUuid: string,
    guard?: SessionRewindGuard,
  ): Promise<ConversationRewindPlan> {
    const writer = this.runnerConfig.transcriptWriter;

    const beforeMessages = [...this.messages];
    const beforeTurnCount = this.turnCount;
    const beforeLeaf = this.lastTranscriptParentUuid;

    return executeConversationRewind({
      targetUuid,
      writer,
      ...(writer
        ? {
            resolvePlan: (_state, resolvedTargetUuid) =>
              this.resolveConversationRewindPlan(resolvedTargetUuid, writer),
          }
        : {}),
      adapter: {
        readState: () => ({
          sessionId: this.sessionId,
          messages: [...this.messages],
          leafUuid: this.lastTranscriptParentUuid,
          guardRevision: guard?.getRevision() ?? 0,
        }),
        assertReady: () => guard?.assertReady(),
        commit: (plan) => {
          this.replaceMessages(plan.retainedMessages);
          this.lastTranscriptParentUuid = plan.retainedLeafUuid;
        },
        restore: () => {
          this.conversationRevision++;
          this.messages = [...beforeMessages];
          this.rebuildMessageUuids();
          this.turnCount = beforeTurnCount;
          this.lastTranscriptParentUuid = beforeLeaf;
        },
      },
    });
  }

  private async readActiveChain(): Promise<readonly TranscriptMessage[]> {
    const writer = this.runnerConfig.transcriptWriter;
    const session =
      writer &&
      (await this.resolveHistoricalSession(
        writer,
        this.lastTranscriptParentUuid ?? undefined,
      ));
    return session?.chain ?? [];
  }

  /**
   * 有 transcript 就按**历史视图**规划回卷，没有就按内存里的历史规划。
   *
   * 两者的差别是分支：transcript 里可能有一条完整的旧链，而内存历史在 resume 之后只是
   * 其中一段。按历史视图规划才能选到正确的保留集。
   */
  private async resolveConversationRewindPlan(
    targetUuid: string,
    writer: NonNullable<SessionQueryRunnerConfig['transcriptWriter']>,
  ): Promise<ConversationRewindPlan> {
    const historical = await this.resolveHistoricalSession(writer);
    return historical
      ? planHistoricalConversationRewind(historical.chain, targetUuid)
      : planConversationRewind(this.messages, targetUuid);
  }

  /** Read the active branch across compact boundaries through the writer snapshot. */
  private async resolveHistoricalSession(
    writer: NonNullable<SessionQueryRunnerConfig['transcriptWriter']>,
    leafUuid?: string,
  ) {
    const getSessionFilePath = (writer as { getSessionFilePath?: () => string })
      .getSessionFilePath;
    const readTranscriptSnapshot = (
      writer as { readTranscriptSnapshot?: () => Promise<Buffer> }
    ).readTranscriptSnapshot;
    if (
      typeof getSessionFilePath !== 'function' ||
      typeof readTranscriptSnapshot !== 'function'
    ) {
      return undefined;
    }

    const transcriptBytes = await readTranscriptSnapshot.call(writer);
    return new TranscriptRepository().resolveBuffer(
      getSessionFilePath.call(writer),
      transcriptBytes,
      {
        sessionId: this.sessionId,
        view: 'historical',
        ...(leafUuid ? { leafUuid } : {}),
      },
    );
  }

  // ===========================================================================
  // 运行时刷新
  // ===========================================================================

  refreshRuntimeContext({
    refreshTools,
    refreshSystemPrompt,
    resetModelRouting,
    invalidateRequestSnapshot,
  }: SessionRuntimeRefreshOptions): void {
    if (refreshTools || refreshSystemPrompt) {
      this.runnerConfig.promptAssembler?.clearCache();
    }
    if (
      refreshTools ||
      refreshSystemPrompt ||
      resetModelRouting ||
      invalidateRequestSnapshot
    ) {
      this.invalidateCacheSafeSnapshot();
    }
  }

  queueHookOutput(
    hookEventName: HookEventName,
    output: string,
    toolName?: string,
    options?: {
      sourceType?: PendingHookOutput['sourceType'];
      hookName?: string;
      hookCommand?: string;
    },
  ): void {
    if (!output.trim()) return;
    // sourceType 决定产出哪种 attachment：'stdout' → hook_success，
    // 'additionalContext' → hook_output。调用方应当显式给。
    enqueueHookOutput(this.attachmentCtx, {
      hookEventName,
      output,
      ...(toolName && { toolName }),
      sourceType: options?.sourceType ?? 'additionalContext',
      ...(options?.hookName && { hookName: options.hookName }),
      ...(options?.hookCommand && { hookCommand: options.hookCommand }),
    });
  }

  updateSystemPromptSources(update: {
    /** `undefined` 保持当前来源；`null` 清掉。 */
    readonly overrideSystemPrompt?: string | null;
    /** `undefined` 保持当前来源；`null` 清掉。 */
    readonly appendSystemPrompt?: string | null;
  }): void {
    let changed = false;
    if (update.overrideSystemPrompt !== undefined) {
      const nextOverride = update.overrideSystemPrompt ?? undefined;
      changed ||= this.systemPromptOverride !== nextOverride;
      this.systemPromptOverride = nextOverride;
    }
    if (update.appendSystemPrompt !== undefined) {
      const nextAppend = update.appendSystemPrompt ?? undefined;
      changed ||= this.runtimeAppendSystemPrompt !== nextAppend;
      this.runtimeAppendSystemPrompt = nextAppend;
    }
    if (changed) this.invalidateCacheSafeSnapshot();
  }

  updateSdkMemoryPrompt(
    state:
      | { readonly owner: 'native' | 'none' }
      | { readonly owner: 'sdk'; readonly prompt: string }
      | {
          readonly owner: 'sdk';
          readonly promptsByBundle: Readonly<Record<'full' | 'lean', string>>;
        },
  ): void {
    this.invalidateCacheSafeSnapshot();
    this.sdkMemoryPromptState =
      state.owner === 'sdk'
        ? 'prompt' in state
          ? Object.freeze({
              owner: 'sdk',
              prompt: state.prompt,
              shapeKey: ++this.sdkMemoryShapeKey,
            })
          : Object.freeze({
              owner: 'sdk',
              promptsByBundle: Object.freeze({
                full: state.promptsByBundle.full,
                lean: state.promptsByBundle.lean,
              }),
              shapeKey: ++this.sdkMemoryShapeKey,
            })
        : Object.freeze({ owner: state.owner });
    this.runnerConfig.promptAssembler?.clearCache(PROMPT_SECTION_ID.memoryAuto);
  }

  setModelRequestPatches(patches: ModelPromptPatches | undefined): void {
    this.modelRequestPatches = patches;
  }

  /** SDK 在 initialize 里带这个开关时运行时改。 */
  setIncludePartialMessages(value: boolean): void {
    this.includePartialMessages = value;
    runLogger.log('[session-runner] includePartialMessages updated', {
      sessionId: this.sessionId,
      value,
    });
  }

  /**
   * 把 turn 外补投的子 Agent 事件按同一套 wire 投影交给宿主。
   *
   * 只投影，不累计 result、不写 transcript：这些事件属于后台任务，不属于当前
   * turn 的预算与持久化范围。
   */
  *projectSubagentEvent(event: QueryEvent): Generator<SDKMessage> {
    yield* projectQueryEvent(event, this.projectionContext(), () => {});
  }

  dispose(): void {
    clearSystemContext(this.sessionId);
    this.runnerConfig.promptAssembler?.clearCache();
    this.abort();
    this.unsubSkillChange?.();
    this.unsubSkillChange = null;
    this.unsubPlanStateChange?.();
    this.unsubPlanStateChange = null;
    this.runnerConfig.config.registerForkContextAccessors(undefined);
    this.runnerConfig.config.registerSessionRuntimeBinding(undefined);
    this.runnerConfig.hookCoordinator.dispose();
    this.runnerConfig.config.getHookSystem?.()?.dispose();
    void this.disposeSessionCreditsPersistence?.();
    this.disposeSessionCreditsPersistence = undefined;
  }

  // ===========================================================================
  // 内部
  // ===========================================================================

  private projectionContext(): QueryProjectionContext {
    return {
      sessionId: this.sessionId,
      includePartialMessages: this.includePartialMessages,
    };
  }

  private buildLifecycleContext(
    promptId: string,
    requestSetId: string,
    model?: string,
  ): QueryLifecycleContext {
    return {
      sessionId: this.sessionId,
      promptId,
      requestSetId,
      model: model ?? this.runnerConfig.defaultModel,
      workspacePath: this.runnerConfig.config.getTargetDir(),
      isInteractive: false,
    };
  }

  /**
   * 解析当前会话的 plan 文件路径写进 attachmentCtx。
   *
   * 两处调用：人轮边界（submitMessage）覆盖常规情况；PlanStateChanged 监听覆盖
   * `enter_plan_mode` 造成的轮中途进入，让紧随其后的轮间注入就带上正确路径。
   */
  private syncPlanFilePath(): void {
    const externalCtx = this.runnerConfig.buildAttachmentExternalContext?.();
    if (
      externalCtx?.plansDir &&
      externalCtx.sessionId &&
      this.runnerConfig.config.planStateManager
    ) {
      this.attachmentCtx.currentPlanFilePath =
        this.runnerConfig.config.planStateManager.getPlanFilePath(
          externalCtx.plansDir,
          externalCtx.sessionId,
        );
    }
  }

  private async createSystemPromptResolver(): Promise<
    (effectiveModel: string) => Promise<PromptBuildResult>
  > {
    return createTurnPromptResolver({
      agentLoopContext: this.runnerConfig.config,
      sessionId: this.sessionId,
      cwd: this.runnerConfig.config.getWorkingDir(),
      promptSurface: this.runnerConfig.promptSurface,
      assembler: this.runnerConfig.promptAssembler,
      overrideSystemPrompt: this.systemPromptOverride,
      customSystemPrompt: this.runnerConfig.customSystemPrompt,
      appendSystemPrompt: this.runtimeAppendSystemPrompt,
      cliAppendSystemPrompt: this.runnerConfig.appendSystemPrompt,
      mainThreadAgentDefinition: this.runnerConfig.mainThreadAgentDefinition,
      sdkMemoryState: this.sdkMemoryPromptState,
      onResult: (result) => {
        this.lastPromptBuildResult = result;
      },
    });
  }

  /**
   * 换掉 attachment 上下文并重新播种它的 delta 状态。
   *
   * 会话身份或历史被整体替换时（构造、resume、回卷）都要调，生成器才会对着模型真正
   * 会看到的那份历史做 diff。
   */
  private rebuildAttachmentContext(
    sessionId: string,
    messages: readonly Message[],
  ): AttachmentToolUseContext {
    const ctx = createAttachmentContext(
      // 用会话 cwd（cwdContext 在构造与 worktree 切换时维护），不能回落 daemon 进程
      // 目录：@ 文件解析与历史附件的相对路径基线都会落到错误根。
      this.cwdContext.cwd,
      sessionId,
      // 把 config 与权限模块穿进 attachment 上下文，生成器才能读会话状态与实时权限模式。
      { config: this.runnerConfig.config },
    );
    restoreAttachmentTranscriptState(ctx, messages);
    seedStartupStaticMemoryFileReadState(
      ctx,
      this.runnerConfig.config.getMemoryContextManager?.(),
    );
    this.attachmentCtx = ctx;
    return ctx;
  }

  private appendMessage(message: Message): void {
    this.messages.push(message);
    this.messageUuids.add(message.uuid);
  }

  private trackMessageUuids(messages: Iterable<Message>): void {
    for (const message of messages) this.messageUuids.add(message.uuid);
  }

  private rebuildMessageUuids(): void {
    this.messageUuids.clear();
    this.trackMessageUuids(this.messages);
  }

  private async recordTranscriptMessages(
    messages: readonly Message[],
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    if (!this.runnerConfig.transcriptWriter || messages.length === 0) return;
    this.lastTranscriptParentUuid =
      await this.runnerConfig.transcriptWriter.recordMessages(
        messages,
        this.lastTranscriptParentUuid,
        options,
      );
  }

  private async recordAssistantUsage(usage: NonNullableUsage): Promise<void> {
    try {
      await recordSessionUsage(this.sessionStateStore, usage);
      await this.flushSessionUsageState();
    } catch (error) {
      runLogger.warn('[session-runner] failed to persist session usage', {
        error,
      });
    }
  }

  private async flushSessionUsageState(): Promise<void> {
    try {
      await flushSessionUsage(this.sessionStateStore);
    } catch (error) {
      runLogger.warn('[session-runner] failed to flush session usage', {
        error,
      });
    }
  }

  private openSessionStateStore(sessionId: string): SessionStateStore {
    const persist = this.runnerConfig.config.getSessionPersistence();
    if (this.runnerConfig.sessionStateStoreFactory) {
      return this.runnerConfig.sessionStateStoreFactory(sessionId, { persist });
    }
    return new SessionStateStore({
      projectRoot: this.runnerConfig.config.getSessionArtifactProjectRoot(),
      sessionId,
      persist,
    });
  }

  private async bindSessionCreditsStore(): Promise<void> {
    try {
      this.disposeSessionCreditsPersistence =
        await bindSessionCreditsPersistence(
          this.sessionId,
          this.sessionStateStore,
        );
    } catch (error) {
      runLogger.warn('[session-runner] failed to restore session credits', {
        error,
      });
    }
  }

  private invalidateCacheSafeSnapshot(): void {
    this.suggestionRuntimeRevision++;
    this.lastCacheSafeSnapshot = null;
  }

/**
 * 手动压缩：跑压缩管线、恢复 attachment 并更新运行时状态，返回带 `newHistory`
 * 的结果供 wire 投影。缓存关键字段整组复用最近一次安全快照，压缩可随会话中止。
 */
  async compressNow(options?: {
    force?: boolean;
    model?: string;
    customInstructions?: string;
    /** 本次手动压缩请求要透传的不透明 SDK 上下文。 */
    customContext?: Readonly<Record<string, string>>;
  }): Promise<{
    newHistory: readonly Message[] | null;
    info: ChatCompressionInfo;
  }> {
    return runWithCwdContext(this.cwdContext, () =>
      this.compressNowImpl(options),
    );
  }

  private async compressNowImpl(
    options: Parameters<SessionQueryRunner['compressNow']>[0],
  ): ReturnType<SessionQueryRunner['compressNow']> {
    const pipeline = this.runnerConfig.compressionPipeline;
    if (!pipeline) {
      return {
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    const promptId = `compress-${randomUUID()}`;
    const priorHistory: readonly Message[] = [...this.messages];
    const snapshot = this.lastCacheSafeSnapshot;
    const currentConfiguredModel =
      this.runnerConfig.config.getModel?.() ??
      this.runnerConfig.defaultModel ??
      'unknown';
    // 缓存关键请求字段以一个整体复用；显式换模型时在下面整组重建，绝不新旧混用。
    const reusableSnapshot =
      snapshot !== null &&
      (options?.model === undefined || options.model === snapshot.model)
        ? snapshot
        : null;
    const compactModel =
      options?.model ?? reusableSnapshot?.model ?? currentConfiguredModel;
    let requestPrefixMessages = reusableSnapshot?.requestPrefixMessages ?? [];
    let compactSystemPrompt = reusableSnapshot?.systemPrompt;
    let compactTools: readonly ModelStreamTool[] | undefined =
      reusableSnapshot?.toolSchemas;
    let compactReasoningEffort = reusableSnapshot?.reasoningEffort;
    let compactGeneration = reusableSnapshot?.generation;
    let compactContextWindow = reusableSnapshot?.contextWindow;

    if (!reusableSnapshot) {
      requestPrefixMessages = buildStartupMemoryPrefix(
        createStartupMemoryContext(this.runnerConfig.config),
      );
      const resolveSystemPrompt = await this.createSystemPromptResolver();
      compactSystemPrompt = (await resolveSystemPrompt(compactModel)).blocks;
      const compactSchemaRegistry = this.runnerConfig.toolRegistryFactory.create(
        promptId,
        promptId,
      );
      compactTools = compactSchemaRegistry.getSchema(compactModel, {
        preReadLineDropped: true,
      });
      if (options?.model !== undefined) {
        const listed = await this.runnerConfig.config
          .getModelProviderManager()
          .getModel(compactModel);
        compactReasoningEffort = getPreferredReasoningEffort(
          this.runnerConfig.config,
          listed,
        );
        compactGeneration = getPreferredGeneration(
          this.runnerConfig.config,
          listed,
        );
        compactContextWindow =
          this.runnerConfig.config.getEffectiveContextWindow?.(
            listed,
            compactModel,
          );
      }
    }

    const compactParent: Parameters<
      typeof createCompactRequestResolver
    >[0]['parent'] = reusableSnapshot
      ? {
          modelResolution: reusableSnapshot.modelResolution,
          model: compactModel,
          source: options?.model !== undefined ? 'explicit' : 'current',
          reasoningEffort: compactReasoningEffort,
          generation: compactGeneration,
          contextWindow: compactContextWindow,
        }
      : options?.model !== undefined
        ? {
            model: compactModel,
            source: 'explicit',
            config: modelConfigFromGeneration(
              compactGeneration,
              compactReasoningEffort,
              compactContextWindow,
            ),
          }
        : undefined;
    const compactController = new AbortController();
    this.compressionAbortControllers.add(compactController);
    const compactSignal = compactController.signal;
    try {
      const resolveCompactRequest = createCompactRequestResolver({
        config: this.runnerConfig.config,
        parent: compactParent,
        signal: compactSignal,
        sessionId: this.sessionId,
        turnIndex: this.turnCount,
        cumulativeUsage: this.cumulativeUsage,
        logLabel: '[session-runner] manual compact resolve',
      });
      const preparedRequest = reusableSnapshot
        ? undefined
        : await resolveCompactRequest.prepareParent();
      // fork 出的压缩 agent 经 AsyncLocalStorage 继承会话 UUID，与 submitMessage 一致。
      sessionIdContext.enterWith(this.sessionId);
      const result = await pipeline.compress(priorHistory as Message[], {
        promptId,
        force: options?.force ?? true,
        rootSessionId: this.sessionId,
        trigger: 'manual',
        modelResolution:
          preparedRequest?.modelResolution ?? reusableSnapshot!.modelResolution,
        resolveCompactSelection: async () => {
          const request = await resolveCompactRequest();
          return {
            selection: request.modelResolution,
            policyLabels: request.policyLabels,
            source: request.source,
          };
        },
        config: this.runnerConfig.config,
        requestPrefixMessages,
        customInstructions: options?.customInstructions,
        projectionOptions: buildModelProjectionOptions(
          this.runnerConfig.config,
          reusableSnapshot?.model ?? currentConfiguredModel,
          reusableSnapshot?.modelResolution,
        ),
        sessionStateStore: this.sessionStateStore,
        systemPrompt: compactSystemPrompt,
        tools: compactTools,
        ...(options?.customContext !== undefined
          ? { customContext: options.customContext }
          : {}),
        abortSignal: compactSignal,
      });

      let finalHistory: readonly Message[] | null = result.newHistory ?? null;
      if (finalHistory) {
        finalHistory = await this.applyPostCompact(priorHistory, finalHistory);
      }

      return {
        newHistory: finalHistory,
        info: result.info ?? {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    } finally {
      this.compressionAbortControllers.delete(compactController);
    }
  }

  /** Prompt caches restart at these boundaries, allowing MCP declarations to settle again. */
  private resetMcpDeferral(): void {
    this.runnerConfig.config.getMcpClientManager?.()?.resetMcpDeferral();
  }

  /**
   * 构造压缩后的恢复 attachment、追加进历史并经 transcript writer 落盘，返回 agent loop
   * 应当作为下一轮基线的扩展历史。
   */
  async applyPostCompact(
    priorHistory: readonly Message[],
    newHistory: readonly Message[],
  ): Promise<readonly Message[]> {
    return runWithCwdContext(this.cwdContext, async () => {
      this.invalidateCacheSafeSnapshot();
      this.resetMcpDeferral();
      return applyPostCompact(priorHistory, newHistory, {
        replaceMessages: (msgs) => {
          this.messages = msgs;
          this.rebuildMessageUuids();
        },
        pushAttachments: (msgs) => {
          for (const m of msgs) this.appendMessage(m);
        },
        transcriptParentUuid: () => this.lastTranscriptParentUuid,
        setTranscriptParentUuid: (uuid) => {
          this.lastTranscriptParentUuid = uuid;
        },
        transcriptWriter: this.runnerConfig.transcriptWriter,
        attachmentCtx: this.attachmentCtx,
        externalContext: this.runnerConfig.buildAttachmentExternalContext?.(),
        config: this.runnerConfig.config,
      });
    });
  }
}
