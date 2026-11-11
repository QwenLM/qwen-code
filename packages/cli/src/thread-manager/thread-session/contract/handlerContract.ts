/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `handlers/` 内部包的契约。
 *
 * 能力按域分模块，每个模块导出纯函数，第一个参数是会话内部视图，`ThreadSession` 的
 * 方法体是一行委托。handler 不做协议：不构造帧、不认识 subtype、不碰 request_id；可变
 * 会话状态必须经 getter 读，否则快照到旧值。错误一律抛出，由宿主决定 wire code 与文案。
 * 这是内部包不是对外边界，对外窄边界是 `threadSession.ts` 与 `hostContext.ts`。
 */

import type { Config, TaskRegistry } from '@qwen-code/core';
import type { SessionQueryRunner } from '../query/sessionQueryRunner.js';
import type { LoadedSettings, SettingSource } from '../../../config/settings.js';
import type { CliArgs } from '../../../config/config.js';
import type { McpControlModule } from '../host/sessionMcpControl.js';
import type { SessionPhaseLog } from '../phase-log/sessionPhaseLog.js';
import type { ThreadHost, ThreadSessionSnapshot } from './hostContext.js';
import type {
  ThreadInitializeDeclarationProducts,
  ThreadSessionDeclarations,
} from './threadSessionTypes.js';

/**
 * 能力执行失败的统一错误类型。宿主按 `code` 决定 wire 上的错误 code、按 `message`
 * 决定文案；`code` 缺省时由宿主兜底（SDK 下多数错误回包不带 code，带上就是协议分叉）。
 */
export class ThreadCapabilityError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ThreadCapabilityError';
  }
}

/**
 * handler 能看到的会话内部视图，由 `ThreadSession` 实现并传给同包的 handler。
 * 装配产物一律走方法而不是字段：它们在 `start()` 之后才存在，且 runner 是可替换绑定，
 * 字段快照会读到旧值。
 */
export interface ThreadSessionInternals {
  // ── 只读依赖 ──
  readonly sessionId: string;
  readonly cwd: string;
  readonly cliArgs: CliArgs;
  /** 会话级宿主通道：出站事件与八个反向请求都经它。 */
  readonly host: ThreadHost;
  /**
   * 阶段耗时日志的同一个实例（open_session 创建、沿链路下传）。handlers 用它把
   * initialize 各步记进与装配期同一张汇总表，使「受理 → sessionId → 首 token」可以从
   * 一份日志里读全。
   */
  readonly phaseLog: SessionPhaseLog;
  /** 会话级中止信号；长等待与反向请求默认挂它。 */
  readonly signal: AbortSignal;
  /** 会话独占的后台任务登记表。 */
  readonly taskRegistry: TaskRegistry;
  /**
   * 当前排队 / 在途的本会话命令 uuid。只读收窄：命令的生命周期归
   * `command/sessionCommandManager.ts` 独占，handler 不能 enqueue / cancel / prune。
   */
  queuedCommandUuids(): readonly string[];
  /**
   * MCP 控制面（8 个 `mcp_*` 能力经 `handle` 委托）。装配产物，
   * 经 getter 读：runner 装好之前、或非 stream-json 输出时是 undefined。
   */
  readonly mcpControl: McpControlModule | undefined;

  requireConfig(): Config;
  requireSettings(): LoadedSettings;
  /** 当前已装配的 runner；懒建，未建时回 null，不触发装配。 */
  peekQueryRunner(): SessionQueryRunner | null;
  /** 触发 runner 装配并等它就绪（memoized，失败可重试）。 */
  ensureQueryRunner(): Promise<SessionQueryRunner>;
  /** 会话是否已被收尾。收尾期间到达的调用按此短路。 */
  isTerminated(): boolean;

  // ── 会话状态：只能经 getter / setter，解构成局部常量会快照旧值 ──
  isInitialized(): boolean;
  setInitialized(value: boolean): void;
  isTurnRunning(): boolean;
  getCurrentSettings(): LoadedSettings;
  setCurrentSettings(value: LoadedSettings): void;
  /** 本会话设置加载的来源过滤；undefined = argv 未声明（全来源）。 */
  getSettingSources(): readonly SettingSource[] | undefined;
  getPromptSuggestionsEnabled(): boolean;
  setPromptSuggestionsEnabled(value: boolean): void;
  /**
   * 宿主是否用「plan mode 与 permission mode 各自独立」的控制面；影响能力快照里
   * permissionMode 取哪个视图。
   */
  isIndependentPlanModeControls(): boolean;
  setIndependentPlanModeControls(value: boolean): void;

  // ── 只有会话能做的动作（handler 不碰会话内部结构）──
  interruptTurn(): void;
  /** 整批作废排队命令并逐个报 `cancelled` 终态。 */
  cancelQueuedCommands(commandUuids: readonly string[]): void;
  /**
   * 在空闲会话上内联跑一轮（`setGoal` 的 kickoff 借用）。turnRunning 由会话自己记账，
   * handler 不需要也不允许设置它；返回后队列会继续派发。
   */
  runInlineTurn(message: unknown): Promise<void>;
  /**
   * goal 的 idle 续跑：空闲立即 kickoff，result 已出但 turn 仍在收尾时登记 pending，
   * 由会话在真正空闲后补启动一次。handler 不判断 turnRunning。
   */
  continueGoalIfIdle(): void;
  /** 请求结束会话。等价于宿主调 `close()`，但由会话内部触发。 */
  endSession(): void;

  // ── 进程级副作用的会话内包装 ──
  /** 把带外调用产生的后台任务事件立即刷出去。 */
  flushTaskControlEvents(): void;
  /**
   * 推理面就绪：绑定会话 auth → 等目录可信 → 按目录对齐会话模型。三步必须成对，
   * 理由见 inferenceReadiness.ts。
   */
  ensureInferenceReady(): Promise<void>;
  /**
   * 处理 `initialize` 声明里所有会改变会话装配的部分。字段之间的相对位置是硬约束
   * （resolveSessionArtifacts 早于快照、hooks / agents 早于回包、memory 准备早于
   * runner 的提示词装配），全部由会话一处保证，handler 不参与排序。
   */
  applyInitializeDeclarations(
    declarations: ThreadSessionDeclarations,
  ): Promise<void>;
  /**
   * 声明产物（memory / skill evolution 的有效配置回执，产品字段）；没有声明时返回
   * undefined（不能展开一个 undefined）。wire 键位由宿主的回包组装补。
   */
  getInitializeDeclarationProducts():
    | ThreadInitializeDeclarationProducts
    | undefined;
  /** 回包出门之后 best-effort 恢复宿主侧 artifact 快照；未声明时是空操作。 */
  recoverHostArtifacts(): void;
  /**
   * 启动会话状态广播面。必须在回包之后调：命令目录 publisher 要用回包里的 commands
   * 当初始指纹，早一步启动就会把刚报过的那份目录再发一次变更通知。
   */
  startSessionBroadcast(
    declarations: ThreadSessionDeclarations,
    initialCommands: readonly unknown[],
  ): void;
  /**
   * SessionStart hook：先确保 runner 装配好，再跑一次（一次性，重复调用是空操作）；
   * hook 的 additionalContext 要进 runner 队列。
   */
  ensureSessionStartHooks(): Promise<void>;
  /** 产出能力快照并作为事件交出去。握手回包之前、以及每轮提交之前各一次。 */
  emitInitSnapshot(): Promise<void>;
  /** 当前能力快照的数据（不产生事件），供回包合并字段用。 */
  sessionSnapshot(): Promise<ThreadSessionSnapshot>;
  /** `side_question` 的按调用 id 取消控制器；同 id 并发要拒绝。 */
  readonly sideQuestionControllers: Map<string, AbortController>;
}
