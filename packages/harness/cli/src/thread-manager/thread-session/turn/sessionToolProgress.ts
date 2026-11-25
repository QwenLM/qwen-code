/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  CoreToolCallStatus,
  ROOT_TOOL_CALL_SCOPE_ID,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  SHELL_PROGRESS_THRESHOLD_MS,
  SHELL_OUTPUT_PREVIEW_MAX_BYTES,
  type ToolCallSnapshotSubscriber,
  type ToolLiveOutput,
} from '@qwen-code/core';
import type {
  ThreadNotice,
  SessionToolProgress,
} from '../contract/hostContext.js';

type Preview = Pick<
  SessionToolProgress,
  'output' | 'totalBytes' | 'totalLines' | 'previewTruncated'
>;
type ProgressState = {
  toolCallScopeId: string;
  notice: SessionToolProgress;
  pending?: Preview;
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

// 尾部窗口按 UTF-8 字节裁剪，不能从多字节字符中间解码。
function preview(live: ToolLiveOutput | undefined): Preview {
  const structured =
    typeof live === 'object' && live !== null && 'isShellLiveOutput' in live
      ? live
      : undefined;
  const text = typeof live === 'string' ? live : (structured?.output ?? '');
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - SHELL_OUTPUT_PREVIEW_MAX_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const count = (n: unknown): number | undefined =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  const totalBytes = count(structured?.totalBytes);
  const totalLines = count(structured?.totalLines);
  return {
    output: bytes.subarray(start).toString('utf8'),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(totalLines !== undefined ? { totalLines } : {}),
    ...(start > 0 || (totalBytes !== undefined && totalBytes > bytes.length)
      ? { previewTruncated: true }
      : {}),
  };
}

/** 会话所有的只读观察器；不干预执行、权限或后台切换。 */
export function attachSessionToolProgress(params: {
  snapshots: ToolCallSnapshotSubscriber;
  emitNotice: (notice: ThreadNotice) => void;
}): () => void {
  const active = new Map<string, ProgressState>();
  const ended = new Map<string, string>();
  let disposed = false;
  const send = (state: ProgressState) => {
    state.notice = {
      ...state.notice,
      sequence: state.notice.sequence + 1,
      elapsedMs: Math.max(0, Date.now() - state.notice.startedAtMs),
    };
    state.sentAt = Date.now();
    params.emitNotice({ ...state.notice });
  };
  const unsubscribe = params.snapshots.subscribeToolCallSnapshots(
    (snapshot) => {
      if (disposed || (snapshot.toolCallScopeId !== ROOT_TOOL_CALL_SCOPE_ID && !snapshot.codeMode)) return;
      const executing = new Set<string>();
      const present = new Set(
        snapshot.toolCalls.map((call) => call.request.callId),
      );
      for (const [id, toolCallScopeId] of ended) {
        if (toolCallScopeId === snapshot.toolCallScopeId && !present.has(id)) ended.delete(id);
      }
      for (const call of snapshot.toolCalls) {
        const { callId, name, args, parentCallId } = call.request;
        if (
          call.status !== CoreToolCallStatus.Executing ||
          (parentCallId && !snapshot.codeMode) ||
          (name !== SHELL_TOOL_NAME && name !== POWERSHELL_TOOL_NAME) ||
          args['run_in_background'] === true ||
          ended.has(callId)
        )
          continue;
        executing.add(callId);
        let state = active.get(callId);
        if (!state) {
          const start = call.executionStartedAt;
          state = {
            toolCallScopeId: snapshot.toolCallScopeId,
            notice: {
              kind: 'toolProgress',
              ...(snapshot.codeMode?.parentToolUseId ? {
                parentToolUseId: snapshot.codeMode.parentToolUseId,
              } : {}),
              toolUseId: callId,
              toolName: name,
              executionId: randomUUID(),
              sequence: 0,
              phase: 'running',
              startedAtMs:
                typeof start === 'number' &&
                Number.isFinite(start) &&
                start >= 0
                  ? start
                  : Date.now(),
              elapsedMs: 0,
              output: '',
            },
            sentAt: 0,
          };
          active.set(callId, state);
          send(state);
        }
        const next = preview(call.liveOutput);
        if (
          next.output === state.notice.output &&
          next.totalBytes === state.notice.totalBytes &&
          next.totalLines === state.notice.totalLines &&
          next.previewTruncated === state.notice.previewTruncated
        ) {
          state.pending = undefined;
          continue;
        }
        state.pending = next;
        if (state.timer) continue;
        const current = state;
        const flush = () => {
          current.timer = undefined;
          if (disposed || !current.pending || !active.has(callId)) return;
          current.notice = {
            ...current.notice,
            totalBytes: undefined,
            totalLines: undefined,
            previewTruncated: undefined,
            ...current.pending,
          };
          current.pending = undefined;
          send(current);
        };
        const delay = Math.max(
          0,
          state.notice.startedAtMs + SHELL_PROGRESS_THRESHOLD_MS - Date.now(),
          state.sentAt + 1000 - Date.now(),
        );
        if (delay === 0) flush();
        else {
          state.timer = setTimeout(flush, delay);
          state.timer.unref?.();
        }
      }
      for (const [id, state] of active) {
        if (state.toolCallScopeId !== snapshot.toolCallScopeId) continue;
        if (executing.has(id)) continue;
        clearTimeout(state.timer);
        state.notice = {
          ...state.notice,
          ...(state.pending ? {
            totalBytes: undefined, totalLines: undefined, previewTruncated: undefined,
            ...state.pending,
          } : {}),
          phase: 'ended',
        };
        send(state);
        active.delete(id);
        if (present.has(id)) ended.set(id, snapshot.toolCallScopeId);
      }
    },
  );
  return () => {
    disposed = true;
    unsubscribe();
    for (const state of active.values()) clearTimeout(state.timer);
    active.clear();
    ended.clear();
  };
}
