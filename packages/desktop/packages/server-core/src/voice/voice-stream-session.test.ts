import { describe, expect, it, mock } from 'bun:test'
import type { SocketLike } from './voice-stream-session'

mock.module('../runtime/platform', () => ({
  CONSOLE_LOGGER: {},
  createScopedLogger: () => ({
    debug: () => {},
    warn: () => {},
  }),
}))

const { openVoiceStream } = await import('./voice-stream-session')

class FakeSocket implements SocketLike {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  sent: Array<string | Uint8Array> = []
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

describe('openVoiceStream', () => {
  it('keeps trailing partial text in the final transcript', async () => {
    const socket = new FakeSocket()
    const streamPromise = openVoiceStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'paraformer-realtime-v2',
      },
      {},
      { createWebSocket: () => socket },
    )

    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-started' } }),
    )
    const stream = await streamPromise
    socket.emit(
      'message',
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { text: 'hello world' } } },
      }),
    )

    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
    )

    await expect(finishPromise).resolves.toBe('hello world')
  })

  it('commits sentences on sentence_end and resets the running partial', async () => {
    const socket = new FakeSocket()
    const interims: string[] = []
    const streamPromise = openVoiceStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'paraformer-realtime-v2',
      },
      { onInterim: (text) => interims.push(text) },
      { createWebSocket: () => socket },
    )

    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-started' } }),
    )
    const stream = await streamPromise

    // Interim partial for the first sentence (no sentence_end yet).
    socket.emit(
      'message',
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { text: 'hel' } } },
      }),
    )
    // sentence_end commits the sentence and clears the running partial.
    socket.emit(
      'message',
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { text: 'hello', sentence_end: true } } },
      }),
    )
    // A second committed sentence appends to the running transcript.
    socket.emit(
      'message',
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { text: 'world', sentence_end: true } } },
      }),
    )

    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
    )

    // lastPartial was reset by sentence_end, so the final value comes from the
    // committed transcript ('hel' would leak through if it were not reset).
    await expect(finishPromise).resolves.toBe('hello world')
    expect(interims).toEqual(['hel', 'hello', 'hello world'])
  })

  it('redacts credentials from stream server errors', async () => {
    const socket = new FakeSocket()
    const streamPromise = openVoiceStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'paraformer-realtime-v2',
        apiKey: 'sk-secret-token',
      },
      {},
      { createWebSocket: () => socket },
    )

    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-started' } }),
    )
    const stream = await streamPromise
    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({
        header: {
          event: 'task-failed',
          error_code: 'InvalidApiKey',
          error_message:
            'Authorization Bearer sk-secret-token was rejected for sk-secret-token',
        },
      }),
    )

    await expect(finishPromise).rejects.toThrow('[REDACTED]')
    await expect(finishPromise).rejects.not.toThrow('sk-secret-token')
  })
})
