/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as acp from '@agentclientprotocol/sdk';
import { isDeepStrictEqual } from 'node:util';
import {
  completedToolCallToResult,
  CoreToolCallStatus,
  type ToolCallSnapshotSubscriber,
} from '@qwen-code/core';
import {
  projectToolCall,
  projectToolCallUpdate,
  projectTerminalOutputUpdate,
  type ProjectToolCallUpdateInput,
} from './toolProjection.js';

type PublishedTool = {
  name?: string;
  status: acp.ToolCallStatus;
  result?: acp.ToolCallUpdate;
};

/** One prompt's ACP projection. Observes execution without changing result order. */
export class AcpToolCallPublisher {
  private readonly tools = new Map<string, PublishedTool>();
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    snapshots: ToolCallSnapshotSubscriber,
    toolCallScopeId: string,
    messageId: string,
    private readonly supportsTerminalOutput: boolean,
    private readonly send: (update: acp.SessionUpdate) => Promise<void>,
  ) {
    this.unsubscribe = snapshots.subscribeToolCallSnapshots((snapshot) => {
      if (snapshot.toolCallScopeId !== toolCallScopeId) return;
      for (const call of snapshot.toolCalls) {
        if (call.request.message_id !== messageId) continue;
        if (
          call.status !== CoreToolCallStatus.Executing &&
          call.status !== CoreToolCallStatus.Success &&
          call.status !== CoreToolCallStatus.Error &&
          call.status !== CoreToolCallStatus.Cancelled
        )
          continue;
        void this.enqueue(async () => {
          // Execution may precede the assistant message. Declare the known
          // invocation first; the later assistant projection is deduped.
          await this.declareNow(
            projectToolCall({
              toolCallId: call.request.callId,
              name: call.request.name,
              input: call.request.args,
              kind: call.tool?.kind,
              status: 'pending',
              supportsTerminalOutput: this.supportsTerminalOutput,
            }),
            call.request.name,
          );
          if (this.disposed) return;
          if (call.status === CoreToolCallStatus.Executing) {
            const published = this.tools.get(call.request.callId)!;
            if (published.status !== 'pending') return;
            await this.send({
              sessionUpdate: 'tool_call_update',
              toolCallId: call.request.callId,
              status: 'in_progress',
            });
            published.status = 'in_progress';
          } else {
            if (this.tools.get(call.request.callId)?.result) return;
            const result = completedToolCallToResult(call);
            // Image uploads happen later in the ordered result path. Publish
            // status/text now without rendering raw image bytes as JSON text.
            const content = Array.isArray(result.content)
              ? result.content.filter(
                  (part) =>
                    part.type !== 'image' || part.source.type !== 'base64',
                )
              : result.content;
            await this.resultNow({
              toolCallId: result.tool_use_id,
              name: call.request.name,
              content:
                Array.isArray(content) && content.length === 0
                  ? undefined
                  : content,
              isError: result.is_error,
            });
          }
        });
      }
    });
  }

  declare(call: acp.ToolCall, name: string): Promise<void> {
    return this.enqueue(() => this.declareNow(call, name));
  }

  /** request_permission already supplies the tool's initial presentation. */
  permissionRequested(toolCallId: string, name: string): void {
    void this.enqueue(async () => {
      if (!this.tools.has(toolCallId)) {
        this.tools.set(toolCallId, { name, status: 'pending' });
      }
    });
  }

  result(input: ProjectToolCallUpdateInput): Promise<void> {
    return this.enqueue(() => this.resultNow(input));
  }

  flush(): Promise<void> {
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.tools.clear();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (!this.disposed) await task();
    });
    // Snapshot listeners are synchronous. Surface transport errors through the
    // next awaited projection or flush, without an unhandled rejection.
    void this.pending.catch(() => {});
    return this.pending;
  }

  private async declareNow(call: acp.ToolCall, name: string): Promise<void> {
    if (this.tools.has(call.toolCallId)) return;
    await this.send({ sessionUpdate: 'tool_call', ...call });
    if (this.disposed) return;
    this.tools.set(call.toolCallId, { name, status: call.status ?? 'pending' });
  }

  private async resultNow(input: ProjectToolCallUpdateInput): Promise<void> {
    const previous = this.tools.get(input.toolCallId);
    const projectedInput = {
      ...input,
      name: input.name ?? previous?.name,
      supportsTerminalOutput: this.supportsTerminalOutput,
    };
    const result = projectToolCallUpdate(projectedInput);
    if (
      previous?.result &&
      (previous.result.status !== result.status ||
        isDeepStrictEqual(previous.result, result))
    )
      return;
    if (!previous?.result) {
      const output = projectTerminalOutputUpdate(projectedInput);
      if (output)
        await this.send({ sessionUpdate: 'tool_call_update', ...output });
    }
    if (this.disposed) return;
    const update = { ...result };
    if (previous?.result) {
      // Enrich the existing result, without repeating terminal exit/output.
      delete update.status;
      delete update._meta;
    }
    await this.send({ sessionUpdate: 'tool_call_update', ...update });
    if (this.disposed) return;
    this.tools.set(input.toolCallId, {
      name: projectedInput.name,
      status: result.status!,
      result,
    });
  }
}
