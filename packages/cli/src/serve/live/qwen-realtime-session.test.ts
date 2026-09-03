/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  deriveQwenOmniRealtimeUrl,
  openQwenRealtimeSession,
  QWEN_REALTIME_LIMITS,
  type QwenRealtimeCallbacks,
  type QwenRealtimeSession,
} from './qwen-realtime-session.js';

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

describe('qwen-realtime-session', () => {
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

  it('configures the Codex V2 conversation and handoff tools', async () => {
    const socket = new FakeSocket();
    await connect(socket);

    const update = sentJson(socket, 0);
    expect(update['type']).toBe('session.update');
    const session = update['session'] as Record<string, unknown>;
    expect(session['modalities']).toEqual(['text', 'audio']);
    expect(session['voice']).toBe('Tina');
    expect(session['tool_choice']).toBe('auto');
    expect(session['turn_detection']).toEqual({
      type: 'semantic_vad',
      create_response: true,
      interrupt_response: true,
    });
    const tools = session['tools'] as Array<{
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }>;
    expect(tools.map((tool) => tool.function.name)).toEqual([
      'background_agent',
      'remain_silent',
    ]);
    expect(tools[0]?.function.parameters).toMatchObject({
      required: ['prompt'],
      additionalProperties: false,
    });
    expect(tools[0]?.function.description).toContain(
      'Before invoking this function for the first time in a user turn, first output one short, concrete assistant speech sentence',
    );
    expect(tools[0]?.function.description).toContain(
      'never creates a separate user-visible task, session, or conversation by itself',
    );
    expect(String(session['instructions'])).toContain(
      'Respond directly only when the request is clearly self-contained',
    );
    expect(String(session['instructions'])).toContain(
      'Always use the backend when the user asks about the current screen',
    );
    expect(String(session['instructions'])).toContain(
      'Never answer capability questions based only on your own realtime-model capabilities',
    );
    expect(String(session['instructions'])).toContain(
      "Call `background_agent` with the user's exact words",
    );
    expect(String(session['instructions'])).toContain(
      'A handoff is not the requested separate task',
    );
    expect(String(session['instructions'])).toContain(
      'Messages from the backend are prefixed with [BACKEND] .',
    );
    expect(String(session['instructions'])).toContain(
      '[BACKEND] messages are silent context',
    );
    expect(String(session['instructions'])).toContain(
      'speak exactly the text after the prefix, verbatim',
    );
    expect(String(session['instructions'])).toContain(
      'If the user explicitly requests frequent or detailed updates',
    );
  });

  it('lets Realtime answer an ordinary turn directly', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onDelegateCall: vi.fn(),
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

    expect(callbacks.onDelegateCall).not.toHaveBeenCalled();
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
      onDelegateCall: vi.fn(),
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
      'background_agent',
      JSON.stringify({ prompt: '检查当前页面' }),
    );
    expect(callbacks.onDelegateCall).toHaveBeenCalledOnce();
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

  it('keeps a handoff open while sending backend Agent messages in order', async () => {
    const socket = new FakeSocket();
    const callbacks = { onDelegateCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-handoff', '查看当前仓库');
    responseCreated(socket, 'response-handoff');
    functionCall(
      socket,
      'response-handoff',
      'call-handoff',
      'background_agent',
      JSON.stringify({ prompt: '查看当前仓库' }),
    );

    expect(callbacks.onDelegateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-handoff',
        request: '查看当前仓库',
        inputItemId: 'input-handoff',
        activeTranscript: [{ role: 'user', text: '查看当前仓库' }],
      }),
    );
    expect(session.takeTranscriptTail()).toEqual([]);
    expect(
      session.sendHandoffUpdate({
        callEpoch: 7,
        callId: 'call-handoff',
        output: '正在检查仓库。',
      }),
    ).toBe(true);
    expect(
      session.sendHandoffUpdate({
        callEpoch: 7,
        callId: 'call-handoff',
        output: '检查完成。',
      }),
    ).toBe(true);
    expect(
      session.completeHandoff({ callEpoch: 7, callId: 'call-handoff' }),
    ).toBe(true);

    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
      'conversation.item.create',
    ]);
    responseDone(socket, 'response-handoff');
    await Promise.resolve();

    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
    ]);
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[BACKEND] 正在检查仓库。' }],
    });
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[BACKEND] 检查完成。' }],
    });
    expect(sentJson(socket, 3)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-handoff',
      output:
        'Background agent finished. Use the preceding [BACKEND] messages as the result.',
    });
  });

  it('keeps a second handoff silent while routing its text as steering', async () => {
    const socket = new FakeSocket();
    const callbacks = { onDelegateCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-first', '开始检查');
    responseCreated(socket, 'response-first');
    functionCall(
      socket,
      'response-first',
      'call-first',
      'background_agent',
      JSON.stringify({ prompt: '开始检查' }),
    );
    responseDone(socket, 'response-first');

    commitFinalInput(socket, 'input-steer', '只看测试目录');
    responseCreated(socket, 'response-steer');
    functionCall(
      socket,
      'response-steer',
      'call-steer',
      'background_agent',
      JSON.stringify({ prompt: '只看测试目录' }),
    );
    expect(callbacks.onDelegateCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        callId: 'call-steer',
        request: '只看测试目录',
      }),
    );
    responseDone(socket, 'response-steer');
    await Promise.resolve();

    const steeringOutput = socket.sent
      .map(sentJsonEntry)
      .find(
        (entry) =>
          (entry['item'] as { call_id?: string } | undefined)?.call_id ===
          'call-steer',
      );
    expect(steeringOutput?.['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-steer',
      output: 'This was sent to steer the previous background agent task.',
    });
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(0);

    expect(
      session.sendHandoffUpdate({
        callEpoch: 7,
        callId: 'call-first',
        output: '已按新要求完成。',
      }),
    ).toBe(true);
    expect(
      session.completeHandoff({ callEpoch: 7, callId: 'call-first' }),
    ).toBe(true);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(0);
  });

  it('handles remain_silent without creating backend work or another response', async () => {
    const socket = new FakeSocket();
    const callbacks = { onDelegateCall: vi.fn() };
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-silent', '');
    responseCreated(socket, 'response-silent');
    functionCall(
      socket,
      'response-silent',
      'call-silent',
      'remain_silent',
      '{}',
    );
    responseDone(socket, 'response-silent');
    await Promise.resolve();

    expect(callbacks.onDelegateCall).not.toHaveBeenCalled();
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

  it('ignores unknown Realtime tools while preserving an active handoff', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onDelegateCall: vi.fn(),
      onError: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-screen', '查看屏幕');
    responseCreated(socket, 'response-screen');
    functionCall(
      socket,
      'response-screen',
      'call-screen',
      'background_agent',
      JSON.stringify({ prompt: '查看屏幕' }),
    );
    functionCall(socket, 'response-screen', 'call-unknown', 'appshot', '{}');
    responseDone(socket, 'response-screen');

    expect(callbacks.onDelegateCall).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(
      session.sendHandoffUpdate({
        callEpoch: 7,
        callId: 'call-screen',
        output: '屏幕已读取。',
      }),
    ).toBe(true);
    expect(
      session.completeHandoff({ callEpoch: 7, callId: 'call-screen' }),
    ).toBe(true);
  });

  it('continues direct Realtime conversation after handoff completion', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onDelegateCall: vi.fn(),
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
      'background_agent',
      JSON.stringify({ prompt: '执行任务' }),
    );
    responseDone(socket, 'response-work');
    session.sendHandoffUpdate({
      callEpoch: 7,
      callId: 'call-work',
      output: '任务完成。',
    });
    session.completeHandoff({ callEpoch: 7, callId: 'call-work' });
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

    expect(callbacks.onDelegateCall).toHaveBeenCalledTimes(1);
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
      onDelegateCall: vi.fn(),
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
      'background_agent',
      JSON.stringify({ prompt: '检查当前页面' }),
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
      session.completeHandoff({ callEpoch: 7, callId: 'call-handoff' }),
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
