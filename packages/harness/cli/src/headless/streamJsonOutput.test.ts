/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { StreamJsonOutput } from './streamJsonOutput.js';
import type { ThreadEvent } from '../thread-manager/thread-session/contract/hostContext.js';

function collect(options?: {
  includeHookEvents?: boolean;
  replayUserMessages?: boolean;
}) {
  const lines: string[] = [];
  const output = new StreamJsonOutput((line) => lines.push(line), {
    getSessionId: () => 'sess-1',
    ...options,
  });
  return { output, lines };
}

const snapshot = {
  sessionId: 'sess-1',
  cwd: '/workspace',
  model: 'mmodel',
  permissionMode: 'default',
  tools: [],
  mcpServers: [],
  slashCommands: [],
  outputStyle: 'default',
  agents: [],
  skills: [],
  plugins: [],
  version: '1.0.0',
  apiKeySource: 'none',
};

describe('StreamJsonOutput', () => {
  it('dedupes consecutive init frames but re-emits one for the next turn', () => {
    const { output, lines } = collect();
    const snapshotEvent = {
      kind: 'sessionSnapshot',
      snapshot,
    } as unknown as ThreadEvent;

    // initialize 与首轮提交前的两次快照只保留一帧。
    output.handle(snapshotEvent);
    output.handle(snapshotEvent);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      capabilities: [],
    });

    // 中间有会话消息后，下一轮的 init 照常发（1.1.80 每轮一帧）。
    output.handle({
      kind: 'threadMessage',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        uuid: 'u1',
        session_id: 'sess-1',
      },
    } as unknown as ThreadEvent);
    output.handle(snapshotEvent);
    const inits = lines.filter(
      (line) => JSON.parse(line).subtype === 'init',
    );
    expect(inits).toHaveLength(2);
  });

  it('forwards artifacts and hook diagnostics notices as legacy frames', () => {
    const { output, lines } = collect();
    output.handle({
      kind: 'notice',
      notice: { kind: 'artifactsChanged', artifacts: [] },
    } as unknown as ThreadEvent);
    output.handle({
      kind: 'notice',
      notice: {
        kind: 'hookDiagnostics',
        snapshot: {
          readStatus: 'complete',
          checkedAt: '2026-01-01T00:00:00.000Z',
          diagnostics: [],
        },
      },
    } as unknown as ThreadEvent);
    // hook_diagnostics 压到首条会话消息之前，对齐 1.1.80 帧序。
    output.handle({
      kind: 'threadMessage',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        uuid: 'u1',
        session_id: 'sess-1',
      },
    } as unknown as ThreadEvent);

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'system',
      subtype: 'artifacts_update',
      artifacts: [],
      session_id: 'sess-1',
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      type: 'system',
      subtype: 'hook_diagnostics',
      read_status: 'complete',
      checked_at: '2026-01-01T00:00:00.000Z',
      diagnostics: [],
    });
    expect(JSON.parse(lines[2]!)).toMatchObject({ type: 'assistant' });
  });

  it('forwards hook lifecycle frames only when --include-hook-events is set', () => {
    const event = {
      kind: 'notice',
      notice: {
        kind: 'hookStarted',
        payload: {
          hook_id: 'h1',
          hook_name: 'SessionStart',
          hook_event: 'SessionStart',
        },
      },
    } as unknown as ThreadEvent;

    const off = collect();
    off.output.handle(event);
    expect(off.lines).toHaveLength(0);

    const on = collect({ includeHookEvents: true });
    on.output.handle(event);
    expect(on.lines).toHaveLength(1);
    expect(JSON.parse(on.lines[0]!)).toMatchObject({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
    });
  });

  it('replays inbound user messages only when --replay-user-messages is set', () => {
    const event = {
      kind: 'messageReplay',
      commandUuid: 'u1',
      message: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        parent_tool_use_id: null,
      },
    } as unknown as ThreadEvent;

    const off = collect();
    off.output.handle(event);
    expect(off.lines).toHaveLength(0);

    const on = collect({ replayUserMessages: true });
    on.output.handle(event);
    expect(on.lines).toHaveLength(1);
    expect(JSON.parse(on.lines[0]!)).toMatchObject({
      type: 'user',
      uuid: 'u1',
      session_id: 'sess-1',
      isReplay: true,
    });
  });

  it('gates plain user echo and keeps tool-result user frames', () => {
    const { output, lines } = collect();
    output.handle({
      kind: 'threadMessage',
      message: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        uuid: 'u1',
        session_id: 'sess-1',
      },
    } as unknown as ThreadEvent);
    output.handle({
      kind: 'threadMessage',
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
        uuid: 'u2',
        session_id: 'sess-1',
      },
    } as unknown as ThreadEvent);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'user', uuid: 'u2' });
  });

  it('forwards session messages and ignores non-documented event kinds', () => {
    const { output, lines } = collect();
    output.handle({
      kind: 'threadMessage',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        uuid: 'u1',
        session_id: 'sess-1',
      },
    } as unknown as ThreadEvent);
    output.handle({
      kind: 'commandLifecycle',
      commandUuid: 'c1',
      state: 'completed',
    } as unknown as ThreadEvent);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'assistant',
      session_id: 'sess-1',
    });
  });
});
