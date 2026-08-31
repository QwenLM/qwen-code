/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  deriveQwenOmniRealtimeUrl,
  openQwenRealtimeSession,
  QWEN_REALTIME_LIMITS,
  REMAIN_SILENT_TOOL_NAME,
  type QwenRealtimeCallbacks,
  type QwenRealtimeSession,
  type RealtimeToolDefinition,
} from './realtime-session.js';

const HANDOFF_TOOL: RealtimeToolDefinition = {
  type: 'function',
  function: {
    name: 'handoff',
    description: 'Delegate the current request to the backend agent.',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
      additionalProperties: false,
    },
  },
  capturesTranscript: true,
};

const LIST_TOOL: RealtimeToolDefinition = {
  type: 'function',
  function: {
    name: 'session_list',
    description: 'List the active backend sessions.',
    parameters: { type: 'object', properties: {} },
  },
};

const REMAIN_SILENT_DEF: RealtimeToolDefinition = {
  type: 'function',
  function: {
    name: REMAIN_SILENT_TOOL_NAME,
    description: 'Stay silent for this turn.',
    parameters: { type: 'object', properties: {} },
  },
};

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  private readonly handlers = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(cb);
    this.handlers.set(event, handlers);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  message(body: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(body), false);
  }
}

function sentJson(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(String(socket.sent[index]));
}

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((entry) => String(sentJsonEntry(entry)['type']));
}

function sentJsonEntry(entry: string | Uint8Array): Record<string, unknown> {
  return JSON.parse(String(entry));
}

function commitFinalInput(
  socket: FakeSocket,
  itemId: string,
  transcript: string,
): void {
  socket.message({
    type: 'input_audio_buffer.committed',
    event_id: itemId + '-committed',
    item_id: itemId,
  });
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: itemId + '-transcript',
    item_id: itemId,
    transcript,
  });
}

function responseCreated(socket: FakeSocket, responseId: string): void {
  socket.message({
    type: 'response.created',
    event_id: responseId + '-created',
    response: { id: responseId, status: 'in_progress' },
  });
}

function responseDone(
  socket: FakeSocket,
  responseId: string,
  status = 'completed',
): void {
  socket.message({
    type: 'response.done',
    event_id: responseId + '-done',
    response: { id: responseId, status },
  });
}

function functionCall(
  socket: FakeSocket,
  responseId: string,
  callId: string,
  name: string,
  argumentsText: string,
): void {
  socket.message({
    type: 'response.output_item.done',
    event_id: callId + '-done',
    response_id: responseId,
    item: {
      id: 'item-' + callId,
      type: 'function_call',
      name,
      call_id: callId,
      arguments: argumentsText,
    },
  });
}

async function connect(
  socket: FakeSocket,
  callbacks: QwenRealtimeCallbacks = {},
): Promise<QwenRealtimeSession> {
  const opening = openQwenRealtimeSession(
    {
      endpoint: 'https://dashscope.example/compatible-mode/v1',
      apiKey: 'sk-test',
      model: 'qwen3.5-omni-plus-realtime',
      callEpoch: 7,
      voice: 'Tina',
      instructions: 'test instructions',
      tools: [HANDOFF_TOOL, LIST_TOOL, REMAIN_SILENT_DEF],
    },
    callbacks,
    { createWebSocket: () => socket },
  );
  socket.message({ type: 'session.created', event_id: 'session-created' });
  socket.message({
    type: 'session.updated',
    event_id: 'session-updated',
    session: { id: 'session-1' },
  });
  return opening;
}

describe('realtime-session', () => {
  it('derives a model-qualified WebSocket URL', () => {
    expect(
      deriveQwenOmniRealtimeUrl(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3.5-omni-plus-realtime',
      ),
    ).toBe(
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime',
    );
    expect(
      deriveQwenOmniRealtimeUrl(
        'wss://example.test/custom/api-ws/v1/realtime?tenant=one',
        'model/with spaces',
      ),
    ).toBe(
      'wss://example.test/custom/api-ws/v1/realtime?tenant=one&model=model%2Fwith+spaces',
    );
  });

  it('sends the configured instructions and wire-shaped tools in session.update', async () => {
    const socket = new FakeSocket();
    await connect(socket);

    const update = sentJson(socket, 0);
    expect(update['type']).toBe('session.update');
    const session = update['session'] as Record<string, unknown>;
    expect(session['modalities']).toEqual(['text', 'audio']);
    expect(session['voice']).toBe('Tina');
    expect(session['tool_choice']).toBe('auto');
    expect(session['instructions']).toBe('test instructions');
    expect(session['turn_detection']).toEqual({
      type: 'semantic_vad',
      create_response: true,
      interrupt_response: true,
    });
    // The wire shape carries only {type, function}: the local-only
    // `capturesTranscript` flag must be stripped.
    expect(session['tools']).toEqual([
      { type: 'function', function: HANDOFF_TOOL.function },
      { type: 'function', function: LIST_TOOL.function },
      { type: 'function', function: REMAIN_SILENT_DEF.function },
    ]);
    for (const tool of session['tools'] as Array<Record<string, unknown>>) {
      expect('capturesTranscript' in tool).toBe(false);
    }
  });

  it('lets Realtime answer an ordinary turn directly', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseCreated: vi.fn(),
      onOutputTextDelta: vi.fn(),
      onOutputTextDone: vi.fn(),
      onOutputAudioDelta: vi.fn(),
      onOutputAudioDone: vi.fn(),
      onResponseDone: vi.fn(),
      onDirectTranscript: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-direct', '你好');
    responseCreated(socket, 'response-direct');
    socket.message({
      type: 'response.audio_transcript.delta',
      response_id: 'response-direct',
      item_id: 'assistant-direct',
      delta: '你好！',
    });
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-direct',
      item_id: 'assistant-direct',
      transcript: '你好！',
    });
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-direct',
      item_id: 'assistant-direct',
      delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
    });
    socket.message({
      type: 'response.output_audio.done',
      response_id: 'response-direct',
      item_id: 'assistant-direct',
    });
    responseDone(socket, 'response-direct');

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    expect(callbacks.onResponseCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-direct',
        inputItemId: 'input-direct',
        authority: 'direct',
      }),
    );
    expect(callbacks.onOutputTextDone).toHaveBeenCalledWith(
      expect.objectContaining({ text: '你好！', source: 'audio_transcript' }),
    );
    expect(callbacks.onOutputAudioDelta).toHaveBeenCalledWith(
      expect.objectContaining({ audio: new Uint8Array([1, 0, 2, 0]) }),
    );
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: 'response-direct' }),
    );
    expect(callbacks.onDirectTranscript).toHaveBeenCalledWith({
      callEpoch: 7,
      entries: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '你好！' },
      ],
    });
    expect(session.takeTranscriptTail()).toEqual([]);
    expect(sentTypes(socket)).toEqual(['session.update']);
  });

  it('returns undelivered direct dialogue once when no transcript callback is configured', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);

    commitFinalInput(socket, 'input-direct', '你好');
    responseCreated(socket, 'response-direct');
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-direct',
      transcript: '你好！',
    });
    responseDone(socket, 'response-direct');

    expect(session.takeTranscriptTail()).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '你好！' },
    ]);
    expect(session.takeTranscriptTail()).toEqual([]);
  });

  it('uses the active response when response.done omits its identifier', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onError: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-direct', '你好');
    responseCreated(socket, 'response-direct');
    socket.message({
      type: 'response.done',
      event_id: 'response-direct-done',
      response: { status: 'completed' },
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-direct',
        inputItemId: 'input-direct',
        status: 'completed',
      }),
    );
  });

  it('ignores an idless duplicate response.done after a completed response', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onError: vi.fn(),
      onIgnoredEvent: vi.fn(),
      onResponseDone: vi.fn(),
      onFunctionCall: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-direct', '你好');
    responseCreated(socket, 'response-direct');
    responseDone(socket, 'response-direct');
    socket.message({
      type: 'response.done',
      event_id: 'response-direct-late-done',
      response: { status: 'completed' },
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).toHaveBeenCalledOnce();
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response.done',
        reason: 'stale_response',
      }),
    );

    commitFinalInput(socket, 'input-handoff', '检查当前页面');
    responseCreated(socket, 'response-handoff');
    functionCall(
      socket,
      'response-handoff',
      'call-handoff',
      'handoff',
      JSON.stringify({ task: '检查当前页面' }),
    );
    expect(callbacks.onFunctionCall).toHaveBeenCalledOnce();
  });

  it('rejects an idless response.done when no response has completed', async () => {
    const socket = new FakeSocket();
    const callbacks = { onError: vi.fn() } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    socket.message({
      type: 'response.done',
      event_id: 'orphan-response-done',
      response: { status: 'completed' },
    });

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_response' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('dispatches a capturing tool call and holds its output until response.done', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-handoff', '查看当前仓库');
    responseCreated(socket, 'response-handoff');
    functionCall(
      socket,
      'response-handoff',
      'call-handoff',
      'handoff',
      JSON.stringify({ task: '查看当前仓库' }),
    );

    expect(callbacks.onFunctionCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callEpoch: 7,
        responseId: 'response-handoff',
        inputItemId: 'input-handoff',
        callId: 'call-handoff',
        name: 'handoff',
        arguments: JSON.stringify({ task: '查看当前仓库' }),
        activeTranscript: [{ role: 'user', text: '查看当前仓库' }],
      }),
    );
    const event = callbacks.onFunctionCall.mock.calls[0]![0] as {
      arguments: string;
    };
    expect(JSON.parse(event.arguments)).toEqual({ task: '查看当前仓库' });
    // The captured turn is delegated and stays out of the direct collection.
    expect(session.takeTranscriptTail()).toEqual([]);

    // Output submitted before the response completes is held back...
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-handoff' },
        '仓库检查完成。',
      ),
    ).toBe(true);
    expect(sentTypes(socket)).toEqual(['session.update']);

    // ...and flushed right after response.done.
    responseDone(socket, 'response-handoff');
    await Promise.resolve();
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
    ]);
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-handoff',
      output: '仓库检查完成。',
    });
  });

  it('dispatches multiple function calls in one response independently', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-multi', '并行处理');
    responseCreated(socket, 'response-multi');
    functionCall(
      socket,
      'response-multi',
      'call-a',
      'handoff',
      JSON.stringify({ task: '并行处理' }),
    );
    functionCall(socket, 'response-multi', 'call-b', 'session_list', '{}');

    expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(2);
    expect(callbacks.onFunctionCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        callId: 'call-a',
        name: 'handoff',
        activeTranscript: [{ role: 'user', text: '并行处理' }],
      }),
    );
    expect(callbacks.onFunctionCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        callId: 'call-b',
        name: 'session_list',
        arguments: '{}',
        activeTranscript: [],
      }),
    );

    responseDone(socket, 'response-multi');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-a' },
        'A 完成',
      ),
    ).toBe(true);
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-b' },
        'B 完成',
      ),
    ).toBe(true);

    const outputs = socket.sent
      .map(sentJsonEntry)
      .map((entry) => entry['item'] as Record<string, unknown> | undefined)
      .filter((item) => item?.['type'] === 'function_call_output');
    expect(outputs).toEqual([
      { type: 'function_call_output', call_id: 'call-a', output: 'A 完成' },
      { type: 'function_call_output', call_id: 'call-b', output: 'B 完成' },
    ]);
  });

  it('keeps non-capturing tool turns inside the direct transcript flow', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-list', '列出会话');
    responseCreated(socket, 'response-list');
    functionCall(socket, 'response-list', 'call-list', 'session_list', '{}');

    expect(callbacks.onFunctionCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-list',
        name: 'session_list',
        arguments: '{}',
        activeTranscript: [],
      }),
    );

    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-list',
      transcript: '好的，这是会话列表。',
    });
    responseDone(socket, 'response-list');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-list' },
        '会话：alpha',
      ),
    ).toBe(true);

    // The response stayed `direct`, so its dialogue is still collected.
    expect(session.takeTranscriptTail()).toEqual([
      { role: 'user', text: '列出会话' },
      { role: 'assistant', text: '好的，这是会话列表。' },
    ]);
  });

  it('handles remain_silent without dispatching a function call', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-silent', '');
    responseCreated(socket, 'response-silent');
    functionCall(
      socket,
      'response-silent',
      'call-silent',
      REMAIN_SILENT_TOOL_NAME,
      '{}',
    );
    responseDone(socket, 'response-silent');
    await Promise.resolve();

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-silent',
      output: '',
    });
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
    ]);
  });

  it('answers unknown tools with an error receipt instead of dispatching them', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onError: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-screen', '查看屏幕');
    responseCreated(socket, 'response-screen');
    functionCall(
      socket,
      'response-screen',
      'call-screen',
      'handoff',
      JSON.stringify({ task: '查看屏幕' }),
    );
    functionCall(socket, 'response-screen', 'call-unknown', 'appshot', '{}');
    responseDone(socket, 'response-screen');
    await Promise.resolve();

    expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-unknown',
      output: JSON.stringify({
        status: 'error',
        note: 'Unknown tool: appshot',
      }),
    });
    // The declared call in the same response is still completable.
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-screen' },
        '屏幕已读取。',
      ),
    ).toBe(true);
  });

  it('rejects stale function outputs without sending anything', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onIgnoredEvent: vi.fn(),
      onFunctionCall: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    // Unknown call id.
    expect(
      session.submitFunctionOutput({ callEpoch: 7, callId: 'missing' }, '内容'),
    ).toBe(false);
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.item.create',
        reason: 'stale_call',
      }),
    );

    commitFinalInput(socket, 'input-stale', '检查');
    responseCreated(socket, 'response-stale');
    functionCall(
      socket,
      'response-stale',
      'call-stale',
      'handoff',
      JSON.stringify({ task: '检查' }),
    );
    // Wrong epoch.
    expect(
      session.submitFunctionOutput(
        { callEpoch: 8, callId: 'call-stale' },
        '内容',
      ),
    ).toBe(false);
    // A call whose arguments are still streaming has not been dispatched.
    socket.message({
      type: 'response.function_call_arguments.delta',
      event_id: 'partial-delta',
      response_id: 'response-stale',
      call_id: 'call-partial',
      delta: '{"task"',
    });
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-partial' },
        '内容',
      ),
    ).toBe(false);

    responseDone(socket, 'response-stale');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-stale' },
        '完成',
      ),
    ).toBe(true);
    // Double submission.
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-stale' },
        '再次',
      ),
    ).toBe(false);
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledTimes(4);

    const outputs = socket.sent
      .map(sentJsonEntry)
      .map((entry) => entry['item'] as Record<string, unknown> | undefined)
      .filter((item) => item?.['type'] === 'function_call_output');
    expect(outputs).toEqual([
      { type: 'function_call_output', call_id: 'call-stale', output: '完成' },
    ]);
  });

  it('rejects function outputs after the session is closed', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onIgnoredEvent: vi.fn(),
      onFunctionCall: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-late', '检查');
    responseCreated(socket, 'response-late');
    functionCall(
      socket,
      'response-late',
      'call-late',
      'handoff',
      JSON.stringify({ task: '检查' }),
    );
    session.close();

    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-late' },
        '完成',
      ),
    ).toBe(false);
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stale_call' }),
    );
  });

  it('bounds function output size and rejects blank output', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket, { onFunctionCall: vi.fn() });

    commitFinalInput(socket, 'input-bounds', '检查');
    responseCreated(socket, 'response-bounds');
    functionCall(
      socket,
      'response-bounds',
      'call-bounds',
      'handoff',
      JSON.stringify({ task: '检查' }),
    );
    responseDone(socket, 'response-bounds');

    const ref = { callEpoch: 7, callId: 'call-bounds' };
    expect(() => session.submitFunctionOutput(ref, '')).toThrow(RangeError);
    expect(() => session.submitFunctionOutput(ref, '   ')).toThrow(RangeError);
    expect(() =>
      session.submitFunctionOutput(
        ref,
        'x'.repeat(QWEN_REALTIME_LIMITS.maxFunctionOutputChars + 1),
      ),
    ).toThrow(RangeError);
    // The call survives rejected attempts and can still be completed.
    expect(session.submitFunctionOutput(ref, '完成')).toBe(true);
  });

  it('continues direct Realtime conversation after a handoff completes', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseCreated: vi.fn(),
      onOutputTextDone: vi.fn(),
      onDirectTranscript: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-work', '执行任务');
    responseCreated(socket, 'response-work');
    functionCall(
      socket,
      'response-work',
      'call-work',
      'handoff',
      JSON.stringify({ task: '执行任务' }),
    );
    responseDone(socket, 'response-work');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-work' },
        '任务完成。',
      ),
    ).toBe(true);
    session.speakToUser('任务完成。');
    responseCreated(socket, 'response-work-result');
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-work-result',
      transcript: '任务完成。',
    });
    responseDone(socket, 'response-work-result');

    commitFinalInput(socket, 'input-chat', '谢谢');
    responseCreated(socket, 'response-chat');
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-chat',
      transcript: '不客气。',
    });
    responseDone(socket, 'response-chat');

    expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-chat',
        inputItemId: 'input-chat',
        authority: 'direct',
      }),
    );
    expect(callbacks.onOutputTextDone).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '不客气。' }),
    );
    expect(callbacks.onDirectTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onDirectTranscript).toHaveBeenCalledWith({
      callEpoch: 7,
      entries: [
        { role: 'user', text: '谢谢' },
        { role: 'assistant', text: '不客气。' },
      ],
    });
  });

  it('keeps the replacement response alive when VAD interrupts audio', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onBargeIn: vi.fn(),
      onError: vi.fn(),
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(),
      onOutputAudioDelta: vi.fn(),
      onOutputTextDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-first', '先回答第一个问题');
    responseCreated(socket, 'response-first');
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-first',
      item_id: 'assistant-first',
      delta: Buffer.from([1, 0]).toString('base64'),
    });

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started',
      item_id: 'input-second',
    });
    commitFinalInput(socket, 'input-second', '现在回答第二个问题');
    responseCreated(socket, 'response-second');
    responseDone(socket, 'response-first', 'cancelled');
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-second',
      item_id: 'assistant-second',
      delta: Buffer.from([2, 0]).toString('base64'),
    });
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-second',
      item_id: 'assistant-second',
      transcript: '第二个问题的回答。',
    });
    responseDone(socket, 'response-second');

    expect(callbacks.onBargeIn).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: 'response-first' }),
    );
    expect(sentTypes(socket)).not.toContain('response.cancel');
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-second',
        inputItemId: 'input-second',
        authority: 'direct',
      }),
    );
    expect(callbacks.onResponseDone).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        responseId: 'response-first',
        status: 'cancelled',
      }),
    );
    expect(callbacks.onOutputAudioDelta).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-second',
        audio: new Uint8Array([2, 0]),
      }),
    );
    expect(callbacks.onOutputTextDone).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-second',
        text: '第二个问题的回答。',
      }),
    );
    expect(callbacks.onResponseDone).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-second',
        status: 'completed',
      }),
    );
  });

  it('finalizes a superseded response when the provider omits its done event', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onError: vi.fn(),
      onResponseDone: vi.fn(),
      onDirectTranscript: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-first', '第一个问题');
    responseCreated(socket, 'response-first');
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-first',
      transcript: '第一个回答。',
    });

    commitFinalInput(socket, 'input-second', '第二个问题');
    responseCreated(socket, 'response-second');
    socket.message({
      type: 'response.audio_transcript.done',
      response_id: 'response-second',
      transcript: '第二个回答。',
    });
    responseDone(socket, 'response-second');

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        responseId: 'response-first',
        inputItemId: 'input-first',
        status: 'cancelled',
      }),
    );
    expect(callbacks.onResponseDone).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        responseId: 'response-second',
        inputItemId: 'input-second',
        status: 'completed',
      }),
    );
    expect(callbacks.onDirectTranscript).toHaveBeenNthCalledWith(1, {
      callEpoch: 7,
      entries: [
        { role: 'user', text: '第一个问题' },
        { role: 'assistant', text: '第一个回答。' },
      ],
    });
    expect(session.takeTranscriptTail()).toEqual([]);
  });

  it('keeps delegated work alive when its response is superseded without done', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseDone: vi.fn(),
      onDirectTranscript: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-handoff', '检查当前页面');
    responseCreated(socket, 'response-handoff');
    functionCall(
      socket,
      'response-handoff',
      'call-handoff',
      'handoff',
      JSON.stringify({ task: '检查当前页面' }),
    );

    commitFinalInput(socket, 'input-next', '谢谢');
    responseCreated(socket, 'response-next');

    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-handoff',
        inputItemId: 'input-handoff',
        status: 'cancelled',
      }),
    );
    expect(callbacks.onDirectTranscript).not.toHaveBeenCalled();
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-handoff' },
        '页面检查完成。',
      ),
    ).toBe(true);
    expect(sentTypes(socket)).not.toContain('response.create');

    responseDone(socket, 'response-next');
    expect(session.takeTranscriptTail()).toEqual([]);
  });

  it('keeps backend context silent while a response is active', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);

    commitFinalInput(socket, 'input-active', '你好');
    responseCreated(socket, 'response-active');
    expect(session.sendBackendContext('后台消息一')).toBe(true);
    expect(session.sendBackendContext('后台消息二')).toBe(true);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(0);
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[BACKEND] 后台消息一' }],
    });
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[BACKEND] 后台消息二' }],
    });

    responseDone(socket, 'response-active');
    await Promise.resolve();
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(0);
  });

  it('speaks only explicit backend speech with backend_speech authority', async () => {
    const socket = new FakeSocket();
    const callbacks = { onResponseCreated: vi.fn() };
    const session = await connect(socket, callbacks);

    expect(session.sendBackendContext('静默上下文')).toBe(true);
    expect(session.speakToUser('正在检查，请稍等。')).toBe(true);
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '[SPEAK_TO_USER] 正在检查，请稍等。',
        },
      ],
    });
    expect(sentJson(socket, 3)).toMatchObject({
      type: 'response.create',
      response: { modalities: ['text', 'audio'] },
    });

    responseCreated(socket, 'response-speech');
    expect(callbacks.onResponseCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-speech',
        authority: 'backend_speech',
      }),
    );
  });

  it('drops queued backend speech when the user starts speaking', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);

    commitFinalInput(socket, 'input-active', '你好');
    responseCreated(socket, 'response-active');
    expect(session.speakToUser('旧进度一')).toBe(true);
    expect(session.speakToUser('旧进度二')).toBe(true);
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started-new',
      item_id: 'input-new',
    });
    responseDone(socket, 'response-active');
    await Promise.resolve();

    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(0);
  });

  it('serializes multiple explicit speech requests without combining them', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);

    commitFinalInput(socket, 'input-active', '你好');
    responseCreated(socket, 'response-active');
    expect(session.speakToUser('第一条')).toBe(true);
    expect(session.speakToUser('第二条')).toBe(true);
    expect(
      sentTypes(socket).filter((type) => type === 'conversation.item.create'),
    ).toHaveLength(0);

    responseDone(socket, 'response-active');
    await Promise.resolve();
    responseCreated(socket, 'response-first-speech');
    responseDone(socket, 'response-first-speech');
    await Promise.resolve();

    const speechItems = socket.sent
      .map(sentJsonEntry)
      .filter((entry) => entry['type'] === 'conversation.item.create')
      .map((entry) => entry['item']);
    expect(speechItems).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[SPEAK_TO_USER] 第一条' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[SPEAK_TO_USER] 第二条' }],
      },
    ]);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
  });

  it('cancels backend speech requested just before user speech', async () => {
    const socket = new FakeSocket();
    const callbacks = { onResponseCreated: vi.fn() };
    const session = await connect(socket, callbacks);

    expect(session.speakToUser('即将过期的进度')).toBe(true);
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started-before-created',
      item_id: 'input-new',
    });
    responseCreated(socket, 'response-stale-speech');

    expect(sentTypes(socket)).toContain('response.cancel');
    expect(callbacks.onResponseCreated).not.toHaveBeenCalled();
  });

  it('preserves audio backpressure and frame bounds', async () => {
    const socket = new FakeSocket();
    const onAudioDropped = vi.fn();
    const session = await connect(socket, { onAudioDropped });

    expect(() =>
      session.pushAudio(
        new Uint8Array(QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes + 2),
      ),
    ).toThrow(RangeError);
    socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
    expect(session.pushAudio(new Uint8Array([1, 0]))).toBe(false);
    expect(session.pushAudio(new Uint8Array([1, 0]))).toBe(false);
    expect(onAudioDropped).toHaveBeenCalledTimes(1);
  });

  it('redacts provider credentials and classifies rate limits', async () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    const session = await connect(socket, { onError });
    socket.message({
      type: 'error',
      error: {
        code: 'rate_limit_exceeded',
        status: 429,
        message: 'sk-test rate limit exceeded',
      },
    });

    const closed = await session.closed;
    expect(closed.reason).toBe('error');
    expect(closed.error?.kind).toBe('transient');
    expect(closed.error?.message).not.toContain('sk-test');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects realtime endpoints carrying credentials', () => {
    expect(() =>
      deriveQwenOmniRealtimeUrl(
        'https://user:pass@dashscope.example/compatible-mode/v1',
        'qwen3.5-omni-plus-realtime',
      ),
    ).toThrow('must not contain credentials');
    expect(() =>
      deriveQwenOmniRealtimeUrl(
        'https://dashscope.example/compatible-mode/v1?api_key=sk-secret',
        'qwen3.5-omni-plus-realtime',
      ),
    ).toThrow('must not contain credentials');
    expect(() =>
      deriveQwenOmniRealtimeUrl(
        'wss://dashscope.example/api-ws/v1/realtime?token=abc',
        'qwen3.5-omni-plus-realtime',
      ),
    ).toThrow('must not contain credentials');
  });

  it('ignores a late final transcript for an already-consumed input', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onError: vi.fn(),
      onIgnoredEvent: vi.fn(),
      onInputTranscriptDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    // The turn completes before the ASR stream delivers its final.
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'late-committed',
      item_id: 'input-late',
    });
    responseCreated(socket, 'response-late');
    responseDone(socket, 'response-late');
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'late-final',
      item_id: 'input-late',
      transcript: '迟到的转写',
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onInputTranscriptDone).not.toHaveBeenCalled();
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.item.input_audio_transcription.completed',
        reason: 'stale_input',
      }),
    );
    // The session survives and the next turn proceeds normally.
    expect(socket.readyState).toBe(socket.OPEN);
    commitFinalInput(socket, 'input-next', '下一个问题');
    expect(callbacks.onInputTranscriptDone).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'input-next', text: '下一个问题' }),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('still fails a final transcript for a never-committed input', async () => {
    const socket = new FakeSocket();
    const callbacks = { onError: vi.fn() } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'orphan-final',
      item_id: 'input-unknown',
      transcript: '幽灵转写',
    });

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unattributed_final_transcript' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('re-captures repeated user input once handed-off entries are trimmed', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-repeat-1', '重复的任务');
    responseCreated(socket, 'response-repeat-1');
    functionCall(
      socket,
      'response-repeat-1',
      'call-repeat-1',
      'handoff',
      JSON.stringify({ task: '重复的任务' }),
    );
    expect(callbacks.onFunctionCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        activeTranscript: [{ role: 'user', text: '重复的任务' }],
      }),
    );
    responseDone(socket, 'response-repeat-1');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-repeat-1' },
        '完成',
      ),
    ).toBe(true);

    // Second turn: the model calls the tool before any ASR events land, and
    // the task text repeats the previous (already handed-off) user entry.
    // The consumed entries were trimmed, so the repeat is captured again
    // instead of being deduplicated against dead history.
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'repeat-2-committed',
      item_id: 'input-repeat-2',
    });
    responseCreated(socket, 'response-repeat-2');
    functionCall(
      socket,
      'response-repeat-2',
      'call-repeat-2',
      'handoff',
      JSON.stringify({ task: '重复的任务' }),
    );
    expect(callbacks.onFunctionCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        activeTranscript: [{ role: 'user', text: '重复的任务' }],
      }),
    );
  });

  it('caps the retained handoff transcript instead of growing unboundedly', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    await connect(socket, callbacks);

    // 300 direct turns append 600 transcript entries with no handoff to
    // consume them.
    for (let i = 0; i < 300; i += 1) {
      commitFinalInput(socket, `input-${i}`, `问题 ${i}`);
      responseCreated(socket, `response-${i}`);
      socket.message({
        type: 'response.audio_transcript.done',
        event_id: `response-${i}-transcript`,
        response_id: `response-${i}`,
        transcript: `回答 ${i}`,
      });
      responseDone(socket, `response-${i}`);
    }

    commitFinalInput(socket, 'input-handoff', '最后的任务');
    responseCreated(socket, 'response-handoff');
    functionCall(
      socket,
      'response-handoff',
      'call-handoff',
      'handoff',
      JSON.stringify({ task: '最后的任务' }),
    );

    const event = callbacks.onFunctionCall.mock.calls[0]![0] as {
      activeTranscript: ReadonlyArray<{ role: string; text: string }>;
    };
    // 601 entries were appended; only the newest 512 are retained.
    expect(event.activeTranscript.length).toBe(512);
    expect(event.activeTranscript.at(-1)).toEqual({
      role: 'user',
      text: '最后的任务',
    });
  });

  it('distinguishes client and remote closure', async () => {
    const clientSocket = new FakeSocket();
    const client = await connect(clientSocket);
    client.close();
    await expect(client.closed).resolves.toEqual({ reason: 'client' });

    const remoteSocket = new FakeSocket();
    const remote = await connect(remoteSocket);
    remoteSocket.emit('close', 1007, Buffer.from('invalid request'));
    const closed = await remote.closed;
    expect(closed.reason).toBe('remote');
    expect(closed.error?.closeCode).toBe(1007);
  });
});
