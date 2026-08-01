import { describe, expect, it } from 'bun:test'
import { encodeWav, VOICE_SAMPLE_RATE } from './wav'
import {
  assertVoiceBaseUrlNetworkAllowed,
  isLoopbackHost,
  isPrivateNetworkIp,
} from './net-guard'
import { isStreamingVoiceModel, resolveVoiceTransport } from './voice-model'
import { isDashscopeCompatible, normalizeBaseUrl } from './resolve-voice-config'
import { openVoiceStream, type SocketLike } from './voice-stream-session'

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

describe('encodeWav', () => {
  it('prepends a 44-byte mono 16 kHz s16le header', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const wav = Buffer.from(encodeWav(pcm))
    expect(wav.byteLength).toBe(44 + pcm.byteLength)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(VOICE_SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength) // data chunk size
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.byteLength) // RIFF chunk size
  })
})

describe('net-guard host classification', () => {
  it('treats loopback hosts as loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackHost('dashscope.aliyuncs.com')).toBe(false)
  })

  it('flags private IPv4/IPv6 ranges but not public IPs', () => {
    expect(isPrivateNetworkIp('10.0.0.1')).toBe(true)
    expect(isPrivateNetworkIp('192.168.1.1')).toBe(true)
    expect(isPrivateNetworkIp('172.16.0.1')).toBe(true)
    expect(isPrivateNetworkIp('169.254.0.1')).toBe(true)
    expect(isPrivateNetworkIp('fd00::1')).toBe(true)
    expect(isPrivateNetworkIp('fe90::1')).toBe(true)
    expect(isPrivateNetworkIp('::192.168.1.1')).toBe(true)
    expect(isPrivateNetworkIp('8.8.8.8')).toBe(false)
    expect(isPrivateNetworkIp('127.0.0.1')).toBe(false) // loopback, not private
  })
})

describe('normalizeBaseUrl', () => {
  it('prepends https:// when no scheme and appends /v1', () => {
    expect(normalizeBaseUrl('dashscope.aliyuncs.com/compatible-mode')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
    expect(normalizeBaseUrl('https://x.example/openai')).toBe(
      'https://x.example/openai/v1',
    )
  })

  it('leaves an existing /v1 and strips trailing slashes', () => {
    expect(
      normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(
      normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/'),
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('preserves an explicit http:// scheme (rejected later by the https guard)', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:1234')).toBe(
      'http://127.0.0.1:1234/v1',
    )
  })
})

describe('isDashscopeCompatible', () => {
  it('matches DashScope compatible-mode endpoints (incl. intl/us)', () => {
    expect(
      isDashscopeCompatible('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    ).toBe(true)
    expect(
      isDashscopeCompatible(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      ),
    ).toBe(true)
  })

  it('rejects non-compatible-mode and unrelated hosts', () => {
    expect(
      isDashscopeCompatible('https://dashscope.aliyuncs.com/apps/anthropic'),
    ).toBe(false)
    expect(
      isDashscopeCompatible('https://idealab.alibaba-inc.com/api/openai/v1'),
    ).toBe(false)
    expect(isDashscopeCompatible('not a url')).toBe(false)
  })
})

describe('voice-model transport classification', () => {
  it('maps model ids to transports', () => {
    expect(resolveVoiceTransport('qwen3-asr-flash')).toBe('qwen-asr-chat')
    expect(resolveVoiceTransport('qwen3-asr-flash-realtime')).toBe(
      'qwen-asr-realtime',
    )
    expect(resolveVoiceTransport('paraformer-realtime-v2')).toBe(
      'dashscope-task-realtime',
    )
    expect(resolveVoiceTransport('fun-asr-realtime')).toBe(
      'dashscope-task-realtime',
    )
    expect(resolveVoiceTransport('qwen3-coder-plus')).toBe('unsupported')
  })

  it('flags realtime models as streaming, batch models as not', () => {
    expect(isStreamingVoiceModel('qwen3-asr-flash')).toBe(false)
    expect(isStreamingVoiceModel('qwen3-asr-flash-realtime')).toBe(true)
    expect(isStreamingVoiceModel('paraformer-realtime-v2')).toBe(true)
  })
})

describe('openVoiceStream', () => {
  it('does not expose stream URLs or task IDs in server failure errors', async () => {
    const socket = new FakeSocket()
    const sessionPromise = openVoiceStream(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'paraformer-realtime-v2',
      },
      {},
      { createWebSocket: () => socket },
    )

    socket.emit('message', JSON.stringify({ header: { event: 'task-started' } }))
    const session = await sessionPromise
    const finishPromise = session.finish()

    socket.emit(
      'message',
      JSON.stringify({
        header: {
          event: 'task-failed',
          error_code: 'InvalidParameter',
          error_message: 'provider rejected audio',
        },
      }),
    )

    await expect(finishPromise).rejects.toThrow(
      'Voice stream failed (InvalidParameter): provider rejected audio',
    )
    await expect(finishPromise).rejects.not.toThrow('wss://')
    await expect(finishPromise).rejects.not.toThrow('/api-ws/v1/inference')
    await expect(finishPromise).rejects.not.toThrow('task ')
  })
})

describe('assertVoiceBaseUrlNetworkAllowed', () => {
  it('rejects private IP-literal hosts without DNS lookup', async () => {
    let called = false
    const lookup = async () => {
      called = true
      return [{ address: '93.184.216.34' }]
    }

    await expect(
      assertVoiceBaseUrlNetworkAllowed('https://10.0.0.1:443', 'm', lookup),
    ).rejects.toThrow(/private-network/)
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        'https://169.254.169.254',
        'm',
        lookup,
      ),
    ).rejects.toThrow(/private-network/)
    expect(called).toBe(false)
  })

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed('https://evil.example', 'm', async () => [
        { address: '10.1.2.3' },
      ]),
    ).rejects.toThrow(/private-network/)

    await expect(
      assertVoiceBaseUrlNetworkAllowed('https://evil.example', 'm', async () => [
        { address: '127.0.0.1' },
      ]),
    ).rejects.toThrow(/private-network/)

    await expect(
      assertVoiceBaseUrlNetworkAllowed('https://evil.example', 'm', async () => [
        { address: '::ffff:127.0.0.1' },
      ]),
    ).rejects.toThrow(/private-network/)
  })

  it('allows a hostname that resolves to a public address', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed('https://api.example', 'm', async () => [
        { address: '93.184.216.34' },
      ]),
    ).resolves.toBeUndefined()
  })

  it('skips DNS for IP-literal and loopback hosts', async () => {
    let called = false
    const lookup = async () => {
      called = true
      return [{ address: '0.0.0.0' }]
    }
    await assertVoiceBaseUrlNetworkAllowed('https://127.0.0.1:8080', 'm', lookup)
    expect(called).toBe(false)
  })

  it('rejects when the DNS lookup fails (cannot verify network safety)', async () => {
    const lookup = async () => {
      throw new Error('ENOTFOUND voice.example')
    }
    await expect(
      assertVoiceBaseUrlNetworkAllowed('https://voice.example', 'm', lookup),
    ).rejects.toThrow(
      "Voice model 'm': DNS lookup failed for voice.example. Cannot verify network safety.",
    )
  })
})
