/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 运行在 daemon 进程内的 SDK 会话实现。
 *
 * 与子进程模型的三处差异保证多会话正确：`send()` 只做分类与入队、绝不在其中跑 turn；
 * turn 中止控制器是会话字段而非模块级单槽；命令队列强制按会话归属。
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  PermissionModeUnavailableError,
  matchesTranscriptSnapshot,
  beginResumeRead,
  createBoundedResumeReadState,
  createSessionResumeWriterBinding,
  getResumeArtifactWorktreeStates,
  getPromptSuggestionFeatureConfig,
  toTranscriptWorktreeSession,
  extractLastAssistantModelFromTranscript,
  isResumeReadError,
  ResumeReadError,
  type ResumeReadAttempt,
  type ResumeTranscriptResult,
  CompressionPipeline,
  DefaultHookCoordinator,
  FileHistoryManager,
  GoalStatus,
  NoopHookCoordinator,
  OutputFormat,
  SystemPromptAssembler,
  TASK_LIFECYCLE_SUBTYPES,
  TaskRegistry,
  bridgeExecutionLifecycleToRegistry,
  DEFAULT_BACKGROUND_WIND_DOWN_POLICY,
  drainAutoDream,
  drainSubagentSdkEvents,
  getSessionTranscriptPath,
  getVersion,
  isSDKMode,
  isHeadlessMode,
  migrateLegacyWorktreeTranscript,
  parseModelPromptPatches,
  parseReasoningEffortLevel,
  projectTaskSystemEventForSdk,
  promptIdContext,
  customContextContext,
  snapshotCustomContext,
  renderGoalKickoffPrompt,
  getStartupMilestone,
  markStartupMilestone,
  runLogger,
  selectSessionResumePoint,
  sessionLogger,
  SessionEndReason,
  setAllHookEventsEnabled,
  type AcquireSessionWriterOptions,
  type BackgroundWindDownPolicy,
  type Config,
  type FileSystemService,
  type Goal,
  type MCPServerConfig,
  type ResourceService,
  type InboundUserMessage,
  type LoadedPlugin,
  type McpManager,
  type QueryEvent,
  type SessionResumeData,
  type ToolRegistryFactory,
  type TranscriptResumeReadState,
  type TranscriptWriterHandle,
  type ConfigParameters,
  type ModelConfig,
  type ModelTransportManager,
  type CustomProviderManager,
} from '@qwen-code/core';
import { setModelPreference } from '../../utils/modelPreference.js';
import {
  SessionQueryRunner,
  type SessionQueryRunnerConfig,
} from './query/sessionQueryRunner.js';
import {
  drainBackgroundSubagentEvents,
  isBackgroundAgentTask,
} from './query/backgroundSubagentEvents.js';
import type { CliArgs } from '../../config/config.js';
import { loadCliConfig } from '../../config/config.js';
import { createCliSettingsService } from '../../config/createCliSettingsService.js';
import { runAfterConfigInitializedStartup } from '../../core/startupLifecycle.js';
import type { LoadedSettings, SettingSource } from '../../config/settings.js';
import { getSettingsResolveOptions } from '../../config/settings.js';
import type { SettingsService } from '@qwen-code/resource';
import { resolveSessionFlagSettings } from '../config/sessionFlagSettings.js';
import { isStringProp } from '../support/protocolError.js';
import type {
  ThreadCallContext,
  ThreadHost,
  ThreadNotice,
  ThreadTerminationReason,
} from './contract/hostContext.js';
import { isCancelledTurnResult } from './command/commandLifecycle.js';
import type { ThreadSessionSnapshot } from './contract/hostContext.js';
import * as goalHandlers from './handlers/goalHandlers.js';
import * as modeHandlers from './handlers/modeHandlers.js';
import * as modelHandlers from './handlers/modelHandlers.js';
import * as contextHandlers from './handlers/contextHandlers.js';
import * as configurationHandlers from './handlers/configurationHandlers.js';
import * as taskHandlers from './handlers/taskHandlers.js';
import * as metaHandlers from './handlers/metaHandlers.js';
import * as mcpHandlers from './handlers/mcpHandlers.js';
import * as initializeHandlers from './handlers/initializeHandlers.js';
import type { ThreadSessionInternals } from './contract/handlerContract.js';
import type { ThreadResumeData } from './contract/threadResumeData.js';
import { SessionPhaseLog } from './phase-log/sessionPhaseLog.js';
import { isFirstTextMessage } from './phase-log/firstOutput.js';
import type {
  ThreadInitializeResult,
  ThreadInitializeDeclarationProducts,
  ThreadInterruptResult,
  ThreadAddDirectoriesResult,
  ThreadAppliedFlagSettings,
  ThreadGoalResult,
  ThreadMcpResult,
  ThreadPlanModeResult,
  ThreadProxyResult,
  ThreadSessionTitleResult,
  ThreadSideQuestionResult,
  ThreadTaskResult,
  ThreadRewindResult,
  ThreadSessionDeclarations,
  ThreadSubmission,
  ThreadUserMessage,
} from './contract/threadSessionTypes.js';
import {
  HEADLESS_TRANSCRIPT_ENTRYPOINT,
  getTranscriptGitBranch,
} from '../../utils/transcriptMetadata.js';
import { waitForNonInteractiveRequestReady } from '../../startup/startupModePolicy.js';
import { collectSessionInitSnapshot } from './initialize/sessionInitFrame.js';
import {
  recordTranscriptRuntimeConfig,
  registerTranscriptRuntimeConfigRecorder,
} from '../../utils/runtimeConfigTranscript.js';
import { restoreRuntimeConfigFromResumeData } from '../../utils/resumeModel.js';
import { applyResumeWorktreeState } from '../../utils/applyResumeWorktreeState.js';
import { createMcpResourceAttachmentSource } from '../../utils/mcpResourceAttachments.js';
import {
  applyWorktreeStartupRequest as applyWorktreeStartupRequestCore,
  type WorktreeStartupRequest,
} from '../../utils/worktreeStartupRequest.js';
import { RootToolRegistry } from '../../session/rootToolRegistry.js';
import { PresentFilesTool } from '../../session/artifacts/presentFilesTool.js';
import {
  createMcpControlModule,
  type McpControlModule,
} from './host/sessionMcpControl.js';
import { parseContextWindowControlValue } from '../../session/contextWindow.js';
import type { ThreadMemoryPromptUpdate } from './contract/hostContext.js';
import { registerHostMcpServers } from './host/sessionHostMcpServers.js';
import { registerHostAgents } from './host/sessionHostAgents.js';
import {
  drainBackgroundWorkBeforeClose,
} from './turn/backgroundWindDown.js';
import { SessionCommandManager } from './command/sessionCommandManager.js';
import { installThreadPermissionHandling } from './host/sessionPermissionChannel.js';
import {
  createSessionBroadcast,
  type SessionBroadcast,
} from './turn/sessionBroadcast.js';
import { attachSessionToolProgress } from './turn/sessionToolProgress.js';
import { attachSessionCodeModeTools } from './turn/sessionCodeModeTools.js';
import { attachSessionHookEvents } from './turn/sessionHookEvents.js';
import { registerHostHooks } from './host/sessionHostHooks.js';
import {
  createSessionEndCloseout,
  type SessionEndCloseout,
  type SessionEndCloseoutView,
} from './host/sessionEndCloseout.js';
import { installElicitationBridge } from './host/elicitationBridge.js';
import {
  installSessionCompressionStatusBridge,
  type SessionCompressionStatusBridge,
} from './turn/sessionCompressionStatus.js';
import {
  installSessionAgentsMdSizeWarning,
  type SessionAgentsMdSizeWarningBridge,
} from './turn/sessionAgentsMdSizeWarning.js';
import { chunkForkTranscriptEntries } from './turn/forkTranscriptMirror.js';
import { createHostArtifactRefresh } from './initialize/sessionArtifactResolver.js';
import { createModelPolicyCallback } from './initialize/sessionModelPolicy.js';
import {
  createInferenceReadiness,
  type InferenceReadiness,
} from './turn/inferenceReadiness.js';
import { createSessionHooks, type SessionHooks } from './turn/sessionHooks.js';
import {
  extractTrailingTextBlock,
  runSessionCompactCommand,
} from './turn/sessionCompactCommand.js';
import {
  createSessionSlashHandler,
  parseCompactInvocation,
  SessionBridgeSlashDecider,
} from './turn/sessionSlashCommands.js';

type ResumeHistoryData = Pick<
  ThreadResumeData,
  'messages' | 'fileHistorySnapshots' | 'sourceSessionId'
>;

/** 配置了 SessionEnd hook 超时时，closeout 窗口在 hook 超时上再留的收尾余量。 */
const SESSION_END_CLOSEOUT_CONFIGURED_MARGIN_MS = 1_000;

/**
 * flush 控制请求的有界等待。后台 review 的模型请求可能被自定义端点拖住（首包超时
 * 后会继续重试），flush 不能无限占用控制通道与宿主的 release 预算；到点先回执，
 * 剩余排干在 retire() 的后台 teardown 里继续。
 */
const FLUSH_CONTROL_WAIT_BOUND_MS = 5_000;

/**
 * `ThreadManager` 建会话时交进来的东西：三件由它自己持有的事实（sessionId / host /
 * cwd）加两件由宿主胶水翻译好的产品数据（cliArgs、resume transcript 路径）。argv 怎么
 * 解析、物化目录怎么找 transcript，都在 `sdk/thread/openSessionParams.ts` 做完，会话与
 * 承接方都不认识 wire 键。
 */
export interface ThreadSessionParams {
  readonly businessType?: string;
  readonly pluginManagerFactory?: import('@qwen-code/core').PluginManagerFactory;
  readonly sessionId: string;
  readonly cwd: string;
  /**
   * 会话级宿主通道：出站事件与八个反向请求都走它。会话因此不认识任何 wire 形状——
   * 不发帧、不知道 subtype 字符串、不做 request_id 关联。
   */
  readonly host: ThreadHost;
  /**
   * 会话装配所需的 CLI 选项集合。由工厂解析好后注入（SDK 下是 `parseWorkerArgs` 的
   * 产物）：argv 契约是上游协议，会话不解析它。本类在 cli 包内，因此直接吃 `CliArgs`
   * 类型不构成跨层依赖。
   */
  readonly cliArgs: CliArgs;
  /** 会话所属的产品启动面；缺省 sdk（既有嵌入方）。 */
  readonly startupMode?: 'sdk' | 'acp' | 'headless';
  /**
   * 会话关闭时等待后台任务的策略，由宿主在 open 时声明。缺省用 core 的
   * `DEFAULT_BACKGROUND_WIND_DOWN_POLICY`（600s 等待、10s 硬界）；本类不读环境变量。
   */
  readonly backgroundWindDownPolicy?: BackgroundWindDownPolicy;
  /** 宿主已确立的认证类型；缺省从会话 settings 推导。 */
  readonly authType?: import('@qwen-code/core').AuthType;
/**
 * 仅 resume 路径会传：transcript 的绝对路径；不改变本会话的配置根。
 */
  readonly resumeTranscriptPath?: string;
  /** fork 既有历史结果，或普通 candidate 的投影；来源必须由独立 candidate 区分。 */
  readonly resumeData?: ThreadResumeData;
  /** 普通冷恢复的临时候选与同一 attempt；不用于 fork 全历史。 */
  readonly resumeCandidate?: ResumeTranscriptResult;
  /** 宿主随会话打开声明的动态 MCP server，在 `config.initialize()` 前注入。 */
  readonly dynamicMcpServers?: Record<string, MCPServerConfig>;
  /** 宿主文件系统包装；ACP 用它把读写转给客户端。 */
  readonly fileSystemServiceFactory?: (
    config: Config,
    fallback: FileSystemService,
  ) => FileSystemService;
  /**
   * 本会话是否由 fork 创建。由 Manager 的 fork 结果决定，不再从 `cliArgs.forkSession`
   * 反推——ACP / headless 接入时也复用同一个事实。
   */
  readonly forked?: boolean;
  /**
   * 阶段耗时日志。open_session 受理时创建、沿 open → Manager → 会话下传；
   * 非 SDK 入口不传时会话自己建一个（汇总的起点退化为构造时刻，仍可用）。
   */
  readonly phaseLog?: SessionPhaseLog;
  /**
   * 必须借用应用持有的同一资源服务；关闭会话只释放项目 handle 和订阅，
   * 不能关闭其他会话仍在使用的用户资源和文件监听。
   */
  readonly resourceService: ResourceService;
  /** 借用共享服务，关闭会话只退订监听，不销毁其他会话仍需使用的来源。 */
  readonly settingsService: SettingsService;
  /** Process-level MCP pool owned by the application framework. */
  readonly mcpManager?: McpManager;
  readonly builtinPlugins?: import('@qwen-code/core').BuiltinPluginContributions;
  readonly permissionManager: import('@qwen-code/core').PermissionManager;
  /** 会话级 provider 工厂；Config 构造期调用，缺省时无贡献 provider。 */
  readonly modelProviderFactory?: NonNullable<
    ConfigParameters['modelProviderFactory']
  >;
  /**
   * 进程级 transport 注册表；构造会话级 ModelProviderManager 时按协议取 transport。
   */
  readonly modelTransportManager: ModelTransportManager;
  /** 借用 framework 的共享配置服务，会话不接管其生命周期。 */
  readonly customProviderManager?: CustomProviderManager;
}

/**
 * 本会话 argv 声明的 setting sources；undefined 表示按缺省（全部来源）加载。
 * 非法值在 open 阶段抛出，与 flag 解析同一套文案。
 */
function parseSessionSettingSources(
  cliArgs: CliArgs,
): readonly SettingSource[] | undefined {
  if (!cliArgs.settingSources) return undefined;
  const sources: SettingSource[] = [];
  for (const name of cliArgs.settingSources) {
    if (name === '') continue;
    if (name !== 'user' && name !== 'project' && name !== 'local') {
      throw new Error(
        `Invalid setting source: "${name}". Valid options are: user, project, local`,
      );
    }
    sources.push(name);
  }
  return sources;
}

interface PendingRunnerDeclarations {
  promptSources?: {
    overrideSystemPrompt: string | null;
    appendSystemPrompt: string | null;
  };
  sdkMemoryPrompt?: ThreadMemoryPromptUpdate;
  includePartialMessages?: boolean;
  modelRequestPatches?: ReturnType<typeof parseModelPromptPatches>;
}

export class ThreadSession implements ThreadSessionInternals {
  readonly sessionId: string;
  /**
   * 阶段耗时日志。handlers / turn 经 `ThreadSessionInternals.phaseLog` 拿同一个实例，
   * 于是 open_session → 装配 → initialize → 首轮的阶段进同一张汇总表。
   */
  readonly phaseLog: SessionPhaseLog;

  // ── 装配产物（每会话独占）──
  private config: Config | undefined;
  private settings: LoadedSettings | undefined;
  /** 本会话 argv 声明的 setting sources；undefined = 未声明（全来源）。 */
  private settingSources: readonly SettingSource[] | undefined;
/**
 * runner 面 initialize 声明的暂存：runner 懒建，握手期的声明先存这里，
 * runner 建好后回放一次，避免提示词来源、memory 等声明被静默丢弃。
 */
  private pendingRunnerDeclarations: PendingRunnerDeclarations = {};
  private runner: SessionQueryRunner | null = null;
  /** 懒建 + memoize；普通装配失败可重试，本次恢复失败由 openingFailure 保留。 */
  private runnerPromise: Promise<SessionQueryRunner> | null = null;
  private transcriptWriter: TranscriptWriterHandle | undefined;
  /**
   * resume/fork 的恢复事实。plain resume 从 projection 的 index metadata 取，
   * fork 直接取宿主翻译好的 ThreadResumeData；两边都在这一个对象上消费，
   * 避免模型/目录只在其中一条链路上生效。
   */
  private resumeSnapshot: SessionResumeData | undefined;
  private pendingForkResumeData:
    | Omit<ThreadResumeData, 'forkTranscriptEntries'>
    | undefined;
  private forkTranscriptEntries: ThreadResumeData['forkTranscriptEntries'];
  private resumeReadState: TranscriptResumeReadState | undefined;
  private resumeMetadataLoaded = false;
  private resumeCandidate: ResumeTranscriptResult | undefined;
  private resumeAttempt: ResumeReadAttempt | undefined;
  /** open 阶段释放的读取 attempt；懒建 runner 时据此校验候选来源。 */
  private releasedResumeAttempt: ResumeReadAttempt | undefined;
  /** 仅取消恢复，不提前中止退休阶段仍需使用的会话信号。 */
  private readonly resumeAbort = new AbortController();
  /** 本次 opening 的恢复失败事实，后续控制 / hook / turn 不再扫描。 */
  private openingFailure: Error | undefined;
  private readonly params: ThreadSessionParams;
  /**
   * 会话状态广播面：`available_models_update` / `commands_changed` / `status` /
   * `artifacts_update` 四类 system 帧，每会话一份，`start()` 末尾装配。为什么必须
   * 按会话重建（`coreEvents` 是进程级单例总线）见 sessionBroadcast.ts 的文件头。
   */
  private broadcast: SessionBroadcast | undefined;
  private unsubscribeToolProgress: (() => void) | undefined;
  private unsubscribeCodeModeTools: (() => void) | undefined;
  private unsubscribeHookEvents: (() => void) | undefined;
  private compressionStatusBridge: SessionCompressionStatusBridge | undefined;
  private agentsMdSizeWarningBridge:
    | SessionAgentsMdSizeWarningBridge
    | undefined;
/**
 * MCP 控制面（8 个 `mcp_*` 入站请求）。等执行内核与 MCP manager 就绪后再建，
 * 否则 `install()` 关闭 auth 伪工具那一步会被静默跳过。
 */
  private mcpControlRef: McpControlModule | undefined;
  /**
   * SessionStart / SessionEnd 的触发与一次性记账。三个标志与 finally 的三分支语义
   * 都在 sessionHooks.ts，会话只留两个入口。
   */
  private readonly hooks: SessionHooks;
  /**
   * SessionEnd 收尾窗口：close() 里包住 `hooks.fireEnd()` 的那一段。窗口内 SessionEnd 的
   * 反向请求与 hook 生命周期通知才出得去，边界与安全理由见 host/sessionEndCloseout.ts。
   */
  private readonly sessionEndCloseout: SessionEndCloseout;
  /**
   * 会话级宿主通道：出站事件与八个反向请求都走它。会话因此不认识任何 wire 形状——
   * 不发帧、不知道 subtype 字符串、不做 request_id 关联。
   */
  readonly host: ThreadHost;
  /**
   * 命令管理：入队 / 派发 / turn 记账 / 终态上报。以 `commandUuid` 为键的东西都在它
   * 那里，包括 `turnRunning` 与 `turnController`——那两个字段是它的 private，本类与
   * handler 在类型层面就拿不到，于是「记账只在一处发生」由结构保证而不是靠注释。
   */
  private readonly commands: SessionCommandManager;
  /**
   * 收尾窗口里到来的 goal kickoff。result 已出但 `turnRunning` 尚未复位时，
   * set_goal/resume_goal 不能直接起下一轮；登记到这里，等命令管理器通知空闲后
   * 恰好补启动一次。
   */
  private pendingGoalKickoff = false;
/**
 * 后台任务登记表：复用 Config 上已有的登记表，否则本会话新建并挂回；
 * close 时只解绑自己新建的那一份。
 */
  private taskRegistryRef: TaskRegistry | undefined;
  private ownsTaskRegistry = false;
  private cleanupTaskRegistryBridge: (() => void) | undefined;
  private cleanupBackgroundSubagentTaskListener: (() => void) | undefined;
  private backgroundSubagentPump: ReturnType<typeof setInterval> | undefined;
  private readonly backgroundSubagentTaskIds = new Set<string>();
  private readonly backgroundSubagentToolUseIds = new Set<string>();
  /** `side_question` 的按 request_id 取消控制器；同 id 并发要拒绝。 */
  readonly sideQuestionControllers = new Map<string, AbortController>();
  /**
   * 推理面就绪（绑 auth → 等目录可信 → 对齐会话模型）。三步为什么必须成对、Promise
   * 去重与失败重试的记账，都在 inferenceReadiness.ts；会话只留一个入口。
   */
  private readonly inference: InferenceReadiness;

  // ── turn 状态：会话字段，不是模块级单槽 ──
  private initialized = false;
  /** initialize 显式模型优先于 Writer 接管后的历史配置恢复。 */
  private hasInitializeRuntimeOverride = false;
  private promptSuggestionsEnabled = false;
/** SDK 是否把 plan mode 与 permission mode 当作独立控制面，决定 init 帧的视图。 */
  private independentPlanModeControls = false;
/** initialize 声明的两个装配开关；回调按调用时的值门禁，不在装配时快照。 */
  private modelPolicyProviderEnabled = false;
  private resolveSessionArtifactsEnabled = false;
  private artifactPresentationEnabled = false;
/**
 * `initialize` 的 `supportsCatalogReadyInitialize` 声明：为真时推理就绪流程
 * 才跑完整运行时阶段，用于把别名/展示名归一到 catalog key。
 */
  private catalogReadyInitializeEnabled = false;

  // ── SDK memory / skill evolution（initialize 声明驱动，宿主实现） ──
  private memoryEnabled = false;
  private skillEvolutionEnabled = false;
/** 回包要合并进 control_response 的两个字段。 */
  private effectiveMemory: Record<string, unknown> | undefined;
  private effectiveSkillEvolution: Record<string, unknown> | undefined;

  // ── 入站派发 ──
  private transcriptUnsubscribe: (() => void) | undefined;
  /** 运行配置变更跟随写入 transcript，resume 才能恢复会话内切过的模型。 */
  private runtimeConfigRecorderUnsubscribe: (() => void) | undefined;

  // ── 会话级中止 ──
  private readonly sessionAbort = new AbortController();
/**
 * bridge 准入判定器：懒建并缓存 CommandService；使用会话级信号，随会话一起中止。
 */
  private bridgeSlashDecider: SessionBridgeSlashDecider | undefined;
  private terminated = false;
  /** 信道关闭结果（含 transcript flush 屏障）；closeChannel 幂等复用。 */
  private channelClosePromise:
    | Promise<{ transcriptFlushed: Promise<void> }>
    | undefined;
  /** 退休收尾；retire 幂等复用。 */
  private retirePromise: Promise<void> | undefined;
  /** 兼容 close()（closeChannel + flush + retire）的幂等结果。 */
  private closeCompatPromise: Promise<void> | undefined;
  /**
   * 见 `ThreadSession.termination`：自行终止时 resolve 恰好一次，被 `close()` 收掉不
   * resolve（承接方自己关的，它知道）。executor 同步执行，所以 ctor 里赋值完就能用。
   */
  readonly termination: Promise<ThreadTerminationReason>;
  private resolveTermination!: (termination: ThreadTerminationReason) => void;

  constructor(params: ThreadSessionParams) {
    // 不让 params 长期持有一次性 Writer 种子；接管/失败后可统一释放候选引用。
    const { resumeCandidate, resumeData, ...sessionParams } = params;
    this.params = sessionParams;
    if (!resumeCandidate && resumeData) {
      const { forkTranscriptEntries, ...forkResumeData } = resumeData;
      this.pendingForkResumeData = forkResumeData;
      if (params.cliArgs.sessionMirror) {
        this.forkTranscriptEntries = forkTranscriptEntries;
      }
    }
    this.resumeCandidate = resumeCandidate;
    this.resumeAttempt = resumeCandidate?.attempt;
    this.sessionId = params.sessionId;
    this.host = params.host;
    this.phaseLog = params.phaseLog ?? new SessionPhaseLog(params.sessionId);
    this.termination = new Promise<ThreadTerminationReason>((resolve) => {
      this.resolveTermination = resolve;
    });
    this.commands = new SessionCommandManager({
      sessionId: params.sessionId,
      emit: (event) => this.host.events.emit(event),
      isTerminated: () => this.terminated,
      runTurn: (msg, controller, commandUuid) =>
        this.runTurn(msg, controller, commandUuid),
      abortRunner: () => this.runner?.abort(),
      cancelPromptSuggestion: () => this.runner?.cancelPromptSuggestion(),
      hasPersistedUuid: (uuid) =>
        this.runner?.hasPersistedMessageUuid(uuid) ?? false,
      terminate: (reason) => this.terminate(reason),
      onTurnSettled: () => this.flushPendingGoalKickoff(),
    });
    this.sessionEndCloseout = createSessionEndCloseout({
      sessionId: params.sessionId,
      // 延迟求值：此刻 Config 还没装配，hook 配置的超时只能等开窗时读。
      // SessionEnd 预算：hookSystem clamp 到 1.5–60s，缺省 10s。
      windowMs: () => {
        const configured = this.config
          ?.getHookSystem?.()
          ?.getSessionEndTimeoutMs?.(SessionEndReason.Other);
        return configured === undefined
          ? undefined
          : configured + SESSION_END_CLOSEOUT_CONFIGURED_MARGIN_MS;
      },
    });
    // 在 ctor 里建而不是字段初始化器：字段初始化按声明顺序跑，而它要读的
    // `sessionAbort` 声明在本字段之后。config / settings 用 getter 读，此刻还不存在。
    this.inference = createInferenceReadiness({
      sessionId: params.sessionId,
      signal: this.sessionAbort.signal,
      ensureAuthReady: this.host.requests.ensureAuthReady?.bind(
        this.host.requests,
      ),
      prepareInference: this.host.requests.prepareInference?.bind(
        this.host.requests,
      ),
      ...(params.authType === undefined ? {} : { authType: params.authType }),
      getConfig: () => this.requireConfig(),
      getSettings: () => this.requireSettings(),
      // 推理就绪第二段（完整运行时、waitEndpoint:true）按该开关门禁。
      isCatalogReadyInitializeEnabled: () =>
        this.isCatalogReadyInitializeEnabled(),
      getPhaseLog: () => this.phaseLog,
    });
    this.hooks = createSessionHooks({
      sessionId: params.sessionId,
      signal: this.sessionAbort.signal,
      isTerminated: () => this.terminated,
      getConfig: () => this.config,
      peekQueryRunner: () => this.runner,
      ensureQueryRunner: () => this.getQueryRunner(),
      isResume: () => this.params.resumeTranscriptPath !== undefined,
    });
  }

  /**
   * 造一个**已启动**的会话。构造与 `start()` 在这里合成一步：承接方拿不到「造好但没
   * 启动」的中间态，也就没机会在装配完成前把调用转进来。启动失败直接抛，由承接方按
   * open 失败处理、不留表项。
   */
  static async create(params: ThreadSessionParams): Promise<ThreadSession> {
    const session = new ThreadSession(params);
    try {
      if (params.resumeTranscriptPath !== undefined && !params.forked) {
        session.resumeAttempt ??= await beginResumeRead({
          signal: session.resumeAbort.signal,
        });
      }
      const attempt = session.resumeAttempt;
      if (attempt) await attempt.run(() => session.start());
      else await session.start();
      attempt?.check();
      // open 完成即归还进程级读取名额：会话可能空闲很久，租约与 60s 时限只覆盖
      // 真正的读取/装配；runner 懒建到首个 prompt 时再按候选重建 attempt。
      // 外层还有 Manager 的 run() 时由它在 open 成功后释放，避免嵌套者提前终结。
      if (attempt && !attempt.hasActiveRun()) session.releaseResumeLease();
      return session;
    } catch (error) {
      // 未返回的半成品不会进入 Manager 注册表，必须在这里释放已申请的会话资源。
      try {
        await session.close().catch((cleanupError: unknown) => {
          runLogger.warn('[thread-session] failed startup cleanup', {
            sessionId: params.sessionId,
            error: cleanupError,
          });
        });
      } finally {
        session.finishResumeRead();
      }
      throw error;
    }
  }

  // ===========================================================================
  // 生命周期
  // ===========================================================================

/**
 * 装配会话运行时。runner 按首个 prompt 懒建，open 回执不等模型目录与工具注册表。
 */
  private async start(): Promise<void> {
    const { cliArgs, cwd, sessionId, settingsService } = this.params;
    // 诊断 segment 按会话声明的目录归档：daemon 进程内多会话，process.cwd() 是部署目录。
    sessionLogger.bindSessionProject(sessionId, cwd);
// `--include-hook-events` 来自本会话 argv，但 core 的开关是进程级单例：
// 任一需要 hook 事件的会话会为整个 daemon 打开，归多会话串扰统一处理。
    if (cliArgs.includeHookEvents) {
      setAllHookEventsEnabled(true);
      runLogger.log('[thread-session] all hook events enabled', { sessionId });
    }
    // Pass this session's flag settings directly to its settings resolver.
    const flagSettings = cliArgs.settings
      ? resolveSessionFlagSettings(cliArgs.settings, cwd)
      : undefined;
    // `--setting-sources` 同理是本会话的 argv 事实：loadSettings 的来源过滤按它收窄，
    // `--setting-sources` 收窄 loadSettings 的来源；缺省走进程默认（全开）。
    const settingSources = parseSessionSettingSources(cliArgs);
    this.settingSources = settingSources;
    const headless = isHeadlessMode(cliArgs);
    if (!settingsService.isInitialized || !settingsService.getDefinition()) {
      createCliSettingsService({
        service: settingsService,
        environmentPolicy: 'session',
      });
    }
    const settings = this.phaseLog.phaseSync(
      '读取会话设置',
      'settingsService.resolve(options)：复用文件源并独立合并 user / project / local / flag 四层设置，来源按 argv 声明过滤、flag 层按本会话 argv',
      () =>
        settingsService.resolve({
          ...getSettingsResolveOptions(cwd, settingSources, flagSettings),
          // Session flags, not the daemon terminal, determine execution mode.
          headless,
        }),
    );
    this.settings = settings;
    // `startupMode: 'sdk'` 由 stream-json 参数决定，影响 customProviderAccessMode 等分支。
    const config = await this.phaseLog.phase(
      '构造会话 Config',
      'loadCliConfig：把 argv 与合并设置落地成会话级 Config，不含 initialize',
      () =>
        loadCliConfig(settings, sessionId, cliArgs, {
          cwd,
          ...(headless ? { trustedFolder: settings.isTrusted } : {}),
          startupMode: this.params.startupMode ?? 'sdk',
          // 进程级 ResourceService 由 ThreadManager 传入，同进程所有会话共享一份。不传就会
          // 走 Config 的兜底 new ResourceService()，每会话各建一份（见 ThreadSessionParams）。
          resourceService: this.params.resourceService,
          pluginManagerFactory: this.params.pluginManagerFactory,
          settingsService: this.params.settingsService,
          mcpManager: this.params.mcpManager,
          builtinPlugins: this.params.builtinPlugins,
          modelProviderFactory: this.params.modelProviderFactory,
          permissionManager: this.params.permissionManager,

          modelTransportManager: this.params.modelTransportManager,
          customProviderManager: this.params.customProviderManager,
          builtinPluginsInitialization: Promise.resolve(),
          startupPhaseObserver: (record) =>
            this.phaseLog.recordExternal(
              record.name,
              record.name,
              record.durationMs,
              record.status,
            ),
          projectHooks: settings.project?.settings.hooks,
          localHooks: settings.local?.settings.hooks,
          userHooks: settings.user?.settings.hooks,
          flagHooks: settings.flag?.settings.hooks,
        }),
    );
    this.config = config;
    config.setBusinessType(this.params.businessType);
    this.unsubscribeCodeModeTools = attachSessionCodeModeTools({
      snapshots: config.toolCallSnapshots,
      sessionId: config.getSessionId(),
      emitMessage: message => this.host.events.emit({ kind: 'threadMessage', message }),
    });
    // Replay creation entries before initialization can append target metadata.
    if (cliArgs.sessionMirror) {
      this.transcriptUnsubscribe = config
        .getTranscriptStore()
        .addCommitObserver((filePath, entries) =>
          this.host.events.emit({
            kind: 'transcriptMirror',
            filePath,
            entries,
          }),
        );
      await this.emitForkTranscriptMirror();
    }
    if (this.params.fileSystemServiceFactory) {
      config.setFileSystemService(
        this.params.fileSystemServiceFactory(
          config,
          config.getFileSystemService(),
        ),
      );
    }
    if (this.params.dynamicMcpServers) {
      config.setDynamicMcpServers(this.params.dynamicMcpServers);
    }
    await this.phaseLog.phase(
      'Config 初始化',
      '存储、builtin 插件、上下文索引、shell 探测、资源与 agent / 工具注册、agent team；' +
        'MCP 连接与技能发现异步踢出、不在本阶段等待',
      () => config.initialize(),
    );

    // resume / fork 的恢复事实：源会话的模型、推理档位与工作目录。
    // 必须在 initialize 之后（目录与权限上下文此时才存在）、首轮之前——恢复晚于
    // 首轮就等于没恢复：请求会带着默认模型发出去，源会话的模型再也不会被用上。
    await this.phaseLog.phase(
      '恢复会话事实',
      'loadResumeMetadata：读源 transcript 的恢复元数据，并应用运行配置与工作目录',
      async () => {
        await this.loadResumeMetadata(config);
        await this.applyResumeRuntimeConfig(config);
        this.applyResumeWorkspaceDirectories(config);
      },
    );

// Config 初始化后的启动生命周期：接线 auto-mode 判定器并预热 shell/git，
// 否则 auto 模式会退回人工审批、首轮请求承担采集成本。
    await this.phaseLog.phase(
      'Config 初始化后启动生命周期',
      'runAfterConfigInitializedStartup：initializeAutoModeClassifier + shell/git 预热 + 会话配置快照',
      () => runAfterConfigInitializedStartup(config),
    );

    // fork 的标准 session 创建收尾：把源会话的计划文件复制到本会话。入口（SDK / 未来的
    // ACP / headless）不再各自做这一步；失败不阻断装配，与 headless / TUI 的既有语义一致。
    await this.phaseLog.phase(
      'fork 计划状态迁移',
      'copyPlanForResume：从源会话复制计划文件到本会话（失败不阻断装配）',
      () => this.copyForkPlanState(config),
    );

// 认证是 daemon 级共享事实，会话不再单独初始化；推理面就绪（authType 绑定、
// 目录预热、模型对齐）属于 initialize，见 inferenceReadiness.ts。
    this.phaseLog.phaseSync(
      '会话广播与桥接装配',
      '任务注册表、状态广播面、hook 事件订阅、MCP elicitation 桥、压缩状态桥、记忆管线、命令面挂载',
      () => {
        this.setupTaskRegistry(config);
        this.broadcast = createSessionBroadcast({
          config,
          sessionId,
          emitNotice: (notice) => this.emitNotice(notice),
          getQueryRunner: () => this.runner,
          getSettings: () => this.getCurrentSettings(),
          isIndependentPlanModeControls: () => this.independentPlanModeControls,
        });
        this.unsubscribeHookEvents = attachSessionHookEvents({
          sessionId,
          emitNotice: (notice) => this.emitNotice(notice),
        });
// MCP elicitation 桥；不装则所有需要用户补充输入的授权流会静默 cancel。
        installElicitationBridge({
          config,
          sessionId,
          emitNotice: (notice) => this.emitNotice(notice),
          elicit: (payload, options) =>
            this.host.requests.elicit(payload, options),
        });
        // 自动压缩状态桥；不装则压缩期间宿主只看到静默等待。
        this.compressionStatusBridge = installSessionCompressionStatusBridge({
          sessionId,
          emit: (message) =>
            this.host.events.emit({ kind: 'threadMessage', message }),
        });
        // AGENTS.md 超限警告；不装则宿主看不到提示。
        this.agentsMdSizeWarningBridge = installSessionAgentsMdSizeWarning({
          config,
          emit: (message) =>
            this.host.events.emit({ kind: 'threadMessage', message }),
        });
        this.commands.attach();
      },
    );
    const sourceSessionId =
      (this.resumeSnapshot ?? this.pendingForkResumeData)?.sourceSessionId ??
      this.params.cliArgs.resume;
    runLogger.log('[thread-session] started', {
      sessionId,
      cwd,
      resume: this.params.resumeTranscriptPath !== undefined,
      fork: this.params.forked === true,
      ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
    });
  }

  /**
   * fork 的计划状态迁移：源会话的计划文件可能只存在于源 id 名下，复制到本会话后
   * 模型不需要重新读取或重新生成计划。失败只告警，不影响会话可用性。
   */
  private async copyForkPlanState(config: Config): Promise<void> {
    const resumeData = this.resumeSnapshot ?? this.pendingForkResumeData;
    if (this.params.forked !== true || !resumeData) return;
    const planStateManager = config.planStateManager;
    if (!planStateManager) return;
    await planStateManager
      .copyPlanForResume(
        resumeData.messages,
        resumeData.sourceSessionId ?? this.sessionId,
        this.sessionId,
        config.storage.getPlansDir(),
      )
      .catch((error: unknown) => {
        runLogger.warn('[thread-session] fork plan state copy failed', {
          sessionId: this.sessionId,
          error,
        });
      });
  }

/**
 * 关闭信道：封出站、取消在途 turn / 排队命令 / 反向请求、跑 SessionEnd 并启动
 * transcript flush。返回的 `transcriptFlushed` 是新 open 的串行屏障。
 * 不抛错，失败只记日志。
 */
  async closeChannel(): Promise<{ transcriptFlushed: Promise<void> }> {
    this.channelClosePromise ??= Promise.resolve().then(async () => {
      this.terminated = true;
      this.resumeAbort.abort();
      this.finishResumeRead();
      try {
        await this.interruptTurn();
      } catch (error) {
        this.logCloseFailure('interruptTurn', error);
      }
      // develop 新增：先取消在途命令并排干，再统一报 discarded。
      try {
        await this.commands.cancelAndDrain();
      } catch (error) {
        this.logCloseFailure('cancelAndDrain', error);
      }
      try {
        await this.commands.discardQueuedAndReport();
      } catch (error) {
        this.logCloseFailure('discardQueuedAndReport', error);
      }
      // 在途 side_question 是旧信道上的反向请求：信道关了就不该再等旧宿主的答复。
      for (const controller of this.sideQuestionControllers.values()) {
        controller.abort();
      }
      this.sideQuestionControllers.clear();
      // SessionEnd 必须在 close 回包前跑完（SDK 依赖它）；窗口只放行 hook 回调与
      // 生命周期通知，见 host/sessionEndCloseout.ts。runner / config 在 retire 前都还活着。
      try {
        await this.sessionEndCloseout.run(() => this.hooks.fireEnd());
      } catch (error) {
        this.logCloseFailure('SessionEnd hook', error);
      }
      // 启动 flush（不等）：只有它是 open 的屏障，其余后台任务各跑各的。
      const transcriptFlushed = Promise.resolve(this.transcriptWriter?.flush())
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logCloseFailure('transcript flush', error);
        });
      return { transcriptFlushed };
    });
    return this.channelClosePromise;
  }

  /**
   * 退休：信道关闭后，排干后台管线并释放旧 Config 与其余资源。由承接方在后台执行、
   * 不阻塞 close。顺序沿用原 closeRuntime：drain 必须早于 sessionAbort.abort()，
   * 因为 drain 要真的跑 turn、而 turn 用会话信号。
   */
  retire(): Promise<void> {
    this.retirePromise ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const cleanup = async (action: () => unknown): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await cleanup(() => this.stopBackgroundSubagentPump());
      await cleanup(() => this.cleanupBackgroundSubagentTaskListener?.());
      this.cleanupBackgroundSubagentTaskListener = undefined;
      await cleanup(() => this.compressionStatusBridge?.dispose());
      this.compressionStatusBridge = undefined;
      await cleanup(() => this.agentsMdSizeWarningBridge?.dispose());
      this.agentsMdSizeWarningBridge = undefined;
      await cleanup(() => this.drainBackgroundWork());
      await cleanup(() => this.sessionAbort.abort());
      // interruptTurn / discardQueuedAndReport / SessionEnd 已在 closeChannel 完成。
      await cleanup(() => this.commands.dispose());
      await cleanup(() => this.transcriptUnsubscribe?.());
      this.transcriptUnsubscribe = undefined;
      await cleanup(() => this.runtimeConfigRecorderUnsubscribe?.());
      this.runtimeConfigRecorderUnsubscribe = undefined;

      // 作用域限本会话：绝不能调 ExecutionLifecycleService.terminateAll()——那是
      // 进程级 static（executionLifecycleService.ts:258），会杀掉所有会话的后台任务。
      await cleanup(() => this.config?.disposeToolExecution());
      await cleanup(() => this.cleanupTaskRegistryBridge?.());
      this.cleanupTaskRegistryBridge = undefined;
      if (this.ownsTaskRegistry && this.config) {
        await cleanup(() => {
          this.config!.taskRegistry = undefined;
        });
      }
      this.taskRegistryRef = undefined;
      // 记忆/演进管线由宿主持有：drain 内部先退订再等在途任务，且必须早于 artifact
      // flush（`broadcast.dispose()` 的第一步），因为记忆生成会写盘，产物要赶上最后一批快照。
      if (this.config) {
        await cleanup(() => this.drainSessionPipelines(this.config!));
      }
      // 广播面在 config.dispose() 之前收：它订阅着 coreEvents 与 config 的启动运行时，
      // 晚一步就是在已释放的 config 上取模型目录与工作区快照。
      await cleanup(() => this.broadcast?.dispose());
      this.broadcast = undefined;
      // 展示订阅随会话资源退休，先取消待发预览再释放 Config。
      await cleanup(() => this.unsubscribeToolProgress?.());
      await cleanup(() => this.unsubscribeCodeModeTools?.());
      this.unsubscribeCodeModeTools = undefined;
      this.unsubscribeToolProgress = undefined;
      // SessionEnd 已在 closeChannel 的收尾窗口里跑过，这里只退订 hook 帧。
      await cleanup(() => this.unsubscribeHookEvents?.());
      this.unsubscribeHookEvents = undefined;
      // MCP 控制面在 config.dispose() 之前收：dispose 会中止在途的 OAuth pull flow
      // 并从进程级 opener 路由里注销自己（见 structuredIOMcpControl.ts 顶部说明）。
      await cleanup(() => this.mcpControlRef?.dispose());
      this.mcpControlRef = undefined;
      // 执行内核要在 config.dispose() 之前退：它 dispose 时会关掉 hook 系统，又必须在
      // config 释放之前摘掉自己挂在**进程级** coreEvents 上的订阅与 fork context accessors。
      await cleanup(() => this.runner?.dispose());
      this.runner = null;
      this.runnerPromise = null;
      await cleanup(() => this.transcriptWriter?.close());
      this.transcriptWriter = undefined;
      await cleanup(() => this.config?.dispose());
      await cleanup(() => this.commands.clear());
      sessionLogger.clearSessionProject(this.sessionId);
      if (errors.length === 1) throw errors[0];
      if (errors.length) {
        throw new AggregateError(
          errors,
          `Thread session ${this.sessionId} cleanup failed`,
        );
      }
      runLogger.log('[thread-session] retired', { sessionId: this.sessionId });
    });
    return this.retirePromise;
  }

  private logCloseFailure(stage: string, error: unknown): void {
    runLogger.warn('[thread-session] channel close stage failed', {
      sessionId: this.sessionId,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** 直接调用方的兼容入口：关信道 → 等 flush → 退休（承接方分别调度这两步）。 */
  close(): Promise<void> {
    this.closeCompatPromise ??= (async () => {
      const errors: unknown[] = [];
      let transcriptFlushed: Promise<void> = Promise.resolve();
      try {
        ({ transcriptFlushed } = await this.closeChannel());
      } catch (error) {
        errors.push(error);
      }
      await transcriptFlushed.catch(() => undefined);
      try {
        await this.retire();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) {
        throw new AggregateError(
          errors,
          `Thread session ${this.sessionId} cleanup failed`,
        );
      }
    })();
    return this.closeCompatPromise;
  }

  // ===========================================================================
  // 入站
  // ===========================================================================

  // ===========================================================================
  // 派发泵
  // ===========================================================================

  // ===========================================================================
  // turn
  // ===========================================================================

  /**
   * 在空闲会话上内联跑一轮：`set_goal` 的 kickoff 借用。转发给命令管理器——turn 记账
   * 只在它的 `runTurnGuarded` 里发生，所以 handler 不需要、也不允许自己置 turnRunning。
   */
  async runInlineTurn(msg: InboundUserMessage): Promise<void> {
    await this.commands.runExclusive(msg);
  }

  /**
   * goal 的 idle 续跑。
   *
   * 空闲且无排队命令时立即起 kickoff；result 已出、turn 仍在收尾的窗口里只登记
   * pending，由 `onTurnSettled` 在真正空闲后补启动一次。普通运行中的 turn 不登记
   * pending：goal 续跑由该轮的 stop hook 负责，重复 kickoff 会跑两轮。
   */
  continueGoalIfIdle(): void {
    if (this.terminated) {
      this.pendingGoalKickoff = false;
      return;
    }
    const config = this.config;
    if (!config) return;
    const goal = config.getGoalManager().getGoal();
    if (goal?.status !== GoalStatus.Active) {
      this.pendingGoalKickoff = false;
      return;
    }
    if (this.commands.isTurnFinishing()) {
      this.pendingGoalKickoff = true;
      return;
    }
    if (this.commands.isTurnRunning()) {
      return;
    }
    if (this.commands.queuedUuids().length > 0) {
      // 让已排队的用户消息先跑；它们收尾时会再次触发 flush。
      this.pendingGoalKickoff = true;
      return;
    }
    this.pendingGoalKickoff = false;
    this.startGoalKickoff(goal);
  }

  private flushPendingGoalKickoff(): void {
    if (!this.pendingGoalKickoff) return;
    // 离开 onTurnSettled 的同步栈再起新 turn，避免在 runTurnGuarded 的 finally 里重入。
    queueMicrotask(() => this.continueGoalIfIdle());
  }

  private startGoalKickoff(goal: Goal): void {
    const kickoff: InboundUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: renderGoalKickoffPrompt(goal) }],
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      commandMode: 'prompt',
      isMeta: true,
      ...(goal.customContext !== undefined
        ? { custom_context: snapshotCustomContext(goal.customContext) }
        : {}),
    };
    void this.runInlineTurn(kickoff).catch((err) => {
      runLogger.error('[thread-session] goal kickoff turn failed', {
        sessionId: this.sessionId,
        goalId: goal.id,
        error: err,
      });
    });
  }

  /** 跑一轮对话；返回命令生命周期的终态。 */
  private async runTurn(
    msg: InboundUserMessage,
    controller: AbortController,
    commandUuid?: string,
  ): Promise<'completed' | 'cancelled'> {
    const runner = await this.getQueryRunner();
// SessionStart 必须先于 init 帧，且 runner 已建好，hook 输出才有队列可塞。
    await this.hooks.ensureStart();
// SessionStart 后、init 帧前等一次非交互就绪门禁；best-effort 且有上界。
    await waitForNonInteractiveRequestReady(this.requireConfig(), {
      signal: this.sessionAbort.signal,
    });
    const config = this.requireConfig();
    await config.getProcessPermissionManager()?.getManagedPolicy().whenReady?.();
    const restriction = config.getPermissionModeRestriction(
      config.getPermissionMode(),
    );
    if (restriction) throw new PermissionModeUnavailableError(restriction);
// 每轮提交前重发 system/init，携带本轮真实的 tools/model/permissionMode 快照。
    await this.emitInitMessage();
// controller 由命令管理器创建并传入；装好控制器后、模型调用前上报 started。
// 命令不能在 prestart 回执消失之后才装上控制器。
    this.commands.reportStarted(commandUuid ?? msg.uuid);
    const promptId = randomUUID();
    const userMessageUuid = msg.uuid ?? randomUUID();

    // 结构化输入必须保持结构化，媒体字段已在网络入口归一。
    const submitPrompt = msg.message.content;

    const requestSetId = normalizeRequestSetId(msg.request_set_id);
    const customContext = snapshotCustomContext(msg.custom_context);
    let lifecycleState: 'completed' | 'cancelled' = 'completed';

// 手动 `/compact` 在模型调用前拦截，帧序由 sessionCompactCommand 保证；
// 终态仍由命令管理器按 commandUuid 上报。
    if (msg.client_composed !== true && !msg.selected_skills?.length) {
      const compactInvocation = parseCompactInvocation(
        extractTrailingTextBlock(submitPrompt),
      );
      if (compactInvocation) {
        await customContextContext.run(customContext, () =>
          promptIdContext.run(promptId, async () => {
            const frames = runSessionCompactCommand(
              compactInvocation.customInstructions,
              {
                sessionId: this.sessionId,
                compactor: runner,
                ...(customContext !== undefined ? { customContext } : {}),
              },
            );
            for await (const message of frames) {
              if (isCancelledTurnResult(message)) lifecycleState = 'cancelled';
              if (!this.commands.shouldForwardEngineMessage(message)) continue;
              this.host.events.emit({ kind: 'threadMessage', message });
            }
          }),
        );
        if (controller.signal.aborted) lifecycleState = 'cancelled';
        return lifecycleState;
      }
    }

// 用户消息回放 echo：uuid 是宿主做 checkpoint/rewind 归属的唯一线索。
// 会话只发事实，是否出 wire 帧由宿主按 --replay-user-messages 决定。
    this.host.events.emit({
      kind: 'messageReplay',
      message: msg,
      commandUuid: userMessageUuid,
    });

    await customContextContext.run(customContext, () =>
      promptIdContext.run(promptId, async () => {
        // 首 token 的起点是 submitMessage 而不是 user 帧入队：入队到 submit 之间还有
        // slash 拦截、回放帧、engine 装配，那些属于「我们的装配耗时」，单独成阶段记；
        // 这里量的是「请求交给引擎后多久见到第一个模型输出帧」，即接入方
        // session → thinking_start 里属于推理与服务端的那一段。
        const turnSubmitAt = Date.now();
        let firstTokenLogged = false;
        const source = runner.submitMessage(submitPrompt, {
          signal: controller.signal,
          promptId,
          userMessage: {
            uuid: userMessageUuid,
            ...(requestSetId ? { requestSetId } : {}),
          },
// fork 会话每轮带 sourceSessionId（调用级元数据，随请求进入计费/归因）；
// 与 resumeRunnerHistory 使用的源 id 是两份独立数据。
          ...(this.params.forked && this.resumeSnapshot?.sourceSessionId
            ? { sourceSessionId: this.resumeSnapshot.sourceSessionId }
            : {}),
          ...(customContext !== undefined ? { customContext } : {}),
// artifact 快照的唯一观察点；缺了它本轮产出不会进入 artifacts_update。
          onRawQueryEvent: (event) => this.broadcast?.observeQueryEvent(event),
          promptSuggestions: this.promptSuggestionsEnabled,
          shouldQuery: msg.shouldQuery,
          // 用户随本轮输入选中的 Skill。
          selectedSkills: msg.selected_skills,
          ...(msg.client_composed === true ? { skipSlashCommands: true } : {}),
          commandMode: msg.isSynthetic ? msg.commandMode : undefined,
          isMeta: msg.isSynthetic ? msg.isMeta : undefined,
          origin: msg.isSynthetic ? msg.origin : undefined,
          stopHookActive: msg.stopHookActive,
          // 宿主盖的 extra 元数据原样下传；合成轮不带，避免记成宿主提交。
          extra: msg.isSynthetic ? undefined : msg.extra,
          // 与 extra 同理：宿主附加的推理头只随真实输入进入引擎，合成轮不带。
          extraHeaders: msg.isSynthetic ? undefined : msg.extra_headers,
        });
        for await (const message of source) {
          if (isCancelledTurnResult(message)) {
            lifecycleState = 'cancelled';
          }
          // 压缩可能在 done/failed 之前就被中止，或走 NOOP 分支不发终态；
          // 结果帧是每轮必然出现的边界，用它兜底清掉残留的 compacting。
          if (message.type === 'result') {
            this.compressionStatusBridge?.clear();
          }
          // 引擎自己产出的 command_lifecycle 也要过同一道终态去重，否则宿主会收到两个终态。
          if (!this.commands.shouldForwardEngineMessage(message)) continue;
          // 首 token：第一个模型输出帧（流式增量或整条 assistant）。只记一次；
          // thinking 与正文不区分——接入方的 thinking_start 就是「模型开始输出」。
          if (
            !firstTokenLogged &&
            (message.type === 'stream_event' || message.type === 'assistant')
          ) {
            firstTokenLogged = true;
            markStartupMilestone('first_stream_event', this.sessionId);
            this.phaseLog.recordExternal(
              '首 token',
              '自本轮 submitMessage 到第一个模型输出帧（思考或正文）',
              Date.now() - turnSubmitAt,
            );
            this.phaseLog.summary('首 token 到达');
          }
          if (
            getStartupMilestone('first_text', this.sessionId) === undefined &&
            isFirstTextMessage(message)
          ) {
            this.markFirstResponse();
          }
          if (
            message.type === 'assistant' &&
            message.message.stop_reason === 'end_turn'
          ) {
            await this.broadcast?.waitForArtifacts();
          }
          // 原样交出引擎产出：错误 result 归一化与「结构化 user 帧要不要可见」都是 wire
          // 侧的呈现决定（normalizeSdkErrorResult / shouldEmitStructuredUserMessage），
          // 由宿主编解码器做，会话不参与。
          this.host.events.emit({ kind: 'threadMessage', message });
        }
      }),
    );
    return lifecycleState;
  }

  interruptTurn(): void {
    this.hooks.cancelStart();
    this.commands.interruptTurn();
  }

  /**
   * 进入 / 恢复工作树。必须在执行内核装配完成后调用：worktree 状态要写进 transcript，
   * 而 writer 随内核懒建。宿主负责把请求解析成产品数据（create / restore-inherited），
   * 并保证请求属于本会话的项目根。
   */
  async applyWorktreeStartupRequest(
    request: WorktreeStartupRequest,
  ): Promise<void> {
    await this.getQueryRunner();
    const transcriptWriter = this.transcriptWriter;
    if (!transcriptWriter) {
      throw new Error(
        `Thread session ${this.sessionId} has no transcript writer`,
      );
    }
    await applyWorktreeStartupRequestCore(this.requireConfig(), request, {
      record: (...args) => transcriptWriter.recordWorktreeState(...args),
    });
  }

  /** Persist the acknowledged session even before its first prompt. */
  async persistSessionCheckpoint(): Promise<void> {
    const runner = await this.getQueryRunner();
    await this.transcriptWriter?.recordActiveLeaf(
      runner.getMessages().at(-1)?.uuid ?? null,
      { explicit: true, durable: true },
    );
  }

  getTranscriptPath(): string | undefined {
    return this.transcriptWriter?.getSessionFilePath();
  }

  getQueryRunner(): Promise<SessionQueryRunner> {
    if (this.openingFailure) return Promise.reject(this.openingFailure);
    // 退休排干可继续借用已存在的 runner，但关信道后不能新建一个。
    if (this.runner) return Promise.resolve(this.runner);
    if (this.terminated)
      return Promise.reject(
        new Error(`Thread session ${this.sessionId} is closed`),
      );
    if (!this.runnerPromise) {
      this.runnerPromise = this.buildQueryRunner().catch((error) => {
        // 只有恢复读取/接管失败（或恢复状态已被消费后失败）才终结会话；
        // 候选仍在的普通装配错误按基线语义重试。
        if (
          isResumeReadError(error) ||
          (this.params.resumeTranscriptPath !== undefined &&
            !this.params.forked &&
            this.resumeCandidate === undefined)
        ) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          this.openingFailure = failure;
          this.terminate({ kind: 'runtime_error', error: failure });
          // 不等待当前 turn 的收尾，避免 cancelAndDrain 等待自身；只关闭本会话。
          void this.close().catch((cleanupError: unknown) =>
            this.logCloseFailure('resume failure', cleanupError),
          );
        } else {
          this.runnerPromise = null;
        }
        throw error;
      });
    }
    return this.runnerPromise;
  }

  /**
   * 打开完成即归还进程级读取名额；不随空闲时长占住全进程唯一的恢复租约。
   * 候选已按有效压缩边界投影，默认不以固定大小拒绝历史。接管前由
   * ensureResumeAttempt 重建租约。
   * 幂等；Manager 在 open 成功后也调用一次（外层 run 收尾后再释放）。
   */
  releaseResumeLease(): void {
    const attempt = this.resumeAttempt;
    if (!attempt) return;
    this.releasedResumeAttempt = attempt;
    this.resumeAttempt = undefined;
    attempt.finish();
  }

  /**
   * 懒建 runner 前为同一候选申请新 attempt：快照/种子校验与可能的整读都计入
   * 本次装配的预算和时限。候选只能来自本会话 open 时释放的那次读取。
   * fork 若有已读取的候选（如 headless 在 open 期间读取 fork 副本）同样需要重建；
   * 只有走 resumeData、没有候选的 fork 才跳过。
   */
  private async ensureResumeAttempt(): Promise<void> {
    if (this.resumeAttempt) return;
    const candidate = this.resumeCandidate;
    if (!candidate) return;
    if (candidate.attempt !== this.releasedResumeAttempt) {
      throw new ResumeReadError('unsafe');
    }
    const attempt = await beginResumeRead({
      signal: AbortSignal.any([
        this.resumeAbort.signal,
        this.sessionAbort.signal,
      ]),
    });
    this.resumeAttempt = attempt;
    this.releasedResumeAttempt = undefined;
    this.resumeCandidate = { ...candidate, attempt };
    if (this.resumeReadState) {
      this.resumeReadState = { ...this.resumeReadState, attempt };
    }
    if (this.resumeSnapshot) {
      this.resumeSnapshot.transcriptReadState = this.resumeReadState;
    }
  }

  /** 幂等结束；普通 candidate 的重复 Writer 种子不随会话长期驻留。 */
  private finishResumeRead(): void {
    this.resumeAttempt?.finish();
    this.resumeAttempt = undefined;
    this.releasedResumeAttempt = undefined;
    this.resumeCandidate = undefined;
    this.resumeReadState = undefined;
    this.pendingForkResumeData = undefined;
    this.forkTranscriptEntries = undefined;
    if (this.resumeSnapshot)
      this.resumeSnapshot.transcriptReadState = undefined;
  }

  /**
   * 把暂存的 runner 面声明写进执行内核；runner 未建时 no-op（等 buildQueryRunner 回放）。
   * 应用顺序与 applyInitializeDeclarations 一致：提示词来源 → memory 提示词 →
   * includePartialMessages → modelRequestPatches。
   */
  private applyRunnerDeclarationsToRunner(): void {
    const runner = this.runner;
    if (!runner) return;
    const pending = this.pendingRunnerDeclarations;
    if (pending.promptSources) {
      runner.updateSystemPromptSources(pending.promptSources);
    }
    if (pending.sdkMemoryPrompt) {
      runner.updateSdkMemoryPrompt(pending.sdkMemoryPrompt);
    }
    if (pending.includePartialMessages !== undefined) {
      runner.setIncludePartialMessages(pending.includePartialMessages);
    }
    if (pending.modelRequestPatches !== undefined) {
      runner.setModelRequestPatches(pending.modelRequestPatches);
    }
  }

  /**
   * 读 resume / fork 的恢复事实。
   *
   * plain resume 从 transcript 的 index metadata 取模型、推理档位与历史工作目录；
   * fork 的同一批事实由宿主翻译好（ThreadResumeData）直接给。两条链路落到同一个
   * `resumeSnapshot` 上，恢复模型与目录才不会只在其中一条链路上生效。
   */
  private async loadResumeMetadata(config: Config): Promise<void> {
    if (this.openingFailure) throw this.openingFailure;
    if (this.resumeMetadataLoaded) return;
    const forkData = this.pendingForkResumeData;
    if (forkData && this.params.forked) {
      this.resumeSnapshot = {
        sessionId: this.sessionId,
        messages: [...forkData.messages],
        fileHistorySnapshots: [...forkData.fileHistorySnapshots],
        sourceSessionId: forkData.sourceSessionId,
        ...(forkData.model === undefined ? {} : { model: forkData.model }),
        ...(forkData.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: forkData.reasoningEffort }),
        ...(forkData.contextWindow === undefined
          ? {}
          : { contextWindow: forkData.contextWindow }),
        ...(forkData.generation === undefined
          ? {}
          : { generation: forkData.generation }),
        ...(forkData.directories === undefined
          ? {}
          : { directories: [...forkData.directories] }),
        ...(forkData.worktreeSession === undefined
          ? {}
          : { worktreeSession: forkData.worktreeSession }),
      };
      this.resumeReadState = forkData.resumeState;
      this.cacheResumeArtifactStates(config, forkData.resumeState);
      this.pendingForkResumeData = undefined;
      this.resumeMetadataLoaded = true;
      return;
    }
    const resumeTranscriptPath = this.params.resumeTranscriptPath;
    if (resumeTranscriptPath === undefined) {
      if (this.resumeCandidate) throw new ResumeReadError('unsafe');
      this.resumeMetadataLoaded = true;
      return;
    }
    try {
      this.resumeAttempt ??= await beginResumeRead({
        signal: AbortSignal.any([
          this.resumeAbort.signal,
          this.sessionAbort.signal,
        ]),
      });
      const attempt = this.resumeAttempt;
      attempt.check();
      if (this.resumeAbort.signal.aborted)
        throw new ResumeReadError('cancelled');
      let candidate = this.resumeCandidate;
      if (
        candidate &&
        (this.params.forked ||
          candidate.sessionId !== this.sessionId ||
          candidate.attempt !== attempt ||
          path.resolve(candidate.filePath) !==
            path.resolve(resumeTranscriptPath))
      )
        throw new ResumeReadError('unsafe');
      candidate ??=
        (await config
          .getTranscriptStore()
          .repository()
          .readForResume(resumeTranscriptPath, {
            sessionId: this.sessionId,
            attempt,
            consistency: 'flush-pending',
          })) ?? undefined;
      attempt.check();
      if (this.resumeAbort.signal.aborted)
        throw new ResumeReadError('cancelled');
      if (!candidate) throw new ResumeReadError('snapshot');
      const runtime = candidate.metadata.runtimeConfigs.get(this.sessionId);
      const model =
        runtime?.model ??
        extractLastAssistantModelFromTranscript(candidate.messages);
      const directories = candidate.metadata.workspaceDirectories.get(
        this.sessionId,
      );
      const worktreeSession = candidate.metadata.worktreeSessions.get(
        this.sessionId,
      );
      const customTitle = candidate.metadata.customTitles.get(this.sessionId);
      this.resumeCandidate = candidate;
      this.resumeReadState = createBoundedResumeReadState(candidate);
      this.resumeSnapshot = {
        sessionId: this.sessionId,
        sessionPath: candidate.filePath,
        transcriptReadState: this.resumeReadState,
        messages: [...candidate.messages],
        fileHistorySnapshots: [...candidate.fileHistorySnapshots],
        sourceSessionId: candidate.sessionId,
        ...(model === undefined ? {} : { model }),
        ...(runtime?.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: runtime.reasoningEffort }),
        ...(runtime?.contextWindow === undefined
          ? {}
          : { contextWindow: runtime.contextWindow }),
        ...(runtime?.generation === undefined
          ? {}
          : { generation: runtime.generation }),
        ...(directories === undefined ? {} : { directories: [...directories] }),
        ...(worktreeSession === undefined ? {} : { worktreeSession }),
        ...(candidate.originalCwd === undefined
          ? {}
          : { originalCwd: candidate.originalCwd }),
        ...(customTitle === undefined ? {} : { customTitle }),
      };
      this.cacheResumeArtifactStates(config, this.resumeReadState);
      this.resumeMetadataLoaded = true;
    } catch (error) {
      this.openingFailure =
        error instanceof Error ? error : new Error(String(error));
      this.finishResumeRead();
      throw error;
    }
  }

  /** Cache accepted transcript state together with legacy sidecar and runtime worktree roots. */
  private cacheResumeArtifactStates(
    config: Config,
    state: TranscriptResumeReadState,
  ): void {
    if (!this.resumeSnapshot) return;
    const worktree = config.getWorktreeSettings();
    config.setSessionArtifactWorktreeStates(
      getResumeArtifactWorktreeStates(
        {
          ...this.resumeSnapshot,
          sessionId: state.sessionId,
          sessionPath: state.filePath,
          transcriptReadState: state,
        },
        [
          worktree
            ? toTranscriptWorktreeSession(worktree, this.sessionId)
            : undefined,
        ],
      ),
    );
  }

/**
 * 恢复运行配置（模型、推理档位、上下文窗、generation）；CLI 显式值优先。
 */
  private async applyResumeRuntimeConfig(config: Config): Promise<void> {
    const snapshot = this.resumeSnapshot;
    if (!snapshot || this.hasInitializeRuntimeOverride) return;
    const restored = await restoreRuntimeConfigFromResumeData(config, snapshot);
    runLogger.log('[thread-session] resume runtime config restored', {
      sessionId: this.sessionId,
      model: restored.model,
      reasoningEffort: restored.reasoningEffort,
      contextWindow: restored.contextWindow,
      generation:
        restored.generation === null
          ? 'cleared'
          : restored.generation === undefined
            ? undefined
            : 'configured',
    });
  }

/**
 * 恢复历史工作目录：同时进 WorkspaceContext 与权限目录；失败只告警。
 */
  private applyResumeWorkspaceDirectories(config: Config): void {
    const directories = (this.resumeSnapshot?.directories ?? []).filter(
      (directory) =>
        typeof directory === 'string' && directory.trim().length > 0,
    );
    if (directories.length === 0) return;
    try {
      const result = contextHandlers.addWorkspaceDirectories(
        config,
        directories,
      );
      if (result.added.length > 0) config.refreshRuntimeWorkspaceServices();
      runLogger.log('[thread-session] resume workspace directories restored', {
        sessionId: this.sessionId,
        added: result.added,
        failed: result.failed.length,
      });
    } catch (error) {
      runLogger.warn(
        '[thread-session] failed to restore workspace directories',
        { sessionId: this.sessionId, error },
      );
    }
  }

/**
 * 装配会话执行内核：transcript writer、FileHistory、模型路由、hook 协调器与
 * 生命周期观察者，交给 SessionQueryRunner 驱动 core `query()`。
 */
  private async buildQueryRunner(): Promise<SessionQueryRunner> {
    try {
      await this.ensureResumeAttempt();
      await this.loadResumeMetadata(this.requireConfig());
      const attempt = this.resumeAttempt;
      const assemble = () => this.assembleQueryRunner();
      const runner = attempt ? await attempt.run(assemble) : await assemble();
      // 运行态与 Writer 已接受同一快照，先释放临时名额，再写本次运行配置。
      this.finishResumeRead();
      if (this.transcriptWriter) {
        await recordTranscriptRuntimeConfig(
          this.requireConfig(),
          this.transcriptWriter,
          'headless_writer_created',
        );
      }
      return runner;
    } catch (error) {
      // 恢复读取/接管错误是终态；候选仍在说明只是普通装配失败（目录、模型等），
      // 保留恢复状态允许同打开周期重试，与基线“普通装配失败可重试”一致。
      if (isResumeReadError(error) || !this.resumeCandidate) {
        this.finishResumeRead();
      } else {
        // Keep the candidate for retry, but never keep process admission while idle.
        this.releaseResumeLease();
      }
      try {
        this.runner?.dispose();
      } catch (cleanupError) {
        this.logCloseFailure('failed runner', cleanupError);
      }
      this.runner = null;
      await this.transcriptWriter
        ?.close()
        .catch((cleanupError: unknown) =>
          this.logCloseFailure('failed writer', cleanupError),
        );
      this.transcriptWriter = undefined;
      throw error;
    }
  }

  private async assembleQueryRunner(): Promise<SessionQueryRunner> {
    const config = this.requireConfig();
    const settings = this.requireSettings();
    const cliArgs = this.params.cliArgs;
    const [version, gitBranch] = await Promise.all([
      getVersion(),
      getTranscriptGitBranch(config.getWorkingDir()),
    ]);

    const promptAssembler = new SystemPromptAssembler({
      sessionId: this.sessionId,
    });
    config.setPromptAssembler(promptAssembler);

    const isStreamJson = config.getOutputFormat() === OutputFormat.STREAM_JSON;
    const transcriptStore = config.getTranscriptStore();
    const resumeTranscriptPath = this.params.resumeTranscriptPath;
    let resumeHistory: ResumeHistoryData | null = this.resumeSnapshot
      ? {
          messages: this.resumeSnapshot.messages,
          fileHistorySnapshots: this.resumeSnapshot.fileHistorySnapshots ?? [],
          sourceSessionId:
            this.resumeSnapshot.sourceSessionId ?? this.sessionId,
        }
      : null;
    let resumeReadState: TranscriptResumeReadState | undefined =
      this.resumeReadState;
    const attempt = this.resumeAttempt;
    attempt?.check();
    const binding =
      attempt && this.resumeSnapshot
        ? createSessionResumeWriterBinding(
            this.resumeSnapshot,
            config.getProjectRoot(),
          )
        : undefined;
    if (attempt && !binding) throw new ResumeReadError('unsafe');
    const resumeOption: AcquireSessionWriterOptions['resume'] = resumeReadState
      ? {
          state: resumeReadState,
          onRefresh: async (session, state) => {
            // Core binding 在域外准备并校验项目/工作区（包括 legacy sidecar），不能先发布。
            let commit: (() => void) | undefined;
            try {
              commit = binding
                ? await binding.onRefresh(session, state)
                : undefined;
            } catch (error) {
              if (isResumeReadError(error)) throw error;
              throw new ResumeReadError('unsafe');
            }
            const refreshed: ResumeHistoryData = {
              messages: session.messages,
              fileHistorySnapshots: session.fileHistorySnapshots,
              sourceSessionId: this.params.forked
                ? (this.resumeSnapshot?.sourceSessionId ?? this.sessionId)
                : session.sessionId,
            };
            attempt?.check();
            return () => {
              commit?.();
              resumeReadState = state;
              this.resumeReadState = state;
              this.cacheResumeArtifactStates(config, state);
              resumeHistory = refreshed;
              if (!binding && this.resumeSnapshot) {
                this.resumeSnapshot.messages = [...refreshed.messages];
                this.resumeSnapshot.fileHistorySnapshots = [
                  ...refreshed.fileHistorySnapshots,
                ];
                this.resumeSnapshot.sourceSessionId = refreshed.sourceSessionId;
              }
            };
          },
        }
      : undefined;
    const transcriptWriter = config.getSessionPersistence()
      ? await transcriptStore.acquireSessionWriter({
          filePath:
            resumeTranscriptPath ??
            getSessionTranscriptPath(config.getProjectRoot(), this.sessionId),
          sessionId: this.sessionId,
          cwd: config.getWorkingDir(),
          entrypoint: HEADLESS_TRANSCRIPT_ENTRYPOINT,
          userType: 'external',
          version,
          gitBranch,
          initialWorkspaceDirectories:
            config.getWorkspaceContext()?.getDirectories?.() ?? [],
          ...(resumeOption ? { resume: resumeOption } : {}),
          ...(attempt ? { coldResume: { attempt } } : {}),
        })
      : undefined;
    this.transcriptWriter = transcriptWriter;
    attempt?.check();
    if (binding && resumeReadState !== resumeOption?.state)
      await this.applyResumeRuntimeConfig(config);
    if (this.terminated) {
      await transcriptWriter?.close();
      throw new Error(`Thread session ${this.sessionId} is closed`);
    }
// fork 接管源 worktree 时，先恢复 worktree 运行态（cwd / sidecar），再做
// legacy transcript 迁移；FileHistory 用恢复后的 cwd 创建。
    let acceptLegacyFileHistorySnapshots = !config.getWorktreeSettings();
    if (
      transcriptWriter &&
      this.params.forked &&
      this.resumeSnapshot?.worktreeSession !== undefined
    ) {
      const sourceWorktree = this.resumeSnapshot.worktreeSession;
      const outcome = await applyResumeWorktreeState(
        config,
        sourceWorktree,
        (...args) => transcriptWriter.recordWorktreeState(...args),
      );
      acceptLegacyFileHistorySnapshots =
        outcome.acceptLegacyFileHistorySnapshots;
      if (
        sourceWorktree &&
        !(outcome.status === 'fallback' && outcome.pendingCleanup)
      ) {
        await migrateLegacyWorktreeTranscript({
          sessionId: config.getSessionId(),
          selectedPath:
            this.params.resumeTranscriptPath ??
            transcriptWriter.getSessionFilePath(),
          originalCwd: sourceWorktree.originalCwd,
          relocate: async (originalCwd) => {
            await transcriptWriter.relocate({
              filePath: getSessionTranscriptPath(
                originalCwd,
                config.getSessionId(),
              ),
              cwd:
                outcome.worktreeSession?.worktreeCwd ??
                outcome.worktreeSession?.worktreePath ??
                originalCwd,
              gitBranch: outcome.worktreeSession?.worktreeBranch ?? gitBranch,
              worktreeSession: outcome.worktreeSession,
            });
          },
        });
      }
      if (resumeReadState)
        this.cacheResumeArtifactStates(config, resumeReadState);
      runLogger.log('[worktree.resume] restored fork worktree state', {
        sessionId: this.sessionId,
        status: outcome.status,
        cwd: config.getWorkingDir(),
      });
    }
    if (transcriptWriter) {
      // 先订阅，初始快照由 buildQueryRunner 在释放恢复名额后写入；两次写入之间
      // 发生的 set_model / set_config_option 也能被录制，不会按旧快照恢复成默认值。
      this.runtimeConfigRecorderUnsubscribe?.();
      this.runtimeConfigRecorderUnsubscribe =
        registerTranscriptRuntimeConfigRecorder(
          config,
          () => this.transcriptWriter,
          { sessionId: this.sessionId },
        );
    }
    config.setFileHistoryManager(
      new FileHistoryManager({
        cwd: config.getWorkingDir(),
        sessionId: this.sessionId,
        enabled:
          config.getSessionPersistence() &&
          config.getFileCheckpointingEnabled(),
        acceptLegacySnapshots:
          acceptLegacyFileHistorySnapshots && !config.getWorktreeSettings(),
        recordSnapshot: async (entry) => {
          await transcriptWriter?.recordFileHistorySnapshot(entry);
        },
      }),
    );

    const artifactRuntime = this.broadcast?.artifactRuntime;
    const hostTools =
      this.artifactPresentationEnabled && artifactRuntime
        ? [
            new PresentFilesTool(async (paths) => {
              const observation = await artifactRuntime.present(paths);
              return observation.presented;
            }),
          ]
        : [];
    const hiddenToolName = this.host.requests.hiddenToolName;
    const rootToolRegistry = new RootToolRegistry(
      config,
      () => config.getToolRegistry(),
      hostTools,
      hiddenToolName === undefined
        ? {}
        : { schemaFilter: (tool) => tool.name !== hiddenToolName },
    );
    const toolRegistryFactory: ToolRegistryFactory = {
      create: () => rootToolRegistry,
    };

    // 运行时绑定不在这里注册：`registerSessionRuntimeBinding` 是 Config 上的单槽，
    // SessionQueryRunner 构造时会用它自己那份完整绑定（多出 getTranscriptPath /
    // worktree 同步 / stripThoughts 三项）整体替换掉。早注册一份简版只会被覆盖，
    // 留下「以为生效其实没有」的读代码陷阱，所以直接不写。

    // 拉取式模型策略：SDK 声明 modelPolicyProvider 后才启用，回调按 isEnabled() 门禁。
    const getModelPolicy = createModelPolicyCallback({
      sessionId: this.sessionId,
      getModelPolicy: (payload, options) =>
        this.host.requests.getModelPolicy(payload, options),
      isEnabled: () => this.modelPolicyProviderEnabled,
    });
    // 镜像一份到 Config：子 agent 不经 SessionQueryRunner，只从 Config 取。
    config.setModelPolicyCallbacks(getModelPolicy);

    const runnerConfig: SessionQueryRunnerConfig = {
      sessionId: this.sessionId,
      promptSurface: isSDKMode() ? 'sdk' : 'headless',
      promptAssembler,
      customSystemPrompt: config.getCustomSystemPrompt() ?? undefined,
      appendSystemPrompt: config.getAppendSystemPrompt() ?? undefined,
      mainThreadAgentDefinition: config.getSessionAgentDefinitionLike(),
      defaultModel: config.getModel(),
      appVersion: version,
// `--max-turns` 缺省与显式 0 都表示不设上限。
      maxTurns: cliArgs.maxTurns === 0 ? undefined : cliArgs.maxTurns,
      compressionPipeline: new CompressionPipeline({
        target: 'main',
        modelProviderManager: config.getModelProviderManager(),
      }),
      includePartialMessages:
        isStreamJson && cliArgs.includePartialMessages === true,
      config,
      onSlashCommand: createSessionSlashHandler(config, settings),
      onBridgeSlashCommand: (input) => this.bridgeDecider().decide(input),
      hookCoordinator: config.getHookSystem()
        ? new DefaultHookCoordinator(config.getHookSystem()!)
        : new NoopHookCoordinator(),
      toolRegistryFactory,
      // 内核原始错误只给宿主做诊断输出（如 headless text 的 critical error），
      // 不进 wire；没有该回调的宿主自然忽略。
      onQueryError: (error) => this.host.requests.reportQueryError?.(error),
      ...(transcriptWriter ? { transcriptWriter } : {}),
      permissionMode: config.getPermissionMode(),
      buildAttachmentExternalContext: () => {
        const mcpManager = config.getMcpClientManager();
        const agentRegistry = config.getAgentRegistry?.();
        const memoryContextManager = config.getMemoryContextManager();
        return {
          sdkMemoryFileStates: config.getSdkMemoryFileStates?.() ?? [],
// @server:uri 资源展开的宿主入口；缺了它 MCP resource 不可用。
          mcpResources: createMcpResourceAttachmentSource(config),
          ...(mcpManager && {
            mcpClientManager: {
              getConnectedServerInstructions: () =>
                mcpManager.getConnectedServerInstructions(),
              getLazyMcpServerSnapshot: () =>
                mcpManager.getLazyMcpServerSnapshot(),
              peekLazyMode: () => mcpManager.peekLazyMode(),
            },
          }),
          ...(memoryContextManager && { memoryContextManager }),
          permissionMode: config.getPermissionMode(),
          plansDir: config.storage.getPlansDir(),
          sessionId: this.sessionId,
          toolRegistry: rootToolRegistry,
          ...(agentRegistry && { agentRegistry }),
        };
      },
    };

    const runner = new SessionQueryRunner(runnerConfig);
    try {
      await this.resumeRunnerHistory(runner, resumeHistory);
      if (attempt && !transcriptWriter) await this.acceptResumeWithoutWriter();
      attempt?.check();
      if (this.terminated || this.resumeAbort.signal.aborted) {
        if (attempt) throw new ResumeReadError('cancelled');
        throw new Error(`Thread session ${this.sessionId} is closed`);
      }
    } catch (error) {
      await runner.dispose();
      throw error;
    }
    this.runner = runner;
    this.runnerPromise = null;
    // 回放 runner 建好之前到达的 initialize 声明（见 pendingRunnerDeclarations）。
    this.applyRunnerDeclarationsToRunner();
// 宿主提供 canUseTool 时才装 can_use_tool 通道；否则走 hook-only 裁决。
// 不能两条都装：缺失回调会抢先落定，把 hook 的 allow 当迟到裁决丢弃。
    installThreadPermissionHandling({
      config,
      canUseTool: this.host.requests.canUseTool,
      permissionPromptChannel: this.host.requests.permissionPromptChannel,
      getSignal: () => this.commands.turnSignal(),
      onInterrupt: () => this.interruptTurn(),
    });
    if (isStreamJson && !this.mcpControlRef) {
      const mcpControl = createMcpControlModule({
        config,
        runLogger,
      });
      mcpControl.install();
      this.mcpControlRef = mcpControl;
    }
    runLogger.log('[thread-session] query runner ready', {
      sessionId: this.sessionId,
      model: config.getModel(),
    });
    return runner;
  }

  /** 无 Writer 时仍核对 descriptor snapshot；文件变化明确失败，不接受部分或迟到结果。 */
  private async acceptResumeWithoutWriter(): Promise<void> {
    const candidate = this.resumeCandidate;
    const attempt = this.resumeAttempt;
    if (!candidate || !attempt || candidate.attempt !== attempt)
      throw new ResumeReadError('unsafe');
    attempt.check();
    if (
      !(await matchesTranscriptSnapshot(candidate.filePath, candidate.snapshot))
    ) {
      throw new ResumeReadError('snapshot');
    }
    attempt.check();
  }

/**
 * resume 时把物化 transcript 的历史灌回 runner；不灌就是失忆会话。
 * 同时恢复 uuid 索引、attachment 上下文、turn 计数与 FileHistory。
 * `sourceSessionId` 只喂给 `runner.resume()`，不进 `submitMessage`。
 */
  private async resumeRunnerHistory(
    runner: SessionQueryRunner,
    resumeHistory: ResumeHistoryData | null,
  ): Promise<void> {
    const resumeTranscriptPath = this.params.resumeTranscriptPath;
    if (resumeTranscriptPath === undefined) return;
    if (!resumeHistory) {
      // 解析路径那一刻文件还在、这里读不到了（或内容无法投影）：
      // 当全新会话继续。resume 失败不该毁掉整个会话装配，与 loader 自己的 ENOENT 语义一致。
      runLogger.warn('[thread-session] resume transcript not loadable', {
        sessionId: this.sessionId,
        transcriptPath: resumeTranscriptPath,
      });
      return;
    }

    const config = this.requireConfig();
// resumeSessionAt / resumeDropsTurn 来自 argv。fork 的截断已在物化副本时完成，
// 这里传 undefined 避免用源 UUID 去命中已改写 id 的副本；plain resume 不做点位截断。
    const selected = selectSessionResumePoint(
      resumeHistory.messages,
      resumeHistory.fileHistorySnapshots,
      undefined,
      undefined,
    );
    const sourceSessionId = resumeHistory.sourceSessionId;

    await runner.resume(selected.messages, config.getSessionId(), {
      fileHistorySnapshots: selected.fileHistorySnapshots,
      persistFileHistoryToTranscript:
        this.params.forked !== true &&
        sourceSessionId !== config.getSessionId(),
      copyFileHistoryBackups: this.params.forked !== true,
      sourceSessionId,
    });
    runLogger.log('[thread-session] resumed transcript', {
      sessionId: this.sessionId,
      messages: selected.messages.length,
      fileHistorySnapshots: selected.fileHistorySnapshots?.length ?? 0,
      sourceSessionId,
    });
  }

  // ===========================================================================
  // control handler 支撑：后台任务、队列作废、SDK memory
  // ===========================================================================

  /**
   * 后台任务登记表按会话独占。
   *
   * 全局单例：`ExecutionLifecycleService` @ core/src/services/executionLifecycleService.ts
   * 是进程级 static，但它的读写都带 `sessionId` 参数，因此多会话下按会话隔离是成立的；
   * 处理：只桥接、不 terminateAll（close 里已注明）。
   */
  private setupTaskRegistry(config: Config): void {
    this.ownsTaskRegistry = config.taskRegistry === undefined;
    const registry = config.taskRegistry ?? new TaskRegistry();
    this.taskRegistryRef = registry;
    if (this.ownsTaskRegistry) {
      this.cleanupTaskRegistryBridge = bridgeExecutionLifecycleToRegistry(
        registry,
        { sessionId: this.sessionId, config },
      );
      config.taskRegistry = registry;
    }
    const onTaskChanged = (
      _taskId: string,
      task: { type: string; isBackgrounded?: boolean },
    ) => {
      if (isBackgroundAgentTask(task)) this.startBackgroundSubagentPump();
    };
    const onTaskRegistered = (task: {
      type: string;
      isBackgrounded?: boolean;
    }) => {
      if (isBackgroundAgentTask(task)) this.startBackgroundSubagentPump();
    };
    registry.on('task_registered', onTaskRegistered);
    registry.on('task_updated', onTaskChanged);
    this.cleanupBackgroundSubagentTaskListener = () => {
      registry.off('task_registered', onTaskRegistered);
      registry.off('task_updated', onTaskChanged);
    };
    if (registry.all().some(isBackgroundAgentTask)) {
      this.startBackgroundSubagentPump();
    }
  }

  /** 把带外 control 请求（stop_task / background_tasks）产生的任务事件立即刷到 wire。 */
  flushTaskControlEvents(): void {
    const config = this.config;
    if (!config) return;
    for (const event of drainSubagentSdkEvents(
      this.sessionId,
      (candidate) =>
        candidate.type === 'system' &&
        TASK_LIFECYCLE_SUBTYPES.has(candidate.subtype),
    )) {
      // 原样交出：错误 result 归一化与可见性判定都是宿主的呈现决定。
      this.host.events.emit({
        kind: 'threadMessage',
        message: projectTaskSystemEventForSdk(
          event as Extract<QueryEvent, { type: 'system' }>,
          this.sessionId,
        ),
      });
    }
  }

  /** `interrupt {cancel_queued:true}`：整批作废并逐个发 `cancelled` 终态。 */
  cancelQueuedCommands(commandUuids: readonly string[]): void {
    this.commands.cancelQueuedCommands(commandUuids);
  }

/**
 * 后台子 Agent 事件泵：turn 结束后 engine 不再消费其队列，这里按 TaskRegistry
 * 中仍在册的后台任务身份继续转发 progress 与正文增量。
 */
  private startBackgroundSubagentPump(): void {
    if (this.backgroundSubagentPump !== undefined) return;
    const timer = setInterval(
      () => this.pumpBackgroundSubagentEvents(),
      BACKGROUND_SUBAGENT_EVENT_PUMP_INTERVAL_MS,
    );
    timer.unref?.();
    this.backgroundSubagentPump = timer;
  }

  private stopBackgroundSubagentPump(): void {
    if (this.backgroundSubagentPump === undefined) return;
    clearInterval(this.backgroundSubagentPump);
    this.backgroundSubagentPump = undefined;
    this.backgroundSubagentTaskIds.clear();
    this.backgroundSubagentToolUseIds.clear();
  }

  private pumpBackgroundSubagentEvents(): void {
    try {
      if (this.sessionAbort.signal.aborted) {
        this.stopBackgroundSubagentPump();
        return;
      }
      const registry = this.taskRegistryRef;
      if (!registry) {
        this.stopBackgroundSubagentPump();
        return;
      }
      let hasBackgroundAgent = false;
      for (const task of registry.all()) {
        if (!isBackgroundAgentTask(task)) continue;
        hasBackgroundAgent = true;
        this.backgroundSubagentTaskIds.add(task.id);
        this.backgroundSubagentTaskIds.add(task.taskId);
        if (task.publicId) this.backgroundSubagentTaskIds.add(task.publicId);
        if (task.toolUseId)
          this.backgroundSubagentToolUseIds.add(task.toolUseId);
      }
      if (!hasBackgroundAgent) {
        this.stopBackgroundSubagentPump();
        return;
      }
      const runner = this.runner;
      if (!runner) return;
      for (const event of drainBackgroundSubagentEvents(this.sessionId, {
        taskIds: this.backgroundSubagentTaskIds,
        toolUseIds: this.backgroundSubagentToolUseIds,
      })) {
        for (const message of runner.projectSubagentEvent(event)) {
          this.host.events.emit({ kind: 'threadMessage', message });
        }
      }
    } catch (error) {
      runLogger.warn('[thread-session] background subagent event pump failed', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.stopBackgroundSubagentPump();
    }
  }

/**
 * `flush_memory` / `refresh_memory` / `flush_skill_evolution` 的实现体。
 * 未启用时抛错而不是静默成功，宿主需要知道 flush 没有落地。
 */
  async flushMemory(_ctx: ThreadCallContext): Promise<void> {
    if (!this.memoryEnabled) {
      throw new Error('SDK memory is not enabled for this session');
    }
    await this.waitForFlush(
      this.host.requests.memory?.flushMemory(),
      'flush_memory',
    );
  }

  async refreshMemory(_ctx: ThreadCallContext): Promise<void> {
    if (!this.memoryEnabled) {
      throw new Error('SDK memory is not enabled for this session');
    }
    await this.host.requests.memory?.refreshMemory();
    this.peekQueryRunner()?.refreshRuntimeContext({
      invalidateRequestSnapshot: true,
    });
  }

  async flushSkillEvolution(_ctx: ThreadCallContext): Promise<void> {
    if (!this.skillEvolutionEnabled) {
      throw new Error('SDK skill evolution is not enabled for this session');
    }
    await this.waitForFlush(
      this.host.requests.memory?.flushSkillEvolution(),
      'flush_skill_evolution',
    );
  }

  /**
   * 有界等待后台管线 flush：超时只告警并回执，排干继续留在后台。
   * 超时后的失败也只记日志，避免 unhandled rejection；超时前失败仍原样上抛，
   * 保持 host 能看到真实错误。
   */
  private async waitForFlush(
    flush: Promise<void> | undefined,
    operation: 'flush_memory' | 'flush_skill_evolution',
  ): Promise<void> {
    if (flush === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      flush.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(
          () => resolve('timeout'),
          FLUSH_CONTROL_WAIT_BOUND_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'settled') return;
    void flush.catch((error: unknown) => {
      runLogger.warn('[thread-session] flush failed after wait bound', {
        sessionId: this.sessionId,
        operation,
        error,
      });
    });
    runLogger.warn(
      '[thread-session] flush control hit its wait bound; teardown continues in background',
      {
        sessionId: this.sessionId,
        operation,
        waitMs: FLUSH_CONTROL_WAIT_BOUND_MS,
      },
    );
  }

/**
 * 关闭前等在途记忆与 AutoDream 管线排干，避免 Config 释放后仍有写盘访问。
 * 任一管线失败也要等其余结束，再抛出聚合错误。
 */
  private async drainSessionPipelines(config: Config): Promise<void> {
    // 一条管线失败也要等其他管线结束，避免释放 Config 后仍有后台任务访问它。
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.host.requests.memory?.drain()),
      Promise.resolve().then(() => drainAutoDream(config)),
    ]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, 'Session pipelines failed');
  }

/** 退出前：排干主线续跑、等待并强收后台任务，逐个上报停止事实。 */
  private async drainBackgroundWork(): Promise<void> {
    const taskRegistry = this.taskRegistryRef;
    if (!taskRegistry) return;
    await drainBackgroundWorkBeforeClose({
      sessionId: this.sessionId,
      taskRegistry,
      notifyStopped: (notification) =>
        this.host.events.emit({
          kind: 'notice',
          notice: { kind: 'taskNotification', notification },
        }),
      signal: this.sessionAbort.signal,
      policy:
        this.params.backgroundWindDownPolicy ??
        DEFAULT_BACKGROUND_WIND_DOWN_POLICY,
      hasQueuedContinuation: () => this.commands.hasOwnContinuation(),
      drainContinuations: () => this.commands.drainContinuations(),
    });
  }

  // ===========================================================================
  // initialize 请求里会改变会话装配的声明
  // ===========================================================================

/**
 * 集中应用 `initialize` 中会改变会话装配的声明；相对顺序由本方法保证。
 *
 * 硬约束：artifact 解析早于 init 帧；`modelPolicyProvider` 早于推理就绪；
 * hooks 早于回包。提示词类声明必须一次更新，避免互相覆盖；agent 注册放在最后。
 */
  async applyInitializeDeclarations(
    declarations: ThreadSessionDeclarations,
  ): Promise<void> {
    const config = this.requireConfig();

// 非法值直接抛，不静默忽略；作用域与 permissionMode 无关，放在方法首位即可。
    if (Object.prototype.hasOwnProperty.call(declarations, 'goalMaxTurns')) {
      const goalMaxTurns = declarations.goalMaxTurns;
      if (typeof goalMaxTurns !== 'number') {
        throw new Error('goalMaxTurns must be a number');
      }
      // 显式传 sessionId：daemon 进程里无参调用会落到 daemon 根 config。
      this.requireConfig().getGoalManager().setGoalMaxTurns(goalMaxTurns);
    }

    if (
      declarations.includeShellProgress === true &&
      !this.unsubscribeToolProgress
    ) {
      config.setShellProgressEnabled(true);
      this.unsubscribeToolProgress = attachSessionToolProgress({
        snapshots: config.toolCallSnapshots,
        emitNotice: (notice) => this.emitNotice(notice),
      });
    }

    this.modelPolicyProviderEnabled = declarations.modelPolicyProvider === true;
    this.resolveSessionArtifactsEnabled =
      declarations.resolveSessionArtifacts === true;
    this.artifactPresentationEnabled =
      declarations.artifactPresentation === true;
    if (
      this.resolveSessionArtifactsEnabled &&
      this.artifactPresentationEnabled
    ) {
      throw new Error(
        'resolveSessionArtifacts and artifactPresentation are mutually exclusive',
      );
    }
    this.catalogReadyInitializeEnabled =
      supportsCatalogReadyInitialize(declarations);

    const artifactRuntime = this.broadcast?.artifactRuntime;
    if (artifactRuntime) {
      if (this.resolveSessionArtifactsEnabled) {
        artifactRuntime.setHostRefresh(
          createHostArtifactRefresh({
            config,
            sessionId: this.sessionId,
            resolveSessionArtifacts: (payload, options) =>
              this.host.requests.resolveSessionArtifacts(payload, options),
            sessionSignal: this.sessionAbort.signal,
          }),
        );
      } else {
        artifactRuntime.clearHostRefresh();
      }
    }

    // ── SDK memory / skill evolution（宿主实现） ──
    const memoryHost = this.host.requests.memory;
    let memoryPromptUpdate: ThreadMemoryPromptUpdate | undefined;
    let hasMemoryDeclaration = false;
    if (memoryHost) {
      const prepared = await memoryHost.prepare({ declarations, config });
      this.memoryEnabled = prepared.memoryEnabled;
      this.skillEvolutionEnabled = prepared.skillEvolutionEnabled;
      this.effectiveMemory = prepared.effectiveMemory;
      this.effectiveSkillEvolution = prepared.effectiveSkillEvolution;
      memoryPromptUpdate = prepared.memoryPromptUpdate;
      hasMemoryDeclaration = prepared.memoryEnabled;
    }

    // ── 提示词装配（三个来源共用一次 updateSystemPromptSources） ──
    // runner 懒建，initialize 握手期必然还没建：声明先落 pendingRunnerDeclarations，
    // 由 applyRunnerDeclarationsToRunner 决定立即应用还是等 buildQueryRunner 回放。
    // runner 已存在（首轮之后的再声明）时立即应用，与旧行为一致。
    const hasSystemPrompt = isStringProp(declarations, 'systemPrompt');
    const hasAppendSystemPrompt = isStringProp(
      declarations,
      'appendSystemPrompt',
    );
    if (
      hasSystemPrompt ||
      hasAppendSystemPrompt ||
      memoryPromptUpdate?.owner === 'sdk'
    ) {
      this.pendingRunnerDeclarations.promptSources = {
        overrideSystemPrompt: hasSystemPrompt
          ? declarations['systemPrompt']
          : null,
        appendSystemPrompt: hasAppendSystemPrompt
          ? declarations['appendSystemPrompt']
          : null,
      };
    }
    // 只有 SDK 声明了 memory 才改 runner 的记忆提示词，否则保持 native 默认。
    if (hasMemoryDeclaration) {
      this.pendingRunnerDeclarations.sdkMemoryPrompt = memoryPromptUpdate ?? {
        owner: 'none',
      };
    }
    this.applyRunnerDeclarationsToRunner();

    // ── 模型 / 推理参数 ──
    if (isStringProp(declarations, 'model')) {
      config.setModel(declarations['model'], true);
      this.hasInitializeRuntimeOverride = true;
    }
    // wire 上推理参数有 camel/蛇形两种拼写；宿主胶水已合并进中立字段。
    // 显式 null 表示清掉，与「没传」不同。
    const initializeReasoningEffort = parseReasoningEffortLevel(
      declarations.reasoningEffort,
    );
    const initializeContextWindow =
      parseContextWindowControlValue(declarations);
    // 显式 null 表示清掉，与「没传」不同。
    const initializePatch: ModelConfig = {
      ...(initializeReasoningEffort !== undefined ||
      declarations.clearReasoningEffort === true
        ? { reasoning: { effort: initializeReasoningEffort } }
        : {}),
      ...(initializeContextWindow.kind === 'set'
        ? { context: { contextWindow: initializeContextWindow.value } }
        : initializeContextWindow.kind === 'clear'
          ? { context: { contextWindow: undefined } }
          : {}),
    };
    if (initializePatch.reasoning || initializePatch.context) {
      await setModelPreference(config, initializePatch);
      this.hasInitializeRuntimeOverride = true;
    }
    if (isBooleanProp(declarations, 'includePartialMessages')) {
      this.pendingRunnerDeclarations.includePartialMessages =
        declarations['includePartialMessages'];
    }
    if (declarations.modelRequestPatches !== undefined) {
      // 声明期就解析：非法 patch 在 initialize 回错，与旧的立即解析同语义，不推迟到首轮。
      this.pendingRunnerDeclarations.modelRequestPatches =
        parseModelPromptPatches(declarations.modelRequestPatches);
    }
    this.applyRunnerDeclarationsToRunner();

    // ── skill 白名单 ──
    // 非法白名单直接抛，不静默降级。
    const skills = declarations.skills;
    if (skills !== undefined) {
      if (
        !Array.isArray(skills) ||
        !skills.every((skill) => typeof skill === 'string')
      ) {
        throw new Error('invalid skills allowlist');
      }
      config.getSkillManager().setSessionSkillAllowlist(skills);
    }

    // ── hook / MCP server / agent 注入 ──
    registerHostHooks({
      config,
      sessionId: this.sessionId,
      declarations,
      runHookCallback: (hookName, payload, options) =>
        this.host.requests.runHookCallback(hookName, payload, {
          ...options,
          // SessionEnd 收尾窗口内发出的 hook 回调要打标，宿主才肯放行（窗口打开期间
          // 跑的只有 SessionEnd hook：turn 已排干、runner 已中止）。标记与窗口双重
          // 校验，缺一个都过不去，见 host/sessionEndCloseout.ts 与 sessionHost.ts。
          ...(this.sessionEndCloseout.view() !== null
            ? { sessionEndCloseout: true }
            : {}),
        }),
    });
    await registerHostMcpServers({
      config,
      declarations,
      sendMcpMessage: (payload, options) =>
        this.host.requests.sendMcpMessage(payload, options),
    });
    await registerHostAgents({ config, declarations });
  }

  /**
   * 声明产物（memory / skill evolution 的有效配置回执）；没有声明时返回 undefined。
   * wire 键位（`memory` / `evolution: {skill}`）由宿主的回包组装补
   * （sdk/thread/initializeResponse.ts），本方法只交产品字段。
   */
  getInitializeDeclarationProducts():
    | ThreadInitializeDeclarationProducts
    | undefined {
    if (!this.effectiveMemory && !this.effectiveSkillEvolution) {
      return undefined;
    }
    return {
      ...(this.effectiveMemory ? { memory: this.effectiveMemory } : {}),
      ...(this.effectiveSkillEvolution
        ? { skillEvolution: this.effectiveSkillEvolution }
        : {}),
    };
  }

  /**
   * 供 `inferenceReadiness.ts` 经 context getter 读取。必须按调用时的值读取：
   * 声明处理早于 ensure()，装配期快照会读到声明前的 false。消费语义见字段注释。
   */
  isCatalogReadyInitializeEnabled(): boolean {
    return this.catalogReadyInitializeEnabled;
  }

  /**
   * initialize 回包后 best-effort 恢复 Host artifact 快照；失败只记 debug，不影响回包。
   */
  recoverHostArtifacts(): void {
    if (!this.resolveSessionArtifactsEnabled) return;
    const artifactRuntime = this.broadcast?.artifactRuntime;
    if (!artifactRuntime) return;
    void artifactRuntime.recoverHostSnapshot().catch((error) => {
      runLogger.debug('[thread-session] initial host artifact refresh failed', {
        sessionId: this.sessionId,
        error,
      });
    });
  }

  // ===========================================================================
  // control handler 上下文
  // ===========================================================================

  // ===========================================================================
  // 出站
  // ===========================================================================

/**
 * 当前能力快照；宿主渲染成上游的 `system/init`。SDK 靠这一帧发现能力，
 * 缺失会在第一个 result 到达时关闭会话。时机：握手回包前与每轮提交前。
 */
  async sessionSnapshot(): Promise<ThreadSessionSnapshot> {
    const config = this.requireConfig();
    const snapshot = await collectSessionInitSnapshot(
      config,
      this.sessionAbort.signal,
      { hiddenToolName: this.host.requests.hiddenToolName },
    );
    return this.independentPlanModeControls
      ? { ...snapshot, permissionMode: config.getPermissionMode() }
      : snapshot;
  }

  async emitInitMessage(): Promise<void> {
    this.host.events.emit({
      kind: 'sessionSnapshot',
      snapshot: await this.sessionSnapshot(),
    });
// init 帧之后发布 AGENTS.md 超限快照。
    this.agentsMdSizeWarningBridge?.onInitialized();
// init 帧之后用 runner 消息快照初始化 artifact；runner 懒建，未建时等下一次 init。
    await this.broadcast?.initializeArtifacts();
  }

  /** fork 会话在 `--session-mirror` 下补发继承历史的初始快照。 */
  private async emitForkTranscriptMirror(): Promise<void> {
    const filePath = this.params.resumeTranscriptPath;
    if (!this.params.forked || filePath === undefined) {
      return;
    }
    const entries = this.forkTranscriptEntries;
    this.forkTranscriptEntries = undefined;
    if (!entries) {
      throw new Error(
        `Fork transcript entries are unavailable for mirroring: ${filePath}`,
      );
    }
    for (const chunk of chunkForkTranscriptEntries(entries)) {
      this.host.events.emit({
        kind: 'transcriptMirror',
        filePath,
        entries: chunk,
      });
    }
  }

  // ===========================================================================
  // 消息队列与插话
  // ===========================================================================

  /**
   * 投递一条用户消息。**同步分类 + 入队后立即返回**，绝不等 turn 跑完：宿主的读循环
   * 对每帧都要投递，而进程内所有会话共享一个事件循环，在这里跑完一整轮会卡死其余会话
   * 与宿主的查询面。真正的派发在命令管理器的 `pump()` 里，进度与终态经事件报出去。
   */
  async submitMessage(
    _ctx: ThreadCallContext,
    message: ThreadUserMessage,
  ): Promise<ThreadSubmission> {
    if (this.openingFailure) throw this.openingFailure;
    const restriction = this.config?.getPermissionModeRestriction(
      this.config.getPermissionMode(),
    );
    return this.commands.submit(
      message,
      restriction ? new PermissionModeUnavailableError(restriction) : undefined,
    );
  }

  /**
   * 中止当前 turn。**顺序是硬的**：先打断在跑的 turn，再取排队快照——反过来的话快照里
   * 会少掉被打断那一轮自己重新入队的续跑命令。
   */
  async interrupt(
    _ctx: ThreadCallContext,
    options?: { cancelQueued?: boolean },
  ): Promise<ThreadInterruptResult> {
    this.hooks.cancelStart();
    return this.commands.interrupt(options);
  }

  /**
   * 按 commandUuid 作废一条**仍在排队**的消息。命中在途批次时回 `cancelled: false`：
   * 批次结算时会整批丢弃，但此刻命令已被取走，不能声称取消成功。
   */
  cancelQueuedMessage(commandUuid: string): { cancelled: boolean } {
    return this.commands.cancelQueuedMessage(commandUuid);
  }

  /** 当前排队中的命令 uuid。`interrupt` 与 `rewind` 的空闲门禁要用。 */
  queuedCommandUuids(): readonly string[] {
    return this.commands.queuedUuids();
  }

  isTurnRunning(): boolean {
    return this.commands.isTurnRunning();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

/**
 * 本会话已启用的插件（含 `--plugin-dir` 的 flag 来源）。
 * 会话尚未装配时返回空，不因启动中而失败。
 */
  getEnabledPlugins(): readonly LoadedPlugin[] {
    return this.config?.getEnabledPlugins() ?? [];
  }

  // ===========================================================================
  // 出站：会话只产语义事件，wire 形状一律归宿主
  // ===========================================================================

  /** 一条会话级状态通知（模型目录 / 命令目录 / 产物 / 状态 / plan / goal / hook / 记忆）。 */
  private emitNotice(notice: ThreadNotice): void {
    this.host.events.emit({ kind: 'notice', notice });
  }

  private terminate(termination: ThreadTerminationReason): void {
    if (this.terminated) return;
    this.terminated = true;
    // resolve 而不是回调：承接方 attach 在 ThreadSession.termination 上，promise 语义
    // 保证它恰好收到一次，这里不需要自己防重入之外的任何记账。
    this.resolveTermination(termination);
  }

  /** Once per session: later turns reach `first_text` again but are not startup. */
  private markFirstResponse(): void {
    if (getStartupMilestone('first_text', this.sessionId) !== undefined) return;
    markStartupMilestone('first_text', this.sessionId);
  }

  requireConfig(): Config {
    if (this.openingFailure) throw this.openingFailure;
    if (!this.config) {
      throw new Error(`Thread session ${this.sessionId} is not started`);
    }
    return this.config;
  }

  requireSettings(): LoadedSettings {
    if (!this.settings) {
      throw new Error(`Thread session ${this.sessionId} is not started`);
    }
    return this.settings;
  }

  /** 本会话设置加载所用的来源过滤；apply_flag_settings 重载设置时复用同一份。 */
  getSettingSources(): readonly SettingSource[] | undefined {
    return this.settingSources;
  }

  requireTaskRegistry(): TaskRegistry {
    if (!this.taskRegistryRef) {
      throw new Error(`Thread session ${this.sessionId} is not started`);
    }
    return this.taskRegistryRef;
  }

// 能力面：每个方法一行委托给 handlers/；状态与装配产物留在本类。

  // ── goalHandlers ──

  setGoal(
    ctx: ThreadCallContext,
    goal: {
      objective?: string;
      status?: string;
      creditsBudget?: number | null;
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<ThreadGoalResult> {
    return goalHandlers.setGoal(this, ctx, goal);
  }

  setGoalMaxTurns(
    ctx: ThreadCallContext,
    maxTurns: number | null,
  ): Promise<{ goalMaxTurns: number }> {
    return goalHandlers.setGoalMaxTurns(this, ctx, maxTurns);
  }

  getGoal(ctx: ThreadCallContext): Promise<ThreadGoalResult> {
    return goalHandlers.getGoal(this, ctx);
  }

  resumeGoal(ctx: ThreadCallContext): Promise<ThreadGoalResult> {
    return goalHandlers.resumeGoal(this, ctx);
  }

  clearGoal(ctx: ThreadCallContext): Promise<{ cleared: boolean }> {
    return goalHandlers.clearGoal(this, ctx);
  }

  // ── modeHandlers ──

  setPermissionMode(
    ctx: ThreadCallContext,
    request: { mode: string; preservePlanMode?: boolean },
  ): Promise<void> {
    return modeHandlers.setPermissionMode(this, ctx, request);
  }

  setPlanMode(
    ctx: ThreadCallContext,
    active: boolean,
  ): Promise<ThreadPlanModeResult> {
    return modeHandlers.setPlanMode(this, ctx, active);
  }

  getPlanMode(ctx: ThreadCallContext): Promise<ThreadPlanModeResult> {
    return modeHandlers.getPlanMode(this, ctx);
  }

  // ── modelHandlers ──

  setModel(
    ctx: ThreadCallContext,
    request: {
      model?: string;
      reasoningEffort?: string | null;
      contextWindow?: unknown;
    },
  ): Promise<void> {
    return modelHandlers.setModel(this, ctx, request);
  }

  setContextWindow(ctx: ThreadCallContext, value: unknown): Promise<void> {
    return modelHandlers.setContextWindow(this, ctx, value);
  }

  setMaxThinkingTokens(
    ctx: ThreadCallContext,
    maxThinkingTokens: number,
  ): Promise<void> {
    return modelHandlers.setMaxThinkingTokens(this, ctx, maxThinkingTokens);
  }

  // ── contextHandlers ──

  addDirectories(
    ctx: ThreadCallContext,
    directories: readonly string[],
  ): Promise<ThreadAddDirectoriesResult> {
    return contextHandlers.addDirectories(this, ctx, directories);
  }

  seedReadState(
    ctx: ThreadCallContext,
    entries: ReadonlyArray<{ path: string; mtime: number }>,
  ): Promise<void> {
    return contextHandlers.seedReadState(this, ctx, entries);
  }

  rewind(
    ctx: ThreadCallContext,
    request: { userMessageId: string; scope?: string; dryRun?: boolean },
  ): Promise<ThreadRewindResult> {
    return contextHandlers.rewind(this, ctx, request);
  }

  rewindFiles(
    ctx: ThreadCallContext,
    request: { userMessageId: string; dryRun?: boolean },
  ): Promise<ThreadRewindResult> {
    return contextHandlers.rewindFiles(this, ctx, request);
  }

  getContextUsage(ctx: ThreadCallContext): Promise<Record<string, unknown>> {
    return contextHandlers.getContextUsage(this, ctx);
  }

  // ── configurationHandlers ──

  getSettings(ctx: ThreadCallContext): Promise<Record<string, unknown>> {
    return configurationHandlers.getSettings(this, ctx);
  }

  applyFlagSettings(
    ctx: ThreadCallContext,
    settings: Record<string, unknown>,
  ): Promise<ThreadAppliedFlagSettings> {
    return configurationHandlers.applyFlagSettings(this, ctx, settings);
  }

  reloadPlugins(ctx: ThreadCallContext): Promise<Record<string, unknown>> {
    return configurationHandlers.reloadPlugins(this, ctx);
  }

  reloadSkills(ctx: ThreadCallContext): Promise<Record<string, unknown>> {
    return configurationHandlers.reloadSkills(this, ctx);
  }

  setProxy(
    ctx: ThreadCallContext,
    proxy: string | undefined,
  ): Promise<ThreadProxyResult> {
    return configurationHandlers.setProxy(this, ctx, proxy);
  }

  /** daemon 级代理继承：只更新本会话 Config，进程级 runtime 由宿主统一重建。 */
  applyDaemonProxy(proxy: string | undefined): void {
    this.requireConfig().setProxy(proxy);
  }

  // ── taskHandlers ──

  stopTask(ctx: ThreadCallContext, taskId: string): Promise<ThreadTaskResult> {
    return taskHandlers.stopTask(this, ctx, taskId);
  }

  backgroundTasks(
    ctx: ThreadCallContext,
    options?: { toolUseId?: string },
  ): Promise<ThreadTaskResult> {
    return taskHandlers.backgroundTasks(this, ctx, options);
  }

  // ── metaHandlers ──

  generateSessionTitle(
    ctx: ThreadCallContext,
    request: {
      sourceUserMessageId?: string;
      description?: string;
      persist?: boolean;
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<ThreadSessionTitleResult> {
    return metaHandlers.generateSessionTitle(this, ctx, request);
  }

  setSessionTitle(ctx: ThreadCallContext, title: string): Promise<void> {
    return metaHandlers.setSessionTitle(this, ctx, title);
  }

  getSessionIdentity(ctx: ThreadCallContext): Promise<Record<string, unknown>> {
    return metaHandlers.getSessionIdentity(this, ctx);
  }

  sideQuestion(
    ctx: ThreadCallContext,
    request: {
      question: string;
      history?: readonly unknown[];
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<ThreadSideQuestionResult> {
    return metaHandlers.sideQuestion(this, ctx, request);
  }

  // ── mcpHandlers ──

  setMcpServers(
    ctx: ThreadCallContext,
    servers: readonly unknown[],
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.setMcpServers(this, ctx, servers);
  }

  reconnectMcp(
    ctx: ThreadCallContext,
    serverName?: string,
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.reconnectMcp(this, ctx, serverName);
  }

  toggleMcp(
    ctx: ThreadCallContext,
    serverName: string,
    enabled: boolean,
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.toggleMcp(this, ctx, serverName, enabled);
  }

  mcpStatus(ctx: ThreadCallContext): Promise<ThreadMcpResult> {
    return mcpHandlers.mcpStatus(this, ctx);
  }

  injectMcpToken(
    ctx: ThreadCallContext,
    payload: unknown,
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.injectMcpToken(this, ctx, payload);
  }

  authenticateMcp(
    ctx: ThreadCallContext,
    payload: unknown,
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.authenticateMcp(this, ctx, payload);
  }

  mcpOAuthCallbackUrl(
    ctx: ThreadCallContext,
    payload: unknown,
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.mcpOAuthCallbackUrl(this, ctx, payload);
  }

  clearMcpAuth(
    ctx: ThreadCallContext,
    payload: unknown,
  ): Promise<ThreadMcpResult> {
    return mcpHandlers.clearMcpAuth(this, ctx, payload);
  }

  // ── initializeHandlers ──

  /**
   * 握手。八步顺序是硬的，逐条出处见 handlers/initializeHandlers.ts 的头注；回包出门
   * 之后的三步收尾经返回值的 `afterResponseSent` 交回宿主执行。
   */
  initialize(
    ctx: ThreadCallContext,
    declarations: ThreadSessionDeclarations,
  ): Promise<ThreadInitializeResult> {
    return initializeHandlers.initialize(this, ctx, declarations);
  }

// handlers/ 内部包视图：用方法而非字段快照暴露可变状态，保证取值时机一致。

  get cwd(): string {
    return this.params.cwd;
  }

  get cliArgs(): CliArgs {
    return this.params.cliArgs;
  }

  /** 会话级中止信号。反向请求与长等待默认挂它。 */
  get signal(): AbortSignal {
    return this.sessionAbort.signal;
  }

  /**
   * 当前打开的 SessionEnd 收尾窗口；未打开时是 null。宿主（SDKServer）的出站门禁
   * 每次放行前现读它——窗口只在 close() 的 fireEnd 期间打开，见 host/sessionEndCloseout.ts。
   */
  get sessionEndCloseoutView(): SessionEndCloseoutView | null {
    return this.sessionEndCloseout.view();
  }

  /** 会话独占的后台任务登记表；未装配时抛。 */
  get taskRegistry(): TaskRegistry {
    return this.requireTaskRegistry();
  }

  /** MCP 控制面；runner 装配好之前是 undefined（它要 config.getMcpClientManager()）。 */
  get mcpControl(): McpControlModule | undefined {
    return this.mcpControlRef;
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  /** 当前已装配的 runner；懒建，未建时回 null，不触发装配。 */
  peekQueryRunner(): SessionQueryRunner | null {
    return this.runner;
  }

  /** 触发 runner 装配并等它就绪（memoized，失败可重试）。 */
  ensureQueryRunner(): Promise<SessionQueryRunner> {
    return this.getQueryRunner();
  }

  setInitialized(value: boolean): void {
    this.initialized = value;
  }

  getCurrentSettings(): LoadedSettings {
    return this.requireSettings();
  }

  setCurrentSettings(value: LoadedSettings): void {
    this.settings = value;
  }

  /** 懒建 bridge 判定器：命令面重载后调 `invalidate()`，下一次判定重建 service。 */
  private bridgeDecider(): SessionBridgeSlashDecider {
    if (!this.bridgeSlashDecider) {
      this.bridgeSlashDecider = new SessionBridgeSlashDecider(
        this.requireConfig(),
        this.sessionAbort.signal,
      );
    }
    return this.bridgeSlashDecider;
  }

  getPromptSuggestionsEnabled(): boolean {
    return this.promptSuggestionsEnabled;
  }

  setPromptSuggestionsEnabled(value: boolean): void {
    this.promptSuggestionsEnabled = value;
    if (!value && getPromptSuggestionFeatureConfig().forkEnabled) {
      this.runner?.cancelPromptSuggestion();
    }
  }

  isIndependentPlanModeControls(): boolean {
    return this.independentPlanModeControls;
  }

  setIndependentPlanModeControls(value: boolean): void {
    this.independentPlanModeControls = value;
  }

  /** 请求结束会话。等价于宿主调 `close()`，但由会话内部触发。 */
  endSession(): void {
    void this.close();
  }

  /** 推理面就绪（绑 auth → 等目录可信 → 对齐模型），见 inferenceReadiness.ts。 */
  ensureInferenceReady(): Promise<void> {
    return this.inference.ensure();
  }

  /** SessionStart hook：先确保 runner 装配好再跑一次，见 sessionHooks.ts。 */
  ensureSessionStartHooks(): Promise<void> {
    return this.hooks.ensureStart();
  }

  /** 产出能力快照事件。握手回包之前、以及每轮提交之前各一次。 */
  emitInitSnapshot(): Promise<void> {
    return this.emitInitMessage();
  }

/**
 * 启动会话状态广播面；必须在 initialize 回包之后，否则命令目录会被再发一次变更。
 */
  startSessionBroadcast(
    declarations: ThreadSessionDeclarations,
    initialCommands: readonly unknown[],
  ): void {
    this.broadcast?.startAfterInitialize({
      declarations,
      initialCommands: initialCommands as never,
    });
  }
}

function normalizeRequestSetId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

/** 判断对象上的布尔属性。 */
function isBooleanProp<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<string, unknown> & Record<K, boolean> {
  const val = obj[key];
  return key in obj && typeof val === 'boolean';
}

/** catalog-ready initialize 的最短超时声明。 */
const SDK_CATALOG_READY_INITIALIZE_MIN_TIMEOUT_MS = 120_000;

/** 后台子 Agent 事件泵的轮询间隔；与宿主 live projection 的轮询同量级。 */
const BACKGROUND_SUBAGENT_EVENT_PUMP_INTERVAL_MS = 250;

/**
 * `supportsCatalogReadyInitialize`：显式能力位，或宿主给出足够长的
 * `initializeTimeoutMs`。本会话只用它驱动完整运行时就绪。
 */
function supportsCatalogReadyInitialize(
  declarations: ThreadSessionDeclarations,
): boolean {
  if (declarations.supportsCatalogReadyInitialize === true) {
    return true;
  }
  const initializeTimeoutMs = declarations.initializeTimeoutMs;
  return (
    typeof initializeTimeoutMs === 'number' &&
    Number.isFinite(initializeTimeoutMs) &&
    initializeTimeoutMs >= SDK_CATALOG_READY_INITIALIZE_MIN_TIMEOUT_MS
  );
}
