/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 命令生命周期的终态去重。同一个 commandUuid 的 `completed` / `cancelled` / `discarded`
 * 只能报一次：队列派发、turn 循环、teardown 三条路径都可能对同一 uuid 报终态，而上游按
 * commandUuid 记账。去重属于会话而非宿主（成因是会话内部并发，不是 wire 的性质），投影
 * 自己产出的 `command_lifecycle` 消息也要过同一道去重。本模块只产事件、不构造帧。
 */

import type { SDKMessage } from '@qwen-code/core';
import type {
  ThreadCommandState,
  ThreadEvent,
} from '../contract/hostContext.js';

function isTerminalState(state: string): boolean {
  return (
    state === 'completed' || state === 'cancelled' || state === 'discarded'
  );
}

export class CommandLifecycleDedupe {
  private readonly terminalUuids = new Set<string>();

  constructor(private readonly emit: (event: ThreadEvent) => void) {}

  /** 投影产出的 command_lifecycle 消息是否该放行（终态已报过则丢弃）。 */
  filterSdkMessage(message: SDKMessage): boolean {
    if (message.type !== 'command_lifecycle') return true;
    if (!isTerminalState(message.state)) return true;
    if (this.terminalUuids.has(message.command_uuid)) return false;
    this.terminalUuids.add(message.command_uuid);
    return true;
  }

  /** 报一次状态转移；终态按 uuid 去重，uuid 为空时不报。 */
  emitLifecycle(
    commandUuid: string | undefined,
    state: ThreadCommandState,
  ): void {
    if (!commandUuid) return;
    if (isTerminalState(state)) {
      if (this.terminalUuids.has(commandUuid)) return;
      this.terminalUuids.add(commandUuid);
    }
    this.emit({ kind: 'commandLifecycle', commandUuid, state });
  }

  /** 撤销某个 uuid 的终态记账，让它能再报一次（uuid 被复用时用）。 */
  forget(commandUuid: string): void {
    this.terminalUuids.delete(commandUuid);
  }
}

/**
 * 这条投影消息是否表示本轮被取消（而不是正常完成）。会话用它决定命令终态报
 * `completed` 还是 `cancelled`，因此属于会话语义而不是 wire 投影。`error_max_turns`
 * 是预算用尽的正常终局，不算取消。
 */
export function isCancelledTurnResult(message: SDKMessage): boolean {
  return (
    message.type === 'result' &&
    message.is_error === true &&
    message.subtype !== 'error_max_turns'
  );
}
