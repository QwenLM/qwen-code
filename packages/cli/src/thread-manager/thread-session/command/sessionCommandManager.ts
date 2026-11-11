/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话的命令管理：以 `commandUuid` 为键串起入队、派发、turn 记账与终态上报。
 *
 * 生命周期上报（queued / started / completed / cancelled / discarded）全部以
 * `commandUuid` 为键，终态按 uuid 去重；turn 记账只在 `runTurnGuarded` 发生。
 * `terminated` 是会话级事实，通过 getter 注入而不是复制。
 */

import {
  runLogger,
  snapshotCustomContext,
  subscribeToCommandQueue,
  type InboundUserMessage,
  type QueuedCommand,
  type SDKMessage,
} from '@qwen-code/core';
import type {
  ThreadCommandState,
  ThreadEvent,
  ThreadTerminationReason,
} from '../contract/hostContext.js';
import type {
  ThreadInterruptResult,
  ThreadSubmission,
  ThreadUserMessage,
} from '../contract/threadSessionTypes.js';
import { CommandLifecycleDedupe } from './commandLifecycle.js';
import { SessionCommandQueue } from './sessionCommandQueue.js';

export interface SessionCommandManagerDeps {
  readonly sessionId: string;
  /** 出站事件。lifecycle 与 duplicate 回显都经它。 */
  readonly emit: (event: ThreadEvent) => void;
  /** 会话是否已收尾。`terminated` 留在会话，单一真相源。 */
  readonly isTerminated: () => boolean;
  /**
   * 执行一轮，返回命令终态。这是唯一的「执行」缝。
   *
   * `controller` 由本类创建并传入（见头注的跨对象约束）：会话只拿得到这一轮的实例，
   * 拿不到字段，于是 `turnController` 的记账也只剩一处。
   */
  readonly runTurn: (
    msg: InboundUserMessage,
    controller: AbortController,
    commandUuid?: string,
  ) => Promise<'completed' | 'cancelled'>;
  /** `runner.abort()`。 */
  readonly abortRunner: () => void;
  /** 本会话有新可派发命令：取消在途 prompt suggestion，别让插话等建议生成。 */
  readonly cancelPromptSuggestion?: () => void;
  /** 重复投递查重：`runner?.hasPersistedMessageUuid(uuid) ?? false`。 */
  readonly hasPersistedUuid: (uuid: string) => boolean;
  /** `runPump` 的 catch：逃逸异常 = 会话级不可恢复。 */
  readonly terminate: (reason: ThreadTerminationReason) => void;
  /**
   * 一轮结束、`turnRunning` 复位后的同步回调。
   *
   * goal 的 idle kickoff 用它做补偿：set_goal/resume_goal 在「result 已出、turn
   * 尚未收尾」的窗口里只能登记 pending，真正启动必须等这里通知会话已空闲。
   * 回调本身不得再进入 turn；实现方应把它推迟到下一个 microtask。
   */
  readonly onTurnSettled?: () => void;
}

export class SessionCommandManager {
  private readonly queue: SessionCommandQueue;
  private readonly lifecycle: CommandLifecycleDedupe;
  private turnController: AbortController | null = null;
  private turnRunning = false;
  /**
   * 本轮是否已经出过终态 `result` 帧。记账放在本类而不是会话或 runner：
   * `runTurnGuarded` 是 turn 记账的唯一缝（见文件头），`turnFailed` 的 emit 就在它的
   * catch 里，抑制它的事实也必须在同一个对象里——跨对象传 flag 等于长出第二份真相源。
   * 观察点是 `shouldForwardEngineMessage`：真实 runTurn 的消费循环对**每条**引擎产出
   * 都调它，result 帧不会漏记。
   */
  private turnResultEmitted = false;
  private pumpRunning = false;
  private activeCommand: Promise<void> | undefined;
  private pumpScheduled = false;
  private pruneScheduled = false;
  private unsubscribeQueue: (() => void) | undefined;

  constructor(private readonly deps: SessionCommandManagerDeps) {
    this.queue = new SessionCommandQueue(deps.sessionId);
    this.lifecycle = new CommandLifecycleDedupe((event) => deps.emit(event));
  }

  /**
   * 订阅全局队列。**必须在会话装配完成后调用一次**：回调会在任意时刻被 core 的队列变更
   * 触发，早于装配就会在还没有 config / runner 的会话上派发。
   */
  attach(): void {
    this.unsubscribeQueue = subscribeToCommandQueue(() =>
      this.onQueueChanged(),
    );
  }

  // ===========================================================================
  // 派发泵
  // ===========================================================================

  /** 队列变化：忙时看是否要抢跑（priority 'now'），闲时推进派发。 */
  private onQueueChanged(): void {
    this.scheduleQueuePrune();
    if (this.deps.isTerminated()) return;
    if (this.queue.hasDispatchableCommand()) {
      // 本会话有新命令：先掐掉在途 prompt suggestion，别让插话等建议生成。
      this.deps.cancelPromptSuggestion?.();
    }
    if (this.turnRunning) {
      if (this.queue.hasPriorityNowCommand()) this.interruptTurn();
      return;
    }
    this.pump();
  }

/**
 * 原始帧映射的回收必须推迟到微任务：core 的 `dequeue()` 先 splice 再通知，
 * 同步 prune 会删掉正在派发那一帧的映射，使它退化成空 turn。
 */
  private scheduleQueuePrune(): void {
    if (this.pruneScheduled || this.deps.isTerminated()) return;
    this.pruneScheduled = true;
    queueMicrotask(() => {
      this.pruneScheduled = false;
      if (this.deps.isTerminated()) return;
      this.queue.prune();
    });
  }

  private pump(): void {
    if (this.pumpScheduled || this.pumpRunning || this.deps.isTerminated()) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.runPump();
    });
  }

  /**
   * 串行派发循环。排队的 control 请求优先于开新 turn——与 headlessSession 的主循环
   * 同序（那里 control 与合并后的 user 消息共用一个 messageQueue，逐个 await）。
   */
  private async runPump(): Promise<void> {
    if (this.pumpRunning) return;
    this.pumpRunning = true;
    try {
      for (;;) {
        if (this.deps.isTerminated()) return;
        if (this.turnRunning) return;
        const command = this.queue.dequeueNext();
        if (!command) return;
        const active = this.runQueuedCommand(command);
        this.activeCommand = active;
        try { await active; } finally {
          if (this.activeCommand === active) this.activeCommand = undefined;
        }
      }
    } catch (error) {
      // 逃逸出 turn 循环的异常是会话级不可恢复错误：交给 Manager 合成 worker 退出。
      runLogger.error('[thread-session] pump failed', {
        sessionId: this.deps.sessionId,
        error,
      });
      this.deps.terminate({
        kind: 'runtime_error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      this.pumpRunning = false;
    }
  }

  private async runQueuedCommand(command: QueuedCommand): Promise<void> {
    // prompt 正文刻意不打：只打归属与模式，正文属于脱敏红线。
    runLogger.log('[thread-session] queued command dispatched', {
      sessionId: this.deps.sessionId,
      commandUuid: command.uuid,
      queueId: command.queueId,
      commandMode: command.commandMode,
      own: this.queue.isOwnCommand(command),
    });
    const msg = this.takeDispatchMessage(command);
    this.queue.forgetQueueId(command);
    const lifecycleState = await this.runTurnGuarded(msg, command.uuid);
    if (command.uuid !== undefined) {
      this.emitLifecycle(command.uuid, lifecycleState);
    }
    this.pump();
  }

/**
 * 取出本轮要跑的入站帧：主线命令取回原始 wire 帧，内部续跑才合成。
 * 合成帧不能当兜底——映射丢失时显式失败，避免把用户输入换成空 turn。
 */
  private takeDispatchMessage(command: QueuedCommand): InboundUserMessage {
    if (!this.queue.isOwnCommand(command)) {
      return buildSyntheticContinuationMessage(command);
    }
    const original = this.queue.originalMessage(command);
    if (!original) {
      throw new Error(
        `thread session ${this.deps.sessionId} lost the wire frame for queued command ${command.queueId}`,
      );
    }
    return original;
  }

  // ===========================================================================
  // turn 记账（唯一所在）
  // ===========================================================================

  /**
   * 跑一轮并兜住异常，返回命令生命周期的终态。
   *
   * `turnRunning` / `turnController` 的记账**只**在这里发生：`set_goal` 的 kickoff
   * 也走它，所以 handler 不需要、也不允许自己置 turnRunning——两处记账必然分叉。
   * 搬进本类之后这条从注释级变成结构级：两个字段是 private，会话与 handler 拿不到。
   */
  private async runTurnGuarded(
    msg: InboundUserMessage,
    commandUuid?: string,
  ): Promise<'completed' | 'cancelled'> {
    this.turnRunning = true;
    this.turnResultEmitted = false;
    const controller = new AbortController();
    this.turnController = controller;
    const startedAt = Date.now();
    runLogger.log('[thread-session] turn started', {
      sessionId: this.deps.sessionId,
      commandUuid,
      messageUuid: msg.uuid,
      commandMode: msg.commandMode,
      synthetic: msg.isSynthetic === true,
    });
    try {
      const state = await this.deps.runTurn(msg, controller, commandUuid);
      runLogger.log('[thread-session] turn finished', {
        sessionId: this.deps.sessionId,
        commandUuid,
        state,
        durationMs: Date.now() - startedAt,
      });
      return state;
    } catch (error) {
      runLogger.error('[thread-session] turn failed', {
        sessionId: this.deps.sessionId,
        commandUuid,
        durationMs: Date.now() - startedAt,
        error,
      });
// 一轮的终态 result 只能有一个：result 已出门后再抛异常不能再报 turnFailed，
// 否则宿主会把同一个 turn 编码成两个终态。
      if (this.turnResultEmitted) {
        runLogger.warn(
          '[thread-session] turn failed after its result frame; suppressing duplicate terminal',
          { sessionId: this.deps.sessionId },
        );
      } else {
        this.deps.emit({ kind: 'turnFailed', error });
      }
      return 'cancelled';
    } finally {
      this.turnRunning = false;
      this.turnController = null;
      try {
        this.deps.onTurnSettled?.();
      } catch (error) {
        runLogger.warn('[thread-session] onTurnSettled callback failed', {
          sessionId: this.deps.sessionId,
          error,
        });
      }
    }
  }

  /**
   * 在空闲会话上内联跑一轮：`set_goal` 的 kickoff 借用。
   * 与主循环 user 分支同一个契约——跑完之后排队在后面的命令要拿到派发机会。
   */
  async runExclusive(msg: InboundUserMessage): Promise<void> {
    const active = this.runTurnGuarded(msg).then(() => {});
    this.activeCommand = active;
    try { await active; } finally {
      if (this.activeCommand === active) this.activeCommand = undefined;
    }
    this.pump();
  }

  /**
   * 中止当前 turn：先 abort runner 停止产事件，再 abort controller 让反向请求失败。
   * 取消通过信号表达，会话不需要认识 request_id。
   */
  interruptTurn(): void {
    if (this.turnController) {
      runLogger.log('[thread-session] turn interrupted', {
        sessionId: this.deps.sessionId,
        turnRunning: this.turnRunning,
      });
      this.deps.abortRunner();
      this.turnController.abort();
    }
  }

  /** Shutdown must keep the host alive until cancellation emits its terminal frames. */
  async cancelAndDrain(): Promise<void> {
    this.interruptTurn();
    await this.activeCommand;
  }

  /** 本轮 turn 的信号。权限询问通道用它挂反向请求（见 createThreadPermissionChannel）。 */
  turnSignal(): AbortSignal | undefined {
    return this.turnController?.signal;
  }

  isTurnRunning(): boolean {
    return this.turnRunning;
  }

  /** result 已出、turn 仍在收尾。goal kickoff 在这个窗口必须挂 pending。 */
  isTurnFinishing(): boolean {
    return this.turnRunning && this.turnResultEmitted;
  }

  // ===========================================================================
  // 宿主入站
  // ===========================================================================

  /**
   * 投递一条用户消息。**同步分类 + 入队后立即返回**，绝不等 turn 跑完：宿主的读循环
   * 对每帧都要投递，而进程内所有会话共享一个事件循环，在这里跑完一整轮会卡死其余会话
   * 与宿主的查询面。真正的派发在 `pump()` 里，进度与终态经事件报出去。
   */
  async submit(
    message: ThreadUserMessage,
    rejection?: Error,
  ): Promise<ThreadSubmission> {
    const uuid = message.uuid;
    if (uuid) {
      const persisted = this.deps.hasPersistedUuid(uuid);
      if (persisted || this.queue.hasAcceptedUuid(uuid)) {
        // 重发的消息不重跑这一轮，但要按回放规则回显、并在已持久化时补一个 completed
        // 终态，否则宿主的命令状态机会一直挂着。
        this.emitDuplicateAcknowledgement(message, uuid, persisted);
        if (persisted) this.emitLifecycle(uuid, 'completed');
        return { commandUuid: uuid, disposition: 'duplicate' };
      }
      for (const expired of this.queue.acceptUuid(uuid)) {
        this.forgetLifecycle(expired);
      }
    }
    if (rejection) {
      // 受理后直接结算；不进入共享队列，不中止正在运行的那一轮。
      this.emitLifecycle(uuid, 'queued');
      this.deps.emit({ kind: 'turnFailed', error: rejection });
      this.emitLifecycle(uuid, 'cancelled');
      return { commandUuid: uuid, disposition: 'rejected' };
    }
    this.queue.enqueueMessage(message);
    this.emitLifecycle(uuid, 'queued');
    runLogger.log('[thread-session] user message queued', {
      sessionId: this.deps.sessionId,
      uuid,
      commandMode: message.commandMode,
    });
    this.pump();
    return { commandUuid: uuid, disposition: 'queued' };
  }

/**
 * 重复用户消息：不重跑，只回放一帧 replay；出不出发由宿主门禁决定。
 * 时序必须在 `emitLifecycle(uuid,'completed')` 之前。
 */
  private emitDuplicateAcknowledgement(
    msg: InboundUserMessage,
    uuid: string,
    persisted: boolean,
  ): void {
    runLogger.log('[thread-session] duplicate user message ignored', {
      sessionId: this.deps.sessionId,
      uuid,
      persisted,
    });
    this.deps.emit({
      kind: 'messageReplay',
      message: msg,
      commandUuid: uuid,
    });
  }

  /**
   * 中止当前 turn。**顺序是硬的**：先打断在跑的 turn，再取排队快照——反过来的话快照里
   * 会少掉被打断那一轮自己重新入队的续跑命令。
   */
  async interrupt(options?: {
    cancelQueued?: boolean;
  }): Promise<ThreadInterruptResult> {
    this.interruptTurn();
    const queued = this.queuedUuids();
    if (options?.cancelQueued === true) {
      this.cancelQueuedCommands(queued);
      runLogger.log('[thread-session] queued commands cancelled by interrupt', {
        sessionId: this.deps.sessionId,
        cancelled: queued.length,
      });
      return { stillQueued: [], cancelled: queued };
    }
    return { stillQueued: queued, cancelled: undefined };
  }

  /**
   * 按 commandUuid 作废一条**仍在排队**的消息。命中在途批次时回 `cancelled: false`：
   * 批次结算时会整批丢弃，但此刻命令已被取走，不能声称取消成功。
   */
  cancelQueuedMessage(commandUuid: string): { cancelled: boolean } {
    const { cancelled } = this.queue.cancelByUuid(commandUuid);
    if (cancelled) this.emitLifecycle(commandUuid, 'cancelled');
    return { cancelled };
  }

  /** `interrupt {cancel_queued:true}`：整批作废并逐个发 `cancelled` 终态。 */
  cancelQueuedCommands(commandUuids: readonly string[]): void {
    this.queue.cancelQueued();
    for (const commandUuid of commandUuids) {
      this.emitLifecycle(commandUuid, 'cancelled');
    }
  }

  /** 当前排队中的命令 uuid。`interrupt` 与 `rewind` 的空闲门禁要用。 */
  queuedUuids(): readonly string[] {
    return this.queue.queuedUuids();
  }

  // ===========================================================================
  // 会话内部（runTurn / close / drainBackgroundWork 调）
  // ===========================================================================

  /**
   * `runTurn` 在 controller 装好之后、模型调用之前调。时机是硬的，见头注。
   */
  reportStarted(commandUuid: string | undefined): void {
    this.emitLifecycle(commandUuid, 'started');
  }

  /**
   * `runTurn` 的消费循环里调：引擎回放的 `command_lifecycle` 终态在此被吃掉。
   * 返回 false 表示这一条不该转发给宿主。
   *
   * 这里同时是本轮 result 帧的观察点：消费循环对每条引擎产出都调本方法，所以
   * `turnResultEmitted` 的记账不需要会话再插一个回调（见字段的注释）。
   */
  shouldForwardEngineMessage(message: SDKMessage): boolean {
    if (message.type === 'result') {
      this.turnResultEmitted = true;
    }
    return this.lifecycle.filterSdkMessage(message);
  }

  /** `close()` 里调：取出仍排队的命令并逐个报 discarded。 */
  discardQueuedAndReport(): void {
    const discarded = this.queue.discardQueued();
    for (const command of discarded) {
      this.emitLifecycle(command.uuid, 'discarded');
    }
    if (discarded.length > 0) {
      runLogger.log('[thread-session] queued commands discarded on close', {
        sessionId: this.deps.sessionId,
        count: discarded.length,
      });
    }
  }

  /** 后台收尾用：本会话是否还有排队的主线续跑。 */
  hasOwnContinuation(): boolean {
    return this.queue.hasOwnContinuation();
  }

/**
 * 排干本会话排队的主线续跑，返回处理条数。归属由 `isOwnContinuation` 按
 * `sessionId` 收敛；turn 记账仍由 `runTurnGuarded` 独占。
 */
  async drainContinuations(): Promise<number> {
    let drained = 0;
    for (;;) {
      const command = this.queue.dequeueContinuation();
      if (!command) break;
      await this.runQueuedCommand(command);
      drained++;
    }
    if (drained > 0) {
      runLogger.log('[thread-session] queued continuations drained', {
        sessionId: this.deps.sessionId,
        drained,
      });
    }
    return drained;
  }

  /** `close()` 末尾调：清 queue 映射与 uuid 记账。 */
  clear(): void {
    this.queue.clear();
  }

  /** 退订全局队列。 */
  dispose(): void {
    this.unsubscribeQueue?.();
    this.unsubscribeQueue = undefined;
  }

  // ===========================================================================
  // 生命周期上报（终态按 uuid 去重，见 commandLifecycle.ts）
  // ===========================================================================

  private emitLifecycle(
    commandUuid: string | undefined,
    state: ThreadCommandState,
  ): void {
    this.lifecycle.emitLifecycle(commandUuid, state);
  }

  /** 撤销某个 uuid 的终态记账，让它能再报一次（uuid 被复用时用）。 */
  private forgetLifecycle(commandUuid: string): void {
    this.lifecycle.forget(commandUuid);
  }
}

/** 内部续跑（任务通知、队友消息）没有原始 wire 帧，按 headlessSession 合成一个。 */
function buildSyntheticContinuationMessage(
  command: QueuedCommand,
): InboundUserMessage {
  const prompt = typeof command.prompt === 'string' ? command.prompt : '';
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
    parent_tool_use_id: null,
    isSynthetic: true,
    commandMode: command.commandMode,
    isMeta: command.isMeta ?? true,
    stopHookActive: command.stopHookActive,
    origin:
      command.origin ??
      (command.commandMode === 'task-notification'
        ? { kind: 'task-notification' as const }
        : undefined),
    ...(command.customContext !== undefined
      ? { custom_context: snapshotCustomContext(command.customContext) }
      : {}),
  };
}
