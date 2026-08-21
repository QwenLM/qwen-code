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
    // Mapped loopback forms are intentionally not loopback-exempt: they stay
    // blocked through the transition-unwrap chain (fail-closed).
    expect(isLoopbackHost('::ffff:7f00:1')).toBe(false)
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
    expect(isPrivateNetworkIp('::a00:1')).toBe(true)
    expect(isPrivateNetworkIp('::a9fe:a9fe')).toBe(true)
    expect(isPrivateNetworkIp('0:0:0:0:0:0:a00:1')).toBe(true)
    expect(isPrivateNetworkIp('0:0:0:0:0:ffff:a00:1')).toBe(true)
    expect(isPrivateNetworkIp('64:ff9b::a00:1')).toBe(true)
    expect(isPrivateNetworkIp('64:ff9b:0:0:0:0:a00:1')).toBe(true)
    expect(isPrivateNetworkIp('0064:ff9b::a00:1')).toBe(true)
    expect(isPrivateNetworkIp('64:ff9b::10.0.0.1')).toBe(true)
    expect(isPrivateNetworkIp('64:ff9b:1::a00:1')).toBe(true)
    expect(isPrivateNetworkIp('64:ff9b:1:1::1')).toBe(true)
    expect(isPrivateNetworkIp('2002:a00:1::1')).toBe(true)
    expect(isPrivateNetworkIp('2002:8000::1')).toBe(true)
    expect(
      isPrivateNetworkIp('2001:0:4136:e378:8000:63bf:3fff:fdd2'),
    ).toBe(true)
    expect(isPrivateNetworkIp('2001:100::1')).toBe(true)
    expect(isPrivateNetworkIp('::5db8')).toBe(true)
    expect(isPrivateNetworkIp('8.8.8.8')).toBe(false)
    expect(isPrivateNetworkIp('::5db8:d822')).toBe(false)
    expect(isPrivateNetworkIp('::ffff:5db8:d822')).toBe(false)
    expect(isPrivateNetworkIp('64:ff9b::5db8:d822')).toBe(false)
    expect(isPrivateNetworkIp('2001:4860::8888')).toBe(false)
    expect(isPrivateNetworkIp('64:ff9b:2::1')).toBe(false)
    expect(isPrivateNetworkIp('2001:200::1')).toBe(false)
    expect(isPrivateNetworkIp('2003::1')).toBe(false)
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
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://10.0.0.1:443', model: 'm' },
        lookup,
      ),
    ).rejects.toThrow(/private-network/)
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://169.254.169.254', model: 'm' },
        lookup,
      ),
    ).rejects.toThrow(/private-network/)
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://[::a9fe:a9fe]', model: 'm' },
        lookup,
      ),
    ).rejects.toThrow(/private-network/)
    expect(called).toBe(false)
  })

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://evil.example', model: 'm' },
        async () => [{ address: '10.1.2.3' }],
      ),
    ).rejects.toThrow(/private-network/)

    for (const address of [
      '0:0:0:0:0:0:a00:8',
      '0:0:0:0:0:0:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '::ffff:a17:2d43',
      '64:ff9b::a00:8',
      '64:ff9b:0:0:0:0:a00:8',
      '0064:ff9b::a00:8',
      '64:ff9b::10.0.0.8',
      '64:ff9b:1::a00:8',
      '64:ff9b:1:1::1',
      '2002:a00:8::1',
      '2002:8000::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2001:100::1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed(
          { baseUrl: 'https://evil.example', model: 'm' },
          async () => [{ address }],
        ),
      ).rejects.toThrow(/private-network/)
    }
  })

  it('rejects loopback DNS results even when trusted, with loopback guidance', async () => {
    for (const address of [
      '127.0.0.1',
      '127.0.0.5',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed(
          {
            baseUrl: 'http://voice.internal.example/v1',
            model: 'm',
            allowInsecureBaseUrl: true,
          },
          async () => [{ address }],
        ),
      ).rejects.toThrow(/loopback/)
    }
  })

  it('allows a hostname that resolves to a public address', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://api.example', model: 'm' },
        async () => [{ address: '93.184.216.34' }],
      ),
    ).resolves.toBeUndefined()
  })

  it('allows an explicitly trusted private address', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed({
        baseUrl: 'http://10.0.0.8/v1',
        model: 'm',
        allowInsecureBaseUrl: true,
      }),
    ).resolves.toBeUndefined()

    await expect(
      assertVoiceBaseUrlNetworkAllowed({
        baseUrl: 'http://[::ffff:10.0.0.8]/v1',
        model: 'm',
        allowInsecureBaseUrl: true,
      }),
    ).resolves.toBeUndefined()

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [{ address: '10.0.0.9' }],
      ),
    ).resolves.toBeUndefined()

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [{ address: '::ffff:a00:9' }],
      ),
    ).resolves.toBeUndefined()

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [{ address: '64:ff9b::a00:9' }],
      ),
    ).resolves.toBeUndefined()
  })

  it('keeps metadata and link-local addresses blocked when trusted', async () => {
    for (const address of [
      '0.0.0.0',
      '169.254.169.254',
      '100.100.100.200',
      '[::6464:64c8]',
      '[::]',
      '[::5db8]',
      '[::ffff:a9fe:a9fe]',
      '[::a9fe:a9fe]',
      '[64:ff9b::a9fe:a9fe]',
      '[64:ff9b::6464:64c8]',
      '[64:ff9b::]',
      '[64:ff9b::1]',
      '[64:ff9b:1::a9fe:a9fe]',
      '[64:ff9b:1:1::1]',
      '[2002:a9fe:a9fe::1]',
      '[2002:8000::1]',
      '[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
      '[2001:100::1]',
      '[fd00:ec2::254]',
      '[fd00:0ec2:0000:0000:0000:0000:0000:0254]',
      '[fe80::1]',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed({
          baseUrl: `http://${address}/v1`,
          model: 'm',
          allowInsecureBaseUrl: true,
        }),
      ).rejects.toThrow(/private-network/)
    }

    // Loopback-range literals outside the three accepted spellings stay
    // blocked but get the spelling remedy instead of the private-network label.
    for (const address of [
      '127.0.0.5',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[64:ff9b::7f00:1]',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed({
          baseUrl: `http://${address}/v1`,
          model: 'm',
          allowInsecureBaseUrl: true,
        }),
      ).rejects.toThrow(
        'uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].',
      )
    }

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [{ address: '169.254.169.254' }],
      ),
    ).rejects.toThrow('resolved to an address that is always blocked')

    for (const address of [
      '0.0.0.0',
      '::',
      'fe80::1',
      'fd00:ec2::254',
      '::5db8',
      '100.100.100.200',
      '::ffff:a9fe:a9fe',
      '::a9fe:a9fe',
      '::6464:64c8',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::6464:64c8',
      '64:ff9b::',
      '64:ff9b::1',
      '64:ff9b:0:0:0:0:a9fe:a9fe',
      '0064:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::a9fe:a9fe',
      '64:ff9b:1:1::1',
      '2002:a9fe:a9fe::1',
      '2002:8000::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2001:100::1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed(
          {
            baseUrl: 'http://voice.internal.example/v1',
            model: 'm',
            allowInsecureBaseUrl: true,
          },
          async () => [{ address }],
        ),
      ).rejects.toThrow('resolved to an address that is always blocked')
    }

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [
          { address: 'fd00:0ec2:0000:0000:0000:0000:0000:0254' },
        ],
      ),
    ).rejects.toThrow('resolved to an address that is always blocked')
  })

  it('skips DNS for IP-literal and loopback hosts', async () => {
    let called = false
    const lookup = async () => {
      called = true
      return [{ address: '0.0.0.0' }]
    }
    for (const baseUrl of [
      'http://localhost:8080/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed({ baseUrl, model: 'm' }, lookup),
      ).resolves.toBeUndefined()
    }
    expect(called).toBe(false)
  })

  it('rejects when the DNS lookup fails (cannot verify network safety)', async () => {
    const lookup = async () => {
      throw new Error('ENOTFOUND voice.example')
    }
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://voice.example', model: 'm' },
        lookup,
      ),
    ).rejects.toThrow(
      "Voice model 'm': DNS lookup failed for voice.example. Cannot verify network safety.",
    )
  })

  it('rejects a multi-record DNS answer when any record is blocked', async () => {
    // defaultLookupHost (dnsLookup with { all: true }) always returns an
    // array; a blocked record hidden among legitimate ones must reject the
    // whole answer even when another record would pass on its own.
    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [{ address: '10.0.0.9' }, { address: '169.254.169.254' }],
      ),
    ).rejects.toThrow('resolved to an address that is always blocked')

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        { baseUrl: 'https://voice.example', model: 'm' },
        async () => [{ address: '93.184.216.34' }, { address: '10.1.2.3' }],
      ),
    ).rejects.toThrow(/private-network/)

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          baseUrl: 'http://voice.internal.example/v1',
          model: 'm',
          allowInsecureBaseUrl: true,
        },
        async () => [{ address: '10.0.0.9' }, { address: '10.0.0.10' }],
      ),
    ).resolves.toBeUndefined()
  })
})
