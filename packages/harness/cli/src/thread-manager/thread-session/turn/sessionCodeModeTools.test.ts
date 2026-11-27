/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CoreToolCallStatus,
  InMemoryToolCallSnapshotStore,
  coreEvents,
  type SDKMessage,
  type ToolCall,
} from '@qwen-code/core';
import { attachSessionCodeModeTools } from './sessionCodeModeTools.js';

function call(id: string, extra = {}): ToolCall {
  return {
    status: CoreToolCallStatus.Validating,
    request: { callId: id, name: 'mcp__test__lookup', args: { key: id }, prompt_id: 'p' },
    startTime: Date.now(),
    ...extra,
  } as unknown as ToolCall;
}

describe('CodeMode 宿主消息', () => {
  it('并行子调用跨 CodeMode/Wait 保持归属，结果只发送一次，MCP 进度按调用隔离', () => {
    const snapshots = new InMemoryToolCallSnapshotStore();
    const messages: SDKMessage[] = [];
    const dispose = attachSessionCodeModeTools({ snapshots, sessionId: 'session', emitMessage: m => messages.push(m) });
    const publish = (toolCalls: ToolCall[], toolCallScopeId = 'cell') => snapshots.publishToolCallSnapshot({
      toolCallScopeId, toolCalls, codeMode: { rootToolUseId: 'exec', parentToolUseId: 'agent' },
    });
    const progress = (callId: string) => coreEvents.emitMcpProgress({
      sessionId: 'session', callId, serverName: 'test', progressToken: 'token', progress: 1, total: 2, message: '一半',
    });
    try {
      publish([call('a'), call('b', { status: CoreToolCallStatus.AwaitingApproval })]);
      expect(messages).toMatchObject([
        { type: 'system', subtype: 'host_tool_use', code_mode_tool_use_id: 'exec', parent_tool_use_id: 'agent', message: { content: [{ id: 'a' }] } },
        { type: 'system', subtype: 'host_tool_use', code_mode_tool_use_id: 'exec', parent_tool_use_id: 'agent', message: { content: [{ id: 'b' }] } },
      ]);
      // A Wait snapshot leaves child calls in other schedulers active.
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'root', toolCalls: [call('wait')] });
      progress('unrelated');
      progress('a');
      expect(messages).toHaveLength(3);
      expect(messages[2]).toMatchObject({ type: 'tool_progress', tool_use_id: 'a', parent_tool_use_id: 'agent', mcp: { server_name: 'test', progress: 1, total: 2, message: '一半' } });
      const hostResult = {
        content: [{ type: 'text', text: 'done' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
        is_error: false,
        tool_use_result: { content: 'done', structuredContent: { value: 1 } },
      };
      const done = call('a', { status: CoreToolCallStatus.Success, response: { hostResult } });
      publish([done, call('b')]);
      publish([done, call('b')]);
      progress('a');
      expect(messages).toHaveLength(4);
      expect(messages[3]).toMatchObject({ type: 'system', subtype: 'host_tool_result', code_mode_tool_use_id: 'exec', tool_use_result: hostResult.tool_use_result, message: { content: [{ tool_use_id: 'a', content: hostResult.content }] } });
      publish([done, call('b', { status: CoreToolCallStatus.Cancelled, response: { hostResult: { content: 'denied', is_error: true, tool_result_meta: [{ id: 'b', non_execution_kind: 'user-rejected' }] } } })]);
      expect(messages).toHaveLength(5);
      expect(messages[4]).toMatchObject({ type: 'system', subtype: 'host_tool_result', message: { content: [{ tool_use_id: 'b', is_error: true }] }, tool_result_meta: [{ id: 'b' }] });
      publish([]);
      progress('b');
      expect(messages).toHaveLength(5);
      for (const message of messages) {
        if (message.type === 'system' && message.subtype === 'host_tool_use') {
          expect(message.message).not.toHaveProperty('model');
          expect(message.message).not.toHaveProperty('usage');
        }
      }
    } finally { dispose(); }
    publish([call('c')]);
    expect(messages).toHaveLength(5);
  });

  it('普通 MCP 与 CodeMode 共用精确进度出口，原生调用不重复生成宿主消息', () => {
    const snapshots = new InMemoryToolCallSnapshotStore();
    const messages: SDKMessage[] = [];
    const dispose = attachSessionCodeModeTools({ snapshots, sessionId: 'session', emitMessage: m => messages.push(m) });
    const progress = (callId: string) => coreEvents.emitMcpProgress({ sessionId: 'session', callId, serverName: 'test', progressToken: 1, progress: 1 });
    try {
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'root', toolCalls: [call('a'), call('b')] });
      expect(messages).toEqual([]);
      progress('b'); progress('a');
      expect(messages).toMatchObject([{ type: 'tool_progress', tool_use_id: 'b' }, { type: 'tool_progress', tool_use_id: 'a' }]);
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'root', toolCalls: [call('a', { status: CoreToolCallStatus.Success }), call('b')] });
      progress('a');
      expect(messages).toHaveLength(2);
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'root', toolCalls: [] });
      progress('b');
      expect(messages).toHaveLength(2);
    } finally { dispose(); }
  });

  it('相同的普通 MCP 调用 ID 只接收本会话进度，另一会话结束后仍能继续', () => {
    const open = (sessionId: string) => {
      const snapshots = new InMemoryToolCallSnapshotStore();
      const messages: SDKMessage[] = [];
      const dispose = attachSessionCodeModeTools({
        sessionId,
        snapshots,
        emitMessage: (m) => messages.push(m),
      });
      snapshots.publishToolCallSnapshot({
        toolCallScopeId: 'root',
        toolCalls: [call('same')],
      });
      return { messages, dispose, snapshots };
    };
    const a = open('a');
      const b = open('b');
    const progress = (sessionId: string, message: string) =>
      coreEvents.emitMcpProgress({
        sessionId,
        message,
        callId: 'same',
        progress: 1,
        progressToken: sessionId,
        serverName: 'shared',
      });
    try {
      progress('b', 'B1');
      progress('a', 'A1');
      progress('', 'unowned');
      a.snapshots.publishToolCallSnapshot({
        toolCallScopeId: 'root',
        toolCalls: [],
      });
      progress('a', 'late');
      progress('b', 'B2');
      expect(a.messages).toMatchObject([
        { type: 'tool_progress', session_id: 'a', mcp: { message: 'A1' } },
      ]);
      expect(b.messages).toMatchObject([
        { type: 'tool_progress', session_id: 'b', mcp: { message: 'B1' } },
        { type: 'tool_progress', session_id: 'b', mcp: { message: 'B2' } },
      ]);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('根 Agent 的子调用不占用 parent_tool_use_id，多个会话不重复接收 MCP 进度', () => {
    const first = new InMemoryToolCallSnapshotStore();
    const second = new InMemoryToolCallSnapshotStore();
    const a: SDKMessage[] = [];
    const b: SDKMessage[] = [];
    const disposeA = attachSessionCodeModeTools({ snapshots: first, sessionId: 'a', emitMessage: m => a.push(m) });
    const disposeB = attachSessionCodeModeTools({ snapshots: second, sessionId: 'b', emitMessage: m => b.push(m) });
    try {
      first.publishToolCallSnapshot({ toolCallScopeId: 'cell-a', codeMode: { rootToolUseId: 'exec-a' }, toolCalls: [call('only-a', { request: { ...call('only-a').request, parentCallId: 'exec-a' } })] });
      coreEvents.emitMcpProgress({ sessionId: 'a', callId: 'only-a', serverName: 'test', progressToken: 1, progress: 1 });
      expect(a).toHaveLength(2);
      expect(a[0]).toMatchObject({ parent_tool_use_id: null, code_mode_tool_use_id: 'exec-a' });
      expect(a[1]).toMatchObject({ type: 'tool_progress', parent_tool_use_id: null });
      expect(b).toEqual([]);
    } finally { disposeA(); disposeB(); }
  });
});
