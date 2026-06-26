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

  it('redacts credentials from streaming session errors before sending them to the renderer', async () => {
    let onError: ((error: Error) => void) | undefined
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash-realtime',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'leaked-token',
      }),
      openStream: async (_config, callbacks) => {
        onError = callbacks.onError
        return {
          pushAudio: () => {},
          finish: async () => '',
          abort: () => {},
        }
      },
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()

    // Upstream `ws.on('error')` can surface auth URLs / Bearer tokens verbatim;
    // the handler must redact them like the batch path before they reach the UI.
    onError?.(
      new Error(
        'Bearer leaked-token connecting to wss://host/api-ws?apikey=leaked-token',
      ),
    )
    await flush()

    const errors = ws.sentJson().filter((message) => message.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Bearer [REDACTED]')
    expect(errors[0].message).not.toContain('leaked-token')
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

  it('does not count buffered PCM frames toward the control-message cap', async () => {
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      // Never resolves — mimics a slow upstream connect that holds the chain
      // on the first frame while PCM keeps streaming in behind it.
      resolveConfig: async () => {
        await new Promise(() => {})
        return {
          model: 'qwen3-asr-flash',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        }
      },
    })

    handler(ws as never)
    // Far more PCM frames than MAX_PENDING_OPERATIONS (64); their total size
    // stays well under the queued-bytes limit, so only the count cap is at play.
    for (let i = 0; i < 200; i++) {
      ws.emitMessage(Buffer.from([1, 2, 3, 4]), true)
    }
    await flush()

    expect(ws.sentJson()).not.toContainEqual({
      type: 'error',
      message: 'Too many pending voice messages.',
    })
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

  // Streaming frames are forwarded immediately, so the batch 10 MB/~5-min file
  // cap must not cut a stream off before the 6-min hard timer. Two 6 MB frames
  // exceed MAX_AUDIO_BYTES cumulatively while each stays under the queued-bytes
  // limit (drained between flushes).
  it('keeps forwarding streaming audio past the batch byte cap', async () => {
    const pushed: Uint8Array[] = []
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash-realtime',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
      openStream: async () => ({
        pushAudio: (pcm) => pushed.push(pcm),
        finish: async () => 'final transcript',
        abort: () => {},
      }),
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()
    ws.emitMessage(Buffer.alloc(6 * 1024 * 1024), true)
    await flush()
    ws.emitMessage(Buffer.alloc(6 * 1024 * 1024), true)
    await flush()

    expect(pushed).toHaveLength(2)
    expect(ws.sentJson()).not.toContainEqual({
      type: 'error',
      message: 'Recording is too long for transcription (max ~5 minutes).',
    })
  })

  // The batch file cap stays intact: an 11 MB batch frame (over MAX_AUDIO_BYTES
  // but under the 20 MB queued-bytes limit) must be rejected.
  it('still rejects batch audio that exceeds the file byte cap', async () => {
    const ws = new FakeWebSocket()
    const handler = createVoiceConnectionHandler({
      resolveConfig: () => ({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
      transcribeBatch: async () => 'unused',
    })

    handler(ws as never)
    ws.emitMessage(JSON.stringify({ type: 'start' }))
    await flush()
    ws.emitMessage(Buffer.alloc(11 * 1024 * 1024), true)
    await flush()

    expect(ws.sentJson()).toContainEqual({
      type: 'error',
      message: 'Recording is too long for transcription (max ~5 minutes).',
    })
  })
})
