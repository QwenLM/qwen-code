/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookDiagnosticsSnapshot } from '@qwen-code/core';

/**
 * 会话与宿主之间的通道：出站事件 + 反向请求。
 *
 * 会话负责「发生了什么」，宿主负责「这在 wire 上长什么样」：会话不构造帧、不认识 subtype
 * 字符串、不做 request_id 关联；宿主不碰会话内部状态、不决定排队与 turn 时序。
 */

import type {
  Config,
  PermissionPolicySnapshot,
  SDKMessage,
} from '@qwen-code/core';
import type { ThreadSessionDeclarations } from './threadSessionTypes.js';

// ===========================================================================
// 终止原因
// ===========================================================================

/**
 * 会话自行终止的原因。turn 级错误不在这里——那是 `turnFailed` 事件，会话仍然活着；
 * 这里只有「会话本身已经结束」的情形。翻译成上游形状（如退出码）是宿主的责任。
 */
export type ThreadTerminationReason =
  /** 会话自行正常收尾（例如上游输入流结束）。 */
  | { kind: 'ended' }
  /** 逃逸出会话主循环的不可恢复错误：装配失败、协议错误、未捕获异常。 */
  | { kind: 'runtime_error'; error: Error };

// ===========================================================================
// 出站：会话产出，宿主装帧
// ===========================================================================

/**
 * 命令生命周期状态。队列派发、turn 循环与 teardown 都可能对同一命令报终态，
 * 去重是会话的责任：宿主收到的每次状态转移恰好一次，因此无需自己维护状态。
 */
export type ThreadCommandState =
  | 'queued'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'discarded';

/**
 * 会话能力快照。宿主把它帧化成上游的「会话已就绪」通知（SDK 下是 `system/init`）；
 * 不发就等于把能力全关掉，时机由会话决定（握手回包前与每轮提交前），因此它是事件
 * 而不只是 `initialize` 的返回值。
 */
export interface ThreadSessionSnapshot {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly tools: readonly string[];
  readonly mcpServers: ReadonlyArray<{ name: string; status: string }>;
  readonly slashCommands: readonly string[];
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly plugins: ReadonlyArray<{ name: string; path: string }>;
  readonly outputStyle: string;
  readonly apiKeySource: string | undefined;
  readonly version: string;
}

/** 前台 Shell 的有界输出预览；不改变工具执行或最终结果。 */
export interface SessionToolProgress {
  kind: 'toolProgress';
  parentToolUseId?: string;
  toolUseId: string;
  toolName: string;
  executionId: string;
  sequence: number;
  phase: 'running' | 'ended';
  startedAtMs: number;
  elapsedMs: number;
  output: string;
  totalBytes?: number;
  totalLines?: number;
  previewTruncated?: boolean;
}

/**
 * 会话级状态通知。宿主决定各自的 wire 形状（subtype 字符串、字段名、能力位门禁）。
 * 载荷一律是产品数据而非 wire 投影，且每个成员必须带齐渲染该帧所需的全部字段——
 * 宿主拿不到会话状态，少一个字段就是静默丢失的 wire 字段。
 */
export type ThreadNotice =
  | { kind: 'permissionPolicyChanged'; policy: PermissionPolicySnapshot }
  | { kind: 'hookDiagnostics'; snapshot: HookDiagnosticsSnapshot }
  /** 前台命令执行进度，载荷由宿主转换为对应通知。 */
  | SessionToolProgress
  /** 可用模型目录或当前模型变了。 */
  | {
      kind: 'availableModelsChanged';
      models: readonly unknown[];
      currentModel: string | undefined;
    }
  /** 命令目录变了。载荷是目录快照，宿主负责投影成 wire 的 commands 形状。 */
  | { kind: 'commandsChanged'; commands: readonly unknown[] }
  /** 会话产物快照变了；changedArtifacts 只包含本次观察新增或更新的产物。 */
  | {
      kind: 'artifactsChanged';
      artifacts: readonly unknown[];
      changedArtifacts?: readonly unknown[];
    }
  /**
   * 权限模式视图变了。wire 上这一帧的 `status` 恒为 null、真正的内容在
   * `permissionMode`，且取原始视图还是 SDK 映射视图由会话按控制面形态决定后才交出来。
   */
  | { kind: 'statusChanged'; permissionMode: string }
  | { kind: 'planModeChanged'; active: boolean }
  | { kind: 'goalChanged'; goal: unknown; reason?: string }
  | { kind: 'goalCleared'; goalId: string; reason?: string }
  | { kind: 'taskNotification'; notification: unknown }
  /** 三类 hook 事件：载荷就是 core 的 hook 事件负载，原样带出。 */
  | { kind: 'hookStarted'; payload: unknown }
  | { kind: 'hookProgress'; payload: unknown }
  | { kind: 'hookResponse'; payload: unknown }
  /** 记忆与技能演进：载荷是 `{ result }` 里的那个 result。 */
  | { kind: 'memoryGeneration'; payload: unknown }
  | { kind: 'memoryConsumption'; payload: unknown }
  | { kind: 'skillEvolution'; payload: unknown }
  /** MCP 授权流要用户补充输入时，先给上游一个「正在询问」的通知。 */
  | { kind: 'elicitationRequested'; payload: unknown }
  /** 上面那次询问结束（无论批准还是取消）。 */
  | { kind: 'elicitationCompleted'; payload: unknown };

/**
 * 会话产出的一切。kind 按产出方命名而不是按载荷格式命名（`threadMessage` 是「会话
 * 吐出的一条消息」），载荷格式另见字段注释。载荷直接复用 core 的 `SDKMessage`：再造
 * 一层中立类型双向映射只是纯仪式，两套 schema 一旦漂移就是静默的数据错误。
 */
export type ThreadEvent =
  /**
   * 执行内核投影出的一条消息（assistant / user / result / stream_event / system …）。
   * 格式是 `SDKMessage`。
   */
  | { kind: 'threadMessage'; message: SDKMessage }
  /** 命令生命周期转移，已按 commandUuid 去重。 */
  | {
      kind: 'commandLifecycle';
      commandUuid: string;
      state: ThreadCommandState;
    }
  /** 会话能力快照。 */
  | { kind: 'sessionSnapshot'; snapshot: ThreadSessionSnapshot }
  /** 会话级状态通知。 */
  | { kind: 'notice'; notice: ThreadNotice }
  /** 一轮对话因不可恢复异常中止；会话仍然活着。 */
  | { kind: 'turnFailed'; error: unknown }
  /** transcript 落盘镜像。 */
  | {
      kind: 'transcriptMirror';
      filePath: string;
      entries: readonly unknown[];
    }
  /**
   * 按回放规则回显一条用户消息。两个发起点：正常轮次派发时的 echo（宿主用帧上的 uuid
   * 做 checkpoint/rewind 归属），以及上游重发已见消息时的回执。是否出帧由宿主按
   * `--replay-user-messages` 门禁决定。
   */
  | { kind: 'messageReplay'; message: unknown; commandUuid: string };

export interface ThreadEventSink {
  emit(event: ThreadEvent): void;
}

// ===========================================================================
// 反向：会话向宿主要东西
// ===========================================================================

/**
 * 会话可以向上游发起的八种反向请求。参数与返回值刻意让 `unknown` 与具名结构体并存：
 * `canUseTool` 的出入参是产品语义，值得强类型；其余 payload 形状由各自的上游协议定义，
 * 会话只透传，强类型化会把协议形状钉进中立层。
 */
export interface ThreadHostRequests {
  /**
   * 会话推理就绪前的身份准备。凭据从哪来、要不要登录属于宿主；缺省视为该宿主不需要
   * 认证（例如基础 ACP），不回退到任何产品实现。
   */
  ensureAuthReady?(): Promise<void>;

  /**
   * 会话推理面准备：刷新会话 Config 的推理身份、等待产品模型目录、按目录归一会话模型。
   * 全部是宿主产品逻辑，缺省视为无需额外准备。
   */
  prepareInference?(input: ThreadInferencePreparation): Promise<void>;

  /**
   * 执行内核捕获的原始错误（诊断用，不产生 wire）。宿主可按自己的输出形态补充诊断，
   * 缺省即忽略；中止不触发。
   */
  reportQueryError?(error: unknown): void;

  /** 产品网络运行时的代理重建；会话只负责校验入参并写 Config。 */
  prepareProxy?(input: { config: Config; proxy?: string }): Promise<void>;

  /** SDK memory / skill evolution 的宿主实现；未提供表示宿主不启用该能力。 */
  memory?: ThreadMemoryHost;

  /**
   * 工具执行前的许可询问，会话阻塞等判决。由宿主决定是否提供：缺席表示没有人可以
   * 应答，会话不装 can_use_tool 控制通道，交给 PermissionRequest hook 串行裁决
   * （无裁决即拒绝）。是否提供属于宿主的参数层判断，会话不解析 argv。
   */
  canUseTool?: ThreadCanUseToolHandler;

  /**
   * 权限询问通道身份，只用于 ask 指标归因：`named_tool` 是第三方审批服务，
   * `stdio_control` 是控制通道。与 `canUseTool` 一起由宿主声明。
   */
  permissionPromptChannel?: 'stdio_control' | 'named_tool';

  /**
   * 仅作宿主审批通道、不应暴露给模型与 init 快照的工具名（例如
   * `--permission-prompt-tool <tool>` 指定的 MCP 工具）。由宿主按参数层决定。
   */
  hiddenToolName?: string;

  /** MCP 授权流需要用户补充输入。 */
  elicit(
    payload: unknown,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;

  /** 执行一个上游注册的 hook，回它的输出。 */
  runHookCallback(
    hookName: string,
    payload: unknown,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;

  /** 拉取式模型策略：问上游本次请求该用哪个模型。 */
  getModelPolicy(
    payload: unknown,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;

  /** 让上游解析会话产物快照。 */
  resolveSessionArtifacts(
    payload: unknown,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;

  /** 把一条 MCP 协议消息转给上游的 in-process MCP server。 */
  sendMcpMessage(
    payload: unknown,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;

  /** 记忆生成门禁：问上游这一轮要不要生成记忆。 */
  shouldGenerateMemory(
    request: ThreadGateRequest,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;

  /** 技能演进门禁：问上游这一轮要不要做演进复核。 */
  shouldReviewSkillEvolution(
    request: ThreadGateRequest,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown>;
}

export type ThreadMemoryPromptUpdate =
  | { readonly owner: 'none' }
  | { readonly owner: 'sdk'; readonly prompt: string }
  | {
      readonly owner: 'sdk';
      readonly promptsByBundle: Readonly<Record<'full' | 'lean', string>>;
    };

export interface ThreadMemoryPreparation {
  readonly memoryEnabled: boolean;
  readonly skillEvolutionEnabled: boolean;
  readonly effectiveMemory?: Record<string, unknown>;
  readonly effectiveSkillEvolution?: Record<string, unknown>;
  readonly memoryPromptUpdate?: ThreadMemoryPromptUpdate;
}

export interface ThreadMemoryHost {
  prepare(input: {
    readonly declarations: ThreadSessionDeclarations;
    readonly config: Config;
  }): Promise<ThreadMemoryPreparation>;
  refreshMemory(): Promise<void>;
  flushMemory(): Promise<void>;
  flushSkillEvolution(): Promise<void>;
  drain(): Promise<void>;
}

export interface ThreadInferencePreparation {
  readonly config: Config;
  /** settings 里用户选择的 auth type 原文；缺席时宿主按自己的默认策略解析。 */
  readonly selectedAuthType?: string;
  /** 宿主在 initialize 声明了 catalog-ready initialize。 */
  readonly catalogReadyInitialize: boolean;
  readonly signal: AbortSignal;
}

/**
 * 反向请求的调用选项。`signal` 是取消在途反向请求的唯一机制：会话 abort turn 控制器
 * 即可，宿主挂在信号上的等待自己失败，会话不需要认识任何 wire 标识；缺省时由宿主兜
 * 会话级信号。
 */
export interface ThreadReverseRequestOptions {
  readonly signal?: AbortSignal;
  /**
   * 逐次超时覆盖。宿主把门禁声明里的等待上界（`ThreadGateRequest.timeoutMs` /
   * `timeoutDescription`）映射到这里，由连接层到点补发 cancel 帧并按超时失败，晚到的
   * 回执被丢弃。缺省按声明策略兜底（门禁类不超时），静态缺省会静默盖掉上游声明。
   */
  readonly timeout?: { readonly ms: number; readonly description: string };
  /**
   * 本次请求发出于 SessionEnd 收尾窗口内。会话 terminated 后出站一律拒绝，唯一例外是
   * `close()` 里执行的 SessionEnd hook——帧出不去，宿主视角里 hook 就从未触发。标记只在
   * 窗口打开期间、只对 hook 回调通道打，宿主还需校验窗口确实开着。
   */
  readonly sessionEndCloseout?: boolean;
}

/**
 * 一次「问上游要不要做某件事」的门禁请求。判别信息在 `ThreadHostRequests` 的方法名里；
 * `timeoutMs` / `timeoutDescription` 交给宿主执行——超时是 wire 侧的等待策略，会话只
 * 声明「最多等多久、超时怎么描述」。
 */
export interface ThreadGateRequest {
  /** 上游在 initialize 里声明的回调 ID；缺失时仍照发，由宿主自己判定。 */
  readonly callbackId?: string;
  readonly input: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly timeoutDescription: string;
}

/** 记忆与技能演进三类通知的 kind。会话按 kind 产通知，subtype 字符串归宿主。 */
export type ThreadMemoryNoticeKind =
  | 'memoryGeneration'
  | 'memoryConsumption'
  | 'skillEvolution';

/** 一次门禁询问的调用形状；判别信息在方法名里，超时策略由宿主执行。 */
export type ThreadGate = (request: ThreadGateRequest) => Promise<unknown>;

export interface ThreadCanUseToolRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly suggestions: readonly unknown[];
  readonly blockedPath: unknown;
  readonly title: string | undefined;
  readonly description: string | undefined;
  /**
   * 本次征询对应的 tool_use 块 id。宿主用它把批准/拒绝归属到会话流里的某一次调用；
   * 缺了它 SDK 的 `canUseTool` 回调只能收到 `undefined`。
   */
  readonly toolUseId: string;
  /** 工具展示名；没有工具定义时回落到 toolName。 */
  readonly displayName: string;
  /** 权限提示详情，原样上帧；由会话侧的 buildCanUseToolPromptDetails 算好。 */
  readonly details: unknown;
  /**
   * 产品级询问种类。doom-loop 续跑确认用 `repeated_tool_call`，宿主据此渲染专属
   * 提示而不是普通权限卡片；普通权限询问缺席。
   */
  readonly permissionKind?: 'repeated_tool_call';
  /** 宿主可展示的选项，随 details 一起上帧。 */
  readonly options?: readonly ThreadCanUseToolPermissionOption[];
}

export interface ThreadCanUseToolPermissionOption {
  readonly outcome:
    | 'proceed_once'
    | 'proceed_always'
    | 'proceed_always_and_save'
    | 'cancel';
  readonly name: string;
  readonly allowed: boolean;
}

export type ThreadCanUseToolDecision =
  | {
      behavior: 'allow';
      updatedInput: unknown;
      /**
       * 批准作用域。doom-loop 续跑确认靠它区分「仅此次」与「本次会话内都允许」；
       * 普通权限询问的会话级规则仍走 updatedPermissions，由宿主落进 Config。
       */
      permissionScope?: 'once' | 'session' | 'persist';
    }
  | { behavior: 'deny'; message: string; interrupt: boolean };

/** 宿主的许可询问回调；是否提供它决定会话装不装 can_use_tool 控制通道。 */
export type ThreadCanUseToolHandler = (
  request: ThreadCanUseToolRequest,
  options?: ThreadReverseRequestOptions,
) => Promise<ThreadCanUseToolDecision>;

// ===========================================================================
// 两个作用域
// ===========================================================================

/** 会话级宿主通道：构造时给一次。 */
export interface ThreadHost {
  readonly events: ThreadEventSink;
  readonly requests: ThreadHostRequests;
}

/**
 * 调用级上下文：每次能力调用传入，只带本次调用的中止信号与宿主通道。刻意不带「回包」
 * 能力——能力方法用返回值表达结果，会话因此不需要知道 request_id 的存在。
 */
export interface ThreadCallContext {
  /** 本次调用的中止信号；上游取消或连接断开时 abort。 */
  readonly signal: AbortSignal;
  readonly host: ThreadHost;
  /**
   * 报告本次调用的执行进度。`side_question` 执行过程中要发进度通知，而该通知在 wire 上
   * 带本次请求的 request_id——会话不知道它，所以进度经 ctx 交回宿主补信封。缺省表示
   * 本次调用不需要进度。
   */
  readonly progress?: (status: string, retry?: Record<string, unknown>) => void;
}
