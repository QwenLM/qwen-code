/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  appendLocalUserTranscriptMessage,
  createDaemonToolPreview,
  createDaemonTranscriptState,
  createDaemonTranscriptStore,
  daemonUiEventToTerminalText,
  getOutputText,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  sanitizeTerminalText,
  selectPendingPermissionBlocks,
} from '../../src/daemon/ui/index.js';

describe('daemon UI normalizer and transcript reducer', () => {
  it('normalizes daemon stream chunks and merges assistant transcript blocks', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(state, 'hello', { now: 2 });

    const first = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi ' },
        },
      },
    });
    const second = normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'there' },
        },
      },
    });

    state = reduceDaemonTranscriptEvents(state, [...first, ...second], {
      now: 3,
    });

    expect(state.lastEventId).toBe(2);
    expect(state.blocks).toMatchObject([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi there', streaming: true },
    ]);
  });

  it('marks assistant streaming complete only on explicit done events', () => {
    const events = normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
          _meta: { usage: { outputTokens: 1 } },
        },
      },
    });

    expect(events).toMatchObject([{ type: 'assistant.text.delta' }]);

    let state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      events,
      { now: 2 },
    );

    expect(state.activeAssistantBlockId).toBe('assistant-1');
    expect(state.blocks).toMatchObject([
      { kind: 'assistant', text: 'done', streaming: true },
    ]);

    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'assistant.done', reason: 'stop' }],
      { now: 3 },
    );

    expect(state.activeAssistantBlockId).toBeUndefined();
    expect(state.blocks).toMatchObject([
      { kind: 'assistant', text: 'done', streaming: false },
    ]);
  });

  it('surfaces missing toolCallId as a recoverable error', () => {
    const events = normalizeDaemonEvent({
      id: 21,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call_update',
          title: 'Run command',
          status: 'running',
          rawInput: { command: 'npm test' },
        },
      },
    });

    expect(events).toMatchObject([
      {
        type: 'error',
        recoverable: true,
        text: expect.stringContaining('missing toolCallId') as string,
      },
    ]);
  });

  it('surfaces session_closed as a visible terminal error', () => {
    const events = normalizeDaemonEvent({
      id: 23,
      v: 1,
      type: 'session_closed',
      data: { reason: 'idle timeout' },
    });

    expect(events).toMatchObject([
      {
        type: 'error',
        recoverable: false,
        text: 'Session closed: idle timeout',
      },
    ]);
  });

  it('suppresses only matching own user echoes', () => {
    const event = {
      id: 22,
      v: 1,
      type: 'session_update',
      originatorClientId: 'client-a',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    } as const;

    expect(
      normalizeDaemonEvent(event, {
        clientId: 'client-a',
        suppressOwnUserEcho: true,
      }),
    ).toEqual([]);
    expect(
      normalizeDaemonEvent(event, {
        clientId: 'client-b',
        suppressOwnUserEcho: true,
      }),
    ).toMatchObject([{ type: 'user.text.delta', text: 'hello' }]);
    expect(
      normalizeDaemonEvent(event, {
        clientId: 'client-a',
        suppressOwnUserEcho: false,
      }),
    ).toMatchObject([{ type: 'user.text.delta', text: 'hello' }]);
  });

  it('projects AskUserQuestion into a semantic tool preview', () => {
    const events = normalizeDaemonEvent({
      id: 3,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'ask-1',
          name: 'AskUserQuestion',
          title: 'Ask user 1 question',
          status: 'completed',
          rawInput: {
            questions: [
              {
                header: '城市',
                question: '你想查询哪个城市的天气？',
                options: [
                  { label: '北京', description: '查询北京今日天气' },
                  { label: '上海', description: '查询上海今日天气' },
                ],
              },
            ],
          },
        },
      },
    });
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 10 }),
      events,
      { now: 10 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'tool',
        toolCallId: 'ask-1',
        preview: {
          kind: 'ask_user_question',
          questions: [
            {
              header: '城市',
              question: '你想查询哪个城市的天气？',
              options: [
                { label: '北京', description: '查询北京今日天气' },
                { label: '上海', description: '查询上海今日天气' },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('tracks pending and resolved permissions', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 4,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'perm-1',
          sessionId: 'session-1',
          toolCall: { name: 'Bash', command: 'npm test' },
          options: [{ optionId: 'allow', label: 'Allow' }],
        },
      }),
      { now: 2 },
    );

    expect(selectPendingPermissionBlocks(state)).toHaveLength(1);

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 5,
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'perm-1',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      }),
      { now: 3 },
    );

    expect(selectPendingPermissionBlocks(state)).toHaveLength(0);
    expect(state.blocks).toMatchObject([
      {
        kind: 'permission',
        requestId: 'perm-1',
        resolved: 'selected:allow',
      },
    ]);
  });

  it('upserts tool blocks and trims stale indexes', () => {
    let state = createDaemonTranscriptState({ maxBlocks: 1, now: 1 });

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 6,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Run command',
            status: 'running',
            rawInput: { command: 'npm test' },
          },
        },
      }),
      { now: 2 },
    );

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 7,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            title: 'Run command',
            status: 'completed',
            rawOutput: 'ok',
          },
        },
      }),
      { now: 3 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'tool',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: 'ok',
      },
    ]);
    expect(state.blockIndexById).toEqual({ 'tool-1': 0 });

    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'status', text: 'trim tool' }],
      { now: 4 },
    );

    expect(state.blocks).toMatchObject([{ kind: 'status', text: 'trim tool' }]);
    expect(state.blockIndexById).toEqual({ 'status-2': 0 });
    expect(state.toolBlockByCallId['tool-1']).toBeDefined();

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 8,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            rawOutput: 'late',
          },
        },
      }),
      { now: 5 },
    );

    expect(state.blocks).toMatchObject([{ kind: 'status', text: 'trim tool' }]);
  });

  it('preserves rich tool preview and status on output-only updates', () => {
    let state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      normalizeDaemonEvent({
        id: 41,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-preserve',
            title: 'Run command',
            status: 'running',
            rawInput: { command: 'npm test' },
          },
        },
      }),
      { now: 2 },
    );

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 42,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-preserve',
            title: 'Run command',
            rawOutput: 'ok',
          },
        },
      }),
      { now: 3 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'tool',
        status: 'running',
        preview: { kind: 'command', command: 'npm test' },
        rawOutput: 'ok',
      },
    ]);
  });

  it('caps verbose tool details from raw input and output', () => {
    const [inputEvent] = normalizeDaemonEvent({
      id: 44,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'large-input',
          title: 'Large input',
          rawInput: { text: 'x'.repeat(5000) },
        },
      },
    });
    const [outputEvent] = normalizeDaemonEvent({
      id: 45,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'large-output',
          title: 'Large output',
          rawOutput: 'y'.repeat(5000),
        },
      },
    });

    expect(inputEvent).toMatchObject({
      type: 'tool.update',
      details: expect.stringContaining('[truncated]') as string,
    });
    expect(outputEvent).toMatchObject({
      type: 'tool.update',
      details: expect.stringContaining('[truncated]') as string,
    });
    expect(
      inputEvent && 'details' in inputEvent ? inputEvent.details?.length : 0,
    ).toBeLessThan(4200);
    expect(
      outputEvent && 'details' in outputEvent ? outputEvent.details?.length : 0,
    ).toBeLessThan(4200);
  });

  it('marks active assistant block complete when a tool interrupts the stream', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'assistant.text.delta', text: 'Before tool' },
        {
          type: 'tool.update',
          toolCallId: 'tool-after-text',
          title: 'Run command',
          status: 'running',
        },
        { type: 'assistant.done', reason: 'stop' },
      ],
      { now: 2 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'assistant',
        text: 'Before tool',
        streaming: false,
      },
      {
        kind: 'tool',
        toolCallId: 'tool-after-text',
      },
    ]);
    expect(state.activeAssistantBlockId).toBeUndefined();
  });

  it('splits thought blocks across assistant text boundaries', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'thought.text.delta', text: 'first thought' },
        { type: 'assistant.text.delta', text: 'answer' },
        { type: 'thought.text.delta', text: 'second thought' },
      ],
      { now: 2 },
    );

    expect(state.blocks).toMatchObject([
      { kind: 'thought', text: 'first thought' },
      { kind: 'assistant', text: 'answer' },
      { kind: 'thought', text: 'second thought' },
    ]);
  });

  it('redacts raw daemon payloads from fallback error text', () => {
    const [event] = normalizeDaemonEvent({
      id: 43,
      v: 1,
      type: 'session_died',
      data: { token: 'secret-token' },
    });

    expect(event).toMatchObject({
      type: 'error',
      recoverable: false,
      text: 'Session died (no details available)',
    });
    expect(event && 'text' in event ? event.text : '').not.toContain(
      'secret-token',
    );
  });

  it('normalizes daemon lifecycle and control events', () => {
    expect(
      normalizeDaemonEvent({
        id: 51,
        v: 1,
        type: 'model_switched',
        data: { modelId: 'qwen-plus' },
      }),
    ).toMatchObject([{ type: 'model.changed', modelId: 'qwen-plus' }]);
    expect(
      normalizeDaemonEvent({
        id: 52,
        v: 1,
        type: 'model_switch_failed',
        data: { error: 'no model' },
      }),
    ).toMatchObject([{ type: 'error', recoverable: true, text: 'no model' }]);
    expect(
      normalizeDaemonEvent({
        id: 53,
        v: 1,
        type: 'client_evicted',
        data: { reason: 'slow' },
      }),
    ).toMatchObject([{ type: 'error', recoverable: true, text: 'slow' }]);
    expect(
      normalizeDaemonEvent({
        id: 54,
        v: 1,
        type: 'slow_client_warning',
        data: {},
      }),
    ).toMatchObject([{ type: 'status', text: 'SSE stream is lagging' }]);
    expect(
      normalizeDaemonEvent({
        id: 55,
        v: 1,
        type: 'stream_error',
        data: { error: 'dropped' },
      }),
    ).toMatchObject([{ type: 'error', recoverable: true, text: 'dropped' }]);
    expect(
      normalizeDaemonEvent({
        id: 56,
        v: 1,
        type: 'permission_already_resolved',
        data: { requestId: 'perm-1', outcome: 'denied' },
      }),
    ).toMatchObject([
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'denied' },
    ]);
    expect(
      normalizeDaemonEvent({
        id: 59,
        v: 1,
        type: 'permission_already_resolved',
        data: { requestId: 'perm-2', status: 'already resolved' },
      }),
    ).toMatchObject([
      {
        type: 'permission.resolved',
        requestId: 'perm-2',
        outcome: 'already resolved',
      },
    ]);
    expect(
      normalizeDaemonEvent({
        id: 57,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: ['help', 'model'],
          },
        },
      }),
    ).toMatchObject([
      { type: 'status', text: 'Available commands updated (2)' },
    ]);
    expect(
      normalizeDaemonEvent({
        id: 58,
        v: 1,
        type: 'mcp_budget_warning',
        data: { token: 'secret' },
      }),
    ).toMatchObject([
      {
        type: 'status',
        text: 'mcp_budget_warning (unrecognized daemon event)',
      },
    ]);
  });

  it('caps recursive output extraction depth', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 70; i += 1) {
      nested = { content: nested };
    }

    expect(getOutputText(nested)).toBe('[output truncated]');
  });

  it('keeps orphan permission resolutions visible after request trimming', () => {
    let state = createDaemonTranscriptState({ maxBlocks: 1, now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 31,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'perm-trimmed',
          toolCall: { name: 'Bash', command: 'npm test' },
          options: [{ optionId: 'allow', label: 'Allow' }],
        },
      }),
      { now: 2 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'status', text: 'trim permission' }],
      { now: 3 },
    );

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 32,
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'perm-trimmed',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      }),
      { now: 4 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'permission',
        requestId: 'perm-trimmed',
        resolved: 'selected:allow',
      },
    ]);
  });

  it('preserves shell output streams while normalizing events', () => {
    const [stdout] = normalizeDaemonEvent({
      id: 8,
      v: 1,
      type: 'shell_output',
      data: { stream: 'stdout', text: 'out' },
    });
    const [stderr] = normalizeDaemonEvent({
      id: 9,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'shell_output',
          stream: 'stderr',
          text: 'err',
        },
      },
    });

    expect(stdout).toMatchObject({ type: 'shell.output', stream: 'stdout' });
    expect(stderr).toMatchObject({ type: 'shell.output', stream: 'stderr' });
  });

  it('merges consecutive same-stream shell output blocks only', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'shell.output', text: 'out-1', stream: 'stdout' },
        { type: 'shell.output', text: 'out-2', stream: 'stdout' },
        { type: 'shell.output', text: 'err-1', stream: 'stderr' },
        { type: 'shell.output', text: 'unknown-1' },
        { type: 'shell.output', text: 'unknown-2' },
      ],
      { now: 2 },
    );

    expect(state.blocks).toMatchObject([
      { kind: 'shell', text: 'out-1out-2', stream: 'stdout' },
      { kind: 'shell', text: 'err-1', stream: 'stderr' },
      { kind: 'shell', text: 'unknown-1' },
      { kind: 'shell', text: 'unknown-2' },
    ]);
  });

  it('provides a batched framework-free external store', async () => {
    const store = createDaemonTranscriptStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.appendLocalUserMessage('hello');
    store.dispatch([
      {
        type: 'status',
        text: 'ready',
      },
      {
        type: 'status',
        text: 'still ready',
      },
    ]);

    expect(calls).toBe(0);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(store.getSnapshot().blocks).toMatchObject([
      { kind: 'user', text: 'hello' },
      { kind: 'status', text: 'ready' },
      { kind: 'status', text: 'still ready' },
    ]);

    store.reset();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(store.getSnapshot().blocks).toEqual([]);

    unsubscribe();
    store.dispatch({ type: 'status', text: 'ignored listener' });
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it('renders UI events to sanitized terminal text', () => {
    const output = daemonUiEventToTerminalText({
      type: 'shell.output',
      text: '\u001b]0;bad\u0007ok\x00',
    });

    expect(output).toContain('shell');
    expect(output).toContain('ok');
    expect(output).not.toContain('bad');
    expect(output).not.toContain('\x00');
  });

  it('strips terminal control and bidi spoofing sequences', () => {
    const output = sanitizeTerminalText(
      '\u202etxt.exe\u001b[31mred\u001bPhidden\u001b\\ok',
    );

    expect(output).toContain('txt.exe');
    expect(output).toContain('red');
    expect(output).toContain('ok');
    expect(output).not.toContain('\u202e');
    expect(output).not.toContain('\u001b[');
    expect(output).not.toContain('hidden');
  });

  it('sanitizes unterminated terminal control sequences without swallowing output', () => {
    const output = sanitizeTerminalText(
      `visible\u001b]${'x'.repeat(1000)}still-visible`,
    );

    expect(output).toContain('visible');
    expect(output).toContain('still-visible');
  });

  it('caps nested tool preview traversal depth', () => {
    let nested: unknown = { command: 'npm test' };
    for (let i = 0; i < 20; i += 1) {
      nested = { rawInput: nested };
    }

    expect(createDaemonToolPreview(nested)).toMatchObject({
      kind: 'generic',
    });
  });
});
