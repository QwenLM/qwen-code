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
})
