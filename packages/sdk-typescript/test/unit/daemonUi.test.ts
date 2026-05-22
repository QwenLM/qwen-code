/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  appendLocalUserTranscriptMessage,
  createDaemonToolPreview,
  createDaemonTranscriptState,
  createDaemonTranscriptStore,
  daemonUiEventToTerminalText,
  getOutputText,
  isDaemonUiSensitiveKey,
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

  it('surfaces session_closed as a visible terminal status', () => {
    const events = normalizeDaemonEvent({
      id: 23,
      v: 1,
      type: 'session_closed',
      data: { reason: 'idle timeout' },
    });

    expect(events).toMatchObject([
      {
        type: 'status',
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

  it('optionally carries raw daemon events for diagnostics', () => {
    const event = {
      id: 24,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
          rawInput: {
            apiKey: 'raw-event-secret',
          },
        },
      },
    } as const;

    const [withoutRaw] = normalizeDaemonEvent(event);
    expect(withoutRaw).toMatchObject({ type: 'assistant.text.delta' });
    expect(withoutRaw).not.toHaveProperty('rawEvent');
    const [withRaw] = normalizeDaemonEvent(event, { includeRawEvent: true });
    expect(withRaw).toMatchObject({
      type: 'assistant.text.delta',
      rawEvent: {
        ...event,
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
            rawInput: {
              apiKey: '[redacted]',
            },
          },
        },
      },
    });
    expect(JSON.stringify(withRaw)).not.toContain('raw-event-secret');
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

    expect(state.blocks).toMatchObject([
      {
        kind: 'error',
        text: 'Tool tool-1 output trimmed (max blocks reached)',
        eventId: 8,
      },
    ]);
    expect(state.trimmedToolNotificationByCallId['tool-1']).toBe(true);

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 9,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            rawOutput: 'late again',
          },
        },
      }),
      { now: 6 },
    );

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks).toMatchObject([
      {
        kind: 'error',
        text: 'Tool tool-1 output trimmed (max blocks reached)',
        eventId: 8,
      },
    ]);
  });

  it('bounds trimmed tool indexes while keeping recent trimmed diagnostics', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ maxBlocks: 2, now: 1 }),
      Array.from({ length: 8 }, (_, index) => ({
        type: 'tool.update' as const,
        toolCallId: `tool-${index}`,
        title: `Tool ${index}`,
        status: 'running',
      })),
      { now: 2 },
    );

    const trimmedToolCallIds = Object.entries(state.toolBlockByCallId)
      .filter(([, blockId]) => blockId === '__trimmed_tool_block__')
      .map(([toolCallId]) => toolCallId);
    expect(trimmedToolCallIds).toHaveLength(2);
    expect(Object.keys(state.toolBlockByCallId)).toHaveLength(4);
  });

  it('keeps active assistant text open when reporting trimmed tool updates', () => {
    let state = createDaemonTranscriptState({ maxBlocks: 2, now: 1 });

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 10,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-stream',
            title: 'Run command',
            status: 'running',
          },
        },
      }),
      { now: 2 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      [
        { type: 'status', text: 'first trim filler' },
        { type: 'status', text: 'second trim filler' },
      ],
      { now: 3 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'assistant.text.delta', text: 'streaming' }],
      { now: 4 },
    );

    const assistantBlockBeforeLateToolUpdate = state.blocks.find(
      (block) => block.kind === 'assistant',
    );
    expect(assistantBlockBeforeLateToolUpdate).toMatchObject({
      kind: 'assistant',
      streaming: true,
    });
    expect(state.activeAssistantBlockId).toBe(
      assistantBlockBeforeLateToolUpdate?.id,
    );

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 11,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-stream',
            rawOutput: 'late',
          },
        },
      }),
      { now: 5 },
    );

    const assistantBlockAfterLateToolUpdate = state.blocks.find(
      (block) => block.kind === 'assistant',
    );
    expect(assistantBlockAfterLateToolUpdate).toMatchObject({
      kind: 'assistant',
      text: 'streaming',
      streaming: true,
    });
    expect(state.activeAssistantBlockId).toBe(
      assistantBlockAfterLateToolUpdate?.id,
    );
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

  it('preserves daemon tool content and locations for web renderers', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      normalizeDaemonEvent({
        id: 46,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-rich',
            title: 'Read file',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'read ok' },
              },
            ],
            locations: [{ path: 'src/index.ts', line: 3 }],
          },
        },
      }),
      { now: 2 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'tool',
        toolCallId: 'tool-rich',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'read ok' },
          },
        ],
        locations: [{ path: 'src/index.ts', line: 3 }],
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
          rawInput: { text: 'x'.repeat(5000), apiKey: 'input-secret' },
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
          rawOutput: { text: 'y'.repeat(5000), token: 'output-secret' },
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
    expect(
      inputEvent && 'details' in inputEvent ? inputEvent.details : '',
    ).not.toContain('input-secret');
    expect(
      outputEvent && 'details' in outputEvent ? outputEvent.details : '',
    ).not.toContain('output-secret');
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

  it('caps text transcript blocks to prevent unbounded memory growth', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'assistant.text.delta', text: 'x'.repeat(160_000) },
        { type: 'assistant.text.delta', text: 'y'.repeat(80_000) },
      ],
      { now: 2 },
    );
    const [block] = state.blocks;

    expect(block).toMatchObject({ kind: 'assistant' });
    expect(
      block && 'text' in block ? block.text.length : 0,
    ).toBeLessThanOrEqual(100_000);
    expect(block && 'text' in block ? block.text : '').toContain('[truncated]');
  });

  it('caps shell transcript blocks to prevent unbounded output growth', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'shell.output', text: 'x'.repeat(160_000), stream: 'stdout' },
        { type: 'shell.output', text: 'y'.repeat(80_000), stream: 'stdout' },
      ],
      { now: 2 },
    );
    const [block] = state.blocks;

    expect(block).toMatchObject({ kind: 'shell', stream: 'stdout' });
    expect(
      block && 'text' in block ? block.text.length : 0,
    ).toBeLessThanOrEqual(100_000);
    expect(block && 'text' in block ? block.text : '').toContain('[truncated]');
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
      {
        type: 'debug',
        text: expect.not.stringContaining('secret') as string,
      },
    ]);
  });

  it('normalizes plan session updates as visible tool blocks', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      normalizeDaemonEvent({
        id: 60,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: 'Design API', status: 'completed' },
              { content: 'Implement UI', status: 'in_progress' },
              { content: 'Add tests', status: 'pending' },
            ],
          },
        },
      }),
      { now: 2 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'tool',
        toolCallId: 'daemon-plan',
        toolKind: 'updated_plan',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: '- [x] Design API\n- [-] Implement UI\n- [ ] Add tests',
            },
          },
        ],
      },
    ]);
  });

  it('caps normalized plan content before storing it in tool content', () => {
    const longPlan = 'x'.repeat(5_000);
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      normalizeDaemonEvent({
        id: 62,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: longPlan, status: 'in_progress' }],
          },
        },
      }),
      { now: 2 },
    );

    const block = state.blocks[0];
    expect(block).toMatchObject({ kind: 'tool', toolKind: 'updated_plan' });
    if (block?.kind !== 'tool') throw new Error('expected plan tool block');
    const firstContent = block.content?.[0];
    expect(firstContent).toMatchObject({
      content: {
        type: 'text',
        text: expect.stringContaining('[truncated]') as string,
      },
    });
    expect(JSON.stringify(block.content).length).toBeLessThan(4_300);
  });

  it('recreates synthetic plan blocks after transcript trimming', () => {
    let state = createDaemonTranscriptState({ maxBlocks: 1, now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 60,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Design API', status: 'completed' }],
          },
        },
      }),
      { now: 2 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'status', text: 'trim plan block' }],
      { now: 3 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 61,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Implement UI', status: 'in_progress' }],
          },
        },
      }),
      { now: 4 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'tool',
        toolCallId: 'daemon-plan',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: '- [-] Implement UI',
            },
          },
        ],
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

  it('merges consecutive same-stream and streamless shell output blocks only', () => {
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
      { kind: 'shell', text: 'unknown-1unknown-2' },
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

  it('keeps notifying store listeners when one listener throws', async () => {
    const store = createDaemonTranscriptStore();
    const globalWithReportError = globalThis as typeof globalThis & {
      reportError?: (error: unknown) => void;
    };
    const originalReportError = globalWithReportError.reportError;
    const reportError = vi.fn();
    globalWithReportError.reportError = reportError;
    let calls = 0;
    store.subscribe(() => {
      throw new Error('listener failed');
    });
    store.subscribe(() => {
      calls += 1;
    });

    try {
      store.dispatch({ type: 'status', text: 'ready' });
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      if (originalReportError) {
        globalWithReportError.reportError = originalReportError;
      } else {
        delete globalWithReportError.reportError;
      }
    }
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
      '\u202etxt.exe\u001b[31mred\roverwrite\u001bPhidden\u001b\\ok',
    );

    expect(output).toContain('txt.exe');
    expect(output).toContain('red');
    expect(output).toContain('overwrite');
    expect(output).toContain('ok');
    expect(output).not.toContain('\u202e');
    expect(output).not.toContain('\u001b[');
    expect(output).not.toContain('\r');
    expect(output).not.toContain('hidden');
  });

  it('redacts nested sensitive daemon payload fields', () => {
    const events = normalizeDaemonEvent({
      id: 70,
      v: 1,
      type: 'future_event',
      data: {
        headers: {
          Authorization: 'Bearer secret',
          'x-api-key': 'key-secret',
        },
        nested: [{ client_secret: 'client-secret' }],
        credentials: { passphrase: 'pass-secret' },
      },
    });

    expect(events).toMatchObject([
      { type: 'status' },
      {
        type: 'debug',
        text: expect.stringContaining('[redacted]') as string,
      },
    ]);
    const debug = events.find((event) => event.type === 'debug');
    expect(debug?.text).not.toContain('Bearer secret');
    expect(debug?.text).not.toContain('key-secret');
    expect(debug?.text).not.toContain('client-secret');
    expect(debug?.text).not.toContain('pass-secret');
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

  it('redacts sensitive values in generic tool previews', () => {
    expect(
      createDaemonToolPreview({
        apiKey: 'secret-key',
        password: 'secret-password',
        visible: 'ok',
      }),
    ).toMatchObject({
      kind: 'key_value',
      rows: [
        { label: 'apiKey', value: '[redacted]' },
        { label: 'password', value: '[redacted]' },
        { label: 'visible', value: 'ok' },
      ],
    });
  });

  it('recognizes common secret-key aliases before rendering previews', () => {
    expect(
      [
        'secret_key',
        'access_key',
        'DATABASE_PASSWORD',
        'db_password',
        'aws_secret_access_key',
      ].every((key) => isDaemonUiSensitiveKey(key)),
    ).toBe(true);
    expect(
      createDaemonToolPreview({
        secret_key: 'secret-key',
        access_key: 'access-key',
        DATABASE_PASSWORD: 'database-password',
        db_password: 'db-password',
      }),
    ).toMatchObject({
      kind: 'key_value',
      rows: [
        { label: 'secret_key', value: '[redacted]' },
        { label: 'access_key', value: '[redacted]' },
        { label: 'DATABASE_PASSWORD', value: '[redacted]' },
        { label: 'db_password', value: '[redacted]' },
      ],
    });
  });

  it('redacts sensitive fields in tool.update rawInput and rawOutput at normalizer boundary (wenshao CRIT #2)', () => {
    const events = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-secret',
          title: 'Run curl',
          status: 'completed',
          name: 'Bash',
          rawInput: {
            command: 'curl https://api.example.com',
            apiKey: 'sk-prod-do-not-leak',
            headers: { Authorization: 'Bearer secret-do-not-leak' },
          },
          rawOutput: {
            text: 'OK',
            token: 'returned-secret-do-not-leak',
          },
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                apiKey: 'content-secret-do-not-leak',
                text: 'visible content',
              },
            },
          ],
          locations: [
            {
              path: '/tmp/output.txt',
              access_key: 'location-secret-do-not-leak',
            },
          ],
        },
      },
    } as never);
    const event = events[0] as Extract<DaemonUiEvent, { type: 'tool.update' }>;

    expect(event.type).toBe('tool.update');
    expect(event.rawInput).toBeDefined();
    expect(event.rawOutput).toBeDefined();

    // Full-event string scan: no secret value can survive end-to-end.
    // Previously these leaked into `rawInput` / `rawOutput`, exposing them
    // to any UI component that JSON.stringify-ed the event or rendered
    // those fields in a debug panel.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('sk-prod-do-not-leak');
    expect(serialized).not.toContain('Bearer secret-do-not-leak');
    expect(serialized).not.toContain('returned-secret-do-not-leak');

    // Structural keys preserved; only sensitive VALUES are redacted.
    expect((event.rawInput as Record<string, unknown>).apiKey).toBe(
      '[redacted]',
    );
    expect(
      (
        (event.rawInput as Record<string, unknown>).headers as Record<
          string,
          unknown
        >
      ).Authorization,
    ).toBe('[redacted]');
    expect((event.rawOutput as Record<string, unknown>).token).toBe(
      '[redacted]',
    );
    // Non-sensitive fields survive verbatim.
    expect((event.rawInput as Record<string, unknown>).command).toBe(
      'curl https://api.example.com',
    );
    expect((event.rawOutput as Record<string, unknown>).text).toBe('OK');
    expect(event.details).toContain('[redacted]');
    expect(event.details).not.toContain('sk-prod-do-not-leak');
    expect(event.details).not.toContain('Bearer secret-do-not-leak');
    expect(event.details).not.toContain('returned-secret-do-not-leak');
    expect(serialized).not.toContain('content-secret-do-not-leak');
    expect(serialized).not.toContain('location-secret-do-not-leak');
    expect(event.content).toMatchObject([
      {
        content: {
          apiKey: '[redacted]',
          text: 'visible content',
        },
      },
    ]);
    expect(event.locations).toMatchObject([
      {
        path: '/tmp/output.txt',
        access_key: '[redacted]',
      },
    ]);
  });

  it('redacts permission tool calls at the normalizer boundary', () => {
    const [event] = normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'perm-secret',
        toolCall: {
          name: 'Bash',
          rawInput: {
            command: 'curl https://api.example.com',
            Authorization: 'Bearer permission-secret-do-not-leak',
          },
        },
        options: [{ optionId: 'allow', label: 'Allow' }],
      },
    } as never);

    expect(event).toMatchObject({
      type: 'permission.request',
      toolCall: {
        rawInput: {
          command: 'curl https://api.example.com',
          Authorization: '[redacted]',
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain(
      'Bearer permission-secret-do-not-leak',
    );
  });

  it('reports subscriber errors when reportError is unavailable', async () => {
    const previousReportError = (
      globalThis as typeof globalThis & {
        reportError?: (error: unknown) => void;
      }
    ).reportError;
    const consoleError = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => {});
    try {
      (
        globalThis as typeof globalThis & {
          reportError?: (error: unknown) => void;
        }
      ).reportError = undefined;
      const store = createDaemonTranscriptStore();
      const listenerError = new Error('listener failed');
      store.subscribe(() => {
        throw listenerError;
      });

      store.dispatch({ type: 'status', text: 'notify' });
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleError).toHaveBeenCalledWith(listenerError);
    } finally {
      consoleError.mockRestore();
      (
        globalThis as typeof globalThis & {
          reportError?: (error: unknown) => void;
        }
      ).reportError = previousReportError;
    }
  });
});
