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

  it('uses an exactly allowlisted private provider from qwen settings', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { PRIVATE_ASR_KEY: 'settings-key' },
              security: { allowedInsecureVoiceBaseUrls: [`${baseUrl}/`] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl,
                    envKey: 'PRIVATE_ASR_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'settings-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('preserves disjoint provider groups across trusted settings scopes', async () => {
    const baseUrl = 'http://voice.user.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      systemDefaultsPath: '/managed/system-defaults.json',
      systemSettingsPath: '/managed/settings.json',
      readSystemJson: async <T,>(file: string) =>
        (file.endsWith('system-defaults.json')
          ? {
              modelProviders: {
                anthropic: [{ id: 'managed-default-model' }],
              },
            }
          : {
              modelProviders: {
                gemini: [{ id: 'managed-system-model' }],
              },
            }) as T,
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { PRIVATE_ASR_KEY: 'user-key' },
              security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl,
                    envKey: 'PRIVATE_ASR_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'user-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('rejects unsupported URL schemes even when exactly allowlisted', async () => {
    const baseUrl = 'ftp://voice.region-a.internal.example/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { PRIVATE_ASR_KEY: 'settings-key' },
                security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl,
                      envKey: 'PRIVATE_ASR_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow(/http or https/)
  })

  it('applies the exact allowlist to an environment-provided endpoint', async () => {
    const baseUrl = 'http://voice.region-b.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? { security: { allowedInsecureVoiceBaseUrls: [baseUrl] } }
          : undefined) as T | undefined,
    })

    expect(config.allowInsecureBaseUrl).toBe(true)
    expect(config.baseUrl).toBe(baseUrl)
  })

  it('does not select a private custom provider without an exact allowlist match', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { PRIVATE_ASR_KEY: 'settings-key' },
                security: {
                  allowedInsecureVoiceBaseUrls: [
                    'http://voice.region-a.internal.example/v1',
                  ],
                },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl:
                        'http://voice.region-b.internal.example/v1',
                      envKey: 'PRIVATE_ASR_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow('security.allowedInsecureVoiceBaseUrls')
  })

  it('reports the missing key for an exact model provider', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl,
                      envKey: 'PRIVATE_ASR_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow("Voice model 'qwen3-asr-flash' requires PRIVATE_ASR_KEY")
  })

  it('reports an exact model provider without a baseUrl', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { PRIVATE_ASR_KEY: 'settings-key' },
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      envKey: 'PRIVATE_ASR_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow(
      "Voice model 'qwen3-asr-flash' does not define a baseUrl",
    )
  })

  it('reports an invalid baseUrl for an exact model provider', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { PRIVATE_ASR_KEY: 'settings-key' },
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl:
                        'http://user:pass@voice.internal.example/v1',
                      envKey: 'PRIVATE_ASR_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow("Voice model 'qwen3-asr-flash' has an invalid baseUrl")
  })

  it('reports an exact model provider without an envKey', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl:
                        'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow(
      "Voice model 'qwen3-asr-flash' does not define an envKey",
    )
  })

  it('merges trusted settings scopes with system override precedence', async () => {
    const defaultUrl = 'http://voice.default.internal.example/v1'
    const userUrl = 'http://voice.user.internal.example/v1'
    const systemUrl = 'http://voice.system.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      systemDefaultsPath: '/managed/system-defaults.json',
      systemSettingsPath: '/managed/settings.json',
      readSystemJson: async <T,>(file: string) =>
        (file.endsWith('system-defaults.json')
          ? {
              env: { DEFAULT_KEY: 'default-key' },
              security: { allowedInsecureVoiceBaseUrls: [defaultUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl: defaultUrl,
                    envKey: 'DEFAULT_KEY',
                  },
                ],
              },
            }
          : {
              env: { SYSTEM_KEY: 'system-key' },
              security: { allowedInsecureVoiceBaseUrls: [systemUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl: systemUrl,
                    envKey: 'SYSTEM_KEY',
                  },
                ],
              },
            }) as T,
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { USER_KEY: 'user-key' },
              security: { allowedInsecureVoiceBaseUrls: [userUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl: userUrl,
                    envKey: 'USER_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: systemUrl,
      apiKey: 'system-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('honors a SystemDefaults allowlist when higher scopes do not override it', async () => {
    const baseUrl = 'http://voice.default.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
      systemDefaultsPath: '/managed/system-defaults.json',
      systemSettingsPath: '/managed/settings.json',
      readSystemJson: async <T,>(file: string) =>
        (file.endsWith('system-defaults.json')
          ? { security: { allowedInsecureVoiceBaseUrls: [baseUrl] } }
          : undefined) as T | undefined,
      readQwenJson: async () => undefined,
    })

    expect(config.allowInsecureBaseUrl).toBe(true)
  })

  it('selects credentials only from the provider matching the voice model', async () => {
    const wrongUrl = 'http://voice.region-a.internal.example/v1'
    const selectedUrl = 'http://voice.region-b.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readSystemJson: async () => undefined,
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { WRONG_KEY: 'wrong-key', SELECTED_KEY: 'selected-key' },
              security: {
                allowedInsecureVoiceBaseUrls: [wrongUrl, selectedUrl],
              },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3.7-plus',
                    baseUrl: wrongUrl,
                    envKey: 'WRONG_KEY',
                  },
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl: selectedUrl,
                    envKey: 'SELECTED_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
    })

    expect(config.baseUrl).toBe(selectedUrl)
    expect(config.apiKey).toBe('selected-key')
  })

  it('rejects duplicate providers for the selected voice model', async () => {
    const firstUrl = 'http://voice.region-a.internal.example/v1'
    const secondUrl = 'http://voice.region-b.internal.example/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readSystemJson: async () => undefined,
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { FIRST_KEY: 'first-key', SECOND_KEY: 'second-key' },
                security: {
                  allowedInsecureVoiceBaseUrls: [firstUrl, secondUrl],
                },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl: firstUrl,
                      envKey: 'FIRST_KEY',
                    },
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl: secondUrl,
                      envKey: 'SECOND_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
      }),
    ).rejects.toThrow("Voice model 'qwen3-asr-flash' is ambiguous")
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
