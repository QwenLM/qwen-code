import { describe, expect, it } from 'bun:test'
import { resolveDesktopVoiceConfig } from './resolve-voice-config'

const future = 4_102_444_800_000

describe('resolveDesktopVoiceConfig', () => {
  it('prefers fresh OAuth credentials over settings and env keys', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      now: () => 1_700_000_000_000,
      env: { DASHSCOPE_API_KEY: 'env-key' },
      readQwenJson: async (file) =>
        file === 'oauth_creds.json'
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
            },
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
      readQwenJson: async (file) =>
        file === 'oauth_creds.json'
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
            },
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
})
