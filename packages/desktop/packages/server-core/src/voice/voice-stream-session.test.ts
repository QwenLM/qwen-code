import { describe, expect, it, mock } from 'bun:test'
import type { SocketLike } from './voice-stream-session'

const warnCalls: string[] = []
mock.module('../runtime/platform', () => ({
  CONSOLE_LOGGER: {},
  createScopedLogger: () => ({
    debug: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '))
    },
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

  it('counts and logs dropped audio frames under upstream backpressure', async () => {
    warnCalls.length = 0
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

    // Ignore the run-task control frame buffered on open.
    socket.sent.length = 0
    // Upstream socket is backed up past the 1 MiB ceiling: frames must be dropped.
    socket.bufferedAmount = 2 * 1024 * 1024
    stream.pushAudio(new Uint8Array(4096))
    stream.pushAudio(new Uint8Array(4096))

    // Dropped, not forwarded, and surfaced with a cumulative count (not silent).
    expect(socket.sent).toHaveLength(0)
    const dropWarn = warnCalls.find((m) => m.includes('backpressure'))
    expect(dropWarn).toContain('dropping DashScope audio')
    expect(dropWarn).toContain('frame(s)')

    // When the buffer drains, audio flows again and the episode total is reported.
    socket.bufferedAmount = 0
    stream.pushAudio(new Uint8Array(4096))
    expect(socket.sent).toHaveLength(1)
    const recoverWarn = warnCalls.find((m) => m.includes('recovered'))
    expect(recoverWarn).toContain('dropped 2 frame(s)')
    expect(recoverWarn).toContain('8192 bytes')
  })

  it('reports the cumulative dropped total once when a dropping session ends', async () => {
    warnCalls.length = 0
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

    // Force two frames to be dropped under upstream backpressure.
    socket.bufferedAmount = 2 * 1024 * 1024
    stream.pushAudio(new Uint8Array(4096))
    stream.pushAudio(new Uint8Array(4096))

    // End the session normally; the cumulative loss must be surfaced once.
    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
    )
    await finishPromise

    const endReports = warnCalls.filter((m) => m.includes('session ended with'))
    expect(endReports).toHaveLength(1)
    expect(endReports[0]).toContain('2 dropped frame(s)')
    expect(endReports[0]).toContain('8192 bytes total')
  })

  it('reports the cumulative dropped total once when a dropping session fails', async () => {
    warnCalls.length = 0
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

    // Force two frames to be dropped under upstream backpressure.
    socket.bufferedAmount = 2 * 1024 * 1024
    stream.pushAudio(new Uint8Array(4096))
    stream.pushAudio(new Uint8Array(4096))

    // An upstream socket error drives fail() (which sets `settled` before
    // reporting); the cumulative loss must still surface once.
    socket.emit('error', new Error('upstream socket exploded'))

    const endReports = warnCalls.filter((m) => m.includes('session ended with'))
    expect(endReports).toHaveLength(1)
    expect(endReports[0]).toContain('2 dropped frame(s)')
    expect(endReports[0]).toContain('8192 bytes total')
  })

  it('reports the cumulative dropped total once when a dropping session closes', async () => {
    warnCalls.length = 0
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

    // Force two frames to be dropped under upstream backpressure.
    socket.bufferedAmount = 2 * 1024 * 1024
    stream.pushAudio(new Uint8Array(4096))
    stream.pushAudio(new Uint8Array(4096))

    // The socket closes mid-session (no finish()); the close path reports the
    // loss before it sets `settled` (the inverse order of fail()).
    socket.emit('close')

    const endReports = warnCalls.filter((m) => m.includes('session ended with'))
    expect(endReports).toHaveLength(1)
    expect(endReports[0]).toContain('2 dropped frame(s)')
    expect(endReports[0]).toContain('8192 bytes total')
  })

  it('reports the cumulative dropped total exactly once across multiple terminal paths', async () => {
    warnCalls.length = 0
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

    // Force two frames to be dropped under upstream backpressure.
    socket.bufferedAmount = 2 * 1024 * 1024
    stream.pushAudio(new Uint8Array(4096))
    stream.pushAudio(new Uint8Array(4096))

    // Two terminal paths fire: a close, then a late task-finished. task-finished
    // is not short-circuited by `settled`, so the report runs again — only the
    // droppedTotalsReported guard keeps the totals line to a single entry.
    socket.emit('close')
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
    )

    const endReports = warnCalls.filter((m) => m.includes('session ended with'))
    expect(endReports).toHaveLength(1)
    expect(endReports[0]).toContain('2 dropped frame(s)')
    expect(endReports[0]).toContain('8192 bytes total')
  })

  it('does not report a dropped total when no frames were dropped', async () => {
    warnCalls.length = 0
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
    stream.pushAudio(new Uint8Array(4096))

    const finishPromise = stream.finish()
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
    )
    await finishPromise

    expect(warnCalls.some((m) => m.includes('session ended with'))).toBe(false)
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
