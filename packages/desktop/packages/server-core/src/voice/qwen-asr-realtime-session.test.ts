import { describe, expect, it, mock } from 'bun:test'
import type { SocketLike } from './voice-stream-session'

mock.module('../runtime/platform', () => ({
  CONSOLE_LOGGER: {},
  createScopedLogger: () => ({
    debug: () => {},
    warn: () => {},
  }),
}))

const { deriveQwenRealtimeUrl, openQwenAsrRealtimeStream } = await import(
  './qwen-asr-realtime-session'
)

class FakeSocket implements SocketLike {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  sent: Array<string | Uint8Array> = []
  url = ''
  headers: Record<string, string> = {}
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  send(data: string | Uint8Array) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  on(event: string, cb: (...args: unknown[]) => void) {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(cb)
    this.handlers.set(event, handlers)
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args)
    }
  }
}

describe('openQwenAsrRealtimeStream', () => {
  it('opens a Qwen realtime session and returns committed transcripts', async () => {
    const socket = new FakeSocket()
    const interimTexts: string[] = []
    const streamPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash-realtime',
        apiKey: 'test-key',
      },
      { onInterim: (text) => interimTexts.push(text) },
      {
        createWebSocket: (url, options) => {
          socket.url = url
          socket.headers = options.headers
          return socket
        },
      },
    )

    expect(socket.url).toBe(
      deriveQwenRealtimeUrl(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3-asr-flash-realtime',
      ),
    )
    expect(socket.headers).toEqual({ Authorization: 'Bearer test-key' })

    socket.emit('message', JSON.stringify({ type: 'session.created' }))
    expect(JSON.parse(String(socket.sent.at(-1)))).toMatchObject({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        turn_detection: null,
      },
    })

    socket.emit('message', JSON.stringify({ type: 'session.updated' }))
    const stream = await streamPromise
    stream.pushAudio(new Uint8Array([1, 2, 3]))

    expect(JSON.parse(String(socket.sent.at(-1)))).toMatchObject({
      type: 'input_audio_buffer.append',
      audio: 'AQID',
    })

    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.text',
        text: 'hel',
        stash: 'lo',
      }),
    )
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello',
      }),
    )

    const finishPromise = stream.finish()
    expect(
      socket.sent
        .slice(-2)
        .map((message) => JSON.parse(String(message)).type),
    ).toEqual(['input_audio_buffer.commit', 'session.finish'])

    socket.emit('message', JSON.stringify({ type: 'session.finished' }))

    await expect(finishPromise).resolves.toBe('hello')
    expect(interimTexts).toEqual(['hello', 'hello'])
  })

  it('sanitizes realtime server errors before rejecting', async () => {
    const socket = new FakeSocket()
    const streamPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash-realtime',
      },
      {},
      { createWebSocket: () => socket },
    )

    socket.emit('message', JSON.stringify({ type: 'session.created' }))
    socket.emit('message', JSON.stringify({ type: 'session.updated' }))
    const stream = await streamPromise
    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.failed',
        error: {
          message: '\u001b[31mupstream rejected audio\u001b[0m',
        },
      }),
    )

    await expect(finishPromise).rejects.toThrow('upstream rejected audio')
    await expect(finishPromise).rejects.not.toThrow('\u001b')
  })

  it('redacts credentials from realtime server errors', async () => {
    const socket = new FakeSocket()
    const streamPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash-realtime',
        apiKey: 'sk-secret-token',
      },
      {},
      { createWebSocket: () => socket },
    )

    socket.emit('message', JSON.stringify({ type: 'session.created' }))
    socket.emit('message', JSON.stringify({ type: 'session.updated' }))
    const stream = await streamPromise
    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({
        type: 'error',
        error: {
          code: 'InvalidApiKey',
          message:
            'Authorization Bearer sk-secret-token was rejected for sk-secret-token',
        },
      }),
    )

    await expect(finishPromise).rejects.toThrow('[REDACTED]')
    await expect(finishPromise).rejects.not.toThrow('sk-secret-token')
  })

  it('keeps trailing partial text in the final transcript', async () => {
    const socket = new FakeSocket()
    const streamPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash-realtime',
      },
      {},
      { createWebSocket: () => socket },
    )

    socket.emit('message', JSON.stringify({ type: 'session.created' }))
    socket.emit('message', JSON.stringify({ type: 'session.updated' }))
    const stream = await streamPromise
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.text',
        text: 'hello',
        stash: ' world',
      }),
    )

    const finishPromise = stream.finish()
    socket.emit('message', JSON.stringify({ type: 'session.finished' }))

    await expect(finishPromise).resolves.toBe('hello world')
  })

  it('does not double-fire onError when a close is followed by another terminal event', async () => {
    const socket = new FakeSocket()
    const errors: Error[] = []
    const streamPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash-realtime',
      },
      { onError: (error) => errors.push(error) },
      { createWebSocket: () => socket },
    )

    socket.emit('message', JSON.stringify({ type: 'session.created' }))
    socket.emit('message', JSON.stringify({ type: 'session.updated' }))
    await streamPromise

    // The first close fires onError once; a late error/close must not re-fire it.
    socket.emit('close')
    socket.emit('error', new Error('late error'))
    socket.emit('close')

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('closed unexpectedly')
  })
})
