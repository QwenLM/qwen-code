import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  getQwenConfigDir,
  normalizeBaseUrl,
  parseEnvFileContent,
  resolveDesktopVoiceConfig,
} from './resolve-voice-config'

const future = 4_102_444_800_000

describe('resolveDesktopVoiceConfig', () => {
  it('keeps OAuth credentials ahead of a public HTTPS exact model provider', async () => {
    // A public HTTPS entry needs no allowlist decision, so it must not preempt
    // OAuth credentials — the pre-allowlist credential precedence is kept.
    const baseUrl = 'https://voice.example.com/openai/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      now: () => 1_700_000_000_000,
      env: {},
      readQwenJson: async <T,>(file: string) => {
        if (file === 'oauth_creds.json') {
          return {
            access_token: 'oauth-token',
            resource_url: 'dashscope.aliyuncs.com/compatible-mode',
            expiry_date: future,
          } as T
        }
        if (file === 'settings.json') {
          return {
            env: { CUSTOM_ASR_KEY: 'provider-key' },
            modelProviders: {
              openai: [
                {
                  id: 'qwen3-asr-flash',
                  baseUrl,
                  envKey: 'CUSTOM_ASR_KEY',
                },
              ],
            },
          } as T
        }
        return undefined
      },
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'oauth-token',
    })
  })

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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.apiKey).toBe('settings-key')
  })

  it('throws without credentials and rejects cleartext non-loopback endpoints', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async () => undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')

    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { OPENAI_API_KEY: 'key', OPENAI_BASE_URL: 'http://api.example' },
        readQwenJson: async () => undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('https baseUrl')
  })

  it('does not send OPENAI_API_KEY to the default DashScope endpoint', async () => {
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { OPENAI_API_KEY: 'openai-key' },
        readQwenJson: async () => undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Set OPENAI_BASE_URL')

    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://proxy.example.com/openai',
      },
      readQwenJson: async () => undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.baseUrl).toBe('https://dashscope-proxy.example.com/asr/v1')
  })

  it('falls through and warns when an exact model provider baseUrl is incomplete', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        resolveDesktopVoiceConfig({
          getVoiceModel: () => 'qwen3-asr-flash',
          env: {},
          readQwenJson: async <T,>(file: string) =>
            (file === 'settings.json'
              ? {
                  env: { DASHSCOPE_API_KEY: 'settings-key' },
                  modelProviders: {
                    openai: [
                      {
                        id: 'qwen3-asr-flash',
                        baseUrl: 'dashscope.aliyuncs.com/compatible-mode/v1',
                        envKey: 'DASHSCOPE_API_KEY',
                      },
                    ],
                  },
                }
              : undefined) as T | undefined,
          readSystemJson: async () => undefined,
          readHomeEnvFile: async () => undefined,
        }),
      ).rejects.toThrow('Voice dictation needs Qwen credentials')
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('not a valid URL')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not infer missing path segments for an exact model provider', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/compatible-mode'
    const config = await resolveDesktopVoiceConfig({
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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.baseUrl).toBe(baseUrl)
  })

  it('preserves /v1 inference for a DashScope provider through the legacy fallback', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { DASHSCOPE_API_KEY: 'settings-key' },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl:
                      'https://dashscope.aliyuncs.com/compatible-mode',
                    envKey: 'DASHSCOPE_API_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'settings-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('requires allowlist entries to include an explicit scheme and full path', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'

    for (const allowedBaseUrl of [
      'voice.region-a.internal.example/v1',
      'http://voice.region-a.internal.example',
    ]) {
      await expect(
        resolveDesktopVoiceConfig({
          getVoiceModel: () => 'qwen3-asr-flash',
          env: {},
          readQwenJson: async <T,>(file: string) =>
            (file === 'settings.json'
              ? {
                  env: { PRIVATE_ASR_KEY: 'settings-key' },
                  security: {
                    allowedInsecureVoiceBaseUrls: [allowedBaseUrl],
                  },
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
          readSystemJson: async () => undefined,
          readHomeEnvFile: async () => undefined,
        }),
      ).rejects.toThrow('security.allowedInsecureVoiceBaseUrls')
    }
  })

  it('defers an unlisted public HTTPS exact provider to the legacy chain', async () => {
    const baseUrl = 'https://voice.example.com/openai/v1'
    const settingsWithEntry = (allowlisted: boolean) => ({
      env: { CUSTOM_ASR_KEY: 'settings-key' },
      security: allowlisted
        ? { allowedInsecureVoiceBaseUrls: [baseUrl] }
        : undefined,
      modelProviders: {
        openai: [
          {
            id: 'qwen3-asr-flash',
            baseUrl,
            envKey: 'CUSTOM_ASR_KEY',
          },
        ],
      },
    })
    const readSettings = (allowlisted: boolean) =>
      (async <T,>(file: string) =>
        (file === 'settings.json'
          ? settingsWithEntry(allowlisted)
          : undefined) as T | undefined)

    // Without OAuth the legacy chain finds nothing: an unlisted public entry
    // needs no allowlist decision, so it neither resolves nor fails on its
    // own.
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: readSettings(false),
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')

    // An explicit allowlist entry makes even a public HTTPS entry
    // authoritative, matching the CLI where the configured model always wins.
    const allowlisted = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: readSettings(true),
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(allowlisted).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'settings-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('deep-merges modelProviders across scopes like the CLI', async () => {
    const baseUrl = 'http://voice.user.internal.example/v1'
    // The CLI's customDeepMerge has no REPLACE branch: disjoint provider-group
    // keys from every scope survive, so managed System/SystemDefaults providers
    // must not discard the user's voice entry.
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
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'user-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('lets a higher scope replace the same provider-group key like the CLI merge', async () => {
    const baseUrl = 'http://voice.user.internal.example/v1'
    // Same group key: the higher scope's array wins (CLI deep-merge semantics),
    // so the managed System entry displaces the user's voice entry.
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        systemDefaultsPath: '/managed/system-defaults.json',
        systemSettingsPath: '/managed/settings.json',
        readSystemJson: async <T,>(file: string) =>
          (file.endsWith('settings.json')
            ? {
                modelProviders: {
                  openai: [{ id: 'managed-system-model' }],
                },
              }
            : undefined) as T | undefined,
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
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')
  })

  it('skips prototype-pollution keys when merging trusted settings like the CLI', async () => {
    // customDeepMerge drops __proto__/constructor/prototype keys at every
    // level; the desktop merge must too so one settings file resolves
    // identically on both surfaces (object spread keeps those own JSON keys).
    const settings = JSON.parse(
      '{"env":{"VOICE_KEY":"settings-key"},' +
        '"security":{"allowedInsecureVoiceBaseUrls":["http://voice.region-a.internal.example/v1"]},' +
        '"modelProviders":{' +
        '"__proto__":[{"id":"qwen3-asr-flash","baseUrl":"http://voice.region-a.internal.example/v1","envKey":"VOICE_KEY"}],' +
        '"constructor":[{"id":"qwen3-asr-flash","baseUrl":"http://voice.region-a.internal.example/v1","envKey":"VOICE_KEY"}]}}',
    )
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json' ? settings : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')
  })

  it('lets a System-scope empty allowlist revoke a User-scope entry', async () => {
    const baseUrl = 'http://voice.user.internal.example/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        systemDefaultsPath: '/managed/system-defaults.json',
        systemSettingsPath: '/managed/settings.json',
        readSystemJson: async <T,>(file: string) =>
          (file.endsWith('settings.json')
            ? { security: { allowedInsecureVoiceBaseUrls: [] } }
            : undefined) as T | undefined,
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
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('security.allowedInsecureVoiceBaseUrls')
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
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
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.allowInsecureBaseUrl).toBe(true)
    expect(config.baseUrl).toBe(baseUrl)
  })

  it('reports the complete normalized URL including query and fragment', async () => {
    const configuredBaseUrl = 'http://10.0.0.8?api-version=2#voice'
    const normalizedBaseUrl =
      'http://10.0.0.8/v1?api-version=2#voice'
    const readQwenJson = async <T,>(file: string) =>
      (file === 'settings.json'
        ? {
            security: {
              allowedInsecureVoiceBaseUrls: [configuredBaseUrl],
            },
          }
        : undefined) as T | undefined

    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {
          OPENAI_API_KEY: 'env-key',
          OPENAI_BASE_URL: configuredBaseUrl,
        },
        readQwenJson,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(normalizedBaseUrl)

    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {
        OPENAI_API_KEY: 'env-key',
        OPENAI_BASE_URL: configuredBaseUrl,
      },
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              security: {
                allowedInsecureVoiceBaseUrls: [normalizedBaseUrl],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toMatchObject({
      baseUrl: normalizedBaseUrl,
      allowInsecureBaseUrl: true,
    })
  })

  it('rejects cleartext custom providers without an exact allowlist match', async () => {
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('security.allowedInsecureVoiceBaseUrls')
  })

  it('rejects always-blocked base URLs at config time even when allowlisted', async () => {
    for (const baseUrl of [
      'http://169.254.169.254/v1',
      'https://169.254.169.254/v1',
      'http://[fe80::1]/v1',
      'http://0.0.0.0/v1',
    ]) {
      for (const allowlisted of [false, true]) {
        await expect(
          resolveDesktopVoiceConfig({
            getVoiceModel: () => 'qwen3-asr-flash',
            env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
            readQwenJson: async <T,>(file: string) =>
              (file === 'settings.json' && allowlisted
                ? { security: { allowedInsecureVoiceBaseUrls: [baseUrl] } }
                : undefined) as T | undefined,
            readSystemJson: async () => undefined,
            readHomeEnvFile: async () => undefined,
          }),
        ).rejects.toThrow(
          'Voice endpoint must not use a private-network baseUrl.',
        )
      }
    }
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      /Voice model 'qwen3-asr-flash' requires PRIVATE_ASR_KEY\. Remove or complete this provider entry/,
    )
  })

  it('falls through when an exact model provider has no baseUrl', async () => {
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')
  })

  it('reports embedded credentials in an exact model provider baseUrl', async () => {
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      "Voice model 'qwen3-asr-flash' baseUrl must not contain embedded credentials",
    )
  })

  it('resolves a keyless exact provider like the CLI', async () => {
    // CLI parity: an entry without envKey resolves without an API key (a
    // keyless local gateway) instead of failing.
    const baseUrl = 'http://localhost:8000/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl,
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
    })
  })

  it('falls through when a public exact provider defines no envKey', async () => {
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')
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
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: systemUrl,
      apiKey: 'system-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('applies scope precedence when the same env key appears in multiple scopes', async () => {
    const baseUrl = 'http://voice.user.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      systemDefaultsPath: '/managed/system-defaults.json',
      systemSettingsPath: '/managed/settings.json',
      readSystemJson: async <T,>(file: string) =>
        (file.endsWith('settings.json')
          ? { env: { SHARED_KEY: 'system-value' } }
          : undefined) as T | undefined,
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { SHARED_KEY: 'user-value' },
              security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl,
                    envKey: 'SHARED_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.apiKey).toBe('system-value')
    expect(config.baseUrl).toBe(baseUrl)
  })

  it('rejects unallowlisted private-network HTTPS endpoints at config time', async () => {
    const baseUrl = 'https://10.0.0.8/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
        readQwenJson: async () => undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      `Voice endpoint must not use a private-network baseUrl. To trust this managed endpoint, add its exact complete normalized URL (${baseUrl}) to security.allowedInsecureVoiceBaseUrls.`,
    )

    const allowlisted = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? { security: { allowedInsecureVoiceBaseUrls: [baseUrl] } }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(allowlisted).toMatchObject({
      baseUrl,
      allowInsecureBaseUrl: true,
    })
  })

  it('derives System and SystemDefaults paths for every supported platform', async () => {
    const cases: Array<{
      currentPlatform: NodeJS.Platform
      expectedPaths: string[]
    }> = [
      {
        currentPlatform: 'darwin',
        expectedPaths: [
          '/Library/Application Support/QwenCode/system-defaults.json',
          '/Library/Application Support/QwenCode/settings.json',
        ],
      },
      {
        currentPlatform: 'win32',
        expectedPaths: [
          'C:\\ProgramData\\qwen-code\\system-defaults.json',
          'C:\\ProgramData\\qwen-code\\settings.json',
        ],
      },
      {
        currentPlatform: 'linux',
        expectedPaths: [
          '/etc/qwen-code/system-defaults.json',
          '/etc/qwen-code/settings.json',
        ],
      },
    ]

    for (const { currentPlatform, expectedPaths } of cases) {
      const readPaths = new Set<string>()
      await resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        platform: currentPlatform,
        env: {
          OPENAI_API_KEY: 'env-key',
          OPENAI_BASE_URL: 'https://voice.example.com/v1',
        },
        readQwenJson: async () => undefined,
        readSystemJson: async <T,>(file: string) => {
          readPaths.add(file)
          return undefined as T | undefined
        },
        readHomeEnvFile: async () => undefined,
      })

      expect(readPaths).toEqual(new Set(expectedPaths))
    }
  })

  it('honors explicit System and SystemDefaults path overrides', async () => {
    const readPaths = new Set<string>()
    await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      platform: 'win32',
      env: {
        OPENAI_API_KEY: 'env-key',
        OPENAI_BASE_URL: 'https://voice.example.com/v1',
        QWEN_CODE_SYSTEM_SETTINGS_PATH: '/managed/settings.json',
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/managed/defaults.json',
      },
      readQwenJson: async () => undefined,
      readSystemJson: async <T,>(file: string) => {
        readPaths.add(file)
        return undefined as T | undefined
      },
      readHomeEnvFile: async () => undefined,
    })

    expect(readPaths).toEqual(
      new Set(['/managed/defaults.json', '/managed/settings.json']),
    )
  })

  it('parses JSONC and resolves env placeholders in managed settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-voice-settings-'))
    const systemSettingsPath = join(root, 'settings.json')
    const systemDefaultsPath = join(root, 'system-defaults.json')
    const originalQwenHome = process.env.QWEN_HOME
    process.env.QWEN_HOME = join(root, 'qwen-home')

    try {
      await writeFile(
        systemSettingsPath,
        `{
          // Managed settings use the same JSONC syntax as the CLI.
          "env": { "PRIVATE_ASR_KEY": "\${INJECTED_KEY}" },
          "modelProviders": {
            "openai": [{
              "id": "qwen3-asr-flash",
              "baseUrl": "\${INJECTED_URL}",
              "envKey": "PRIVATE_ASR_KEY"
            }]
          },
          "security": {
            "allowedInsecureVoiceBaseUrls": ["$INJECTED_URL"]
          }
        }`,
      )

      const config = await resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        systemSettingsPath,
        systemDefaultsPath,
        env: {
          INJECTED_KEY: 'settings-key',
          INJECTED_URL: 'http://voice.managed.internal.example/v1',
        },
      })

      expect(config).toEqual({
        model: 'qwen3-asr-flash',
        baseUrl: 'http://voice.managed.internal.example/v1',
        apiKey: 'settings-key',
        allowInsecureBaseUrl: true,
      })
    } finally {
      if (originalQwenHome === undefined) delete process.env.QWEN_HOME
      else process.env.QWEN_HOME = originalQwenHome
      await rm(root, { recursive: true, force: true })
    }
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
      readHomeEnvFile: async () => undefined,
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
      readHomeEnvFile: async () => undefined,
    })

    expect(config.baseUrl).toBe(selectedUrl)
    expect(config.apiKey).toBe('selected-key')
  })

  it('matches allowlist paths case-sensitively', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
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
                    'http://voice.region-a.internal.example/V1',
                  ],
                },
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
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('security.allowedInsecureVoiceBaseUrls')
  })

  it('reads only user and managed system settings, never workspace settings', async () => {
    const qwenFiles = new Set<string>()
    const systemFiles = new Set<string>()
    await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      platform: 'linux',
      env: {
        OPENAI_API_KEY: 'env-key',
        OPENAI_BASE_URL: 'https://voice.example.com/v1',
      },
      readQwenJson: async <T,>(file: string) => {
        qwenFiles.add(file)
        return undefined as T | undefined
      },
      readSystemJson: async <T,>(file: string) => {
        systemFiles.add(file)
        return undefined as T | undefined
      },
      readHomeEnvFile: async () => undefined,
    })

    expect(qwenFiles).toEqual(new Set(['oauth_creds.json', 'settings.json']))
    expect(systemFiles).toEqual(
      new Set([
        '/etc/qwen-code/system-defaults.json',
        '/etc/qwen-code/settings.json',
      ]),
    )
  })

  it('resolves settings placeholders and provider keys from the home .env fallback', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    const envFileContent =
      'VOICE_GW=http://voice.region-a.internal.example\nVOICE_KEY=home-env-key\n'
    const readHomeEnvFile = async (file: string) =>
      file === join(getQwenConfigDir(), '.env') ? envFileContent : undefined

    const config = await resolveDesktopVoiceConfig({
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
                    baseUrl: '$VOICE_GW/v1',
                    envKey: 'VOICE_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'home-env-key',
      allowInsecureBaseUrl: true,
    })

    // The process env takes precedence over the home .env for the same key.
    const overridden = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: { VOICE_KEY: 'process-key' },
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl: '$VOICE_GW/v1',
                    envKey: 'VOICE_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile,
    })

    expect(overridden.apiKey).toBe('process-key')
  })

  it('fills empty process env values from the home .env fallback like the CLI', async () => {
    const readHomeEnvFile = async (file: string) =>
      file === join(getQwenConfigDir(), '.env')
        ? 'DASHSCOPE_API_KEY=home-key\n'
        : undefined
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: { DASHSCOPE_API_KEY: '' },
      readQwenJson: async () => undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile,
    })

    expect(config.apiKey).toBe('home-key')
    expect(config.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
  })

  it('interpolates baseUrl placeholders with empty env values like the CLI', async () => {
    // Settings interpolation mirrors the CLI's getHomeEnvFallbackVars: the
    // process env wins even when empty, so an empty VOICE_GW must not be
    // re-filled from the home .env (credential lookup keeps that fill).
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    const readHomeEnvFile = async (file: string) =>
      file === join(getQwenConfigDir(), '.env')
        ? 'VOICE_GW=http://voice.region-a.internal.example\nVOICE_KEY=home-env-key\n'
        : undefined
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { VOICE_GW: '' },
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl: '$VOICE_GW/v1',
                      envKey: 'VOICE_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')
  })

  it('unwraps legacy v5 modelProviders wrappers like the CLI migration', async () => {
    const baseUrl = 'http://voice.internal.example/v1'
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? ({
              env: { VOICE_KEY: 'wrapped-key' },
              security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
              modelProviders: {
                openai: {
                  protocol: 'openai',
                  models: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl,
                      envKey: 'VOICE_KEY',
                    },
                  ],
                },
              },
            } as unknown as T)
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'wrapped-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('still reads managed system settings when only the user reader is injected', async () => {
    // Regression: injecting readQwenJson must not silently stop reading the
    // System scope, or a managed allowlist/revocation would be dropped.
    const root = await mkdtemp(join(tmpdir(), 'qwen-voice-system-'))
    const baseUrl = 'http://voice.system.internal.example/v1'
    try {
      await writeFile(
        join(root, 'settings.json'),
        JSON.stringify({
          security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
        }),
      )
      const config = await resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
        systemSettingsPath: join(root, 'settings.json'),
        systemDefaultsPath: join(root, 'system-defaults.json'),
        readQwenJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      })
      expect(config.allowInsecureBaseUrl).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow("Voice model 'qwen3-asr-flash' is ambiguous")
  })

  it('keeps the legacy fall-through for duplicate public HTTPS providers with valid OAuth', async () => {
    // Regression: ambiguity must be decided after classification. Two public
    // HTTPS entries need no policy decision, so they must not break dictation
    // for configs that resolved through OAuth before the allowlist existed.
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      now: () => 1_700_000_000_000,
      env: {},
      readQwenJson: async <T,>(file: string) => {
        if (file === 'oauth_creds.json') {
          return {
            access_token: 'oauth-token',
            resource_url: 'dashscope.aliyuncs.com/compatible-mode',
            expiry_date: future,
          } as T
        }
        if (file === 'settings.json') {
          return {
            modelProviders: {
              openai: [
                {
                  id: 'qwen3-asr-flash',
                  baseUrl:
                    'https://dashscope.aliyuncs.com/compatible-mode/v1',
                  envKey: 'DASHSCOPE_API_KEY',
                },
              ],
              dashscope: [
                {
                  id: 'qwen3-asr-flash',
                  baseUrl:
                    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
                  envKey: 'DASHSCOPE_API_KEY',
                },
              ],
            },
          } as T
        }
        return undefined
      },
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'oauth-token',
    })
  })

  it('still treats duplicates as ambiguous when any entry needs a policy decision', async () => {
    const publicUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    const privateUrl = 'http://voice.region-a.internal.example/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readSystemJson: async () => undefined,
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { VOICE_KEY: 'settings-key' },
                security: {
                  allowedInsecureVoiceBaseUrls: [privateUrl],
                },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl: publicUrl,
                      envKey: 'VOICE_KEY',
                    },
                  ],
                  custom: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl: privateUrl,
                      envKey: 'VOICE_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow("Voice model 'qwen3-asr-flash' is ambiguous")
  })

  it('tolerates exact duplicate provider entries like the CLI registry', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    // The CLI model registry keys models by (id, baseUrl) and keeps the first
    // registration of an exact duplicate (copy-paste / settings-sync artifact).
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readSystemJson: async () => undefined,
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { VOICE_KEY: 'settings-key' },
              security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl,
                    envKey: 'VOICE_KEY',
                  },
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl,
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'settings-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('ignores malformed non-object provider entries instead of crashing', async () => {
    // Hand-edited or merged settings can carry null/scalar elements in a
    // provider group; resolution must fall through to OAuth instead of
    // throwing a raw TypeError out of the provider scan.
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      now: () => 1_700_000_000_000,
      env: {},
      readQwenJson: async <T,>(file: string) => {
        if (file === 'oauth_creds.json') {
          return {
            access_token: 'oauth-token',
            resource_url: 'dashscope.aliyuncs.com/compatible-mode',
            expiry_date: future,
          } as T
        }
        if (file === 'settings.json') {
          return {
            modelProviders: { openai: [null], custom: ['entry', 42] },
          } as T
        }
        return undefined
      },
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'oauth-token',
    })
  })

  it('skips malformed entries while scanning the legacy DashScope fallback', async () => {
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { DASHSCOPE_API_KEY: 'settings-key' },
              modelProviders: {
                openai: [null, 42],
                dashscope: [
                  {
                    baseUrl:
                      'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    envKey: 'DASHSCOPE_API_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config.apiKey).toBe('settings-key')
    expect(config.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
  })

  it('skips a legacy DashScope fallback whose baseUrl is not a string', async () => {
    // Hand-edited settings can carry an array baseUrl; the legacy fallback
    // must skip it like a missing baseUrl instead of crashing on raw.trim().
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: { VOICE_KEY: 'env-key' },
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                modelProviders: {
                  dashscope: [
                    {
                      baseUrl: [
                        'https://dashscope.aliyuncs.com/compatible-mode/v1',
                      ],
                      envKey: 'VOICE_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow('Voice dictation needs Qwen credentials')
  })

  it('reports a non-string provider baseUrl with the remediation error', async () => {
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
                      baseUrl: 8080,
                      envKey: 'VOICE_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      "Voice model 'qwen3-asr-flash' baseUrl must be a string. Remove or complete this provider entry to fall back to your Qwen sign-in.",
    )
  })

  it('reports a non-string provider envKey with the remediation error', async () => {
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
                    { id: 'qwen3-asr-flash', baseUrl, envKey: 12345 },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      "Voice model 'qwen3-asr-flash' envKey must be a string. Remove or complete this provider entry to fall back to your Qwen sign-in.",
    )
  })

  it('reports a missing key instead of crashing when envKey names an Object.prototype member', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    for (const envKey of ['constructor', 'toString', '__proto__']) {
      await expect(
        resolveDesktopVoiceConfig({
          getVoiceModel: () => 'qwen3-asr-flash',
          env: {},
          readQwenJson: async <T,>(file: string) =>
            (file === 'settings.json'
              ? {
                  security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
                  modelProviders: {
                    openai: [{ id: 'qwen3-asr-flash', baseUrl, envKey }],
                  },
                }
              : undefined) as T | undefined,
          readSystemJson: async () => undefined,
          readHomeEnvFile: async () => undefined,
        }),
      ).rejects.toThrow(`Voice model 'qwen3-asr-flash' requires ${envKey}.`)
    }
  })

  it('reports a missing key instead of crashing on a non-string settings env value', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { VOICE_KEY: 12345 },
                security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
                modelProviders: {
                  openai: [
                    { id: 'qwen3-asr-flash', baseUrl, envKey: 'VOICE_KEY' },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow("Voice model 'qwen3-asr-flash' requires VOICE_KEY.")
  })

  it('names the accepted loopback spellings for a non-canonical loopback exact provider', async () => {
    const baseUrl = 'http://127.0.0.5/v1'
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { VOICE_KEY: 'settings-key' },
                security: { allowedInsecureVoiceBaseUrls: [baseUrl] },
                modelProviders: {
                  openai: [
                    { id: 'qwen3-asr-flash', baseUrl, envKey: 'VOICE_KEY' },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      "Voice model 'qwen3-asr-flash' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1]. Remove or complete this provider entry to fall back to your Qwen sign-in.",
    )
  })

  it('names the accepted loopback spellings for non-canonical loopback environment base URLs', async () => {
    // Mapped and non-canonical loopback literals stay blocked (fail closed),
    // but the error must point at the three accepted spellings instead of
    // mislabeling them as private-network addresses.
    for (const baseUrl of [
      'http://127.0.0.5:8000',
      'http://[::ffff:127.0.0.1]:8000',
    ]) {
      await expect(
        resolveDesktopVoiceConfig({
          getVoiceModel: () => 'qwen3-asr-flash',
          env: { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: baseUrl },
          readQwenJson: async () => undefined,
          readSystemJson: async () => undefined,
          readHomeEnvFile: async () => undefined,
        }),
      ).rejects.toThrow(
        'Voice endpoint uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].',
      )
    }
  })

  it('matches the DashScope-compatible allowlist on the final post-/v1 URL', async () => {
    // Split-horizon deployments can serve the official DashScope hostname
    // over cleartext. The allowlist must converge on a single string: the
    // final post-/v1 URL that the top-level recheck also matches against.
    // The CLI voice resolver performs no /v1 inference, so CLI parity
    // requires the /v1-suffixed provider baseUrl; see
    // docs/design/trusted-private-voice-base-urls.md.
    const config = await resolveDesktopVoiceConfig({
      getVoiceModel: () => 'qwen3-asr-flash',
      env: {},
      readQwenJson: async <T,>(file: string) =>
        (file === 'settings.json'
          ? {
              env: { VOICE_KEY: 'settings-key' },
              security: {
                allowedInsecureVoiceBaseUrls: [
                  'http://dashscope.aliyuncs.com/compatible-mode/v1',
                ],
              },
              modelProviders: {
                openai: [
                  {
                    id: 'qwen3-asr-flash',
                    baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode',
                    envKey: 'VOICE_KEY',
                  },
                ],
              },
            }
          : undefined) as T | undefined,
      readSystemJson: async () => undefined,
      readHomeEnvFile: async () => undefined,
    })

    expect(config).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'settings-key',
      allowInsecureBaseUrl: true,
    })
  })

  it('reports the post-/v1 URL in the remedy for DashScope-compatible entries', async () => {
    // Listing only the pre-/v1 form must not resolve; the error points at
    // the same post-/v1 form the top-level recheck demands, so a single
    // allowlist entry converges.
    await expect(
      resolveDesktopVoiceConfig({
        getVoiceModel: () => 'qwen3-asr-flash',
        env: {},
        readQwenJson: async <T,>(file: string) =>
          (file === 'settings.json'
            ? {
                env: { VOICE_KEY: 'settings-key' },
                security: {
                  allowedInsecureVoiceBaseUrls: [
                    'http://dashscope.aliyuncs.com/compatible-mode',
                  ],
                },
                modelProviders: {
                  openai: [
                    {
                      id: 'qwen3-asr-flash',
                      baseUrl:
                        'http://dashscope.aliyuncs.com/compatible-mode',
                      envKey: 'VOICE_KEY',
                    },
                  ],
                },
              }
            : undefined) as T | undefined,
        readSystemJson: async () => undefined,
        readHomeEnvFile: async () => undefined,
      }),
    ).rejects.toThrow(
      'add its exact complete normalized URL (http://dashscope.aliyuncs.com/compatible-mode/v1) to security.allowedInsecureVoiceBaseUrls',
    )
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

describe('parseEnvFileContent (dotenv@17 parity)', () => {
  it('strips inline comments and surrounding quotes', () => {
    expect(parseEnvFileContent('KEY="value" # comment')).toEqual({
      KEY: 'value',
    })
    expect(parseEnvFileContent("KEY='value' # comment")).toEqual({
      KEY: 'value',
    })
  })

  it('keeps double-quoted values spanning multiple lines', () => {
    expect(parseEnvFileContent('KEY="line1\nline2"')).toEqual({
      KEY: 'line1\nline2',
    })
  })

  it('cuts unquoted values at # without requiring whitespace', () => {
    expect(parseEnvFileContent('KEY=abc#def')).toEqual({ KEY: 'abc' })
  })

  it('expands \\n and \\r but keeps \\t and \\\\ literal in double quotes', () => {
    expect(parseEnvFileContent('KEY="a\\nb\\rc\\td\\\\e"')).toEqual({
      KEY: 'a\nb\rc\\td\\\\e',
    })
  })

  it('supports the export prefix, single quotes, and colon separators', () => {
    expect(
      parseEnvFileContent("export A='plain'\nB: colon-value\n"),
    ).toEqual({ A: 'plain', B: 'colon-value' })
  })

  it('lets the last definition win for duplicate keys', () => {
    expect(parseEnvFileContent('KEY=first\nKEY=second')).toEqual({
      KEY: 'second',
    })
  })
})
