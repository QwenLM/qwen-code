/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  CoreEvent,
  CoreToolCallStatus,
  coreEvents,
  type McpProgressPayload,
  type SDKMessage,
  type ToolCallSnapshotSubscriber,
} from '@qwen-code/core';

/** Observe child calls across CodeMode and CodeModeWait for the live host stream only. */
export function attachSessionCodeModeTools(params: {
  snapshots: ToolCallSnapshotSubscriber;
  sessionId: string;
  emitMessage: (message: SDKMessage) => void;
}): () => void {
  const schedulers = new Map<string, Set<string>>();
  const calls = new Map<string, {
    name: string;
    parentToolUseId: string | null;
    startedAt: number;
    ended: boolean;
  }>();
  const unsubscribe = params.snapshots.subscribeToolCallSnapshots(snapshot => {
    const { rootToolUseId, parentToolUseId } = snapshot.codeMode ?? {};
    const known = schedulers.get(snapshot.toolCallScopeId) ?? new Set<string>();
    schedulers.set(snapshot.toolCallScopeId, known);
    for (const call of snapshot.toolCalls) {
      const { callId, name, args } = call.request;
      const envelope = {
        type: 'system' as const,
        code_mode_tool_use_id: rootToolUseId,
        session_id: params.sessionId,
        parent_tool_use_id: parentToolUseId ?? null,
      };
      if (!known.has(callId)) {
        known.add(callId);
        calls.set(callId, {
          name,
          parentToolUseId: snapshot.codeMode
            ? parentToolUseId ?? null
            : call.request.parentCallId ?? null,
          startedAt: call.startTime ?? Date.now(),
          ended: false,
        });
        if (rootToolUseId) params.emitMessage({
          ...envelope,
          code_mode_tool_use_id: rootToolUseId,
          subtype: 'host_tool_use',
          uuid: randomUUID(),
          message: { role: 'assistant', content: [{
            type: 'tool_use', id: callId, name, input: { ...args },
          }] },
        });
      }
      const state = calls.get(callId)!;
      if (call.status === CoreToolCallStatus.Executing && call.executionStartedAt !== undefined) {
        state.startedAt = call.executionStartedAt;
      }
      const hostResult = 'response' in call ? call.response.hostResult : undefined;
      if (!state.ended && hostResult && rootToolUseId) {
        state.ended = true;
        const { content, is_error, tool_use_result, tool_result_meta } = hostResult;
        params.emitMessage({
          ...envelope,
          code_mode_tool_use_id: rootToolUseId,
          subtype: 'host_tool_result',
          uuid: randomUUID(),
          message: { role: 'user', content: [{
            type: 'tool_result', tool_use_id: callId, content,
            ...(is_error === undefined ? {} : { is_error }),
          }] },
          ...(tool_use_result === undefined ? {} : { tool_use_result }),
          ...(tool_result_meta === undefined ? {} : { tool_result_meta }),
        });
      }
      if (!snapshot.codeMode && (call.status === CoreToolCallStatus.Success ||
          call.status === CoreToolCallStatus.Error || call.status === CoreToolCallStatus.Cancelled)) {
        state.ended = true;
      }
    }
    if (snapshot.toolCalls.length === 0) {
      for (const id of known) calls.delete(id);
      schedulers.delete(snapshot.toolCallScopeId);
    }
  });
  const onProgress = (event: McpProgressPayload) => {
    if (event.sessionId !== params.sessionId) return;
    const call = calls.get(event.callId);
    if (!call || call.ended) return;
    params.emitMessage({
      type: 'tool_progress',
      uuid: randomUUID(),
      session_id: params.sessionId,
      tool_use_id: event.callId,
      tool_name: call.name,
      parent_tool_use_id: call.parentToolUseId,
      elapsed_time_seconds: Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000)),
      mcp: {
        server_name: event.serverName,
        progress: event.progress,
        ...(event.total === undefined ? {} : { total: event.total }),
        ...(event.message === undefined ? {} : { message: event.message }),
      },
    });
  };
  coreEvents.on(CoreEvent.McpProgress, onProgress);
  return () => {
    unsubscribe();
    coreEvents.off(CoreEvent.McpProgress, onProgress);
    calls.clear();
    schedulers.clear();
  };
}
