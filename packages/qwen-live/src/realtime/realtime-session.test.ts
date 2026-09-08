/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { PROACTIVE_SESSION_TOOLS } from '../tools/definitions.js';
import {
  deriveQwenOmniRealtimeUrl,
  openQwenRealtimeSession,
  QWEN_REALTIME_LIMITS,
  REMAIN_SILENT_TOOL_NAME,
  type QwenRealtimeCallbacks,
  type QwenRealtimeDeps,
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
  continuesResponse: true,
  function: {
    name: 'session_list',
    description: 'List the active backend sessions.',
    parameters: { type: 'object', properties: {} },
  },
};

const APPSHOT_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: 'appshot',
    description: 'Capture the selected visual source.',
    parameters: { type: 'object', properties: {} },
  },
};

const CREATE_PROACTIVE_MONITOR_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: 'create_proactive_monitor',
    description: 'Create a condition-based Proactive monitor.',
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

function conversationInputCreated(socket: FakeSocket, itemId: string): void {
  socket.message({
    type: 'conversation.item.created',
    event_id: itemId + '-created',
    item: {
      id: itemId,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_audio' }],
    },
  });
}

function sessionUpdated(socket: FakeSocket, eventId: string): void {
  socket.message({
    type: 'session.updated',
    event_id: eventId,
    session: { id: 'session-1' },
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
  deps: Omit<QwenRealtimeDeps, 'createWebSocket'> = {},
  tools: readonly RealtimeToolDefinition[] = [
    HANDOFF_TOOL,
    LIST_TOOL,
    APPSHOT_TOOL,
    CREATE_PROACTIVE_MONITOR_TOOL,
    REMAIN_SILENT_DEF,
  ],
): Promise<QwenRealtimeSession> {
  const opening = openQwenRealtimeSession(
    {
      endpoint: 'https://dashscope.example/compatible-mode/v1',
      apiKey: 'sk-test',
      model: 'qwen3.5-omni-plus-realtime',
      callEpoch: 7,
      voice: 'Tina',
      instructions: 'test instructions',
      tools,
    },
    callbacks,
    { ...deps, createWebSocket: () => socket },
  );
  socket.message({ type: 'session.created', event_id: 'session-created' });
  sessionUpdated(socket, 'session-updated');
  return opening;
}

describe('realtime-session', () => {
  it.each([
    'qwen3.5-omni-plus-realtime',
    'qwen3.5-omni-flash-realtime',
    'qwen3-omni-flash-realtime',
    'custom-realtime',
  ])(
    'pins documented %s PCM output to 24 kHz without changing VAD or legacy models',
    async (model) => {
      const socket = new FakeSocket();
      const opening = openQwenRealtimeSession(
        {
          endpoint: 'https://dashscope.example/compatible-mode/v1',
          apiKey: 'sk-test',
          model,
          callEpoch: 7,
          instructions: 'test instructions',
          tools: [APPSHOT_TOOL],
        },
        {},
        { createWebSocket: () => socket },
      );
      socket.message({ type: 'session.created', event_id: 'created' });
      sessionUpdated(socket, 'ready');
      const session = await opening;
      try {
        const settings = sentJson(socket, 0)['session'] as Record<
          string,
          unknown
        >;
        if (
          model === 'qwen3.5-omni-plus-realtime' ||
          model === 'qwen3.5-omni-flash-realtime'
        ) {
          expect(settings['audio']).toEqual({
            input: { format: { type: 'pcm', sample_rate: 16000 } },
            output: { format: { type: 'pcm', sample_rate: 24000 } },
          });
          expect(settings).not.toHaveProperty('output_audio_format');
        } else {
          expect(settings).not.toHaveProperty('audio');
          expect(settings).toMatchObject({
            input_audio_format: 'pcm',
            output_audio_format: 'pcm',
          });
        }
        expect(settings['turn_detection']).toEqual({
          type: 'semantic_vad',
          create_response: false,
          interrupt_response: true,
        });
        expect(settings).not.toHaveProperty('sample_rate');
        session.configure({
          instructions: 'updated instructions',
          tools: [APPSHOT_TOOL],
        });
        const updated = sentJson(socket, 1)['session'] as Record<
          string,
          unknown
        >;
        expect(updated).not.toHaveProperty('audio');
        expect(updated).not.toHaveProperty('output_audio_format');
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it('reports safe pre-transition protocol metadata in provider event order', async () => {
    const socket = new FakeSocket();
    const events: Array<Record<string, unknown>> = [];
    const onError = vi.fn();
    const session = await connect(socket, {
      onProtocolDebug: (event) => events.push(event),
      onError,
    });
    expect(events).toEqual([]);
    session.pushAudio(new Uint8Array([1, 0]));
    expect(session.respondToProactiveEvent('private monitor event')).toBe(true);
    responseCreated(socket, 'response-proactive-debug');
    socket.message({
      type: 'response.done',
      event_id: 'cancel-before-vad',
      response: {
        id: 'response-proactive-debug',
        status: 'cancelled',
        status_details: { type: 'cancelled', reason: 'turn_detected' },
      },
    });
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'vad-start-debug',
      item_id: 'input-debug',
      audio_start_ms: 12,
    });
    socket.message({
      type: 'input_audio_buffer.speech_stopped',
      event_id: 'vad-stop-debug',
      item_id: 'input-debug',
      audio_end_ms: 32,
    });
    socket.message({
      type: 'conversation.item.created',
      event_id: 'created-debug',
      item: {
        id: 'input-debug',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'private words' }],
      },
    });
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'committed-debug',
      item_id: 'input-debug',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'asr-debug',
      item_id: 'input-debug',
      transcript: 'private words',
    });
    responseCreated(socket, 'response-direct-debug');
    responseDone(socket, 'response-direct-debug');
    expect(events.map((event) => event['eventId'])).toEqual([
      'response-proactive-debug-created',
      'cancel-before-vad',
      'vad-start-debug',
      'vad-stop-debug',
      'created-debug',
      'committed-debug',
      'asr-debug',
      'response-direct-debug-created',
      'response-direct-debug-done',
    ]);
    expect(events[0]).toMatchObject({
      hasPendingResponseCreate: true,
      hasSentInputAudio: true,
    });
    expect(events[1]).toMatchObject({
      responseStatus: 'cancelled',
      statusType: 'cancelled',
      statusReason: 'turn_detected',
      activeResponseAuthority: 'proactive',
      responseCancelled: false,
      speechInputInProgress: false,
    });
    expect(events[2]).toMatchObject({
      pendingSpeechItems: 0,
      speechInputInProgress: false,
      speechCommitPending: false,
    });
    expect(events[3]).toMatchObject({
      pendingSpeechItems: 1,
      hasPendingSpeechItem: true,
      speechInputInProgress: true,
      speechCommitPending: true,
    });
    expect(events[4]).toMatchObject({
      itemType: 'message',
      role: 'user',
      contentKinds: ['input_audio'],
      pendingSpeechItems: 1,
      committedInputItems: 0,
      hasCommittedInputItem: false,
      speechInputInProgress: false,
    });
    expect(events[5]).toMatchObject({
      pendingSpeechItems: 0,
      committedInputItems: 1,
      hasCommittedInputItem: true,
      speechCommitPending: false,
    });
    expect(events[6]).toMatchObject({
      itemId: 'input-debug',
      committedInputItems: 1,
      completedInputTranscripts: 0,
      hasCommittedInputItem: true,
      hasCompletedInputTranscript: false,
    });
    expect(onError).not.toHaveBeenCalled();
    session.close({ discardPendingInput: true });
  });

  it('distinguishes local cancellation metadata and identifies safely ignored late ASR input', async () => {
    const socket = new FakeSocket();
    const events: Array<Record<string, unknown>> = [];
    const onError = vi.fn();
    const session = await connect(socket, {
      onProtocolDebug: (event) => events.push(event),
      onError,
    });
    commitFinalInput(socket, 'debug-old-input', 'old input');
    responseCreated(socket, 'debug-old-response');
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'new-speech-debug',
      item_id: 'debug-new-input',
    });
    responseDone(socket, 'debug-old-response', 'cancelled');
    expect(events.at(-1)).toMatchObject({
      responseId: 'debug-old-response',
      responseStatus: 'cancelled',
      responseCancelled: true,
      cancellationReason: 'user_interrupted',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'late-old-asr-debug',
      item_id: 'debug-old-input',
      transcript: 'PRIVATE_LATE_ASR',
    });
    expect(events.at(-1)).toMatchObject({
      hasCommittedInputItem: false,
      hasConsumedInputItem: true,
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_LATE_ASR');
    expect(onError).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(socket.OPEN);
    session.close({ discardPendingInput: true });
  });

  it('omits protocol payloads, sensitive fields and unrecognized or oversized diagnostic identifiers', async () => {
    const socket = new FakeSocket();
    const events: Array<Record<string, unknown>> = [];
    const onError = vi.fn();
    const session = await connect(socket, {
      onProtocolDebug: (event) => events.push(event),
      onError,
    });
    const sentinel = 'SENSITIVE_SENTINEL';
    socket.message({
      type: 'conversation.item.created',
      event_id: 'safe-event',
      transcript: sentinel,
      prompt: sentinel,
      audio: sentinel,
      image: sentinel,
      api_key: 'sk-test',
      item: {
        id: 'safe-item',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: sentinel },
          { type: 'input_image', image: sentinel },
          { type: 'input_audio', audio: sentinel },
          { type: sentinel, transcript: sentinel },
        ],
      },
    });
    socket.message({
      type: 'conversation.item.created',
      event_id: `\u001b[31m${sentinel}`,
      item: {
        id: `item-sk-test-${sentinel}`,
        type: sentinel,
        role: sentinel,
        content: [{ type: sentinel, text: sentinel }],
      },
    });
    socket.message({
      type: 'conversation.item.created',
      event_id: 'x'.repeat(QWEN_REALTIME_LIMITS.maxIdentifierChars + 1),
      item: { id: 'y'.repeat(QWEN_REALTIME_LIMITS.maxIdentifierChars + 1) },
    });
    expect(session.respondToProactiveEvent(sentinel)).toBe(true);
    responseCreated(socket, 'safe-response');
    socket.message({
      type: 'response.done',
      event_id: 'safe-done',
      response: {
        id: 'safe-response',
        status: 'cancelled',
        output: [{ text: sentinel, audio: sentinel }],
        status_details: {
          type: sentinel,
          reason: sentinel,
          error: { code: sentinel, message: sentinel, api_key: 'sk-test' },
        },
      },
    });
    socket.message({ type: sentinel, transcript: sentinel });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('sk-test');
    expect(serialized).not.toContain('test instructions');
    expect(serialized).not.toContain('status_details');
    expect(serialized).not.toContain('error');
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({
      eventId: 'safe-event',
      itemId: 'safe-item',
      contentKinds: ['input_text', 'input_image', 'input_audio'],
    });
    expect(events[1]?.['eventId']).toBeUndefined();
    expect(events[1]?.['itemId']).toBeUndefined();
    expect(events[1]?.['role']).toBeUndefined();
    expect(events[1]?.['itemType']).toBeUndefined();
    expect(events[2]?.['eventId']).toBeUndefined();
    expect(events[2]?.['itemId']).toBeUndefined();
    expect(events[4]?.['statusReason']).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    session.close({ discardPendingInput: true });
  });

  it('records orphan final attribution before failure without accepting an uncommitted transcript', async () => {
    const socket = new FakeSocket();
    const events: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    const onError = vi.fn(() => order.push('error'));
    const onInputCommitted = vi.fn();
    const session = await connect(socket, {
      onProtocolDebug: (event) => {
        events.push(event);
        order.push('debug');
      },
      onInputCommitted,
      onError,
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'orphan-debug',
      item_id: 'never-committed-debug',
      transcript: 'PRIVATE_TRANSCRIPT',
    });
    expect(order).toEqual(['debug', 'error']);
    expect(events[0]).toMatchObject({
      itemId: 'never-committed-debug',
      pendingSpeechItems: 0,
      committedInputItems: 0,
      hasPendingSpeechItem: false,
      hasCommittedInputItem: false,
      hasConsumedInputItem: false,
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_TRANSCRIPT');
    expect(onInputCommitted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unattributed_final_transcript' }),
    );
    await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('keeps protocol behavior identical with no debug observer or a throwing observer', async () => {
    const socket = new FakeSocket();
    const throwingSocket = new FakeSocket();
    const onError = vi.fn();
    const throwingError = vi.fn();
    const onProtocolDebug = vi.fn(() => {
      throw new Error('observer failure');
    });
    const session = await connect(socket, { onError });
    const throwingSession = await connect(throwingSocket, {
      onProtocolDebug,
      onError: throwingError,
    });
    for (const current of [socket, throwingSocket]) {
      commitFinalInput(current, 'healthy-debug', 'healthy input');
      responseCreated(current, 'healthy-debug-response');
      responseDone(current, 'healthy-debug-response');
    }
    expect(onProtocolDebug).toHaveBeenCalledTimes(4);
    expect(throwingError).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(socket.OPEN);
    expect(throwingSocket.readyState).toBe(throwingSocket.OPEN);
    const withoutIds = (current: FakeSocket) =>
      current.sent.map((entry) => {
        const { event_id: _eventId, ...message } = sentJsonEntry(entry);
        return message;
      });
    expect(withoutIds(throwingSocket)).toEqual(withoutIds(socket));
    expect(throwingSession.takeTranscriptTail()).toEqual(
      session.takeTranscriptTail(),
    );
    session.close({ discardPendingInput: true });
    throwingSession.close({ discardPendingInput: true });
  });

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
      create_response: false,
      interrupt_response: true,
    });
    // The wire shape carries only {type, function}: local-only behavior
    // flags must be stripped.
    expect(session['tools']).toEqual([
      { type: 'function', function: HANDOFF_TOOL.function },
      { type: 'function', function: LIST_TOOL.function },
      { type: 'function', function: APPSHOT_TOOL.function },
      { type: 'function', function: CREATE_PROACTIVE_MONITOR_TOOL.function },
      { type: 'function', function: REMAIN_SILENT_DEF.function },
    ]);
    for (const tool of session['tools'] as Array<Record<string, unknown>>) {
      expect('capturesTranscript' in tool).toBe(false);
      expect('continuesResponse' in tool).toBe(false);
    }
  });

  it('sends bounded JPEG frames only after the first audio append', async () => {
    const socket = new FakeSocket();
    const callbacks = { onImageDropped: vi.fn() };
    const session = await connect(socket, callbacks);
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

    expect(session.pushImage(image)).toBe(false);
    expect(callbacks.onImageDropped).toHaveBeenCalledWith({
      callEpoch: 7,
      reason: 'audio_not_started',
      bufferedBytes: 0,
    });
    expect(session.pushAudio(new Uint8Array([1, 0]))).toBe(true);
    expect(session.pushImage(image)).toBe(true);

    expect(sentTypes(socket)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_image_buffer.append',
    ]);
    expect(sentJson(socket, 2)).toMatchObject({
      type: 'input_image_buffer.append',
      image,
    });
  });

  it('rejects malformed and oversized image frames', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);
    session.pushAudio(new Uint8Array([1, 0]));

    expect(() => session.pushImage('not-base64')).toThrow(
      'bounded JPEG base64 frame',
    );
    const oversized = Buffer.alloc(QWEN_REALTIME_LIMITS.maxInputImageBytes + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[oversized.length - 2] = 0xff;
    oversized[oversized.length - 1] = 0xd9;
    expect(() => session.pushImage(oversized.toString('base64'))).toThrow(
      'bounded JPEG base64 frame',
    );
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
      responseId: 'response-direct',
      inputItemId: 'input-direct',
      entries: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '你好！' },
      ],
    });
    expect(session.takeTranscriptTail()).toEqual([]);
    expect(sentTypes(socket)).toEqual(['session.update', 'response.create']);
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

  it('dispatches a capturing tool without a redundant receipt continuation', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseCreated: vi.fn(),
    };
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
    expect(sentTypes(socket)).toEqual(['session.update', 'response.create']);

    // ...and flushed right after response.done.
    responseDone(socket, 'response-handoff');
    await Promise.resolve();
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
      'conversation.item.create',
    ]);
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-handoff',
      output: '仓库检查完成。',
    });
  });

  it('returns an on-demand appshot through the normal tool continuation', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-appshot', '看一下当前画面');
    responseCreated(socket, 'response-appshot');
    functionCall(socket, 'response-appshot', 'call-appshot', 'appshot', '{}');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-appshot' },
        '{"status":"ok","source":"camera","asset":"asset_1"}',
      ),
    ).toBe(true);

    responseDone(socket, 'response-appshot');
    await Promise.resolve();

    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-appshot',
      output: '{"status":"ok","source":"camera","asset":"asset_1"}',
    });
    expect(sentTypes(socket)).not.toContain('input_image_buffer.append');
    expect(sentTypes(socket)).not.toContain('input_audio_buffer.commit');
    expect(
      socket.sent
        .map(sentJsonEntry)
        .filter((event) => event['type'] === 'session.update'),
    ).toHaveLength(1);
  });

  it('preserves ordinary tool authority through a direct Appshot continuation', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-appshot-handoff', '看一下画面并继续处理');
    responseCreated(socket, 'response-appshot-handoff');
    functionCall(
      socket,
      'response-appshot-handoff',
      'call-appshot-handoff',
      'appshot',
      '{}',
    );
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-appshot-handoff' },
        '{"status":"ok","asset":"asset_1"}',
      ),
    ).toBe(true);
    responseDone(socket, 'response-appshot-handoff');
    await Promise.resolve();

    responseCreated(socket, 'response-appshot-handoff-receipt');
    callbacks.onFunctionCall.mockClear();
    functionCall(
      socket,
      'response-appshot-handoff-receipt',
      'call-handoff-after-appshot',
      'handoff',
      JSON.stringify({
        task: '看一下画面并继续处理',
        input_refs: ['asset_1'],
      }),
    );

    expect(callbacks.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        responseId: 'response-appshot-handoff-receipt',
        callId: 'call-handoff-after-appshot',
        name: 'handoff',
      }),
    );
  });

  it('rejects ordinary tools from Proactive and backend speech responses', async () => {
    for (const authority of ['proactive', 'backend_speech'] as const) {
      const socket = new FakeSocket();
      const callbacks = { onFunctionCall: vi.fn() };
      const session = await connect(socket, callbacks);
      const accepted =
        authority === 'proactive'
          ? session.respondToProactiveEvent('A monitored event.')
          : session.speakToUser('A backend update.');
      expect(accepted).toBe(true);

      const responseId = `response-${authority}-ordinary-tool`;
      const callId = `call-${authority}-session-list`;
      responseCreated(socket, responseId);
      functionCall(socket, responseId, callId, 'session_list', '{}');
      responseDone(socket, responseId);
      await Promise.resolve();

      expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
      const rejection = socket.sent
        .map(sentJsonEntry)
        .map((entry) => entry['item'] as Record<string, unknown> | undefined)
        .find((item) => item?.['call_id'] === callId);
      expect(JSON.parse(String(rejection?.['output']))).toMatchObject({
        status: 'error',
      });
      expect(
        sentTypes(socket).filter((type) => type === 'response.create'),
      ).toHaveLength(1);
      session.close({ discardPendingInput: true });
    }
  });

  it('rejects ordinary tools from an unsolicited response without microphone input', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    await connect(socket, callbacks);

    responseCreated(socket, 'response-unsolicited-handoff');
    functionCall(
      socket,
      'response-unsolicited-handoff',
      'call-unsolicited-handoff',
      'handoff',
      JSON.stringify({ task: 'must not run' }),
    );
    responseDone(socket, 'response-unsolicited-handoff');
    await Promise.resolve();

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    const rejection = socket.sent
      .map(sentJsonEntry)
      .map((entry) => entry['item'] as Record<string, unknown> | undefined)
      .find((item) => item?.['call_id'] === 'call-unsolicited-handoff');
    expect(JSON.parse(String(rejection?.['output']))).toMatchObject({
      status: 'error',
    });
  });

  it('defers Proactive repair until a delayed Appshot receipt starts its continuation', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-delayed-appshot', '看一下当前画面');
    responseCreated(socket, 'response-delayed-appshot');
    functionCall(
      socket,
      'response-delayed-appshot',
      'call-delayed-appshot',
      'appshot',
      '{}',
    );
    responseDone(socket, 'response-delayed-appshot');

    expect(
      session.requestProactiveRepair('Call one allowed tool only.', [
        'create_proactive_monitor',
      ]),
    ).toBe(false);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);

    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-delayed-appshot' },
        '{"status":"ok","source":"camera","asset":"asset_1"}',
      ),
    ).toBe(true);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
    responseCreated(socket, 'response-delayed-appshot-receipt');
    expect(callbacks.onFunctionCall).toHaveBeenCalledOnce();
  });

  it('rejects Proactive tools from synthetic responses without continuing', async () => {
    for (const authority of ['proactive', 'backend_speech'] as const) {
      const socket = new FakeSocket();
      const callbacks = { onFunctionCall: vi.fn() };
      const session = await connect(socket, callbacks);
      const responseId = `response-${authority}`;
      let requestAccepted: boolean;

      if (authority === 'proactive') {
        requestAccepted = session.respondToProactiveEvent('A monitored event.');
      } else {
        requestAccepted = session.speakToUser('A backend update.');
      }
      expect(requestAccepted).toBe(true);

      responseCreated(socket, responseId);
      callbacks.onFunctionCall.mockClear();
      const responseCreateCount = sentTypes(socket).filter(
        (type) => type === 'response.create',
      ).length;
      const callId = `call-${authority}-proactive-tool`;
      functionCall(
        socket,
        responseId,
        callId,
        'create_proactive_monitor',
        '{}',
      );
      responseDone(socket, responseId);
      await Promise.resolve();

      expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
      const rejection = socket.sent
        .map(sentJsonEntry)
        .map((entry) => entry['item'] as Record<string, unknown> | undefined)
        .find((item) => item?.['call_id'] === callId);
      expect(rejection).toMatchObject({
        type: 'function_call_output',
        call_id: callId,
      });
      expect(JSON.parse(String(rejection?.['output']))).toMatchObject({
        status: 'error',
      });
      expect(
        sentTypes(socket).filter((type) => type === 'response.create'),
      ).toHaveLength(responseCreateCount);
      session.close({ discardPendingInput: true });
    }
  });

  it.each([
    ['list_proactive_tasks', 'cancel_proactive_task', '{"status":"ok"}'],
    ['appshot', 'create_proactive_monitor', '{"status":"ok"}'],
    [
      'create_proactive_monitor',
      'create_proactive_monitor',
      '{"status":"error"}',
    ],
  ])(
    'preserves microphone authority through %s then %s',
    async (first, next, receipt) => {
      const socket = new FakeSocket();
      const callbacks = { onFunctionCall: vi.fn() };
      const session = await connect(socket, callbacks, {}, [
        APPSHOT_TOOL,
        ...PROACTIVE_SESSION_TOOLS,
      ]);
      commitFinalInput(socket, 'input-chain', 'Complete the requested task.');
      responseCreated(socket, 'response-chain-1');
      functionCall(socket, 'response-chain-1', 'call-chain-1', first!, '{}');
      expect(
        session.submitFunctionOutput(
          { callEpoch: 7, callId: 'call-chain-1' },
          receipt!,
        ),
      ).toBe(true);
      responseDone(socket, 'response-chain-1');
      await Promise.resolve();

      responseCreated(socket, 'response-chain-2');
      functionCall(socket, 'response-chain-2', 'call-chain-2', next!, '{}');
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(2);
      expect(callbacks.onFunctionCall).toHaveBeenLastCalledWith(
        expect.objectContaining({
          callId: 'call-chain-2',
          name: next,
          inputItemId: 'input-chain',
        }),
      );
      expect(
        session.submitFunctionOutput(
          { callEpoch: 7, callId: 'call-chain-2' },
          '{"status":"ok"}',
        ),
      ).toBe(true);
      responseDone(socket, 'response-chain-2');
      await Promise.resolve();
      expect(
        sentTypes(socket).filter((type) => type === 'response.create'),
      ).toHaveLength(3);
      session.close({ discardPendingInput: true });
    },
  );

  it('dispatches a Proactive tool from a direct response', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-create-monitor', '帮我盯着构建');
    responseCreated(socket, 'response-create-monitor');
    functionCall(
      socket,
      'response-create-monitor',
      'call-create-monitor',
      'create_proactive_monitor',
      '{}',
    );
    expect(callbacks.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        responseId: 'response-create-monitor',
        callId: 'call-create-monitor',
        name: 'create_proactive_monitor',
      }),
    );

    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-create-monitor' },
        '{"status":"running"}',
      ),
    ).toBe(true);
    responseDone(socket, 'response-create-monitor');
    await Promise.resolve();
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
  });

  it('rejects a Proactive tool from an unsolicited response without microphone input', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    await connect(socket, callbacks);

    responseCreated(socket, 'response-unsolicited');
    functionCall(
      socket,
      'response-unsolicited',
      'call-unsolicited-monitor',
      'create_proactive_monitor',
      '{}',
    );
    responseDone(socket, 'response-unsolicited');
    await Promise.resolve();

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    const rejection = socket.sent
      .map(sentJsonEntry)
      .map((entry) => entry['item'] as Record<string, unknown> | undefined)
      .find((item) => item?.['call_id'] === 'call-unsolicited-monitor');
    expect(rejection).toMatchObject({
      type: 'function_call_output',
      call_id: 'call-unsolicited-monitor',
    });
    expect(JSON.parse(String(rejection?.['output']))).toMatchObject({
      status: 'error',
    });
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(0);
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
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
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
    expect(sentTypes(socket)).toContain('response.create');

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
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-silent',
      output: '',
    });
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
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
    functionCall(
      socket,
      'response-screen',
      'call-unknown',
      'missing_tool',
      '{}',
    );
    responseDone(socket, 'response-screen');
    await Promise.resolve();

    expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-unknown',
      output: JSON.stringify({
        status: 'error',
        note: 'Unknown tool: missing_tool',
      }),
    });
    // The declared call in the same response is still completable.
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-screen' },
        '屏幕已读取。',
      ),
    ).toBe(true);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
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

  it('does not continue a failed tool response', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket, { onFunctionCall: vi.fn() });

    commitFinalInput(socket, 'input-failed', '检查');
    responseCreated(socket, 'response-failed');
    functionCall(
      socket,
      'response-failed',
      'call-failed',
      'session_list',
      '{}',
    );
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-failed' },
        '未完成',
      ),
    ).toBe(true);

    responseDone(socket, 'response-failed', 'failed');
    await Promise.resolve();
    expect(sentTypes(socket)).toEqual(['session.update', 'response.create']);
  });

  it('preserves sanitized provider details for a failed response', async () => {
    const socket = new FakeSocket();
    const callbacks = { onError: vi.fn() } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-provider-failed', '看看这里');
    responseCreated(socket, 'response-provider-failed');
    socket.message({
      type: 'response.done',
      event_id: 'response-provider-failed-done',
      response: {
        id: 'response-provider-failed',
        status: 'failed',
        status_details: {
          error: {
            code: 'invalid_image',
            type: 'invalid_request_error',
            param: 'image',
            status: 400,
            message: 'bad image for sk-test',
          },
        },
      },
    });

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'bad image for [REDACTED]',
        code: 'invalid_image',
        kind: 'configuration',
        status: 400,
        providerType: 'invalid_request_error',
        param: 'image',
        fatal: false,
      }),
    );
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
    expect(callbacks.onDirectTranscript).toHaveBeenCalledExactlyOnceWith({
      callEpoch: 7,
      responseId: 'response-chat',
      inputItemId: 'input-chat',
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
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
    responseDone(socket, 'response-first', 'cancelled');
    await Promise.resolve();
    responseCreated(socket, 'response-second');
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

  it('interrupts a direct response before its first audio frame', async () => {
    const socket = new FakeSocket();
    const callbackOrder: string[] = [];
    const callbacks = {
      onSpeechStarted: vi.fn(() => callbackOrder.push('speech_started')),
      onBargeIn: vi.fn(() => callbackOrder.push('barge_in')),
      onError: vi.fn(),
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(() => callbackOrder.push('response_done')),
    } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    commitFinalInput(socket, 'input-first', '第一个问题');
    responseCreated(socket, 'response-first');
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'second-started-before-audio',
      item_id: 'input-second',
    });
    commitFinalInput(socket, 'input-second', '第二个问题');
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
    responseDone(socket, 'response-first', 'cancelled');
    await Promise.resolve();
    responseCreated(socket, 'response-second');

    expect(callbacks.onBargeIn).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: 'response-first' }),
    );
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-first',
        inputItemId: 'input-first',
        status: 'cancelled',
      }),
    );
    expect(callbackOrder).toEqual([
      'speech_started',
      'barge_in',
      'response_done',
    ]);
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-second',
        inputItemId: 'input-second',
        authority: 'direct',
      }),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('preserves Proactive authority when user speech cancels before response.created', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    expect(
      session.respondToProactiveEvent('A monitored condition changed.'),
    ).toBe(true);
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-before-proactive-created',
      item_id: 'input-user-interrupt',
    });
    responseCreated(socket, 'response-proactive-cancelled');
    responseDone(socket, 'response-proactive-cancelled', 'cancelled');

    expect(callbacks.onResponseCreated).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-proactive-cancelled',
        status: 'cancelled',
        authority: 'proactive',
        cancellationReason: 'user_interrupted',
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
      type: 'response.audio_transcript.delta',
      response_id: 'response-first',
      delta: '第一个回答。',
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
      responseId: 'response-first',
      inputItemId: 'input-first',
      entries: [
        { role: 'user', text: '第一个问题' },
        { role: 'assistant', text: '第一个回答。' },
      ],
    });
    expect(session.takeTranscriptTail()).toEqual([]);
  });

  it('preserves microphone capability across provider-split direct responses', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-split', '帮我盯着构建');
    responseCreated(socket, 'response-split-first');
    // DashScope may start a second response for the same committed turn
    // without another client response.create request.
    responseCreated(socket, 'response-split-second');
    functionCall(
      socket,
      'response-split-second',
      'call-split-monitor',
      'create_proactive_monitor',
      '{}',
    );

    expect(callbacks.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        responseId: 'response-split-second',
        inputItemId: 'input-split',
        callId: 'call-split-monitor',
        name: 'create_proactive_monitor',
      }),
    );
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-split-monitor' },
        '{"status":"running"}',
      ),
    ).toBe(true);
    responseDone(socket, 'response-split-second');
    await Promise.resolve();
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
  });

  it('blocks proactive admission while a split response is replacing the active response', async () => {
    const socket = new FakeSocket();
    const admissions: boolean[] = [];
    const callbacks = {
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn((event) => {
        if (event.responseId === 'response-split-first') {
          admissions.push(
            session.respondToProactiveEvent('A queued monitored event.'),
          );
        }
      }),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-split-admission', '先回答当前问题');
    responseCreated(socket, 'response-split-first');
    responseCreated(socket, 'response-split-second');

    expect(admissions).toEqual([false]);
    expect(sentTypes(socket)).toEqual(['session.update', 'response.create']);

    responseDone(socket, 'response-split-second');
    await Promise.resolve();
    expect(session.respondToProactiveEvent('A queued monitored event.')).toBe(
      true,
    );
    responseCreated(socket, 'response-proactive-after-split');

    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-proactive-after-split',
        authority: 'proactive',
      }),
    );
  });

  it('queues ordinary injected speech behind a provider-split response', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn((event) => {
        if (event.responseId !== 'response-split-first') return;
        expect(session.sendBackendContext('A completed backend update.')).toBe(
          true,
        );
        expect(session.speakToUser('The backend update is ready.')).toBe(true);
      }),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-split-injection', '先回答当前问题');
    responseCreated(socket, 'response-split-first');
    responseCreated(socket, 'response-split-second');

    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
    responseDone(socket, 'response-split-second');
    await Promise.resolve();
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);

    responseCreated(socket, 'response-backend-speech');
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-backend-speech',
        authority: 'backend_speech',
      }),
    );
  });

  it('keeps delegated work alive when its response is interrupted', async () => {
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

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'input-next-started',
      item_id: 'input-next',
    });
    commitFinalInput(socket, 'input-next', '谢谢');
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
    responseDone(socket, 'response-handoff', 'cancelled');
    await Promise.resolve();
    responseCreated(socket, 'response-next');

    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-handoff',
        inputItemId: 'input-handoff',
        status: 'cancelled',
      }),
    );
    expect(callbacks.onDirectTranscript).not.toHaveBeenCalled();
    const responseCreatesBefore = sentTypes(socket).filter(
      (type) => type === 'response.create',
    ).length;
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-handoff' },
        '页面检查完成。',
      ),
    ).toBe(true);
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(responseCreatesBefore);

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
    ).toHaveLength(1);
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[BACKEND] 后台消息一' }],
    });
    expect(sentJson(socket, 3)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[BACKEND] 后台消息二' }],
    });

    responseDone(socket, 'response-active');
    await Promise.resolve();
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
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

  it('responds to a proactive event as raw input_text with proactive authority', async () => {
    const socket = new FakeSocket();
    const callbacks = { onResponseCreated: vi.fn() };
    const session = await connect(socket, callbacks);

    const event = 'The build finished and all checks passed.';
    expect(session.respondToProactiveEvent(event)).toBe(true);
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: event }],
    });
    expect(sentJson(socket, 2)).toMatchObject({
      type: 'response.create',
      response: { modalities: ['text', 'audio'] },
    });

    responseCreated(socket, 'response-proactive');
    expect(callbacks.onResponseCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-proactive',
        authority: 'proactive',
      }),
    );
  });

  it('runs an allowlisted Proactive repair silently before a normal tool continuation', async () => {
    const socket = new FakeSocket();
    const terminalOrder: string[] = [];
    const callbacks = {
      onFunctionCall: vi.fn(() => terminalOrder.push('function_call')),
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(() => terminalOrder.push('response_done')),
      onOutputTextDelta: vi.fn(),
      onOutputTextDone: vi.fn(),
      onOutputAudioDelta: vi.fn(),
      onOutputAudioDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    const instruction =
      'Re-evaluate the preceding turn and call exactly one Proactive mutation tool.';
    expect(
      session.requestProactiveRepair(instruction, ['create_proactive_monitor']),
    ).toBe(true);
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: instruction }],
    });
    expect(sentJson(socket, 2)).toMatchObject({
      type: 'response.create',
      response: { modalities: ['text'] },
    });

    responseCreated(socket, 'response-repair');
    socket.message({
      type: 'response.output_text.delta',
      response_id: 'response-repair',
      delta: 'This must stay private.',
    });
    socket.message({
      type: 'response.output_text.done',
      response_id: 'response-repair',
      text: 'This must stay private.',
    });
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-repair',
      delta: Buffer.from([1, 0]).toString('base64'),
    });
    socket.message({
      type: 'response.output_audio.done',
      response_id: 'response-repair',
    });
    functionCall(
      socket,
      'response-repair',
      'call-repair',
      'create_proactive_monitor',
      JSON.stringify({ title: 'Watch the build' }),
    );

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    expect(callbacks.onOutputTextDelta).not.toHaveBeenCalled();
    expect(callbacks.onOutputTextDone).not.toHaveBeenCalled();
    expect(callbacks.onOutputAudioDelta).not.toHaveBeenCalled();
    expect(callbacks.onOutputAudioDone).not.toHaveBeenCalled();

    responseDone(socket, 'response-repair');
    expect(terminalOrder).toEqual(['function_call', 'response_done']);
    expect(callbacks.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        responseId: 'response-repair',
        callId: 'call-repair',
        name: 'create_proactive_monitor',
        activeTranscript: [],
      }),
    );
    expect(callbacks.onResponseCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-repair',
        authority: 'proactive_repair',
      }),
    );
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-repair',
        authority: 'proactive_repair',
        status: 'completed',
      }),
    );
    expect(session.takeTranscriptTail()).toEqual([]);

    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-repair' },
        JSON.stringify({ status: 'ok' }),
      ),
    ).toBe(true);
    expect(sentJson(socket, 3)['item']).toEqual({
      type: 'function_call_output',
      call_id: 'call-repair',
      output: JSON.stringify({ status: 'ok' }),
    });
    expect(sentJson(socket, 4)).toMatchObject({
      type: 'response.create',
      response: { modalities: ['text', 'audio'] },
    });

    responseCreated(socket, 'response-repair-receipt');
    socket.message({
      type: 'response.output_text.done',
      response_id: 'response-repair-receipt',
      text: 'The monitor is active.',
    });
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-repair-receipt',
      delta: Buffer.from([2, 0]).toString('base64'),
    });
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({ authority: 'tool_continuation' }),
    );
    expect(callbacks.onOutputTextDone).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'The monitor is active.' }),
    );
    expect(callbacks.onOutputAudioDelta).toHaveBeenCalledWith(
      expect.objectContaining({ audio: new Uint8Array([2, 0]) }),
    );
  });

  it('does not grant tool authority to a Proactive repair receipt continuation', async () => {
    const socket = new FakeSocket();
    const callbacks = { onFunctionCall: vi.fn() };
    const session = await connect(socket, callbacks);

    expect(
      session.requestProactiveRepair('Call one allowed tool only.', [
        'create_proactive_monitor',
      ]),
    ).toBe(true);
    responseCreated(socket, 'response-repair-capability');
    functionCall(
      socket,
      'response-repair-capability',
      'call-repair-capability',
      'create_proactive_monitor',
      JSON.stringify({ title: 'Watch the build' }),
    );
    responseDone(socket, 'response-repair-capability');
    expect(callbacks.onFunctionCall).toHaveBeenCalledOnce();
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-repair-capability' },
        JSON.stringify({ status: 'ok' }),
      ),
    ).toBe(true);

    responseCreated(socket, 'response-repair-capability-receipt');
    callbacks.onFunctionCall.mockClear();
    functionCall(
      socket,
      'response-repair-capability-receipt',
      'call-repair-receipt-handoff',
      'handoff',
      JSON.stringify({ task: 'must not run' }),
    );
    responseDone(socket, 'response-repair-capability-receipt');
    await Promise.resolve();

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    const rejection = socket.sent
      .map(sentJsonEntry)
      .map((entry) => entry['item'] as Record<string, unknown> | undefined)
      .find((item) => item?.['call_id'] === 'call-repair-receipt-handoff');
    expect(JSON.parse(String(rejection?.['output']))).toMatchObject({
      status: 'error',
    });
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
  });

  it('rejects unauthorized and additional Proactive repair calls without dispatching them', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    expect(
      session.requestProactiveRepair('Call one allowed tool only.', [
        'create_proactive_monitor',
      ]),
    ).toBe(true);
    responseCreated(socket, 'response-repair-guarded');
    functionCall(
      socket,
      'response-repair-guarded',
      'call-repair-unauthorized',
      'handoff',
      JSON.stringify({ task: 'must not run' }),
    );
    functionCall(
      socket,
      'response-repair-guarded',
      'call-repair-authorized',
      'create_proactive_monitor',
      JSON.stringify({ title: 'first' }),
    );
    functionCall(
      socket,
      'response-repair-guarded',
      'call-repair-extra',
      'create_proactive_monitor',
      JSON.stringify({ title: 'second' }),
    );
    responseDone(socket, 'response-repair-guarded');

    expect(callbacks.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: 'call-repair-authorized' }),
    );
    const repairRejections = socket.sent
      .map(sentJsonEntry)
      .map((entry) => entry['item'] as Record<string, unknown> | undefined)
      .filter(
        (item) =>
          item?.['type'] === 'function_call_output' &&
          item['call_id'] !== 'call-repair-authorized',
      );
    expect(repairRejections).toHaveLength(2);
    expect(repairRejections.map((item) => item?.['call_id'])).toEqual([
      'call-repair-unauthorized',
      'call-repair-extra',
    ]);
    for (const item of repairRejections) {
      const output = String(item?.['output']);
      expect(output.length).toBeLessThanOrEqual(
        QWEN_REALTIME_LIMITS.maxFunctionOutputChars,
      );
      expect(JSON.parse(output)).toMatchObject({ status: 'error' });
    }
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
  });

  it('invalidates an active Proactive repair before any tool side effect on new speech', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    expect(
      session.requestProactiveRepair('Call one allowed tool only.', [
        'create_proactive_monitor',
      ]),
    ).toBe(true);
    responseCreated(socket, 'response-repair-interrupted');
    functionCall(
      socket,
      'response-repair-interrupted',
      'call-repair-interrupted',
      'create_proactive_monitor',
      JSON.stringify({ title: 'stale' }),
    );
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-interrupts-repair',
      item_id: 'input-after-repair',
    });
    responseDone(socket, 'response-repair-interrupted', 'cancelled');

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    expect(
      socket.sent
        .map(sentJsonEntry)
        .filter(
          (entry) =>
            (entry['item'] as Record<string, unknown> | undefined)?.['type'] ===
            'function_call_output',
        ),
    ).toEqual([]);
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: 'proactive_repair',
        status: 'cancelled',
        cancellationReason: 'user_interrupted',
      }),
    );
  });

  it('does not dispatch a Proactive repair tool from a failed response', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onError: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    expect(
      session.requestProactiveRepair('Call one allowed tool only.', [
        'create_proactive_monitor',
      ]),
    ).toBe(true);
    responseCreated(socket, 'response-repair-failed');
    functionCall(
      socket,
      'response-repair-failed',
      'call-repair-failed',
      'create_proactive_monitor',
      JSON.stringify({ title: 'stale' }),
    );
    responseDone(socket, 'response-repair-failed', 'failed');

    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'response_failed', fatal: false }),
    );
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-repair-failed' },
        '{}',
      ),
    ).toBe(false);
  });

  it('cancels a pending Proactive repair before response.created on new speech', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    expect(
      session.requestProactiveRepair('Call one allowed tool only.', [
        'create_proactive_monitor',
      ]),
    ).toBe(true);
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-before-repair-created',
      item_id: 'input-before-repair-created',
    });
    responseCreated(socket, 'response-repair-cancelled');
    functionCall(
      socket,
      'response-repair-cancelled',
      'call-repair-cancelled',
      'create_proactive_monitor',
      JSON.stringify({ title: 'stale' }),
    );
    responseDone(socket, 'response-repair-cancelled', 'cancelled');

    expect(sentTypes(socket)).toContain('response.cancel');
    expect(callbacks.onResponseCreated).not.toHaveBeenCalled();
    expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: 'proactive_repair',
        status: 'cancelled',
        cancellationReason: 'user_interrupted',
      }),
    );
  });

  it('validates Proactive repair instructions and tool allowlists', async () => {
    const socket = new FakeSocket();
    const session = await connect(socket);

    expect(() => session.requestProactiveRepair('', ['appshot'])).toThrow(
      RangeError,
    );
    expect(() => session.requestProactiveRepair('repair', [])).toThrow(
      RangeError,
    );
    expect(() =>
      session.requestProactiveRepair('repair', ['missing_tool']),
    ).toThrow(RangeError);
    expect(sentTypes(socket)).toEqual(['session.update']);
  });

  it('fails an unacknowledged non-direct response.create through a bounded terminal callback', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callbacks = {
        onResponseDone: vi.fn(),
        onError: vi.fn(),
      } satisfies QwenRealtimeCallbacks;
      const session = await connect(socket, callbacks, {
        responseCreatedTimeoutMs: 25,
      });

      expect(session.respondToProactiveEvent('A queued event.')).toBe(true);
      await vi.advanceTimersByTimeAsync(25);

      expect(callbacks.onResponseDone).toHaveBeenCalledWith(
        expect.objectContaining({
          responseId: expect.stringMatching(/^unacknowledged-/),
          authority: 'proactive',
          status: 'failed',
        }),
      );
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'response_created_timeout',
          kind: 'transient',
          fatal: true,
        }),
      );
      await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a non-direct response that never reaches response.done', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callbacks = {
        onResponseDone: vi.fn(),
        onError: vi.fn(),
      } satisfies QwenRealtimeCallbacks;
      const session = await connect(socket, callbacks, {
        responseCreatedTimeoutMs: 100,
        responseDoneTimeoutMs: 25,
      });

      expect(session.respondToProactiveEvent('A queued event.')).toBe(true);
      responseCreated(socket, 'response-proactive-stalled');
      await vi.advanceTimersByTimeAsync(25);

      expect(sentTypes(socket)).toContain('response.cancel');
      expect(callbacks.onResponseDone).toHaveBeenCalledWith(
        expect.objectContaining({
          responseId: 'response-proactive-stalled',
          authority: 'proactive',
          status: 'failed',
        }),
      );
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'response_done_timeout',
          kind: 'transient',
          fatal: true,
        }),
      );
      await expect(session.closed).resolves.toMatchObject({ reason: 'error' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply non-direct response watchdogs to direct speech', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callbacks = {
        onResponseDone: vi.fn(),
        onError: vi.fn(),
      } satisfies QwenRealtimeCallbacks;
      const session = await connect(socket, callbacks, {
        responseCreatedTimeoutMs: 1,
        responseDoneTimeoutMs: 1,
      });

      commitFinalInput(socket, 'input-direct-watchdog', '正常语音');
      responseCreated(socket, 'response-direct-watchdog');
      await vi.advanceTimersByTimeAsync(100);

      expect(callbacks.onResponseDone).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(socket.OPEN);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a proactive response while direct work is active so the caller can retry', async () => {
    const socket = new FakeSocket();
    const callbacks = { onResponseCreated: vi.fn() };
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-foreground', '先回答当前问题');
    responseCreated(socket, 'response-foreground');
    const event = 'A monitored task now needs attention.';
    expect(session.respondToProactiveEvent(event)).toBe(false);

    expect(sentTypes(socket)).toEqual(['session.update', 'response.create']);

    responseDone(socket, 'response-foreground');
    await Promise.resolve();
    expect(session.respondToProactiveEvent(event)).toBe(true);
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: event }],
    });

    responseCreated(socket, 'response-proactive-after-foreground');
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-proactive-after-foreground',
        authority: 'proactive',
      }),
    );
  });

  it('merges queued backend speech when the user starts speaking', async () => {
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
    const mergedItems = socket.sent
      .map(sentJsonEntry)
      .filter((entry) => entry['type'] === 'conversation.item.create')
      .map((entry) => entry['item']);
    expect(mergedItems).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[MERGE_WITH_USER] 旧进度一' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[MERGE_WITH_USER] 旧进度二' }],
      },
    ]);
    responseDone(socket, 'response-active');
    await Promise.resolve();

    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);

    commitFinalInput(socket, 'input-new', '新问题');
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(2);
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
    ).toHaveLength(3);
  });

  it('coalesces backend speech into the direct response for an open user turn', async () => {
    const socket = new FakeSocket();
    const callbacks = { onResponseCreated: vi.fn() };
    const session = await connect(socket, callbacks);

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started-combined',
      item_id: 'input-combined',
    });
    expect(session.speakToUser('之前的新闻搜索完成了。')).toBe(true);
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
    ]);

    commitFinalInput(socket, 'input-combined', '今天天气怎么样？');
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sentJson(socket, 1)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '[MERGE_WITH_USER] 之前的新闻搜索完成了。',
        },
      ],
    });

    responseCreated(socket, 'response-combined');
    expect(callbacks.onResponseCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-combined',
        inputItemId: 'input-combined',
        authority: 'direct',
      }),
    );
  });

  it('replaces an unacknowledged direct request to include a late merge', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started-ack-gap',
      item_id: 'input-ack-gap',
    });
    commitFinalInput(socket, 'input-ack-gap', '今天天气怎么样？');
    expect(session.speakToUser('之前的新闻搜索完成了。')).toBe(true);

    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
      'conversation.item.create',
    ]);
    expect(sentJson(socket, 2)['item']).toEqual({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '[MERGE_WITH_USER] 之前的新闻搜索完成了。',
        },
      ],
    });

    responseCreated(socket, 'response-before-merge');
    await Promise.resolve();
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
      'conversation.item.create',
      'response.cancel',
    ]);

    responseDone(socket, 'response-before-merge', 'cancelled');
    await Promise.resolve();
    expect(sentTypes(socket)).toEqual([
      'session.update',
      'response.create',
      'conversation.item.create',
      'response.cancel',
      'response.create',
    ]);

    responseCreated(socket, 'response-after-merge');
    responseDone(socket, 'response-after-merge');
    expect(callbacks.onResponseCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        responseId: 'response-after-merge',
        inputItemId: 'input-ack-gap',
        authority: 'direct',
      }),
    );
    expect(callbacks.onResponseDone).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseId: 'response-after-merge',
        inputItemId: 'input-ack-gap',
        status: 'completed',
      }),
    );
  });

  it('rejects Proactive admission while a tool continuation is queued', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onFunctionCall: vi.fn(),
      onResponseDone: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    commitFinalInput(socket, 'input-list', '列出会话');
    responseCreated(socket, 'response-list');
    functionCall(socket, 'response-list', 'call-list', 'session_list', '{}');
    expect(
      session.submitFunctionOutput(
        { callEpoch: 7, callId: 'call-list' },
        JSON.stringify({ sessions: [] }),
      ),
    ).toBe(true);
    responseDone(socket, 'response-list');

    expect(session.respondToProactiveEvent('A queued proactive event.')).toBe(
      false,
    );
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-clears-tool-continuation',
      item_id: 'input-next',
    });
    expect(session.respondToProactiveEvent('A queued proactive event.')).toBe(
      false,
    );
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);

    session.close({ discardPendingInput: true });
  });

  it('retires a replaced input when another speech turn supersedes it', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onError: vi.fn(),
      onIgnoredEvent: vi.fn(),
      onResponseCreated: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    const session = await connect(socket, callbacks);

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started-first',
      item_id: 'input-first',
    });
    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'input-first-committed',
      item_id: 'input-first',
    });
    expect(session.speakToUser('之前的新闻搜索完成了。')).toBe(true);

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-started-second',
      item_id: 'input-second',
    });
    responseCreated(socket, 'response-before-second-speech');
    expect(
      sentTypes(socket).filter((type) => type === 'response.create'),
    ).toHaveLength(1);
    expect(sentTypes(socket)).toContain('response.cancel');
    responseDone(socket, 'response-before-second-speech', 'cancelled');
    await Promise.resolve();

    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-first-late-transcript',
      item_id: 'input-first',
      transcript: '已被第二次讲话替代的问题',
    });
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.item.input_audio_transcription.completed',
        reason: 'stale_input',
      }),
    );

    commitFinalInput(socket, 'input-second', '现在只回答这个问题');
    responseCreated(socket, 'response-second');
    responseDone(socket, 'response-second');
    session.close();

    await expect(session.closed).resolves.toEqual({ reason: 'client' });
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponseCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        responseId: 'response-second',
        inputItemId: 'input-second',
        authority: 'direct',
      }),
    );
  });

  it.each([true, false])(
    'reports whether commit still awaits response creation (createdFirst=%s)',
    async (createdFirst) => {
      const socket = new FakeSocket();
      const callbacks = { onInputCommitted: vi.fn() };
      const session = await connect(socket, callbacks);
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-commit-order',
      });
      if (createdFirst) responseCreated(socket, 'response-commit-order');
      commitFinalInput(socket, 'input-commit-order', 'A real user turn.');
      expect(callbacks.onInputCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          itemId: 'input-commit-order',
          responsePending: !createdFirst,
        }),
      );
      if (!createdFirst) responseCreated(socket, 'response-commit-order');
      responseDone(socket, 'response-commit-order');
      expect(session.respondToProactiveEvent('A queued event.')).toBe(true);
      session.close({ discardPendingInput: true });
    },
  );

  it('accepts the provider conversation item as an idempotent input commit', async () => {
    const socket = new FakeSocket();
    const callbacks = {
      onError: vi.fn(),
      onIgnoredEvent: vi.fn(),
      onInputCommitted: vi.fn(),
      onInputTranscriptDone: vi.fn(),
      onResponseCreated: vi.fn(),
    } satisfies QwenRealtimeCallbacks;
    await connect(socket, callbacks);

    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'provider-started',
      item_id: 'input-provider',
    });
    socket.message({
      type: 'input_audio_buffer.speech_stopped',
      event_id: 'provider-stopped',
      item_id: 'input-provider',
    });
    conversationInputCreated(socket, 'input-provider');

    expect(callbacks.onInputCommitted).toHaveBeenCalledOnce();
    expect(sentTypes(socket)).toContain('response.create');

    socket.message({
      type: 'input_audio_buffer.committed',
      event_id: 'provider-late-committed',
      item_id: 'input-provider',
    });
    expect(callbacks.onInputCommitted).toHaveBeenCalledOnce();
    expect(callbacks.onIgnoredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'input_audio_buffer.committed',
        reason: 'duplicate_event',
      }),
    );

    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'provider-transcript',
      item_id: 'input-provider',
      transcript: '真实服务端提交',
    });
    responseCreated(socket, 'response-provider');

    expect(callbacks.onInputTranscriptDone).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'input-provider',
        text: '真实服务端提交',
      }),
    );
    expect(callbacks.onResponseCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'response-provider',
        inputItemId: 'input-provider',
        authority: 'direct',
      }),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
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

  it('does not hide a configuration error behind pending speech loss', async () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    const session = await connect(socket, { onError });
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-before-auth-error',
      item_id: 'input-before-auth-error',
    });

    socket.message({
      type: 'error',
      error: {
        code: 'InvalidApiKey',
        status: 401,
        message: 'API-key sk-test is blocked.',
      },
    });

    await expect(session.closed).resolves.toMatchObject({
      reason: 'error',
      error: {
        code: 'InvalidApiKey',
        kind: 'configuration',
        status: 401,
        message: 'API-key [REDACTED] is blocked.',
      },
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'InvalidApiKey' }),
    );
  });

  it('preserves a bounded provider error from a rejected WebSocket upgrade', async () => {
    const socket = new FakeSocket();
    const opening = openQwenRealtimeSession(
      {
        endpoint: 'https://dashscope.example/compatible-mode/v1',
        apiKey: 'sk-test',
        model: 'qwen3.5-omni-plus-realtime',
        callEpoch: 7,
        instructions: 'test instructions',
        tools: [],
      },
      {},
      { createWebSocket: () => socket },
    );
    const response = Object.assign(new PassThrough(), { statusCode: 401 });
    socket.emit('unexpected-response', {}, response);
    response.end(
      JSON.stringify({
        code: 'InvalidApiKey',
        message: 'API-key sk-test is blocked.',
      }),
    );

    await expect(opening).rejects.toMatchObject({
      message: 'API-key [REDACTED] is blocked.',
      code: 'InvalidApiKey',
      kind: 'configuration',
      status: 401,
      fatal: true,
    });
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
