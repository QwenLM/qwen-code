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
  socket.message({
    type: 'session.created',
    event_id: 'session-created',
  });
  socket.message({
    type: 'session.updated',
    event_id: 'session-updated',
    session: { id: 'session-1' },
  });
  return opening;
}

describe('qwen-realtime-session', () => {
  it('derives a model-qualified WebSocket URL from provider and endpoint URLs', () => {
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

  it('configures the narrow live session and streams a complete audio turn', async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const callbacks = {
      onReady: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
      onInputCommitted: vi.fn(),
      onInputTranscriptDelta: vi.fn(),
      onInputTranscriptDone: vi.fn(),
      onDelegateCall: vi.fn(),
      onResponseCreated: vi.fn(),
      onOutputTextDelta: vi.fn(),
      onOutputTextDone: vi.fn(),
      onOutputAudioDelta: vi.fn(),
      onOutputAudioDone: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const opening = openQwenRealtimeSession(
      {
        endpoint: 'https://dashscope.example/v1',
        apiKey: 'sk-test',
        model: 'qwen3.5-omni-plus-realtime',
        callEpoch: 'epoch-a',
        voice: 'Tina',
      },
      callbacks,
      { createWebSocket },
    );

    expect(createWebSocket).toHaveBeenCalledWith(
      'wss://dashscope.example/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime',
      {
        headers: { Authorization: 'Bearer sk-test' },
        maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
        perMessageDeflate: false,
        handshakeTimeout: 8_000,
      },
    );
    socket.message({
      type: 'session.created',
      event_id: 'created',
    });
    expect(sentJson(socket, 0)).toMatchObject({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: 'Tina',
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        input_audio_transcription: {
          model: 'qwen3-asr-flash-realtime',
        },
        turn_detection: {
          type: 'semantic_vad',
          create_response: true,
          interrupt_response: true,
        },
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'delegate_to_coordinator',
            }),
          }),
        ]),
      },
    });
    const update = sentJson(socket, 0);
    const configuredSession = update['session'] as Record<string, unknown>;
    expect(configuredSession).not.toHaveProperty('tool_choice');
    expect(configuredSession).not.toHaveProperty('parallel_tool_calls');
    expect(configuredSession['instructions']).toContain(
      'start_new_live_conversation',
    );
    expect(
      (configuredSession['tools'] as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(['delegate_to_coordinator', 'start_new_live_conversation']);

    socket.message({
      type: 'session.updated',
      event_id: 'updated',
      session: { id: 'session-a' },
    });
    const session = await opening;
    expect(callbacks.onReady).toHaveBeenCalledWith({
      callEpoch: 'epoch-a',
      eventId: 'updated',
      sessionId: 'session-a',
    });

    expect(session.pushAudio(new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(sentJson(socket, 1)).toMatchObject({
      type: 'input_audio_buffer.append',
      audio: 'AQIDBA==',
    });
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started',
      item_id: 'user-1',
      audio_start_ms: 100,
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'input-delta',
      item_id: 'user-1',
      text: '帮我',
      stash: '看看页面',
      language: 'zh',
    });
    socket.message({
      type: 'input_audio_buffer.speech_stopped',
      event_id: 'speech-stopped',
      item_id: 'user-1',
      audio_end_ms: 900,
    });
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'committed',
      item_id: 'user-1',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-done',
      item_id: 'user-1',
      transcript: '帮我看看页面',
    });
    expect(callbacks.onInputTranscriptDelta).toHaveBeenCalledWith({
      callEpoch: 'epoch-a',
      eventId: 'input-delta',
      itemId: 'user-1',
      text: '帮我看看页面',
      stash: '看看页面',
      language: 'zh',
      emotion: undefined,
    });
    expect(callbacks.onInputTranscriptDone).toHaveBeenCalledWith({
      callEpoch: 'epoch-a',
      eventId: 'input-done',
      itemId: 'user-1',
      text: '帮我看看页面',
    });

    socket.message({
      type: 'response.created',
      event_id: 'response-created',
      response: { id: 'response-1', status: 'in_progress' },
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'delegate-done',
      response_id: 'response-1',
      item_id: 'function-1',
      call_id: 'call-1',
      name: 'delegate_to_coordinator',
      arguments: '{"request":"帮我看看页面"}',
    });
    expect(callbacks.onDelegateCall).toHaveBeenCalledOnce();
    expect(
      session.submitFunctionCallOutput({
        callEpoch: 'epoch-a',
        callId: 'call-1',
        output: '好的。',
      }),
    ).toBe(true);
    socket.message({
      type: 'response.done',
      event_id: 'delegate-response-done',
      response: { id: 'response-1', status: 'completed' },
    });
    expect(sentJson(socket, socket.sent.length - 1)).toMatchObject({
      type: 'response.create',
    });
    socket.message({
      type: 'response.created',
      event_id: 'spoken-response-created',
      response: { id: 'response-2', status: 'in_progress' },
    });
    socket.message({
      type: 'response.audio_transcript.delta',
      event_id: 'output-text-delta',
      response_id: 'response-2',
      item_id: 'assistant-1',
      delta: '好的',
    });
    socket.message({
      type: 'response.audio.delta',
      event_id: 'output-audio-delta',
      response_id: 'response-2',
      item_id: 'assistant-1',
      delta: Buffer.from([5, 6]).toString('base64'),
    });
    socket.message({
      type: 'response.audio_transcript.done',
      event_id: 'output-text-done',
      response_id: 'response-2',
      item_id: 'assistant-1',
      transcript: '好的。',
    });
    socket.message({
      type: 'response.audio.done',
      event_id: 'output-audio-done',
      response_id: 'response-2',
      item_id: 'assistant-1',
    });
    socket.message({
      type: 'response.done',
      event_id: 'response-done',
      response: { id: 'response-2', status: 'completed' },
    });

    expect(callbacks.onOutputTextDelta).toHaveBeenCalledWith({
      callEpoch: 'epoch-a',
      eventId: 'output-text-delta',
      responseId: 'response-2',
      itemId: 'assistant-1',
      text: '好的',
      source: 'audio_transcript',
    });
    expect(callbacks.onOutputAudioDelta).toHaveBeenCalledWith({
      callEpoch: 'epoch-a',
      eventId: 'output-audio-delta',
      responseId: 'response-2',
      itemId: 'assistant-1',
      audio: new Uint8Array([5, 6]),
    });
    expect(callbacks.onOutputTextDone).toHaveBeenCalledWith(
      expect.objectContaining({ text: '好的。' }),
    );
    expect(callbacks.onOutputAudioDone).toHaveBeenCalledOnce();
    expect(callbacks.onResponseDone).toHaveBeenLastCalledWith({
      callEpoch: 'epoch-a',
      eventId: 'response-done',
      responseId: 'response-2',
      status: 'completed',
    });
    session.close();
  });

  it('clears playback before cancelling the active response on barge-in', async () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    const onIgnoredEvent = vi.fn();
    const session = await connect(socket, {
      onBargeIn: () => {
        order.push('clear-playback');
        expect(socket.sent).toHaveLength(0);
      },
      onSpeechStarted: () => order.push('speech-started'),
      onOutputAudioDelta: () => order.push('audio'),
      onIgnoredEvent,
    });
    expect(session.sendCoordinatorUpdate('authorized response')).toBe(true);
    socket.sent.length = 0;
    socket.message({
      type: 'response.created',
      event_id: 'created-1',
      response: { id: 'response-1', status: 'in_progress' },
    });
    socket.message({
      type: 'response.audio.delta',
      event_id: 'audio-1',
      response_id: 'response-1',
      delta: 'AQI=',
    });
    order.length = 0;

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-1',
      item_id: 'user-2',
    });

    expect(order).toEqual(['clear-playback', 'speech-started']);
    expect(sentJson(socket, 0)).toMatchObject({ type: 'response.cancel' });
    socket.message({
      type: 'response.audio.delta',
      event_id: 'late-audio',
      response_id: 'response-1',
      delta: 'AwQ=',
    });
    expect(onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response.audio.delta',
        reason: 'cancelled_response',
      }),
    );
    socket.message({
      type: 'response.done',
      event_id: 'cancelled-done',
      response: { id: 'response-1', status: 'cancelled' },
    });
    session.close();
  });

  it('correlates delegate arguments and returns one bounded tool result', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onFunctionArgumentsDelta = vi.fn();
    const onIgnoredEvent = vi.fn();
    const session = await connect(socket, {
      onDelegateCall,
      onFunctionArgumentsDelta,
      onIgnoredEvent,
    });
    socket.sent.length = 0;
    socket.message({
      type: 'response.created',
      event_id: 'created-tool',
      response: { id: 'response-tool', status: 'in_progress' },
    });
    socket.message({
      type: 'response.function_call_arguments.delta',
      event_id: 'args-delta',
      response_id: 'response-tool',
      item_id: 'function-1',
      call_id: 'call-1',
      delta: '{"request":"检查',
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'args-done',
      response_id: 'response-tool',
      item_id: 'function-1',
      call_id: 'call-1',
      name: 'delegate_to_coordinator',
      arguments:
        '{"request":"检查当前页面","recent_transcript":"用户指向这个页面"}',
    });
    expect(onFunctionArgumentsDelta).toHaveBeenCalledWith({
      callEpoch: 7,
      eventId: 'args-delta',
      responseId: 'response-tool',
      itemId: 'function-1',
      callId: 'call-1',
      delta: '{"request":"检查',
    });
    expect(onDelegateCall).toHaveBeenCalledWith({
      callEpoch: 7,
      eventId: 'args-done',
      responseId: 'response-tool',
      itemId: 'function-1',
      callId: 'call-1',
      request: '检查当前页面',
      recentTranscript: '用户指向这个页面',
    });
    expect(onDelegateCall).toHaveBeenCalledTimes(1);
    expect(
      session.submitFunctionCallOutput({
        callEpoch: 6,
        callId: 'call-1',
        output: 'stale',
      }),
    ).toBe(false);
    expect(socket.sent).toHaveLength(0);

    expect(
      session.submitFunctionCallOutput({
        callEpoch: 7,
        callId: 'call-1',
        output: '当前页面是项目概览。',
      }),
    ).toBe(true);
    expect(sentJson(socket, 0)).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '当前页面是项目概览。',
      },
    });
    expect(socket.sent).toHaveLength(1);
    socket.message({
      type: 'response.output_item.done',
      event_id: 'output-item-done',
      response_id: 'response-tool',
      item: {
        id: 'function-1',
        type: 'function_call',
        call_id: 'call-1',
        name: 'delegate_to_coordinator',
        arguments:
          '{"request":"检查当前页面","recent_transcript":"用户指向这个页面"}',
      },
    });
    expect(onDelegateCall).toHaveBeenCalledTimes(1);
    expect(
      session.submitFunctionCallOutput({
        callEpoch: 7,
        callId: 'call-1',
        output: 'duplicate',
      }),
    ).toBe(false);
    socket.message({
      type: 'response.done',
      event_id: 'tool-response-done',
      response: { id: 'response-tool', status: 'completed' },
    });
    expect(sentJson(socket, 1)).toMatchObject({ type: 'response.create' });
    expect(
      session.submitFunctionCallOutput({
        callEpoch: 7,
        callId: 'call-1',
        output: 'duplicate',
      }),
    ).toBe(false);
    expect(onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stale_call' }),
    );
    session.close();
  });

  it('accepts coordinator output after the provider tool response completes', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const session = await connect(socket, { onDelegateCall });
    socket.sent.length = 0;
    socket.message({
      type: 'response.created',
      event_id: 'delayed-tool-created',
      response: { id: 'delayed-tool-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'delayed-tool-call',
      response_id: 'delayed-tool-response',
      call_id: 'delayed-call',
      name: 'delegate_to_coordinator',
      arguments: '{"request":"运行较慢的任务"}',
    });
    socket.message({
      type: 'response.done',
      event_id: 'delayed-tool-done',
      response: { id: 'delayed-tool-response', status: 'completed' },
    });

    expect(onDelegateCall).toHaveBeenCalledOnce();
    expect(
      session.submitFunctionCallOutput({
        callEpoch: 7,
        callId: 'delayed-call',
        output: '慢任务完成。',
      }),
    ).toBe(true);
    expect(sentJson(socket, 0)).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'delayed-call',
        output: '慢任务完成。',
      },
    });
    expect(sentJson(socket, 1)).toMatchObject({ type: 'response.create' });
    session.close();
  });

  it.each([
    [
      'repeated delegation',
      'delegate_to_coordinator',
      '{"request":"检查当前页面"}',
    ],
    ['mixed control', 'start_new_live_conversation', '{}'],
  ])(
    'fails closed when one response requests %s after an approved tool',
    async (_label, secondName, secondArguments) => {
      const socket = new FakeSocket();
      const onDelegateCall = vi.fn();
      const onNewConversationRequest = vi.fn();
      const onError = vi.fn();
      const session = await connect(socket, {
        onDelegateCall,
        onNewConversationRequest,
        onError,
      });
      socket.message({
        type: 'response.created',
        event_id: 'multi-created',
        response: { id: 'multi-response', status: 'in_progress' },
      });
      socket.message({
        type: 'response.function_call_arguments.done',
        event_id: 'first-tool',
        response_id: 'multi-response',
        call_id: 'first-call',
        name: 'delegate_to_coordinator',
        arguments: '{"request":"检查当前页面"}',
      });
      socket.message({
        type: 'response.function_call_arguments.done',
        event_id: 'second-tool',
        response_id: 'multi-response',
        call_id: 'second-call',
        name: secondName,
        arguments: secondArguments,
      });

      expect(onDelegateCall).toHaveBeenCalledOnce();
      expect(onNewConversationRequest).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'multiple_approved_tools' }),
      );
      await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
    },
  );

  it('fails closed when a dispatched call id changes tool content', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onNewConversationRequest = vi.fn();
    const onError = vi.fn();
    const session = await connect(socket, {
      onDelegateCall,
      onNewConversationRequest,
      onError,
    });
    socket.message({
      type: 'response.created',
      event_id: 'changed-call-created',
      response: { id: 'changed-call-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'changed-call-first',
      response_id: 'changed-call-response',
      call_id: 'same-call',
      name: 'delegate_to_coordinator',
      arguments: '{"request":"检查当前页面"}',
    });
    socket.message({
      type: 'response.output_item.done',
      event_id: 'changed-call-second',
      response_id: 'changed-call-response',
      item: {
        type: 'function_call',
        call_id: 'same-call',
        name: 'start_new_live_conversation',
        arguments: '{}',
      },
    });

    expect(onDelegateCall).toHaveBeenCalledOnce();
    expect(onNewConversationRequest).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'multiple_approved_tools' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('dispatches the narrow new-conversation control tool without delegation', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onNewConversationRequest = vi.fn();
    const session = await connect(socket, {
      onDelegateCall,
      onNewConversationRequest,
    });
    socket.message({
      type: 'response.created',
      event_id: 'new-live-created',
      response: { id: 'new-live-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.output_item.done',
      event_id: 'new-live-control',
      response_id: 'new-live-response',
      item: {
        id: 'new-live-item',
        type: 'function_call',
        call_id: 'new-live-call',
        name: 'start_new_live_conversation',
        arguments: '{}',
      },
    });

    expect(onNewConversationRequest).toHaveBeenCalledWith({
      callEpoch: 7,
      eventId: 'new-live-control',
      responseId: 'new-live-response',
      itemId: 'new-live-item',
      callId: 'new-live-call',
    });
    expect(onDelegateCall).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(1);
    session.close();
  });

  it('speaks asynchronous coordinator updates without creating a second delegate call', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);
    socket.sent.length = 0;

    expect(session.sendCoordinatorUpdate('后台任务已经完成。')).toBe(true);
    expect(sentJson(socket, 0)).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[QWEN_CODE_COORDINATOR_UPDATE]\n后台任务已经完成。',
          },
        ],
      },
    });
    expect(sentJson(socket, 1)).toMatchObject({ type: 'response.create' });

    socket.message({
      type: 'response.created',
      event_id: 'update-created',
      response: { id: 'update-response', status: 'in_progress' },
    });
    expect(session.sendCoordinatorUpdate('第二个任务也完成了。')).toBe(true);
    expect(socket.sent).toHaveLength(2);
    socket.message({
      type: 'response.done',
      event_id: 'update-done',
      response: { id: 'update-response', status: 'completed' },
    });
    expect(sentJson(socket, 2)).toMatchObject({
      type: 'conversation.item.create',
      item: {
        content: [
          expect.objectContaining({
            text: expect.stringContaining('第二个任务'),
          }),
        ],
      },
    });
    expect(sentJson(socket, 3)).toMatchObject({ type: 'response.create' });
    expect(() =>
      session.sendCoordinatorUpdate(
        'x'.repeat(QWEN_REALTIME_LIMITS.maxFunctionOutputChars + 1),
      ),
    ).toThrow(RangeError);
    session.close();
  });

  it('suppresses direct VAD output and delegates its attributed transcript once', async () => {
    const socket = new FakeSocket();
    const onOutputTextDelta = vi.fn();
    const onOutputTextDone = vi.fn();
    const onOutputAudioDelta = vi.fn();
    const onOutputAudioDone = vi.fn();
    const onDelegateCall = vi.fn();
    const onError = vi.fn();
    const session = await connect(socket, {
      onOutputTextDelta,
      onOutputTextDone,
      onOutputAudioDelta,
      onOutputAudioDone,
      onDelegateCall,
      onError,
    });
    socket.sent.length = 0;
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'direct-input-committed',
      item_id: 'direct-input',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'direct-input-transcript',
      item_id: 'direct-input',
      transcript: '二加二等于多少？',
    });
    socket.message({
      type: 'response.created',
      event_id: 'direct-created',
      response: { id: 'direct-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.audio_transcript.delta',
      event_id: 'direct-text-delta',
      response_id: 'direct-response',
      delta: '未经协调的回答',
    });
    socket.message({
      type: 'response.audio.delta',
      event_id: 'direct-audio-delta',
      response_id: 'direct-response',
      delta: 'AQI=',
    });
    socket.message({
      type: 'response.audio_transcript.done',
      event_id: 'direct-text-done',
      response_id: 'direct-response',
      transcript: '未经协调的回答。',
    });
    socket.message({
      type: 'response.audio.done',
      event_id: 'direct-audio-done',
      response_id: 'direct-response',
    });

    expect(onOutputTextDelta).not.toHaveBeenCalled();
    expect(onOutputTextDone).not.toHaveBeenCalled();
    expect(onOutputAudioDelta).not.toHaveBeenCalled();
    expect(onOutputAudioDone).not.toHaveBeenCalled();

    socket.message({
      type: 'response.done',
      event_id: 'direct-done',
      response: { id: 'direct-response', status: 'completed' },
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onDelegateCall).toHaveBeenCalledOnce();
    expect(onDelegateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'direct-response',
        itemId: 'direct-input',
        request: '二加二等于多少？',
      }),
    );
    const fallbackCall = onDelegateCall.mock.calls[0]?.[0];
    expect(
      session.submitFunctionCallOutput({
        callEpoch: fallbackCall.callEpoch,
        callId: fallbackCall.callId,
        output: '协调器回答：四。',
      }),
    ).toBe(true);
    expect(sentJson(socket, 0)).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[QWEN_CODE_COORDINATOR_UPDATE]\n协调器回答：四。',
          },
        ],
      },
    });
    expect(sentJson(socket, 1)).toMatchObject({ type: 'response.create' });
    expect(socket.sent).toHaveLength(2);
    socket.message({
      type: 'response.created',
      event_id: 'fallback-spoken-created',
      response: { id: 'fallback-spoken', status: 'in_progress' },
    });
    socket.message({
      type: 'response.audio.delta',
      event_id: 'fallback-spoken-audio',
      response_id: 'fallback-spoken',
      delta: 'AQI=',
    });
    expect(onOutputAudioDelta).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: 'fallback-spoken' }),
    );
    session.close();
  });

  it('delegates a reset transcript without language-classifying it in the adapter', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onNewConversationRequest = vi.fn();
    const session = await connect(socket, {
      onDelegateCall,
      onNewConversationRequest,
    });
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'reset-input-committed',
      item_id: 'reset-input',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'reset-input-transcript',
      item_id: 'reset-input',
      transcript: '开始一个新的 Live 语音对话',
    });
    socket.message({
      type: 'response.created',
      event_id: 'reset-response-created',
      response: { id: 'reset-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'reset-response-done',
      response: { id: 'reset-response', status: 'completed' },
    });

    expect(onNewConversationRequest).not.toHaveBeenCalled();
    expect(onDelegateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'reset-response',
        itemId: 'reset-input',
        callId: expect.stringMatching(/^transcript-fallback:/),
        request: '开始一个新的 Live 语音对话',
      }),
    );
    session.close();
  });

  it('returns false for an empty transcript fallback output instead of throwing', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const session = await connect(socket, { onDelegateCall });
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'empty-input-committed',
      item_id: 'empty-input',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'empty-input-transcript',
      item_id: 'empty-input',
      transcript: 'some request',
    });
    socket.message({
      type: 'response.created',
      event_id: 'empty-response-created',
      response: { id: 'empty-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'empty-response-done',
      response: { id: 'empty-response', status: 'completed' },
    });

    const fallbackCall = onDelegateCall.mock.calls[0]?.[0];
    const sentBefore = socket.sent.length;
    expect(
      session.submitFunctionCallOutput({
        callEpoch: fallbackCall.callEpoch,
        callId: fallbackCall.callId,
        output: '   ',
      }),
    ).toBe(false);
    expect(socket.sent).toHaveLength(sentBefore);
    session.close();
  });

  it('fails closed when direct VAD output has no attributable transcript', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onError = vi.fn();
    const session = await connect(socket, { onDelegateCall, onError });
    socket.message({
      type: 'response.created',
      event_id: 'unattributed-created',
      response: { id: 'unattributed-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'unattributed-done',
      response: { id: 'unattributed-response', status: 'completed' },
    });

    expect(onDelegateCall).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'missing_approved_tool' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('deduplicates transcript fallback by response and input item', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onError = vi.fn();
    const session = await connect(socket, { onDelegateCall, onError });
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'dedupe-input-committed',
      item_id: 'dedupe-input',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'dedupe-input-transcript',
      item_id: 'dedupe-input',
      transcript: '只执行一次',
    });
    socket.message({
      type: 'response.created',
      event_id: 'dedupe-created',
      response: { id: 'dedupe-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'dedupe-done',
      response: { id: 'dedupe-response', status: 'completed' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'dedupe-done-repeated',
      response: { id: 'dedupe-response', status: 'completed' },
    });
    expect(onDelegateCall).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();

    socket.message({
      type: 'response.created',
      event_id: 'same-input-created',
      response: { id: 'same-input-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'same-input-done',
      response: { id: 'same-input-response', status: 'completed' },
    });

    expect(onDelegateCall).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'missing_approved_tool' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('fails closed when an authorized spoken response requests another tool', async () => {
    const socket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const onError = vi.fn();
    const session = await connect(socket, { onDelegateCall, onError });
    expect(session.sendCoordinatorUpdate('后台任务已经完成。')).toBe(true);
    socket.message({
      type: 'response.created',
      event_id: 'trusted-created',
      response: { id: 'trusted-response', status: 'in_progress' },
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'trusted-tool',
      response_id: 'trusted-response',
      call_id: 'trusted-call',
      name: 'delegate_to_coordinator',
      arguments: '{"request":"loop"}',
    });

    expect(onDelegateCall).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unexpected_tool_call' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('ignores duplicate, stale response, and stale input events', async () => {
    const socket = new FakeSocket();
    const onOutputTextDelta = vi.fn();
    const onInputTranscriptDone = vi.fn();
    const onIgnoredEvent = vi.fn();
    const session = await connect(socket, {
      onOutputTextDelta,
      onInputTranscriptDone,
      onIgnoredEvent,
    });
    expect(session.sendCoordinatorUpdate('first authorized response')).toBe(
      true,
    );
    socket.message({
      type: 'response.created',
      event_id: 'r1-created',
      response: { id: 'r1' },
    });
    socket.message({
      type: 'response.done',
      event_id: 'r1-done',
      response: { id: 'r1', status: 'completed' },
    });
    expect(session.sendCoordinatorUpdate('second authorized response')).toBe(
      true,
    );
    socket.message({
      type: 'response.created',
      event_id: 'r2-created',
      response: { id: 'r2' },
    });
    socket.message({
      type: 'response.output_text.delta',
      event_id: 'late-r1',
      response_id: 'r1',
      delta: 'stale',
    });
    socket.message({
      type: 'response.output_text.delta',
      event_id: 'r2-delta',
      response_id: 'r2',
      delta: 'current',
    });
    socket.message({
      type: 'response.output_text.delta',
      event_id: 'r2-delta',
      response_id: 'r2',
      delta: 'duplicate',
    });
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'new-input',
      item_id: 'user-new',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'old-input-done',
      item_id: 'user-old',
      transcript: 'old',
    });

    expect(onOutputTextDelta).toHaveBeenCalledTimes(1);
    expect(onOutputTextDelta).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'current' }),
    );
    expect(onInputTranscriptDone).not.toHaveBeenCalled();
    expect(onIgnoredEvent.mock.calls.map(([event]) => event.reason)).toEqual(
      expect.arrayContaining([
        'stale_response',
        'duplicate_event',
        'stale_input',
      ]),
    );
    session.close();
  });

  it('enforces input, output, argument, and tool-result bounds', async () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    const session = await connect(socket, { onError });
    expect(() => session.pushAudio(new Uint8Array([1]))).toThrow(RangeError);
    expect(() =>
      session.pushAudio(
        new Uint8Array(QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes + 2),
      ),
    ).toThrow(RangeError);
    socket.message({
      type: 'response.created',
      event_id: 'large-created',
      response: { id: 'large-response' },
    });
    socket.message({
      type: 'response.audio.delta',
      event_id: 'large-audio',
      response_id: 'large-response',
      delta: Buffer.alloc(
        QWEN_REALTIME_LIMITS.maxOutputAudioFrameBytes + 2,
      ).toString('base64'),
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_audio_frame' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });

    const toolSocket = new FakeSocket();
    const onDelegateCall = vi.fn();
    const toolSession = await connect(toolSocket, { onDelegateCall });
    toolSocket.message({
      type: 'response.created',
      event_id: 'tool-created',
      response: { id: 'tool-response' },
    });
    toolSocket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'tool-done',
      response_id: 'tool-response',
      call_id: 'large-call',
      name: 'delegate_to_coordinator',
      arguments: '{"request":"ok"}',
    });
    expect(onDelegateCall).toHaveBeenCalledOnce();
    expect(() =>
      toolSession.submitFunctionCallOutput({
        callEpoch: 7,
        callId: 'large-call',
        output: 'x'.repeat(QWEN_REALTIME_LIMITS.maxFunctionOutputChars + 1),
      }),
    ).toThrow(RangeError);
    toolSession.close();

    const argsSocket = new FakeSocket();
    const argsError = vi.fn();
    const argsSession = await connect(argsSocket, { onError: argsError });
    argsSocket.message({
      type: 'response.created',
      event_id: 'args-created',
      response: { id: 'args-response' },
    });
    argsSocket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'large-args',
      response_id: 'args-response',
      call_id: 'args-call',
      name: 'delegate_to_coordinator',
      arguments: 'x'.repeat(QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars + 1),
    });
    expect(argsError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_function_arguments' }),
    );
    await expect(argsSession.closed).resolves.toMatchObject({
      reason: 'error',
    });
  });

  it('reports rate limits, redacts credentials from provider errors, and closes', async () => {
    const socket = new FakeSocket();
    const onRateLimit = vi.fn();
    const onError = vi.fn();
    const opening = openQwenRealtimeSession(
      {
        endpoint: 'https://dashscope.example/v1',
        apiKey: 'secret-key',
        model: 'qwen3.5-omni-plus-realtime',
        callEpoch: 1,
      },
      { onRateLimit, onError },
      { createWebSocket: () => socket },
    );
    socket.message({ type: 'session.updated', event_id: 'ready' });
    const session = await opening;
    socket.message({
      type: 'rate_limits.updated',
      event_id: 'limits',
      rate_limits: [
        {
          name: 'requests',
          limit: 10,
          remaining: 2,
          reset_seconds: 1.5,
        },
      ],
    });
    expect(onRateLimit).toHaveBeenCalledWith({
      callEpoch: 1,
      eventId: 'limits',
      limits: [
        { name: 'requests', limit: 10, remaining: 2, resetSeconds: 1.5 },
      ],
    });

    socket.message({
      type: 'error',
      event_id: 'rate-error',
      error: {
        code: 'rate_limit_exceeded',
        message: '429 secret-key \u001b[8mhidden\u001b[0m',
      },
    });
    expect(onRateLimit).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    const reported = onError.mock.calls[0]?.[0] as Error;
    expect(reported.message).toContain('[REDACTED]');
    expect(reported.message).not.toContain('secret-key');
    expect(reported.message).toContain('\\u001b[8m');
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('distinguishes remote and client closure after the session is ready', async () => {
    const remoteSocket = new FakeSocket();
    const onError = vi.fn();
    const remoteSession = await connect(remoteSocket, { onError });
    remoteSocket.emit('close', 1006, Buffer.from('network'));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'connection_closed' }),
    );
    await expect(remoteSession.closed).resolves.toMatchObject({
      reason: 'remote',
    });

    const clientSocket = new FakeSocket();
    const clientSession = await connect(clientSocket);
    clientSession.close();
    await expect(clientSession.closed).resolves.toEqual({ reason: 'client' });
  });
});
