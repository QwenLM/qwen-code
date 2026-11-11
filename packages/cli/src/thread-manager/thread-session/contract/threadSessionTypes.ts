/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话能力面的数据类型：入参、返回值、队列与声明的形状。
 *
 * 方法签名在 `threadSession.ts` 的具体类上，这里只放跨层流动的数据形状，宿主与会话都
 * import 它，改字段等于改协议映射。命名一律用产品语义而不是 wire 语义
 * （`userMessageId` 而非 `user_message_id`），蛇形到驼峰的转换由宿主编解码器负责。
 */

import type { PermissionPolicySnapshot, InboundUserMessage } from '@qwen-code/core';
import type { McpControlResult } from '../host/sessionMcpControl.js';

/** 插话优先级。`now` 打断当前 turn，`next` 排在本轮之后，`later` 排在队尾。 */
export type ThreadMessagePriority = 'now' | 'next' | 'later';

/**
 * 一条待投递的用户消息。直接复用 core 的 `InboundUserMessage`，不另发明中立输入类型：
 * 它与会话的标准输出结构 `SDKMessage` 同为引擎 I/O 层的产物，再造一层再双向映射只是
 * 纯仪式。字段因此是蛇形，由宿主编解码从自己的 wire 形状映射；`uuid` 是命令生命周期的
 * 归组身份，由宿主从帧上取好再传进来，会话不生成也不解释它。
 */
export type ThreadUserMessage = InboundUserMessage;

/**
 * `submitMessage` 的即时结果，不是 turn 的结果——turn 的进度与终态经事件报出。
 * `rejected`：输入已拒绝，终态已通过事件发出、不进入执行队列。`duplicate`：uuid 已见过
 * （引擎已持久化或队列已接受过），不会为它跑一轮，宿主只会收到补发的 completed 终态与
 * （开了回放时的）一帧 replay。
 */
export interface ThreadSubmission {
  readonly commandUuid: string | undefined;
  readonly disposition: 'queued' | 'duplicate' | 'rejected';
}

/**
 * `interrupt` 的结果。`cancelled` 只在请求了「连带作废排队命令」时出现，此时
 * `stillQueued` 必为空；否则 `stillQueued` 报告打断后仍排着的命令，`cancelled` 为
 * undefined。两个列表的元素都是 commandUuid。
 */
export interface ThreadInterruptResult {
  readonly stillQueued: readonly string[];
  readonly cancelled: readonly string[] | undefined;
}

/**
 * `initialize` 的声明袋：上游在握手时一次性声明本会话要开哪些能力，会话据此改变装配。
 * 字段名一律是产品中立名，宿主胶水负责 wire → 中立的映射，本模块只读中立字段。保持
 * 开放索引签名让宿主透传未映射的键，但本模块消费的每个键都必须在这里点名。多数字段
 * 刻意是 `unknown`：合法值由消费点校验，收窄类型只会把校验挪到编译期。
 */
export interface ThreadSessionDeclarations {
  // ── 控制面形态 ──
  readonly permissionMode?: string;
  readonly planMode?: boolean;
  readonly independentPlanModeControls?: boolean;
  readonly promptSuggestions?: boolean;
  // ── 装配开关与能力声明 ──
  readonly goalMaxTurns?: unknown;
  readonly modelPolicyProvider?: boolean;
  readonly resolveSessionArtifacts?: boolean;
  /** Host 是否支持由会话主动交付 Artifact。 */
  readonly artifactPresentation?: boolean;
  readonly supportsCatalogReadyInitialize?: boolean;
  readonly initializeTimeoutMs?: unknown;
  readonly supportsAvailableModelsUpdate?: boolean;
  readonly supportsCommandsChanged?: boolean;
  // ── 提示词与模型 ──
  readonly systemPrompt?: unknown;
  readonly appendSystemPrompt?: unknown;
  readonly model?: unknown;
  readonly reasoningEffort?: unknown;
  /** wire 上蛇形 `reasoning_effort` 显式为 null 表示「清掉」，由宿主映射成这个标志。 */
  readonly clearReasoningEffort?: boolean;
  readonly contextWindow?: unknown;
  readonly includePartialMessages?: unknown;
  readonly includeShellProgress?: boolean;
  readonly modelRequestPatches?: unknown;
  readonly skills?: unknown;
  // ── 能力注入 ──
  readonly memory?: unknown;
  readonly skillEvolution?: unknown;
  readonly hooks?: unknown;
  readonly mcpServers?: unknown;
  readonly mcpToolOverrides?: unknown;
  readonly agents?: unknown;
  readonly [key: string]: unknown;
}

/**
 * `initialize` 的产品快照：回包主体的全部产品事实，由 `sessionInitializeSnapshot.ts`
 * 采集（memory / skillEvolution 两块声明产物由会话在 applyInitializeDeclarations 之后
 * 并入）。wire 回包体不在这里成型：蛇形键名、模型与账号投影、协议能力常量与 `pid`
 * 都由宿主的 initialize 胶水组装，换上游协议时本快照原样复用。
 */
export interface ThreadInitializeSnapshot {
  readonly permissionPolicy: PermissionPolicySnapshot;
  /** 命令目录快照（`buildSdkCommandSnapshot` 的产物，与广播面共用同一份）。 */
  readonly commands: readonly unknown[];
  readonly agents: ReadonlyArray<{
    name: string;
    description: string;
    model?: string;
  }>;
  readonly skills: ReadonlyArray<{
    name: string;
    description: string;
    source?: string;
  }>;
  readonly outputStyleName: string;
  readonly availableOutputStyleNames: readonly string[];
  /** 只在独立控制面时携带；宿主决定是否放进出站体。 */
  readonly permissionMode?: string;
  // ── 声明产物（session.getInitializeDeclarationProducts 并入）──
  /** memory 声明的有效配置回执。 */
  readonly memory?: Record<string, unknown>;
  /** skill evolution 声明的有效配置回执；宿主装进 wire 的 `evolution.skill`。 */
  readonly skillEvolution?: Record<string, unknown>;
}

/**
 * 声明产生的回包附加字段（产品形态）。没有声明时为 undefined，宿主必须只在非
 * undefined 时合并（无条件展开会给回包加上 `memory: undefined` 这种键）；wire 键名
 * 由宿主胶水补。
 */
export interface ThreadInitializeDeclarationProducts {
  readonly memory?: Record<string, unknown>;
  readonly skillEvolution?: Record<string, unknown>;
}

export interface ThreadInitializeResult {
  /** 握手的产品快照。回包 wire 体由宿主组装，本模块不产任何 wire 键名。 */
  readonly snapshot: ThreadInitializeSnapshot;
  /**
   * 回包出门之后才跑的收尾：artifact 快照恢复、广播面启动、SessionStart hook。宿主写完
   * 回包帧之后必须调它——广播面的命令目录初始指纹取自快照里的 commands，早启动就会把
   * 刚报过的那份目录再发一次变更通知。
   */
  readonly afterResponseSent: () => Promise<void>;
}

export interface ThreadModelSnapshot {
  readonly model: string;
  readonly reasoningEffort: string | undefined;
}

export interface ThreadPlanModeSnapshot {
  readonly planModeActive: boolean;
  readonly permissionMode: string;
}

/** 目标快照。字段由产品侧的目标模型定义，会话与宿主都只转交。 */
export type ThreadGoalSnapshot = Record<string, unknown>;

/** 回滚结果。`dryRun` 为真时只描述将会发生什么。 */
export type ThreadRewindResult = Record<string, unknown>;

// ===========================================================================
// 各能力的返回值。字段名一律驼峰（产品语义），蛇形的 wire 字段名由宿主编解码器映射。
// ===========================================================================

/** plan mode 视图。`planMode` 的载荷由 `buildPlanModeSnapshot` 产出，这里原样透传。 */
export interface ThreadPlanModeResult {
  readonly planMode: unknown;
}

/**
 * goal 快照。`null` 表示当前没有目标——与 `undefined`（键不出现）在 wire 上是两回事，
 * 因此这里保留 null。
 */
export interface ThreadGoalResult {
  readonly goal: unknown | null;
}

export interface ThreadAddDirectoriesResult {
  readonly added: readonly string[];
  readonly failed: ReadonlyArray<{ path: string; error: string }>;
  readonly directories: readonly string[];
}

export interface ThreadAppliedFlagSettings {
  readonly applied: {
    readonly effort: string | null;
    readonly ultracode: boolean;
  };
}

export interface ThreadProxyResult {
  readonly proxy: string | null;
}

export interface ThreadSessionTitleResult {
  readonly title: string | null;
}

/**
 * 旁路问答结果。字段名是 `response` 而不是 `answer`，改名即 wire 分叉；
 * `response` 为 null 表示模型没给出文本内容。
 */
export interface ThreadSideQuestionResult {
  readonly response: string | null;
  readonly synthetic: boolean;
}

/**
 * 后台任务类能力（`stop_task` / `background_tasks`）的结果。`payload` 为 undefined
 * 表示回包不带 body，与「带一个空对象」在 wire 上是两回事。`afterResponseSent` 承载
 * `flushTaskControlEvents`：顺序是先回包再 flush，而回包由宿主在方法返回之后写，所以
 * flush 必须交回宿主在写完帧之后调，否则任务事件会抢在回包前面出门。
 */
export interface ThreadTaskResult {
  readonly payload: Record<string, unknown> | undefined;
  readonly afterResponseSent: () => void;
}

/**
 * MCP 控制面能力（8 个 `mcp_*`）的结果。直接复用共享模块的 `McpControlResult`
 * （错误文案是 wire 契约）：宿主把 ok:true 编码
 * 成成功回包帧（`response` 缺省 = 无 payload），ok:false 编码成错误回包帧。
 */
export type ThreadMcpResult = McpControlResult;
