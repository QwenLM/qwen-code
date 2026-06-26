import { describe, expect, it } from 'bun:test'
import { createVoiceConnectionHandler, toStreamConfig } from './voice-ws-handler'

class FakeWebSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  readonly sent: string[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  send(data: string | Uint8Array) {
    if (typeof data === 'string') this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.readyState = 3
    this.closes.push({ code, reason })
  }

  on(event: string, cb: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  }

  emitMessage(data: string | Uint8Array, isBinary = false) {
    for (const cb of this.handlers.get('message') ?? []) cb(data, isBinary)
  }

  emitClose() {
    for (const cb of this.handlers.get('close') ?? []) cb()
  }

  sentJson() {
    return this.sent.map((message) => JSON.parse(message))
  }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createVoiceConnectionHandler', () => {
  it('passes configured language to streaming transports', () => {
    expect(
      toStreamConfig({
        model: 'qwen3-asr-flash-realtime',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'key',
        language: 'en',
      }),
    ).toEqual({
      model: 'qwen3-asr-flash-realtime',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'key',
      language: 'en',
    })
  })

  it('finalizes batch audio through the injected transcriber', async () => {
    let receivedPcm: Uint8Array | undefined
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
      transcribeBatch: async (_config, pcm) => {
        receivedPcm = pcm
        return 'hello desktop'
      },
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()
    ws.emitMessage(Buffer.from([1, 2, 3, 4]), true)
    await flush()
    ws.emitMessage(JSON.stringify({ type: 'stop' }))
    await flush()

    expect(Buffer.from(receivedPcm ?? [])).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(ws.sentJson()).toContainEqual({
      type: 'ready',
      streaming: false,
      model: 'qwen3-asr-flash',
    })
    expect(ws.sentJson()).toContainEqual({
      type: 'final',
      text: 'hello desktop',
    })
  })

  it('streams realtime audio through the injected session', async () => {
    const pushed: Uint8Array[] = []
    let aborted = false
    let streamLanguage: string | undefined
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash-realtime',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        language: 'en',
      }),
      openStream: async (_config, callbacks) => {
        streamLanguage = _config.language
        callbacks.onInterim?.('partial transcript')
        return {
          pushAudio: (pcm) => pushed.push(pcm),
          finish: async () => 'final transcript',
          abort: () => {
            aborted = true
          },
        }
      },
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()
    ws.emitMessage(Buffer.from([5, 6]), true)
    await flush()
    ws.emitMessage(JSON.stringify({ type: 'stop' }))
    await flush()

    expect(pushed.map((pcm) => Buffer.from(pcm))).toEqual([
      Buffer.from([5, 6]),
    ])
    expect(ws.sentJson()).toContainEqual({
      type: 'ready',
      streaming: true,
      model: 'qwen3-asr-flash-realtime',
    })
    expect(ws.sentJson()).toContainEqual({
      type: 'interim',
      text: 'partial transcript',
    })
    expect(ws.sentJson()).toContainEqual({
      type: 'final',
      text: 'final transcript',
    })
    expect(streamLanguage).toBe('en')
    expect(aborted).toBe(false)
  })

  it('aborts in-flight batch transcription when the socket closes', async () => {
    let signal: AbortSignal | undefined
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
      transcribeBatch: async (_config, _pcm, abortSignal) => {
        signal = abortSignal
        await new Promise(() => {})
        return ''
      },
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()
    ws.emitMessage(Buffer.from([1, 2, 3, 4]), true)
    await flush()
    ws.emitMessage(JSON.stringify({ type: 'stop' }))
    await flush()
    ws.emitClose()

    expect(signal?.aborted).toBe(true)
  })

  it('ignores trailing audio while a streaming session is finalizing', async () => {
    let finish!: () => void
    let aborted = false
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash-realtime',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
      openStream: async () => ({
        pushAudio: () => {},
        finish: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return 'final transcript'
        },
        abort: () => {
          aborted = true
        },
      }),
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()
    ws.emitMessage(JSON.stringify({ type: 'stop' }))
    await flush()
    ws.emitMessage(Buffer.alloc(21 * 1024 * 1024), true)
    await flush()

    expect(aborted).toBe(false)
    expect(ws.closes).not.toContainEqual({
      code: 1011,
      reason: 'voice error',
    })

    finish()
    await flush()
  })

  it('rejects unbounded queued control messages', () => {
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: async () => {
        await new Promise(() => {})
        return {
          model: 'qwen3-asr-flash',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        }
      },
    })

    handler(ws as never)
    for (let i = 0; i < 65; i++) {
      ws.emitMessage(JSON.stringify({ type: 'start' }))
    }

    expect(ws.sentJson()).toContainEqual({
      type: 'error',
      message: 'Too many pending voice messages.',
    })
  })
})
