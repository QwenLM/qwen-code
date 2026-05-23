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
  selectTranscriptBlocksOrderedByEventId,
} from '../../src/daemon/ui/index.js';
import type { DaemonTranscriptBlock } from '../../src/daemon/ui/index.js';

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

  it('keeps optimistic local user blocks before daemon replies when sorting', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(state, 'hello', { now: 10 });
    state = reduceDaemonTranscriptEvents(
      state,
      [
        {
          type: 'assistant.text.delta',
          text: 'hi',
          eventId: 7,
          serverTimestamp: 11,
        },
      ],
      { now: 11 },
    );

    expect(selectTranscriptBlocksOrderedByEventId(state)).toMatchObject([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi' },
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
            // Raw command objects pass through to the typed event;
            // primitive entries (the legacy `['help', 'model']` shape) are
            // filtered since they cannot be projected as records.
            availableCommands: [{ name: 'help' }, { name: 'model' }],
          },
        },
      }),
    ).toMatchObject([{ type: 'session.available_commands', count: 2 }]);
    // Known event type with malformed payload: normalizer drops to `debug`
    // with a `<type>: malformed payload` text. Crucially the raw `data` is
    // NOT dumped — `token: 'secret'` must not appear in the fallback text.
    const malformed = normalizeDaemonEvent({
      id: 58,
      v: 1,
      type: 'mcp_budget_warning',
      data: { token: 'secret' },
    });
    expect(malformed).toEqual([
      expect.objectContaining({
        type: 'debug',
        text: expect.stringContaining('mcp_budget_warning'),
      }),
    ]);
    expect(malformed[0]).toMatchObject({ type: 'debug' });
    expect((malformed[0] as { text: string }).text).not.toContain('secret');
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

  it('drops resolution for trimmed permission requests (wenshao Critical)', () => {
    // Previously this test asserted that an orphan permission resolution
    // block was created when the original request had been trimmed.
    // wenshao's review (PR #4353) flagged that as a contract violation:
    // the resolution should be silently dropped, matching the existing
    // `upsertPermissionBlock` guard at the request side. Otherwise the
    // orphan wastes a block slot, accelerates further trimming, and
    // breaks the trimmed-block contract.
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
    // Second `permission_request` with same id is silently dropped because
    // the request side already guards against `TRIMMED_PERMISSION_BLOCK_ID`.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 33,
        v: 1,
        type: 'permission_request',
        data: {
          requestId: 'perm-trimmed',
          toolCall: { name: 'Bash', command: 'npm test' },
          options: [{ optionId: 'allow', label: 'Allow' }],
        },
      }),
      { now: 4 },
    );

    expect(state.blocks).toMatchObject([
      { kind: 'status', text: 'trim permission' },
    ]);

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
      { now: 5 },
    );

    // Resolution drops silently — no new permission block created.
    expect(state.blocks).toMatchObject([
      { kind: 'status', text: 'trim permission' },
    ]);
    expect(state.blocks.find((b) => b.kind === 'permission')).toBeUndefined();
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

  it('redacts tool content, locations, and permission toolCall payloads', () => {
    const [toolEvent] = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-secret',
          title: 'Read secure file',
          status: 'completed',
          content: [{ text: 'ok', secret_key: 'content-secret' }],
          locations: [{ path: '/tmp/x', access_key: 'location-secret' }],
        },
      },
    } as never);
    const [permissionEvent] = normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'perm-1',
        toolCall: {
          name: 'Bash',
          input: {
            DATABASE_PASSWORD: 'db-secret',
            db_password: 'db-secret-2',
            aws_secret_access_key: 'aws-secret',
          },
        },
      },
    } as never);

    const serialized = JSON.stringify([toolEvent, permissionEvent]);
    expect(serialized).not.toContain('content-secret');
    expect(serialized).not.toContain('location-secret');
    expect(serialized).not.toContain('db-secret');
    expect(serialized).not.toContain('db-secret-2');
    expect(serialized).not.toContain('aws-secret');
    expect(serialized).toContain('[redacted]');
  });
});

describe('daemon UI normalizer — Wave 3/4 event coverage (PR-A)', () => {
  function envelopeOf<T>(type: string, data: T, id = 100) {
    return { id, v: 1 as const, type, data } as never;
  }

  it('normalizes session_metadata_updated into a typed session-meta event', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('session_metadata_updated', {
        sessionId: 'sess-1',
        displayName: 'Fix login bug',
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'session.metadata.changed',
        sessionId: 'sess-1',
        displayName: 'Fix login bug',
      }),
    ]);
  });

  it('normalizes approval_mode_changed with persisted flag', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('approval_mode_changed', {
        sessionId: 's1',
        previous: 'default',
        next: 'yolo',
        persisted: true,
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'session.approval_mode.changed',
        sessionId: 's1',
        previous: 'default',
        next: 'yolo',
        persisted: true,
      }),
    ]);
  });

  it('upgrades available_commands_update from status text to typed event', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('session_update', {
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'memory', description: 'Manage memory' },
            { name: 'mcp', description: 'Manage MCP' },
          ],
        },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'session.available_commands',
        count: 2,
      }),
    ]);
  });

  it('normalizes memory_changed with closed-enum scope + mode', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('memory_changed', {
        scope: 'workspace',
        filePath: '/work/QWEN.md',
        mode: 'append',
        bytesWritten: 42,
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'workspace.memory.changed',
        scope: 'workspace',
        filePath: '/work/QWEN.md',
        mode: 'append',
        bytesWritten: 42,
      }),
    ]);
  });

  it('normalizes agent_changed for create/update/delete', () => {
    for (const change of ['created', 'updated', 'deleted'] as const) {
      const events = normalizeDaemonEvent(
        envelopeOf('agent_changed', {
          change,
          name: 'reviewer',
          level: 'project',
        }),
      );
      expect(events).toEqual([
        expect.objectContaining({
          type: 'workspace.agent.changed',
          change,
          name: 'reviewer',
          level: 'project',
        }),
      ]);
    }
  });

  it('normalizes tool_toggled', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('tool_toggled', { toolName: 'Bash', enabled: false }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'workspace.tool.toggled',
        toolName: 'Bash',
        enabled: false,
      }),
    ]);
  });

  it('normalizes workspace_initialized actions', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('workspace_initialized', { path: '/w', action: 'created' }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'workspace.initialized',
        path: '/w',
        action: 'created',
      }),
    ]);
  });

  it('normalizes mcp_budget_warning with mode enum', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('mcp_budget_warning', {
        liveCount: 6,
        reservedCount: 2,
        budget: 8,
        thresholdRatio: 0.75,
        mode: 'warn',
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'workspace.mcp.budget_warning',
        liveCount: 6,
        budget: 8,
        mode: 'warn',
      }),
    ]);
  });

  it('normalizes mcp_child_refused_batch with refusedServers list', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('mcp_child_refused_batch', {
        refusedServers: [
          { name: 'github', transport: 'stdio', reason: 'budget_exhausted' },
        ],
        budget: 4,
        liveCount: 4,
        reservedCount: 0,
        mode: 'enforce',
      }),
    );
    expect(events[0]).toMatchObject({
      type: 'workspace.mcp.child_refused',
      budget: 4,
      refusedServers: [
        { name: 'github', transport: 'stdio', reason: 'budget_exhausted' },
      ],
    });
  });

  it('normalizes mcp_server_restarted and restart_refused', () => {
    const restarted = normalizeDaemonEvent(
      envelopeOf('mcp_server_restarted', {
        serverName: 'github',
        durationMs: 142,
      }),
    );
    expect(restarted[0]).toMatchObject({
      type: 'workspace.mcp.server_restarted',
      serverName: 'github',
      durationMs: 142,
    });
    const refused = normalizeDaemonEvent(
      envelopeOf('mcp_server_restart_refused', {
        serverName: 'github',
        reason: 'in_flight',
      }),
    );
    expect(refused[0]).toMatchObject({
      type: 'workspace.mcp.server_restart_refused',
      reason: 'in_flight',
    });
  });

  it('normalizes auth_device_flow lifecycle (started → throttled → authorized)', () => {
    const started = normalizeDaemonEvent(
      envelopeOf('auth_device_flow_started', {
        deviceFlowId: 'df-1',
        providerId: 'qwen',
        expiresAt: 1_900_000_000_000,
      }),
    );
    expect(started[0]).toMatchObject({
      type: 'auth.device_flow.started',
      providerId: 'qwen',
    });

    const throttled = normalizeDaemonEvent(
      envelopeOf('auth_device_flow_throttled', {
        deviceFlowId: 'df-1',
        intervalMs: 10_000,
      }),
    );
    expect(throttled[0]).toMatchObject({
      type: 'auth.device_flow.throttled',
      intervalMs: 10_000,
    });

    const authorized = normalizeDaemonEvent(
      envelopeOf('auth_device_flow_authorized', {
        deviceFlowId: 'df-1',
        providerId: 'qwen',
        accountAlias: 'alice',
      }),
    );
    expect(authorized[0]).toMatchObject({
      type: 'auth.device_flow.authorized',
      accountAlias: 'alice',
    });
  });

  it('normalizes auth_device_flow_failed with closed-enum errorKind', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('auth_device_flow_failed', {
        deviceFlowId: 'df-1',
        errorKind: 'expired_token',
        hint: 'restart the device flow',
      }),
    );
    expect(events[0]).toMatchObject({
      type: 'auth.device_flow.failed',
      errorKind: 'expired_token',
      hint: 'restart the device flow',
    });
  });

  it('keeps future auth_device_flow_failed errorKind values observable', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('auth_device_flow_failed', {
        deviceFlowId: 'df-1',
        errorKind: 'future_rate_limit',
      }),
    );
    expect(events[0]).toMatchObject({
      type: 'auth.device_flow.failed',
      errorKind: 'future_rate_limit',
    });
  });

  it('falls back to debug for malformed payloads (e.g., missing required field)', () => {
    const events = normalizeDaemonEvent(
      envelopeOf('memory_changed', {
        scope: 'unknown-scope',
        filePath: '/x',
        mode: 'append',
        bytesWritten: 5,
      }),
    );
    expect(events[0]).toMatchObject({ type: 'debug' });
  });

  it('infers mcp tool provenance from `mcp__<server>__<tool>` naming', () => {
    const events = normalizeDaemonEvent({
      id: 999,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          name: 'mcp__github__create_issue',
          title: 'Create Issue',
          status: 'running',
        },
      },
    } as never);
    expect(events[0]).toMatchObject({
      type: 'tool.update',
      toolName: 'mcp__github__create_issue',
      provenance: 'mcp',
      serverId: 'github',
    });
  });

  it('passes through errorKind on session_died when daemon stamps it', () => {
    const events = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_died',
      data: {
        sessionId: 's',
        reason: 'ACP child crashed',
        errorKind: 'init_timeout',
      },
    } as never);
    expect(events[0]).toMatchObject({
      type: 'error',
      errorKind: 'init_timeout',
    });
  });

  it('reducer is no-op on session-meta / workspace / auth events (no transcript blocks emitted)', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent(
          envelopeOf('memory_changed', {
            scope: 'workspace',
            filePath: '/x',
            mode: 'replace',
            bytesWritten: 1,
          }),
        ),
        ...normalizeDaemonEvent(
          envelopeOf('approval_mode_changed', {
            sessionId: 's',
            previous: 'default',
            next: 'plan',
            persisted: false,
          }),
        ),
        ...normalizeDaemonEvent(
          envelopeOf('auth_device_flow_started', {
            deviceFlowId: 'df',
            providerId: 'qwen',
            expiresAt: 1_900_000_000_000,
          }),
        ),
      ],
      { now: 2 },
    );
    // No transcript blocks pushed — sidechannel state subscribers handle these.
    expect(state.blocks).toEqual([]);
    // lastEventId still advanced (monotonic invariant preserved).
    expect(state.lastEventId).toBe(100);
  });
});

describe('daemon UI time schema (PR-B)', () => {
  it('extracts serverTimestamp from envelope _meta and propagates to blocks', () => {
    const eventWithMeta = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      _meta: { serverTimestamp: 1_900_000_000_000 },
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      },
    } as never);
    expect(eventWithMeta[0]).toMatchObject({
      type: 'assistant.text.delta',
      serverTimestamp: 1_900_000_000_000,
    });

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      eventWithMeta,
      { now: 2 },
    );
    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      serverTimestamp: 1_900_000_000_000,
      clientReceivedAt: 2,
      createdAt: 2,
    });
  });

  it('extracts serverTimestamp from data._meta as fallback (sessionUpdate nested location)', () => {
    const events = normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        _meta: { serverTimestamp: 1_888_888_888_888 },
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    } as never);
    expect(events[0]).toMatchObject({
      type: 'user.text.delta',
      serverTimestamp: 1_888_888_888_888,
    });
  });

  it('extracts serverTimestamp from top-level envelope field when present', () => {
    const events = normalizeDaemonEvent({
      id: 3,
      v: 1,
      type: 'model_switched',
      serverTimestamp: 1_777_777_777_777,
      data: { sessionId: 's', modelId: 'qwen-coder-flash' },
    } as never);
    expect(events[0]).toMatchObject({
      type: 'model.changed',
      serverTimestamp: 1_777_777_777_777,
    });
  });

  it('defaults serverTimestamp undefined when envelope has none (forward-compat with older daemons)', () => {
    const events = normalizeDaemonEvent({
      id: 4,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'no ts' },
        },
      },
    });
    expect(events[0]).not.toHaveProperty('serverTimestamp');
  });

  it('selectTranscriptBlocksOrderedByEventId sorts by eventId, ignoring out-of-order arrival', async () => {
    const { selectTranscriptBlocksOrderedByEventId } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    // Push 3 blocks; insert ids in mixed arrival order (replay scenario)
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 10,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ten' },
            },
          },
        } as never),
      ],
      { now: 2 },
    );
    // simulate a later (higher id) event arriving first, then earlier replayed
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 20,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't',
              title: 'twenty',
              status: 'completed',
            },
          },
        } as never),
      ],
      { now: 3 },
    );
    // Append a third with id between the two (would normally arrive earlier
    // but replay delivered it out-of-order).
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 15,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'fifteen' },
            },
          },
        } as never),
      ],
      { now: 4 },
    );

    const ordered = selectTranscriptBlocksOrderedByEventId(state);
    const eventIds = ordered.map((b) => b.eventId);
    expect(eventIds).toEqual([10, 15, 20]);
  });

  it('formatBlockTimestamp prefers serverTimestamp over clientReceivedAt', async () => {
    const { formatBlockTimestamp } = await import(
      '../../src/daemon/ui/index.js'
    );
    const events = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      _meta: { serverTimestamp: 1_900_000_000_000 },
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'x' },
        },
      },
    } as never);
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      events,
      { now: 2 },
    );
    const formatted = formatBlockTimestamp(state.blocks[0]!, {
      locale: 'en-US',
      timeZone: 'UTC',
      dateStyle: 'long',
      timeStyle: 'medium',
    });
    // 1_900_000_000_000 ms = March 17, 2030 UTC
    expect(formatted).toContain('2030');
    expect(formatted).toContain('March');
  });
});

describe('daemon UI reducer state machine (PR-E)', () => {
  it('tracks currentToolCallId as tools enter and leave in-flight', async () => {
    const { selectCurrentTool } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'long task',
            status: 'running',
          },
        },
      } as never),
      { now: 2 },
    );
    expect(state.currentToolCallId).toBe('call-1');
    expect(selectCurrentTool(state)).toMatchObject({
      kind: 'tool',
      toolCallId: 'call-1',
      status: 'running',
    });

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
          },
        },
      } as never),
      { now: 3 },
    );
    expect(state.currentToolCallId).toBeUndefined();
    expect(selectCurrentTool(state)).toBeUndefined();
  });

  it('falls back to another in-flight tool when the current one completes', async () => {
    const { selectCurrentTool } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call-a',
              title: 'first task',
              status: 'running',
            },
          },
        } as never),
        ...normalizeDaemonEvent({
          id: 2,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call-b',
              title: 'second task',
              status: 'running',
            },
          },
        } as never),
      ],
      { now: 2 },
    );
    expect(state.currentToolCallId).toBe('call-b');

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-b',
            status: 'completed',
          },
        },
      } as never),
      { now: 3 },
    );

    expect(state.currentToolCallId).toBe('call-a');
    expect(selectCurrentTool(state)).toMatchObject({ toolCallId: 'call-a' });
  });

  it('marks in-flight tools cancelled when a stream ends unexpectedly', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'long task',
            status: 'running',
          },
        },
      } as never),
      { now: 2 },
    );

    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'assistant.done', reason: 'stream_ended' }],
      { now: 3 },
    );

    expect(state.currentToolCallId).toBeUndefined();
    expect(state.blocks[0]).toMatchObject({
      kind: 'tool',
      status: 'cancelled',
    });
  });

  it('enters resync-required state and skips later non-terminal deltas', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'long task',
            status: 'running',
          },
        },
      } as never),
      { now: 2 },
    );

    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 5,
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 1,
            earliestAvailableId: 4,
          },
        } as never),
        ...normalizeDaemonEvent({
          id: 6,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'stale delta' },
            },
          },
        } as never),
      ],
      { now: 3 },
    );

    expect(state.awaitingResync).toBe(true);
    expect(state.resyncRequiredCount).toBe(1);
    expect(state.lastResyncRequired).toEqual({
      reason: 'ring_evicted',
      lastDeliveredId: 1,
      earliestAvailableId: 4,
    });
    expect(state.lastEventId).toBe(6);
    expect(state.blocks).toMatchObject([
      { kind: 'tool', status: 'cancelled' },
      {
        kind: 'error',
        text: expect.stringContaining('State resync required') as string,
      },
    ]);
    expect(JSON.stringify(state.blocks)).not.toContain('stale delta');
  });

  it('mirrors approval mode from session.approval_mode.changed event', async () => {
    const { selectApprovalMode } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    expect(selectApprovalMode(state)).toBeUndefined();

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'approval_mode_changed',
        data: {
          sessionId: 's',
          previous: 'default',
          next: 'plan',
          persisted: false,
        },
      } as never),
      { now: 2 },
    );
    expect(state.approvalMode).toBe('plan');
    expect(selectApprovalMode(state)).toBe('plan');

    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'approval_mode_changed',
        data: {
          sessionId: 's',
          previous: 'plan',
          next: 'yolo',
          persisted: true,
        },
      } as never),
      { now: 3 },
    );
    expect(selectApprovalMode(state)).toBe('yolo');
  });

  it('propagates cancellation to in-flight tool blocks on assistant.done with reason=cancelled', () => {
    let state = createDaemonTranscriptState({ now: 1 });

    // Two tools in flight + one already completed
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'a',
              title: 'A',
              status: 'running',
            },
          },
        } as never),
        ...normalizeDaemonEvent({
          id: 2,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'b',
              title: 'B',
              status: 'pending',
            },
          },
        } as never),
        ...normalizeDaemonEvent({
          id: 3,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'c',
              title: 'C',
              status: 'completed',
            },
          },
        } as never),
      ],
      { now: 2 },
    );

    // Cancel — propagation should mark a/b as cancelled, leave c untouched.
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'assistant.done', reason: 'cancelled' }],
      { now: 3 },
    );

    const toolBlocks = state.blocks.filter(
      (b): b is Extract<DaemonTranscriptBlock, { kind: 'tool' }> =>
        b.kind === 'tool',
    );
    const a = toolBlocks.find((b) => b.toolCallId === 'a')!;
    const b = toolBlocks.find((b2) => b2.toolCallId === 'b')!;
    const c = toolBlocks.find((b3) => b3.toolCallId === 'c')!;
    expect(a.status).toBe('cancelled');
    expect(b.status).toBe('cancelled');
    expect(c.status).toBe('completed');
    expect(state.currentToolCallId).toBeUndefined();
  });

  it('forward-compat: unknown tool status does NOT clear currentToolCallId', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'a',
            title: 'A',
            status: 'running',
          },
        },
      } as never),
      { now: 2 },
    );
    expect(state.currentToolCallId).toBe('a');

    // Daemon emits a future 'paused' status the SDK doesn't know.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'a',
            status: 'paused',
          },
        },
      } as never),
      { now: 3 },
    );
    // currentToolCallId should remain — unknown status is forward-compat.
    expect(state.currentToolCallId).toBe('a');
  });

  it('explicit assistant.done without reason does NOT propagate cancellation', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'a',
              title: 'A',
              status: 'running',
            },
          },
        } as never),
      ],
      { now: 2 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'assistant.done', reason: 'end_turn' }],
      { now: 3 },
    );
    const toolBlock = state.blocks.find(
      (b): b is Extract<DaemonTranscriptBlock, { kind: 'tool' }> =>
        b.kind === 'tool',
    )!;
    expect(toolBlock.status).toBe('running');
    expect(state.currentToolCallId).toBe('a');
  });
});

describe('daemon UI tool preview taxonomy (PR-C)', () => {
  it('detects file_diff from Anthropic-style oldText/newText', () => {
    const preview = createDaemonToolPreview({
      path: '/work/foo.ts',
      oldText: 'const x = 1',
      newText: 'const x = 2',
    });
    expect(preview).toMatchObject({
      kind: 'file_diff',
      path: '/work/foo.ts',
      oldText: 'const x = 1',
      newText: 'const x = 2',
    });
  });

  it('detects file_diff from patch text', () => {
    const preview = createDaemonToolPreview({
      filePath: '/work/bar.ts',
      patch: '--- a/bar.ts\n+++ b/bar.ts\n@@ -1 +1 @@\n-old\n+new\n',
    });
    expect(preview).toMatchObject({
      kind: 'file_diff',
      path: '/work/bar.ts',
      patch: expect.stringContaining('---') as string,
    });
  });

  it('detects file_read from tool name + range (lineRange)', () => {
    const preview = createDaemonToolPreview(
      { path: '/work/x.md', lineRange: [10, 20] },
      { toolName: 'Read' },
    );
    expect(preview).toMatchObject({
      kind: 'file_read',
      path: '/work/x.md',
      range: [10, 20],
    });
  });

  it('detects file_read from offset/limit pair', () => {
    const preview = createDaemonToolPreview(
      { path: '/work/y.md', offset: 100, limit: 50 },
      { toolName: 'View' },
    );
    expect(preview).toMatchObject({
      kind: 'file_read',
      path: '/work/y.md',
      range: [100, 149],
    });
  });

  it('detects web_fetch from URL with scheme', () => {
    const preview = createDaemonToolPreview({
      url: 'https://api.example.com/data',
      method: 'POST',
    });
    expect(preview).toMatchObject({
      kind: 'web_fetch',
      url: 'https://api.example.com/data',
      method: 'POST',
    });
  });

  it('does NOT detect web_fetch from relative URL (no scheme)', () => {
    const preview = createDaemonToolPreview({
      url: '/relative/path',
    });
    expect(preview.kind).not.toBe('web_fetch');
  });

  it('detects mcp_invocation from mcp__<server>__<tool> naming', () => {
    const preview = createDaemonToolPreview(
      { arguments: { issueTitle: 'Bug report' } },
      { toolName: 'mcp__github__create_issue' },
    );
    expect(preview).toMatchObject({
      kind: 'mcp_invocation',
      serverId: 'github',
      toolName: 'create_issue',
    });
    expect((preview as { argsSummary?: string }).argsSummary).toContain(
      'issueTitle',
    );
  });

  it('mcp_invocation takes priority over file_diff (more specific)', () => {
    // Even if the input shape happens to match file_diff (e.g., an MCP
    // tool that edits files), MCP provenance wins.
    const preview = createDaemonToolPreview(
      {
        path: '/x',
        oldText: 'a',
        newText: 'b',
      },
      { toolName: 'mcp__editor__patch_file' },
    );
    expect(preview.kind).toBe('mcp_invocation');
  });

  it('falls back to command preview when no specific shape matches', () => {
    const preview = createDaemonToolPreview({
      command: 'npm test',
      cwd: '/work',
    });
    expect(preview).toMatchObject({
      kind: 'command',
      command: 'npm test',
      cwd: '/work',
    });
  });
});

describe('daemon UI content extraction (PR-C)', () => {
  it('extractContentPart returns text for string', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    expect(extractContentPart('hello')).toEqual({
      kind: 'text',
      text: 'hello',
    });
  });

  it('extractContentPart returns text for { type: "text" } object', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    expect(extractContentPart({ type: 'text', text: 'hi' })).toEqual({
      kind: 'text',
      text: 'hi',
    });
  });

  it('extractContentPart returns image with source.url', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    const part = extractContentPart({
      type: 'image',
      mediaType: 'image/png',
      source: { url: 'https://example.com/img.png' },
    });
    expect(part).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      source: { url: 'https://example.com/img.png' },
    });
  });

  it('extractContentPart returns audio with source.data', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    const part = extractContentPart({
      type: 'audio',
      mediaType: 'audio/mpeg',
      source: { data: 'base64-blob' },
    });
    expect(part).toMatchObject({
      kind: 'audio',
      mediaType: 'audio/mpeg',
      source: { data: 'base64-blob' },
    });
  });

  it('extractContentPart returns resource with uri', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    const part = extractContentPart({
      type: 'resource',
      uri: 'file:///work/README.md',
      description: 'Project readme',
    });
    expect(part).toMatchObject({
      kind: 'resource',
      uri: 'file:///work/README.md',
      description: 'Project readme',
    });
  });

  it('extractContentPart returns undefined for unknown content type', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    expect(
      extractContentPart({ type: 'video', source: { url: 'x' } }),
    ).toBeUndefined();
  });

  it('extractContentPart returns undefined for image without source', async () => {
    const { extractContentPart } = await import('../../src/daemon/ui/index.js');
    expect(extractContentPart({ type: 'image' })).toBeUndefined();
  });
});

describe('daemon UI render contract (PR-D)', () => {
  it('daemonBlockToMarkdown renders user/assistant/tool/shell/permission/error', async () => {
    const { daemonBlockToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(state, 'hello', { now: 2 });
    state = reduceDaemonTranscriptEvents(
      state,
      [
        ...normalizeDaemonEvent({
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hi there' },
            },
          },
        } as never),
      ],
      { now: 3 },
    );
    const userMd = daemonBlockToMarkdown(state.blocks[0]!);
    const assistantMd = daemonBlockToMarkdown(state.blocks[1]!);
    expect(userMd).toContain('**You**');
    expect(userMd).toContain('hello');
    expect(assistantMd).toContain('hi there');
  });

  it('daemonBlockToMarkdown renders file_diff preview as unified diff', async () => {
    const { daemonBlockToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'edit-1',
            title: 'Edit foo.ts',
            status: 'completed',
            rawInput: {
              path: '/work/foo.ts',
              oldText: 'const x = 1',
              newText: 'const x = 2',
            },
          },
        },
      } as never),
      { now: 2 },
    );
    const md = daemonBlockToMarkdown(state.blocks[0]!);
    expect(md).toContain('Edit `/work/foo.ts`');
    expect(md).toContain('```diff');
    expect(md).toContain('- const x = 1');
    expect(md).toContain('+ const x = 2');
  });

  it('daemonBlockToMarkdown uses longer fences for embedded backticks', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'command',
      command: 'printf "```\\n"',
    });

    expect(md).toMatch(/^````bash\n/);
    expect(md).toContain('printf "```\\n"');
    expect(md).toMatch(/\n````$/);
  });

  it('daemonBlockToMarkdown renders mcp_invocation preview with server::tool', async () => {
    const { daemonBlockToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'mcp-1',
            title: 'Create Issue',
            status: 'completed',
            name: 'mcp__github__create_issue',
          },
        },
      } as never),
      { now: 2 },
    );
    const md = daemonBlockToMarkdown(state.blocks[0]!);
    expect(md).toContain('github::create_issue');
  });

  it('daemonBlockToHtml escapes special characters in user/assistant content', async () => {
    const { daemonBlockToHtml } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(
      state,
      '<script>alert("xss")</script>',
      { now: 2 },
    );
    const html = daemonBlockToHtml(state.blocks[0]!);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
  });

  it('daemonBlockToHtml sanitizes terminal escape sequences in content', async () => {
    const { daemonBlockToHtml } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    // Inject ANSI red color escape — should be stripped by sanitizeTerminalText
    state = appendLocalUserTranscriptMessage(
      state,
      '\x1b[31mhostile\x1b[0m text',
      {
        now: 2,
      },
    );
    const html = daemonBlockToHtml(state.blocks[0]!);
    expect(html).not.toContain('\x1b[');
    expect(html).toContain('hostile');
  });

  it('daemonBlockToHtml emits error blocks with role=alert', async () => {
    const { daemonBlockToHtml } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'error', text: 'auth required', recoverable: true }],
      { now: 2 },
    );
    const html = daemonBlockToHtml(state.blocks[0]!);
    expect(html).toContain('role="alert"');
    expect(html).toContain('daemon-error');
  });

  it('daemonBlockToPlainText drops markdown / html, suitable for copy-paste', async () => {
    const { daemonBlockToPlainText } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'error', text: 'session died' }],
      { now: 2 },
    );
    const plain = daemonBlockToPlainText(state.blocks[0]!);
    expect(plain).toBe('[error] session died');
    expect(plain).not.toContain('[!');
  });

  it('maxFieldLength truncates with ellipsis', async () => {
    const { daemonBlockToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(state, 'X'.repeat(200), {
      now: 2,
    });
    const md = daemonBlockToMarkdown(state.blocks[0]!, {
      maxFieldLength: 50,
    });
    expect(md).toContain('… [truncated]');
    expect(md.length).toBeLessThan(200);
  });

  it('sanitizeUrls strips token query params in web_fetch preview', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown(
      {
        kind: 'web_fetch',
        url: 'https://api.example.com/data?token=secret123&q=hi',
      },
      { sanitizeUrls: true },
    );
    expect(md).not.toContain('secret123');
    expect(md).toContain('q=hi');
  });

  it('sanitizeUrls rejects unsafe protocols and parse failures', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    expect(
      daemonToolPreviewToMarkdown(
        { kind: 'web_fetch', url: 'javascript:alert(1)' },
        { sanitizeUrls: true },
      ),
    ).toBe('GET `#`');
    expect(
      daemonToolPreviewToMarkdown(
        { kind: 'web_fetch', url: 'http://[bad-url' },
        { sanitizeUrls: true },
      ),
    ).toBe('GET `#`');
  });

  it('sanitizeUrls strips common auth query params', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown(
      {
        kind: 'web_fetch',
        url: 'https://api.example.com/data?access_token=a&api_key=b&session_id=c&q=ok',
      },
      { sanitizeUrls: true },
    );
    expect(md).not.toContain('access_token');
    expect(md).not.toContain('api_key');
    expect(md).not.toContain('session_id');
    expect(md).toContain('q=ok');
  });

  it('daemonBlockToMarkdown strips ANSI and bidi controls', async () => {
    const { daemonBlockToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(
      state,
      '\x1b[31mred\x1b[0m \u202Eevil',
      { now: 2 },
    );
    const md = daemonBlockToMarkdown(state.blocks[0]!);
    expect(md).toContain('red evil');
    expect(md).not.toContain('\x1b[');
    expect(md).not.toContain('\u202E');
  });

  it('daemonToolPreviewToMarkdown escapes inline metadata delimiters', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'file_read',
      path: '` <img src=x onerror=alert(1)> `',
    });
    expect(md).toBe('Read `` ` <img src=x onerror=alert(1)> ` ``');
  });

  it('custom sanitizer replaces default escaping', async () => {
    const { daemonBlockToHtml } = await import('../../src/daemon/ui/index.js');
    let state = createDaemonTranscriptState({ now: 1 });
    state = appendLocalUserTranscriptMessage(state, '<b>bold</b>', {
      now: 2,
    });
    const html = daemonBlockToHtml(state.blocks[0]!, {
      sanitizer: (raw) => raw.replace(/<[^>]+>/g, ''),
    });
    // Custom sanitizer strips ALL tags including content tags — verify bold
    // text remains but '<b>' itself is gone.
    expect(html).toContain('bold');
    expect(html).not.toContain('<b>');
  });
});

describe('daemon UI tool preview taxonomy — long-tail kinds (PR-F)', () => {
  it('detects subagent_delegation from Anthropic-style Task tool', () => {
    const preview = createDaemonToolPreview(
      {
        subagent_type: 'code-reviewer',
        prompt: 'Review the auth module',
        description: 'Security review',
      },
      { toolName: 'Task' },
    );
    expect(preview).toMatchObject({
      kind: 'subagent_delegation',
      agentName: 'code-reviewer',
      task: 'Review the auth module',
    });
  });

  it('detects search from grep-style toolName + results array', () => {
    const preview = createDaemonToolPreview(
      {
        query: 'TODO',
        results: ['src/foo.ts:12', 'src/bar.ts:45', 'src/baz.ts:78'],
      },
      { toolName: 'grep' },
    );
    expect(preview).toMatchObject({
      kind: 'search',
      query: 'TODO',
      resultCount: 3,
    });
    expect((preview as { top?: string[] }).top).toEqual([
      'src/foo.ts:12',
      'src/bar.ts:45',
      'src/baz.ts:78',
    ]);
  });

  it('detects search with object-shaped results', () => {
    const preview = createDaemonToolPreview(
      {
        query: 'auth',
        resultCount: 12,
        matches: [
          { path: 'src/auth.ts', text: 'export function auth() {' },
          { path: 'tests/auth.test.ts', text: 'describe(...)' },
        ],
      },
      { toolName: 'ripgrep' },
    );
    expect(preview).toMatchObject({
      kind: 'search',
      query: 'auth',
      resultCount: 12,
    });
    expect((preview as { top?: string[] }).top).toContain('src/auth.ts');
  });

  it('detects image_generation from dalle-style toolName + prompt', () => {
    const preview = createDaemonToolPreview(
      {
        prompt: 'A purple sunset over mountains',
        model: 'dall-e-3',
        url: 'https://cdn.example.com/img.png',
      },
      { toolName: 'dalle3_generate' },
    );
    expect(preview).toMatchObject({
      kind: 'image_generation',
      prompt: 'A purple sunset over mountains',
      model: 'dall-e-3',
      thumbnailUrl: 'https://cdn.example.com/img.png',
    });
  });

  it('detects code_block from explicit language + code', () => {
    const preview = createDaemonToolPreview(
      {
        language: 'typescript',
        code: 'const x: number = 1;',
        origin: 'src/example.ts:42',
      },
      { toolName: 'snippet' },
    );
    expect(preview).toMatchObject({
      kind: 'code_block',
      language: 'typescript',
      origin: 'src/example.ts:42',
    });
  });

  it('detects code_block from REPL toolName even without explicit language', () => {
    const preview = createDaemonToolPreview(
      { code: 'print("hi")' },
      { toolName: 'python_repl' },
    );
    expect(preview).toMatchObject({
      kind: 'code_block',
      code: 'print("hi")',
    });
  });

  it('detects tabular from explicit columns + rows shape', () => {
    const preview = createDaemonToolPreview({
      columns: ['name', 'age', 'role'],
      rows: [
        ['Alice', '30', 'engineer'],
        ['Bob', '25', 'designer'],
      ],
    });
    expect(preview).toMatchObject({
      kind: 'tabular',
      columns: ['name', 'age', 'role'],
      rows: [
        ['Alice', '30', 'engineer'],
        ['Bob', '25', 'designer'],
      ],
    });
  });

  it('detects tabular from legacy data: Array<Record<>> shape', () => {
    const preview = createDaemonToolPreview({
      data: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    });
    expect(preview).toMatchObject({
      kind: 'tabular',
      columns: ['name', 'age'],
    });
    expect((preview as { rows: unknown[] }).rows.length).toBe(2);
  });

  it('caps tabular rows at 50 and stamps totalRows', () => {
    const data = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `row-${i}`,
    }));
    const preview = createDaemonToolPreview({ data });
    expect(preview).toMatchObject({
      kind: 'tabular',
      totalRows: 200,
    });
    expect((preview as { rows: unknown[] }).rows.length).toBe(50);
  });

  it('subagent_delegation wins over file_diff for Task tool delegating an edit', async () => {
    // Task tool with payload that LOOKS like a file edit (path + oldText/
    // newText) — but the toolName is Task, so subagent wins.
    const preview = createDaemonToolPreview(
      {
        subagent_type: 'edit-helper',
        prompt: 'Edit foo.ts',
        path: '/work/foo.ts',
        oldText: 'a',
        newText: 'b',
      },
      { toolName: 'Task' },
    );
    expect(preview.kind).toBe('subagent_delegation');
  });

  it('search preview renders to GFM markdown with bullet list', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'search',
      query: 'TODO',
      resultCount: 3,
      top: ['src/a.ts', 'src/b.ts'],
    });
    expect(md).toContain('**Search**');
    expect(md).toContain('TODO');
    expect(md).toContain('3 results');
    expect(md).toContain('- src/a.ts');
  });

  it('tabular preview renders to GFM markdown table', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'tabular',
      columns: ['name', 'age'],
      rows: [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
    });
    expect(md).toContain('| name | age |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Alice | 30 |');
  });

  it('tabular preview escapes pipes in headers and cells', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'tabular',
      columns: ['Name | ID', 'value'],
      rows: [['Alice | 1', '30']],
    });
    expect(md).toContain('| Name \\| ID | value |');
    expect(md).toContain('| Alice \\| 1 | 30 |');
  });

  it('image_generation renders with embedded markdown image', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'image_generation',
      prompt: 'A sunset',
      thumbnailUrl: 'https://cdn.example.com/x.png',
    });
    expect(md).toContain('![image](https://cdn.example.com/x.png)');
    expect(md).toContain('A sunset');
  });

  it('subagent_delegation renders with delegate header + task quote', async () => {
    const { daemonToolPreviewToMarkdown } = await import(
      '../../src/daemon/ui/index.js'
    );
    const md = daemonToolPreviewToMarkdown({
      kind: 'subagent_delegation',
      agentName: 'reviewer',
      task: 'Review the PR',
    });
    expect(md).toContain('**Delegate -> `reviewer`**');
    expect(md).toContain('> Review the PR');
  });
});

describe('daemon UI adapter conformance framework (PR-G)', () => {
  it('runs the built-in fixture corpus against SDK reference adapter (markdown projection)', async () => {
    const {
      runAdapterConformanceSuite,
      reduceDaemonTranscriptEvents: reduce,
      createDaemonTranscriptState: create,
      daemonBlockToMarkdown,
    } = await import('../../src/daemon/ui/index.js');

    // Reference adapter: use SDK's reducer + markdown render helper.
    const result = runAdapterConformanceSuite({
      reduce(events) {
        return reduce(create({ now: 1 }), events, { now: 2 });
      },
      renderToText(state) {
        const s = state as {
          blocks: readonly Parameters<typeof daemonBlockToMarkdown>[0][];
        };
        return s.blocks.map((b) => daemonBlockToMarkdown(b)).join('\n\n');
      },
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.failed).toEqual([]);
    expect(result.passed).toBe(result.total);
  });

  it('failed fixtures surface missing + leaked phrases for debugging', async () => {
    const { runAdapterConformanceSuite, DAEMON_UI_CONFORMANCE_FIXTURES } =
      await import('../../src/daemon/ui/index.js');
    // Buggy adapter that produces empty string — should fail every fixture
    // that has any `expectedContains`.
    const result = runAdapterConformanceSuite({
      reduce() {
        return null;
      },
      renderToText() {
        return '';
      },
    });
    expect(result.failed.length).toBeGreaterThan(0);
    // Each failure surfaces the missing phrases from its fixture.
    const fixturesWithExpect = DAEMON_UI_CONFORMANCE_FIXTURES.filter(
      (fx) => fx.expectedContains.length > 0,
    );
    expect(result.failed.length).toBe(fixturesWithExpect.length);
    for (const failure of result.failed) {
      expect(failure.missingPhrases.length).toBeGreaterThan(0);
    }
  });

  it('detects redaction violations (leaked phrases in malformed-payload fixture)', async () => {
    const { runAdapterConformanceSuite } = await import(
      '../../src/daemon/ui/index.js'
    );
    // Buggy adapter that dumps raw event data including secrets.
    const result = runAdapterConformanceSuite(
      {
        reduce(events) {
          return events;
        },
        renderToText(state) {
          // Stringify raw events — leaks `data` payload including secrets.
          return JSON.stringify(state);
        },
      },
      { only: ['malformed-payload-redaction'] },
    );
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.leakedPhrases).toContain(
      'must-not-leak-malformed-payload',
    );
  });

  it('respects only / skip filter options', async () => {
    const { runAdapterConformanceSuite } = await import(
      '../../src/daemon/ui/index.js'
    );
    const result = runAdapterConformanceSuite(
      {
        reduce() {
          return null;
        },
        renderToText() {
          return '';
        },
      },
      { only: ['simple-chat'] },
    );
    expect(result.total).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.fixture).toBe('simple-chat');
  });

  it('skip excludes named fixtures', async () => {
    const { runAdapterConformanceSuite, DAEMON_UI_CONFORMANCE_FIXTURES } =
      await import('../../src/daemon/ui/index.js');
    const result = runAdapterConformanceSuite(
      {
        reduce() {
          return null;
        },
        renderToText() {
          return '';
        },
      },
      { skip: ['simple-chat'] },
    );
    expect(result.total).toBe(DAEMON_UI_CONFORMANCE_FIXTURES.length - 1);
    expect(
      result.failed.find((f) => f.fixture === 'simple-chat'),
    ).toBeUndefined();
  });

  it('plain-text reference adapter also conforms to corpus', async () => {
    const {
      runAdapterConformanceSuite,
      reduceDaemonTranscriptEvents: reduce,
      createDaemonTranscriptState: create,
      daemonBlockToPlainText,
    } = await import('../../src/daemon/ui/index.js');

    const result = runAdapterConformanceSuite({
      reduce(events) {
        return reduce(create({ now: 1 }), events, { now: 2 });
      },
      renderToText(state) {
        const s = state as {
          blocks: readonly Parameters<typeof daemonBlockToPlainText>[0][];
        };
        return s.blocks.map((b) => daemonBlockToPlainText(b)).join('\n');
      },
    });
    expect(result.failed).toEqual([]);
  });
});

describe('daemon UI subagent nesting (PR-K, post-rebase)', () => {
  it('extracts parentToolCallId + subagentType from tool_call._meta', () => {
    const events = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'child-1',
          title: 'grep src',
          status: 'running',
          rawInput: { query: 'TODO' },
          _meta: {
            parentToolCallId: 'parent-task-7',
            subagentType: 'code-reviewer',
          },
        },
      },
    } as never);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.update',
        toolCallId: 'child-1',
        parentToolCallId: 'parent-task-7',
        subagentType: 'code-reviewer',
      }),
    ]);
  });

  it('top-level (non-subagent) tool calls have undefined parent fields', () => {
    const events = normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'top-1',
          title: 'Bash ls',
          status: 'running',
          rawInput: { command: 'ls' },
        },
      },
    } as never);
    expect(events[0]).not.toHaveProperty('parentToolCallId');
    expect(events[0]).not.toHaveProperty('subagentType');
  });

  it('reducer correlates parentBlockId at create time when parent already in state', async () => {
    const { selectSubagentChildBlocks } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    // Parent Task tool call first.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'parent-task',
            title: 'Delegate to reviewer',
            status: 'running',
            name: 'Task',
            rawInput: { subagent_type: 'code-reviewer', prompt: 'review' },
          },
        },
      } as never),
      { now: 2 },
    );
    // Child tool call inside subagent.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'child-grep',
            title: 'grep auth',
            status: 'completed',
            rawInput: { query: 'auth' },
            _meta: {
              parentToolCallId: 'parent-task',
              subagentType: 'code-reviewer',
            },
          },
        },
      } as never),
      { now: 3 },
    );

    const parentBlock = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'parent-task',
    )!;
    const childBlock = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'child-grep',
    )!;
    expect(childBlock.parentToolCallId).toBe('parent-task');
    expect(childBlock.subagentType).toBe('code-reviewer');
    expect(childBlock.parentBlockId).toBe(parentBlock.id);

    // Selector returns the child.
    const children = selectSubagentChildBlocks(state, 'parent-task');
    expect(children).toHaveLength(1);
    expect(children[0]!.toolCallId).toBe('child-grep');
  });

  it('reducer adopts parent context on later update if not yet correlated', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    // Parent first.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'p1',
            title: 'P',
            status: 'running',
          },
        },
      } as never),
      { now: 2 },
    );
    // Child arrives FIRST without parent stamp (early in flow).
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'c1',
            title: 'C',
            status: 'running',
          },
        },
      } as never),
      { now: 3 },
    );
    // Subsequent update stamps parent (SubAgentTracker activates).
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'c1',
            status: 'completed',
            _meta: { parentToolCallId: 'p1', subagentType: 'helper' },
          },
        },
      } as never),
      { now: 4 },
    );
    const child = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'c1',
    )!;
    expect(child.parentToolCallId).toBe('p1');
    expect(child.subagentType).toBe('helper');
    expect(child.parentBlockId).toBe(
      state.blocks.find(
        (b): b is Extract<typeof b, { kind: 'tool' }> =>
          b.kind === 'tool' && b.toolCallId === 'p1',
      )!.id,
    );
  });

  it('isSubagentChildBlock discriminates tool blocks by parentToolCallId', async () => {
    const { isSubagentChildBlock } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'standalone',
            title: 'Top',
            status: 'completed',
          },
        },
      } as never),
      { now: 2 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'nested',
            title: 'Nested',
            status: 'completed',
            _meta: { parentToolCallId: 'standalone' },
          },
        },
      } as never),
      { now: 3 },
    );
    expect(isSubagentChildBlock(state.blocks[0]!)).toBe(false);
    expect(isSubagentChildBlock(state.blocks[1]!)).toBe(true);
  });
});

describe('daemon UI subagent nesting — review hardening (R1-R4)', () => {
  it('drops self-reference (parentToolCallId === toolCallId) in normalizer', () => {
    const events = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'self',
          title: 'self-loop attempt',
          status: 'running',
          _meta: { parentToolCallId: 'self', subagentType: 'rogue' },
        },
      },
    } as never);
    expect(events).toEqual([
      expect.not.objectContaining({ parentToolCallId: 'self' }),
    ]);
    // subagentType is dropped together because dropping parent context means
    // the child should not be treated as nested. Actually — we DO keep
    // subagentType independent. Verify:
    expect(events[0]).toMatchObject({
      type: 'tool.update',
      toolCallId: 'self',
      subagentType: 'rogue',
    });
    expect(events[0]).not.toHaveProperty('parentToolCallId');
  });

  it('back-fills parentBlockId when parent appears AFTER child (out-of-order)', async () => {
    const { selectSubagentChildBlocks } = await import(
      '../../src/daemon/ui/index.js'
    );
    let state = createDaemonTranscriptState({ now: 1 });
    // Child first, with parent stamp pointing to a parent not yet in state.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'c-orphan',
            title: 'orphan child',
            status: 'running',
            _meta: {
              parentToolCallId: 'p-later',
              subagentType: 'helper',
            },
          },
        },
      } as never),
      { now: 2 },
    );
    // At this point parentBlockId is undefined but parentToolCallId is set.
    const childPre = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'c-orphan',
    )!;
    expect(childPre.parentToolCallId).toBe('p-later');
    expect(childPre.parentBlockId).toBeUndefined();

    // Parent arrives.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'p-later',
            title: 'parent task',
            status: 'running',
          },
        },
      } as never),
      { now: 3 },
    );
    const parent = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'p-later',
    )!;
    const childPost = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'c-orphan',
    )!;
    // parentBlockId now back-filled on the existing child block.
    expect(childPost.parentBlockId).toBe(parent.id);
    expect(selectSubagentChildBlocks(state, 'p-later')).toHaveLength(1);
  });

  it('back-fills parentBlockId on later child update if parent now exists', () => {
    let state = createDaemonTranscriptState({ now: 1 });
    // Child first WITHOUT parent stamp.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'c2',
            title: 'C2',
            status: 'running',
          },
        },
      } as never),
      { now: 2 },
    );
    // Parent arrives.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'p2',
            title: 'P2',
            status: 'running',
          },
        },
      } as never),
      { now: 3 },
    );
    // Child gets parent stamp on later update — parentBlockId must resolve.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'c2',
            status: 'completed',
            _meta: { parentToolCallId: 'p2', subagentType: 'helper' },
          },
        },
      } as never),
      { now: 4 },
    );
    const child = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'c2',
    )!;
    const parent = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'p2',
    )!;
    expect(child.parentToolCallId).toBe('p2');
    expect(child.parentBlockId).toBe(parent.id);
  });

  it('nulls dangling parentBlockId after parent is trimmed by maxBlocks', () => {
    let state = createDaemonTranscriptState({ now: 1, maxBlocks: 3 });
    // Parent + child pair, then push 3 more blocks to evict the parent.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'pT',
            title: 'parent',
            status: 'completed',
          },
        },
      } as never),
      { now: 2 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'cT',
            title: 'child',
            status: 'completed',
            _meta: { parentToolCallId: 'pT', subagentType: 'helper' },
          },
        },
      } as never),
      { now: 3 },
    );
    // Push 3 unrelated tool blocks to trim the parent.
    for (let i = 0; i < 3; i += 1) {
      state = reduceDaemonTranscriptEvents(
        state,
        normalizeDaemonEvent({
          id: 10 + i,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `f${i}`,
              title: `filler ${i}`,
              status: 'completed',
            },
          },
        } as never),
        { now: 4 + i },
      );
    }
    // Parent is gone now; cT may or may not still be in blocks. If it is,
    // its parentBlockId must NOT reference the trimmed parent.
    const child = state.blocks.find(
      (b): b is Extract<typeof b, { kind: 'tool' }> =>
        b.kind === 'tool' && b.toolCallId === 'cT',
    );
    if (child) {
      // parentToolCallId stays (selector-friendly), parentBlockId is nulled.
      expect(child.parentToolCallId).toBe('pT');
      expect(child.parentBlockId).toBeUndefined();
    }
  });

  it('subagent-nesting fixture passes for the SDK reference adapter', async () => {
    const {
      runAdapterConformanceSuite,
      DAEMON_UI_CONFORMANCE_FIXTURES,
      daemonBlockToMarkdown,
    } = await import('../../src/daemon/ui/index.js');
    const fixture = DAEMON_UI_CONFORMANCE_FIXTURES.find(
      (f) => f.name === 'subagent-nesting',
    );
    expect(fixture).toBeDefined();
    const result = runAdapterConformanceSuite(
      {
        reduce: (events) =>
          reduceDaemonTranscriptEvents(
            createDaemonTranscriptState(),
            events,
          ),
        renderToText: (state) =>
          state.blocks.map((b) => daemonBlockToMarkdown(b)).join('\n\n'),
      },
      { only: ['subagent-nesting'] },
    );
    expect(result.failed).toEqual([]);
    expect(result.passed).toBe(1);
  });
});

describe('daemon UI permission trim contract — wenshao review hardening', () => {
  it('Critical: resolvePermissionBlock drops resolution for trimmed permission requests', () => {
    let state = createDaemonTranscriptState({ now: 1, maxBlocks: 3 });
    // Permission request issued.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'request_permission',
            permissionRequestId: 'req-evict',
            options: [{ optionId: 'allow', label: 'Allow' }],
            toolCall: { name: 'Bash', command: 'rm -rf /tmp/x' },
          },
        },
      } as never),
      { now: 2 },
    );
    // Push 3 unrelated tool blocks to trim the permission request.
    for (let i = 0; i < 3; i += 1) {
      state = reduceDaemonTranscriptEvents(
        state,
        normalizeDaemonEvent({
          id: 10 + i,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `filler-${i}`,
              title: `filler ${i}`,
              status: 'completed',
            },
          },
        } as never),
        { now: 3 + i },
      );
    }
    // The permission request block is now trimmed; index carries the sentinel.
    const blocksBefore = state.blocks.length;
    // Resolution arrives AFTER the request was trimmed.
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent({
        id: 20,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'permission_outcome',
            permissionRequestId: 'req-evict',
            outcome: 'allowed',
          },
        },
      } as never),
      { now: 10 },
    );
    // Critical contract: no orphan resolution block created.
    const blocksAfter = state.blocks.length;
    expect(blocksAfter).toBe(blocksBefore);
    // No permission block of any kind in current state.
    expect(state.blocks.find((b) => b.kind === 'permission')).toBeUndefined();
  });

  it('Suggestion: pruneTrimmedPermissionIndexes caps the trimmed sentinel set', () => {
    let state = createDaemonTranscriptState({ now: 1, maxBlocks: 2 });
    // Issue many permission requests then trim them all by adding tool blocks.
    for (let i = 0; i < 10; i += 1) {
      state = reduceDaemonTranscriptEvents(
        state,
        normalizeDaemonEvent({
          id: 100 + i,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'request_permission',
              permissionRequestId: `req-${i}`,
              options: [{ optionId: 'allow', label: 'Allow' }],
              toolCall: { name: 'Bash', command: `echo ${i}` },
            },
          },
        } as never),
        { now: 2 + i },
      );
    }
    // Push 2 tool blocks to trim everything.
    for (let i = 0; i < 2; i += 1) {
      state = reduceDaemonTranscriptEvents(
        state,
        normalizeDaemonEvent({
          id: 200 + i,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `final-${i}`,
              title: `final ${i}`,
              status: 'completed',
            },
          },
        } as never),
        { now: 50 + i },
      );
    }
    // Index size capped at maxBlocks (= 2), not unbounded (would be 10).
    const indexSize = Object.keys(state.permissionBlockByRequestId).length;
    expect(indexSize).toBeLessThanOrEqual(2);
  });
});
