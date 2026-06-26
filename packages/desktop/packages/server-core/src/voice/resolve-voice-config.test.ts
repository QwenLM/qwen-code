import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  getQwenConfigDir,
  normalizeBaseUrl,
  resolveDesktopVoiceConfig,
} from './resolve-voice-config'

const future = 4_102_444_800_000

describe('resolveDesktopVoiceConfig', () => {
  it('prefers fresh OAuth credentials over settings and env keys', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      now: () => 1_700_000_000_000,
      env: { DASHSCOPE_API_KEY: 'env-key' },
      readQwenJson: async <T,>(file: string) =>
        (file === 'oauth_creds.json'
          ? {
              access_token: 'oauth-token',
              resource_url: 'dashscope.aliyuncs.com/compatible-mode',
              expiry_date: future,
            }
          : {
              env: { DASHSCOPE_API_KEY: 'settings-key' },
              modelProviders: {
                dashscope: [
                  {
                    baseUrl:
                      'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    envKey: 'DASHSCOPE_API_KEY',
                  },
                ],
              },
            }) as T | undefined,
    })

    expect(config.apiKey).toBe('oauth-token')
    expect(config.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
  })

  it('skips expired OAuth and falls back to settings before env', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      now: () => 1_700_000_000_000,
      env: { DASHSCOPE_API_KEY: 'env-key' },
      readQwenJson: async <T,>(file: string) =>
        (file === 'oauth_creds.json'
          ? { access_token: 'expired', expiry_date: 1 }
          : {
              env: { DASH_KEY: 'settings-key' },
              modelProviders: {
                dashscope: [
                  {
                    baseUrl:
                      'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    envKey: 'DASH_KEY',
                  },
                ],
              },
            }) as T | undefined,
    })

    expect(config.apiKey).toBe('settings-key')
  })

  it('throws without credentials and rejects cleartext non-loopback endpoints', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')

    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { OPENAI_API_KEY: 'key', OPENAI_BASE_URL: 'http://api.example' },
        readQwenJson: async () => undefined,
      }),
    ).rejects.toThrow('https baseUrl')
  })

  it('does not send OPENAI_API_KEY to the default DashScope endpoint', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { OPENAI_API_KEY: 'openai-key' },
        readQwenJson: async () => undefined,
      }),
    ).rejects.toThrow('Set OPENAI_BASE_URL')

    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://proxy.example.com/openai',
      },
      readQwenJson: async () => undefined,
    })

    expect(config.apiKey).toBe('openai-key')
    expect(config.baseUrl).toBe('https://proxy.example.com/openai/v1')
  })

  it('does not send DASHSCOPE_API_KEY to OPENAI_BASE_URL', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {
        DASHSCOPE_API_KEY: 'dashscope-key',
        OPENAI_BASE_URL: 'https://proxy.example.com/openai',
      },
      readQwenJson: async () => undefined,
    })

    expect(config.apiKey).toBe('dashscope-key')
    expect(config.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
  })

  it('uses DashScope-specific proxy env for DASHSCOPE_API_KEY', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {
        DASHSCOPE_API_KEY: 'dashscope-key',
        DASHSCOPE_PROXY_BASE_URL: 'https://dashscope-proxy.example.com/asr',
      },
      readQwenJson: async () => undefined,
    })

    expect(config.baseUrl).toBe('https://dashscope-proxy.example.com/asr/v1')
  })
})

describe('getQwenConfigDir', () => {
  const original = process.env.QWEN_HOME

  afterEach(() => {
    if (original === undefined) delete process.env.QWEN_HOME
    else process.env.QWEN_HOME = original
  })

  // QWEN_HOME must be normalized the same way core's Storage.getGlobalQwenDir
  // does, so desktop voice reads the same dir the qwen CLI writes to.
  it('expands a leading ~ to the home directory', () => {
    process.env.QWEN_HOME = '~/custom-qwen'
    expect(getQwenConfigDir()).toBe(join(homedir(), 'custom-qwen'))
  })

  it('resolves a relative value to an absolute path', () => {
    process.env.QWEN_HOME = 'relative/config'
    expect(getQwenConfigDir()).toBe(resolve('relative/config'))
  })

  it('falls back to ~/.qwen when QWEN_HOME is empty', () => {
    process.env.QWEN_HOME = ''
    expect(getQwenConfigDir()).toBe(join(homedir(), '.qwen'))
  })

  it('falls back to ~/.qwen when QWEN_HOME is unset', () => {
    delete process.env.QWEN_HOME
    expect(getQwenConfigDir()).toBe(join(homedir(), '.qwen'))
  })

  it('passes an absolute QWEN_HOME through unchanged', () => {
    process.env.QWEN_HOME = '/opt/qwen-home'
    expect(getQwenConfigDir()).toBe('/opt/qwen-home')
  })
})

describe('normalizeBaseUrl', () => {
  it('does not append a second /v1 when proxy paths already contain it', () => {
    expect(normalizeBaseUrl('https://proxy.example.com/v1/dashscope')).toBe(
      'https://proxy.example.com/v1/dashscope',
    )
  })

  // Credentials must never be sent. `real-host@evil.com` already parses with
  // host evil.com, so stripping userinfo would hide that the configured host is
  // attacker-controlled — reject the URL outright instead.
  it('rejects base URLs that embed credentials instead of stripping them', () => {
    expect(() =>
      normalizeBaseUrl('https://dashscope.aliyuncs.com@evil.com/compatible-mode'),
    ).toThrow('must not contain embedded credentials')
    expect(() =>
      normalizeBaseUrl('https://user:pass@proxy.example.com/v1'),
    ).toThrow('must not contain embedded credentials')
  })
})
