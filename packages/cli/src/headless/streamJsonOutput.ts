/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure headless 的 stream-json 输出投影。
 *
 * 转发会话能力快照、会话消息、hook_diagnostics / hook 事件、artifacts 与 replay；
 * 不实现 SDK 控制面。
 */

import type { SDKSystemMessage } from '@qwen-code/core';
import { randomUUID } from 'node:crypto';
import {
  ndjsonSafeStringify,
  type InboundUserMessage,
  type SDKMessage,
} from '@qwen-code/core';
import type {
  ThreadEvent,
  ThreadNotice,
} from '../thread-manager/thread-session/contract/hostContext.js';
import {
  renderStreamJsonInitMessage,
  type SessionInitSnapshot,
} from '../thread-manager/thread-session/initialize/sessionInitFrame.js';

function isToolResultUserMessage(message: SDKMessage): boolean {
  if (message.type !== 'user') return false;
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  );
}

export interface StreamJsonOutputOptions {
  readonly getSessionId: () => string;
  readonly decorateInitMessage?: (
    message: SDKSystemMessage,
    version: string,
  ) => void;
  /** `--include-hook-events`：hook 生命周期三帧。 */
  readonly includeHookEvents?: boolean;
  /** `--replay-user-messages`：把入站用户消息以 isReplay 帧回显。 */
  readonly replayUserMessages?: boolean;
}

export class StreamJsonOutput {
  /** 首轮只保留一帧 init；出现会话消息后，下一轮的 init 照常发。 */
  private initWritten = false;
  private turnFrameSeen = false;
  /** 首个 hook_diagnostics 压到回放帧之后、首条会话消息之前。 */
  private pendingHookDiagnostics: SDKMessage | undefined;
  private hookDiagnosticsSeen = false;
  /**
   * 模型 key → 展示名。展示名是产品数据且只能异步查到，宿主在装配期预备好写进来；
   * 未命中的 key（自定义 provider 模型）在 init 帧原样回退内部 key。
   */
  private readonly modelDisplayNames = new Map<string, string>();

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly options: StreamJsonOutputOptions,
  ) {}

  /** 宿主装配期登记模型展示名，供 init 帧把内部 key 投影成展示名。 */
  recordModelDisplayName(modelKey: string, displayName: string): void {
    this.modelDisplayNames.set(modelKey, displayName);
  }

  handle(event: ThreadEvent): void {
    switch (event.kind) {
      case 'sessionSnapshot': {
        if (this.initWritten && !this.turnFrameSeen) return;
        const frame = renderStreamJsonInitMessage(
          event.snapshot as unknown as SessionInitSnapshot,
        ) as SDKMessage & { capabilities?: string[] };
        // 纯 headless 不再实现 SDK 控制面，不能宣告这些能力位。
        this.options.decorateInitMessage?.(
          frame as SDKSystemMessage,
          event.snapshot.version,
        );
        frame.capabilities = [];
        // 与 daemon 宿主一致：快照带内部 model key，init 帧回显目录展示名。
        const displayName = this.modelDisplayNames.get(event.snapshot.model);
        if (displayName !== undefined) {
          (frame as { model: string }).model = displayName;
        }
        this.writeLine(`${ndjsonSafeStringify(frame)}\n`);
        this.initWritten = true;
        this.turnFrameSeen = false;
        return;
      }
      case 'threadMessage': {
        // 普通用户输入默认不回显；只有工具结果这类 user 帧属于进度信息。
        if (
          event.message.type === 'user' &&
          !isToolResultUserMessage(event.message)
        ) {
          return;
        }
        this.writeMessage(event.message);
        return;
      }
      case 'notice': {
        this.writeNotice(event.notice);
        return;
      }
      case 'messageReplay': {
        this.writeReplay(event.message, event.commandUuid);
        return;
      }
      default:
        return;
    }
  }

  writeMessage(message: SDKMessage): void {
    // init / artifacts 之外的帧都先放行待发的 hook_diagnostics，保持旧帧序。
    if (message.type !== 'system') {
      this.flushHookDiagnostics();
    }
    this.writeLine(`${ndjsonSafeStringify(message)}\n`);
    if (message.type !== 'system') {
      this.turnFrameSeen = true;
    }
  }

  private writeFrameWithoutHookFlush(message: SDKMessage): void {
    this.writeLine(`${ndjsonSafeStringify(message)}\n`);
    if (message.type !== 'system') {
      this.turnFrameSeen = true;
    }
  }

  private flushHookDiagnostics(): void {
    const pending = this.pendingHookDiagnostics;
    if (pending === undefined) return;
    this.pendingHookDiagnostics = undefined;
    this.writeFrameWithoutHookFlush(pending);
  }

  private writeReplay(message: unknown, commandUuid: string): void {
    if (this.options.replayUserMessages !== true) return;
    const inbound = message as InboundUserMessage;
    this.writeFrameWithoutHookFlush({
      type: 'user',
      message: inbound.message,
      session_id: this.options.getSessionId(),
      parent_tool_use_id: null,
      uuid: commandUuid,
      ...(inbound.timestamp !== undefined
        ? { timestamp: inbound.timestamp }
        : {}),
      isReplay: true,
      ...(inbound.isSynthetic === true ? { isSynthetic: true } : {}),
      ...(inbound.selected_skills && inbound.selected_skills.length > 0
        ? { selected_skills: inbound.selected_skills }
        : {}),
    } as unknown as SDKMessage);
    // replay 回显之后再 flush hook_diagnostics。
    this.flushHookDiagnostics();
  }

  private writeNotice(notice: ThreadNotice): void {
    const envelope = () => ({
      uuid: randomUUID(),
      session_id: this.options.getSessionId(),
    });
    switch (notice.kind) {
      case 'artifactsChanged':
        this.writeFrameWithoutHookFlush({
          type: 'system',
          subtype: 'artifacts_update',
          artifacts: notice.artifacts,
          ...envelope(),
        } as unknown as SDKMessage);
        return;
      case 'hookDiagnostics': {
        const frame = {
          type: 'system',
          subtype: 'hook_diagnostics',
          read_status: notice.snapshot.readStatus,
          checked_at: notice.snapshot.checkedAt,
          diagnostics: notice.snapshot.diagnostics,
          ...envelope(),
        } as unknown as SDKMessage;
        if (!this.hookDiagnosticsSeen) {
          this.hookDiagnosticsSeen = true;
          this.pendingHookDiagnostics = frame;
          return;
        }
        this.writeMessage(frame);
        return;
      }
      case 'hookStarted': {
        if (this.options.includeHookEvents !== true) return;
        const p = notice.payload as Record<string, unknown>;
        this.writeMessage({
          type: 'system',
          subtype: 'hook_started',
          hook_id: p['hook_id'],
          hook_name: p['hook_name'],
          hook_event: p['hook_event'],
          ...envelope(),
        } as unknown as SDKMessage);
        return;
      }
      case 'hookProgress': {
        if (this.options.includeHookEvents !== true) return;
        const p = notice.payload as Record<string, unknown>;
        this.writeMessage({
          type: 'system',
          subtype: 'hook_progress',
          hook_id: p['hook_id'],
          hook_name: p['hook_name'],
          hook_event: p['hook_event'],
          stdout: p['stdout'],
          stderr: p['stderr'],
          output: p['output'],
          ...envelope(),
        } as unknown as SDKMessage);
        return;
      }
      case 'hookResponse': {
        if (this.options.includeHookEvents !== true) return;
        const p = notice.payload as Record<string, unknown>;
        this.writeMessage({
          type: 'system',
          subtype: 'hook_response',
          hook_id: p['hook_id'],
          hook_name: p['hook_name'],
          hook_event: p['hook_event'],
          output: p['output'],
          stdout: p['stdout'],
          stderr: p['stderr'],
          exit_code: p['exit_code'],
          duration_ms: p['duration_ms'],
          outcome: p['outcome'],
          ...envelope(),
        } as unknown as SDKMessage);
        return;
      }
      default:
        return;
    }
  }
}
