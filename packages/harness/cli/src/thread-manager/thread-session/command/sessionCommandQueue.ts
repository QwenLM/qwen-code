/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 本会话在进程级共享命令队列中的视图。
 *
 * 入队必须 stamp `sessionId`，否则内部续跑会穿透到其他会话的 mid-turn 注入点。
 * `queueId` 是进程内私有映射，用来取回 wire 帧的私有字段；in-flight 批次按
 * predicate 归属到本会话。
 */

import { randomUUID } from 'node:crypto';
import {
  dequeue,
  enqueue,
  getCommandQueue,
  getInFlightDrainBatch,
  markCancelPending,
  markInFlightDrainBatchCancelPending,
  peek,
  removeByFilter,
  someInFlightDrainCommand,
  type InboundUserMessage,
  type QueuedCommand,
} from '@qwen-code/core';

/** 已接受帧的 UUID 上限，超出按 FIFO 淘汰（对齐 headlessSession 的 10_000）。 */
const MAX_ACCEPTED_UUIDS = 10_000;

export interface EnqueueOutcome {
  command?: QueuedCommand;
  /** 重复投递：同一个 uuid 已经接受过或已经落盘。 */
  duplicate: boolean;
}

export class SessionCommandQueue {
  private readonly messageByQueueId = new Map<string, InboundUserMessage>();
  private readonly acceptedUuids = new Set<string>();
  private readonly acceptedUuidOrder: string[] = [];

  constructor(private readonly sessionId: string) {}

  /**
   * wire 帧 → 队列命令。`sessionId` 与 `origin` 在这里被强制 stamp，调用方无法绕过。
   */
  toCommand(msg: InboundUserMessage): QueuedCommand {
    return {
      prompt: msg.message.content,
      commandMode: msg.commandMode ?? 'prompt',
      priority: msg.priority ?? 'next',
      shouldQuery: msg.shouldQuery,
      uuid: msg.uuid,
      queueId: randomUUID(),
      isMeta: msg.isMeta ?? msg.isSynthetic,
      // A stream-json connection is bound to exactly one session. The wire field
      // is output metadata, not an input routing selector.
      sessionId: this.sessionId,
      stopHookActive: msg.stopHookActive,
      // 用户随本轮输入选中的 Skill；mid-turn 注入走 core 的 drainMidTurnQueue。
      selectedSkills: msg.selected_skills,
      origin: {
        kind: 'bridge',
        sessionId: this.sessionId,
      },
    };
  }

  hasAcceptedUuid(uuid: string): boolean {
    return this.acceptedUuids.has(uuid);
  }

  /** 记录已接受的 uuid，按 FIFO 淘汰；返回被淘汰的 uuid 供调用方清理终态去重表。 */
  acceptUuid(uuid: string): string[] {
    this.acceptedUuids.add(uuid);
    this.acceptedUuidOrder.push(uuid);
    if (this.acceptedUuidOrder.length <= MAX_ACCEPTED_UUIDS) return [];
    const expired = this.acceptedUuidOrder.splice(
      0,
      this.acceptedUuidOrder.length - MAX_ACCEPTED_UUIDS,
    );
    for (const value of expired) this.acceptedUuids.delete(value);
    return expired;
  }

  enqueueMessage(msg: InboundUserMessage): QueuedCommand {
    const command = this.toCommand(msg);
    this.messageByQueueId.set(command.queueId!, msg);
    enqueue(command);
    return command;
  }

  originalMessage(command: QueuedCommand): InboundUserMessage | undefined {
    return command.queueId === undefined
      ? undefined
      : this.messageByQueueId.get(command.queueId);
  }

  /** 本会话的主线 SDK 命令：有 queueId、原始帧还在、不指向子 agent、属于本会话。 */
  isOwnCommand(command: QueuedCommand): boolean {
    return (
      command.queueId !== undefined &&
      this.messageByQueueId.has(command.queueId) &&
      command.targetAgentId === undefined &&
      (command.sessionId === undefined || command.sessionId === this.sessionId)
    );
  }

  /** 本会话的主线命令（含任务通知、队友消息这类内部续跑）。 */
  isOwnMainThreadCommand(command: QueuedCommand): boolean {
    return (
      command.targetAgentId === undefined &&
      (command.sessionId === undefined || command.sessionId === this.sessionId)
    );
  }

  isOwnContinuation(command: QueuedCommand): boolean {
    if (!this.isOwnMainThreadCommand(command)) return false;
    if (command.commandMode === 'task-notification') return true;
    return command.commandMode === 'prompt' && command.origin?.kind === 'peer';
  }

  dequeueNext(): QueuedCommand | undefined {
    return dequeue(
      (command) =>
        this.isOwnCommand(command) || this.isOwnContinuation(command),
    );
  }

  dequeueContinuation(): QueuedCommand | undefined {
    return dequeue((command) => this.isOwnContinuation(command));
  }

  /**
   * 是否还有本会话的续跑排着；退出前的后台收尾据此判断能否离场。
   */
  hasOwnContinuation(): boolean {
    return peek((command) => this.isOwnContinuation(command)) !== undefined;
  }

  hasPriorityNowCommand(): boolean {
    return (
      peek(
        (command) => this.isOwnCommand(command) && command.priority === 'now',
      ) !== undefined
    );
  }

  /** 本会话是否有排着、下一轮可派发的命令（prompt suggestion 取消的触发判据）。 */
  hasDispatchableCommand(): boolean {
    return peek(
      (command) =>
        this.isOwnCommand(command) || this.isOwnContinuation(command),
    ) !== undefined;
  }

  /** 当前排队 / 在途的本会话命令 uuid，`interrupt` 与 `cancel_async_message` 都要用。 */
  queuedUuids(): string[] {
    const uuids = new Set<string>();
    const record = (command: QueuedCommand) => {
      if (this.isOwnMainThreadCommand(command) && command.uuid !== undefined) {
        uuids.add(command.uuid);
      }
    };
    for (const command of getInFlightDrainBatch()) record(command);
    for (const command of getCommandQueue()) record(command);
    return [...uuids];
  }

  /** `interrupt {cancel_queued:true}`：整批作废，含没有公开 uuid 的命令。 */
  cancelQueued(): QueuedCommand[] {
    const inFlight = markInFlightDrainBatchCancelPending((command) =>
      this.isOwnMainThreadCommand(command),
    );
    const removed = removeByFilter((command) =>
      this.isOwnMainThreadCommand(command),
    );
    const all = [...inFlight, ...removed];
    for (const command of all) this.forgetQueueId(command);
    return all;
  }

  /**
   * `cancel_async_message`：按 uuid 作废。命中在途批次时只打标记（批次结算时整批丢弃），
   * 返回 `cancelled: false` 是 wire 契约，与既有实现一致。
   */
  cancelByUuid(messageUuid: string): { cancelled: boolean } {
    const isInFlight = someInFlightDrainCommand(
      (command) => this.isOwnCommand(command) && command.uuid === messageUuid,
    );
    if (isInFlight) {
      markCancelPending(messageUuid);
      return { cancelled: false };
    }
    const removed = removeByFilter(
      (command) => this.isOwnCommand(command) && command.uuid === messageUuid,
    );
    for (const command of removed) this.forgetQueueId(command);
    return { cancelled: removed.length > 0 };
  }

  /** teardown：把仍属于本会话的排队命令全部取出，调用方发 `discarded` 终态。 */
  discardQueued(): QueuedCommand[] {
    const removed = removeByFilter((command) => this.isOwnCommand(command));
    for (const command of removed) this.forgetQueueId(command);
    return removed;
  }

  /**
   * 原始帧映射的回收：队列与在途批次里都不再出现的 queueId 即可丢弃。
   * 不要在队列订阅回调里同步调用——`dequeue()` 先 splice 再通知，同步 prune 会
   * 删掉正在派发那一帧的映射；调用方必须推迟到微任务。
   */
  prune(): void {
    const live = new Set<string>();
    for (const command of [...getCommandQueue(), ...getInFlightDrainBatch()]) {
      if (command.queueId) live.add(command.queueId);
    }
    for (const queueId of this.messageByQueueId.keys()) {
      if (!live.has(queueId)) this.messageByQueueId.delete(queueId);
    }
  }

  forgetQueueId(command: QueuedCommand): void {
    if (command.queueId) this.messageByQueueId.delete(command.queueId);
  }

  clear(): void {
    this.messageByQueueId.clear();
    this.acceptedUuids.clear();
    this.acceptedUuidOrder.length = 0;
  }
}
