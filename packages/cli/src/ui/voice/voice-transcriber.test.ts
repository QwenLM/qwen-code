/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  assertVoiceBaseUrlNetworkAllowed,
  isStreamingVoiceModel,
  isKeytermEcho,
  resolveVoiceStreamConfig,
  resolveVoiceTranscriptionConfig,
  resolveVoiceTransport,
  transcribeVoiceAudio,
} from './voice-transcriber.js';

function createConfig(models: ReturnType<Config['getAllConfiguredModels']>) {
  return {
    getAllConfiguredModels: vi.fn().mockReturnValue(models),
  } as unknown as Config;
}

function createSettings(
  env: Record<string, string> = {},
  apiKey?: string,
): LoadedSettings {
  return {
    merged: { env, security: { auth: { apiKey } } },
  } as unknown as LoadedSettings;
}

async function lookupPublicHost(): Promise<{ address: string }> {
  return { address: '8.8.8.8' };
}

describe('voice-transcriber', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a plain voice model id from configured models', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Qwen ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.example/v1',
        envKey: 'DASHSCOPE_API_KEY',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://dashscope.example/v1',
      apiKey: 'sk-test',
    });
  });

  it('routes known voice models by model id instead of user protocol', () => {
    expect(resolveVoiceTransport('qwen3-asr-flash')).toBe('qwen-asr-chat');
    expect(resolveVoiceTransport('qwen3-asr-flash-2026-02-10')).toBe(
      'qwen-asr-chat',
    );
    expect(resolveVoiceTransport('qwen3-asr-flash-realtime')).toBe(
      'qwen-asr-realtime',
    );
    expect(resolveVoiceTransport('qwen3-asr-flash-realtime-2026-02-10')).toBe(
      'qwen-asr-realtime',
    );
    expect(resolveVoiceTransport('fun-asr-realtime')).toBe(
      'dashscope-task-realtime',
    );
    expect(resolveVoiceTransport('fun-asr-flash-8k-realtime')).toBe(
      'dashscope-task-realtime',
    );
    expect(resolveVoiceTransport('paraformer-realtime-v2')).toBe(
      'dashscope-task-realtime',
    );
    expect(resolveVoiceTransport('qwen3-asr-flash-filetrans')).toBe(
      'unsupported',
    );
  });

  it('does not rewrite qwen3-asr-flash to a realtime model', () => {
    expect(isStreamingVoiceModel('qwen3-asr-flash')).toBe(false);
    expect(() =>
      resolveVoiceStreamConfig({
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Qwen ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://dashscope.example/v1',
            envKey: 'DASHSCOPE_API_KEY',
          },
        ]),
        settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(/does not support streaming/);
  });

  it('keeps realtime model ids on their matching streaming transport', () => {
    const qwenStreamConfig = resolveVoiceStreamConfig({
      config: createConfig([
        {
          id: 'qwen3-asr-flash-realtime',
          label: 'Qwen ASR Realtime',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.example/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
      voiceModel: 'qwen3-asr-flash-realtime',
    });

    expect(qwenStreamConfig).toEqual({
      transport: 'qwen-asr-realtime',
      model: 'qwen3-asr-flash-realtime',
      baseUrl: 'https://dashscope.example/v1',
      apiKey: 'sk-test',
      keytermsContext: expect.stringContaining('Qwen'),
    });

    const funStreamConfig = resolveVoiceStreamConfig({
      config: createConfig([
        {
          id: 'fun-asr-realtime',
          label: 'Fun ASR Realtime',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.example/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
      voiceModel: 'fun-asr-realtime',
    });

    expect(funStreamConfig.transport).toBe('dashscope-task-realtime');
    expect(funStreamConfig.keytermsContext).toBeUndefined();
  });

  it('does not include project path metadata in voice keyterms', () => {
    const config = {
      ...createConfig([
        {
          id: 'qwen3-asr-flash-realtime',
          label: 'Qwen ASR Realtime',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.example/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      getProjectRoot: vi.fn(() => '/tmp/secret-project-codename'),
    } as unknown as Config;

    const streamConfig = resolveVoiceStreamConfig({
      config,
      settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
      voiceModel: 'qwen3-asr-flash-realtime',
    });

    expect(streamConfig.keytermsContext).toContain('Qwen');
    expect(streamConfig.keytermsContext).not.toContain('secret');
    expect(streamConfig.keytermsContext).not.toContain('codename');
  });

  it('treats colon-containing voice model values as literal model ids', () => {
    const config = createConfig([
      {
        id: 'custom:asr',
        label: 'Custom ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://asr.example/v1',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'custom:asr',
      }).model,
    ).toBe('custom:asr');
  });

  it('rejects duplicate voice model ids', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'A',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://a.example/v1',
      },
      {
        id: 'qwen3-asr-flash',
        label: 'B',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://b.example/v1',
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow("Voice model 'qwen3-asr-flash' is ambiguous.");
  });

  it('rejects non OpenAI-compatible voice models', () => {
    const config = createConfig([
      {
        id: 'claude-sonnet',
        label: 'Claude Sonnet',
        authType: AuthType.USE_ANTHROPIC,
        baseUrl: 'https://anthropic.example/v1',
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'claude-sonnet',
      }),
    ).toThrow("Voice model 'claude-sonnet' cannot be used for transcription.");
  });

  it('falls back to the OpenAI auth apiKey when the model has no envKey', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Qwen ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings({}, 'sk-from-settings'),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-from-settings',
    });
  });

  it('falls back to the primary auth apiKey for DashScope intl and US hosts', () => {
    for (const baseUrl of [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    ]) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ]);

      expect(
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings({}, 'sk-from-settings'),
          voiceModel: 'qwen3-asr-flash',
        }).apiKey,
      ).toBe('sk-from-settings');
    }
  });

  it('does not forward the primary auth apiKey to third-party voice hosts', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Custom ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://asr.example/v1',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings({}, 'sk-primary'),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://asr.example/v1',
    });
  });

  it('does not forward OPENAI_API_KEY to third-party voice hosts without envKey', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Custom ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://asr.example/v1',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://asr.example/v1',
    });
  });

  it('rejects invalid voice base URLs', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Qwen ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'dashscope.example/v1',
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow("Voice model 'qwen3-asr-flash' has an invalid baseUrl.");
  });

  it('rejects non-https voice URLs', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Qwen ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings({}, 'sk-primary'),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(/must use an https baseUrl/);
  });

  it('rejects private-network voice URLs', () => {
    for (const baseUrl of [
      'https://10.0.0.5/v1',
      'https://172.16.0.5/v1',
      'https://192.168.1.5/v1',
      'https://169.254.169.254/v1',
      'https://0.0.0.0/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:169.254.169.254]/v1',
    ]) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Private ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ]);

      expect(() =>
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings(),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(/private-network baseUrl/);
    }
  });

  it('rejects voice model hosts that resolve to private-network IPs', async () => {
    await expect(
      transcribeVoiceAudio(
        { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
        {
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://asr.example/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ]),
          settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
          voiceModel: 'qwen3-asr-flash',
          lookupHost: vi.fn().mockResolvedValue({ address: '10.0.0.8' }),
          fetchFn: vi.fn(),
        },
      ),
    ).rejects.toThrow(/private-network address/);
  });

  it('rejects private-network IP literal voice URLs during network checks', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://169.254.169.254/v1',
      }),
    ).rejects.toThrow(/private-network address/);
  });

  it('rejects voice model hosts when DNS safety lookup fails', async () => {
    await expect(
      transcribeVoiceAudio(
        { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
        {
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://asr.example/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ]),
          settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
          voiceModel: 'qwen3-asr-flash',
          lookupHost: vi.fn().mockRejectedValue(new Error('NXDOMAIN')),
          fetchFn: vi.fn(),
        },
      ),
    ).rejects.toThrow(/DNS lookup failed for asr\.example/);
  });

  it('allows localhost voice URLs for development', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Local ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:8080/v1',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }).baseUrl,
    ).toBe('http://localhost:8080/v1');
  });

  it('strips userinfo from voice base URLs', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Qwen ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl:
          'https://user:secret@dashscope.aliyuncs.com/compatible-mode/v1',
      },
    ]);

    expect(
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings({}, 'sk-primary'),
        voiceModel: 'qwen3-asr-flash',
      }).baseUrl,
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('keeps terse speech that happens to use a few keyterms', () => {
    expect(
      isKeytermEcho(
        'commit schema endpoint async',
        'commit schema endpoint async await api cli npm grep regex json refactor',
      ),
    ).toBe(false);
  });

  it('keeps longer speech that only mentions a small slice of keyterms', () => {
    expect(
      isKeytermEcho(
        'commit schema endpoint async await api cli npm',
        [
          'commit',
          'schema',
          'endpoint',
          'async',
          'await',
          'api',
          'cli',
          'npm',
          'grep',
          'regex',
          'json',
          'refactor',
          'middleware',
          'tokenizer',
          'typescript',
          'javascript',
          'yaml',
          'oauth',
          'grpc',
          'worktree',
          'subagent',
          'stdout',
          'stderr',
          'localhost',
          'codebase',
          'dotfiles',
          'webhook',
          'qwen',
          'mcp',
        ].join(' '),
      ),
    ).toBe(false);
  });

  it('posts audio to chat/completions as input_audio content', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'hello world' } }],
      }),
    });

    const text = await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Qwen ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://dashscope.example/v1/',
            envKey: 'DASHSCOPE_API_KEY',
          },
        ]),
        settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
        voiceModel: 'qwen3-asr-flash',
        lookupHost: lookupPublicHost,
        fetchFn,
      },
    );

    expect(text).toBe('hello world');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://dashscope.example/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-test',
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen3-asr-flash');
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMsg.content[0].type).toBe('input_audio');
    expect(userMsg.content[0].input_audio.data).toMatch(
      /^data:audio\/wav;base64,/,
    );
    expect(userMsg.content[0].input_audio.format).toBe('wav');
  });

  it('passes the caller abort signal to the ASR fetch', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'hello' } }] }),
    });
    const controller = new AbortController();

    await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Qwen ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://dashscope.example/v1/',
            envKey: 'DASHSCOPE_API_KEY',
          },
        ]),
        settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
        voiceModel: 'qwen3-asr-flash',
        lookupHost: lookupPublicHost,
        fetchFn,
        abortSignal: controller.signal,
      },
    );

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it('derives input_audio format from the recorder mime type', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'hello' } }] }),
    });

    await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm;codecs=opus' },
      {
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Custom ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://asr.example/v1',
          },
        ]),
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
        lookupHost: lookupPublicHost,
        fetchFn,
      },
    );

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMsg.content[0].input_audio.data).toMatch(
      /^data:audio\/webm;codecs=opus;base64,/,
    );
    expect(userMsg.content[0].input_audio.format).toBe('webm');
  });

  it('falls back to wav for octet-stream audio uploads', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'hello' } }] }),
    });

    await transcribeVoiceAudio(
      {
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'application/octet-stream',
      },
      {
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Custom ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://asr.example/v1',
          },
        ]),
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
        lookupHost: lookupPublicHost,
        fetchFn,
      },
    );

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMsg.content[0].input_audio.data).toMatch(
      /^data:application\/octet-stream;base64,/,
    );
    expect(userMsg.content[0].input_audio.format).toBe('wav');
  });

  it('sends asr_options.language and a keyterms context message', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'hi' } }] }),
    });
    const config = {
      getAllConfiguredModels: vi.fn().mockReturnValue([
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.example/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      // Non-existent dir => getGitBranch fails fast (no real git subprocess).
      getProjectRoot: vi.fn().mockReturnValue('/no/such/voice/project'),
    } as unknown as Config;
    const settings = {
      merged: {
        env: { DASHSCOPE_API_KEY: 'sk-test' },
        security: { auth: {} },
        general: { voice: { language: 'english' } },
      },
    } as unknown as LoadedSettings;

    await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config,
        settings,
        voiceModel: 'qwen3-asr-flash',
        lookupHost: lookupPublicHost,
        fetchFn,
      },
    );

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.asr_options.language).toBe('en'); // english -> en
    expect(body.asr_options.enable_itn).toBe(true);
    const sys = body.messages.find(
      (m: { role: string }) => m.role === 'system',
    );
    expect(sys.content[0].type).toBe('text');
    expect((sys.content[0].text as string).length).toBeGreaterThan(0);
  });

  it('rejects audio over the size limit without calling the API', async () => {
    const fetchFn = vi.fn();
    await expect(
      transcribeVoiceAudio(
        {
          data: new Uint8Array(10 * 1024 * 1024 + 1),
          mimeType: 'audio/wav',
        },
        {
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://dashscope.example/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ]),
          settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
          voiceModel: 'qwen3-asr-flash',
          lookupHost: lookupPublicHost,
          fetchFn,
        },
      ),
    ).rejects.toThrow(/too long/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('redacts and truncates failed batch transcription responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi
        .fn()
        .mockResolvedValue(
          `Authorization: ApiKey sk-route Bearer sk-secret api_key=sk-query secret=sk-secret-token Invalid API key: sk-test ${'x'.repeat(500)}`,
        ),
    });

    let error: unknown;
    try {
      await transcribeVoiceAudio(
        { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
        {
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://dashscope.example/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ]),
          settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
          voiceModel: 'qwen3-asr-flash',
          lookupHost: lookupPublicHost,
          fetchFn,
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Bearer [REDACTED]');
    expect(message).toContain('Authorization: [REDACTED]');
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('sk-route');
    expect(message).not.toContain('sk-secret');
    expect(message).not.toContain('sk-query');
    expect(message).not.toContain('sk-secret-token');
    expect(message).not.toContain('sk-test');
    expect(message).toMatch(/\.\.\.$/);
  });

  it('sends an inference timeout signal and reports timeout clearly', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.reject(new DOMException('TimeoutError', 'TimeoutError'));
    });

    await expect(
      transcribeVoiceAudio(
        { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
        {
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://dashscope.example/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ]),
          settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
          voiceModel: 'qwen3-asr-flash',
          lookupHost: lookupPublicHost,
          fetchFn,
        },
      ),
    ).rejects.toThrow(
      'Voice transcription timed out after 60s. Check ASR service health and retry.',
    );

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('ignores legacy protocol settings and routes batch models by model id', async () => {
    const fetchFn = vi.fn();
    const settings = {
      merged: {
        env: { DASHSCOPE_API_KEY: 'sk-test' },
        security: { auth: {} },
        general: { voice: { protocol: 'dashscope-realtime' } },
      },
    } as unknown as LoadedSettings;
    fetchFn.mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'hi' } }] }),
    });

    await expect(
      transcribeVoiceAudio(
        { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
        {
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://dashscope.example/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ]),
          settings,
          voiceModel: 'qwen3-asr-flash',
          lookupHost: lookupPublicHost,
          fetchFn,
        },
      ),
    ).resolves.toBe('hi');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('drops an echoed keyterm list instead of inserting it', async () => {
    // What the model returns on non-speech audio: our bias terms verbatim.
    const echoed =
      'grep regex TypeScript JSON OAuth subagent worktree endpoint middleware schema';
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: echoed } }] }),
    });
    const config = {
      getAllConfiguredModels: vi.fn().mockReturnValue([
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.example/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      getProjectRoot: vi.fn().mockReturnValue('/no/such/voice/project'),
    } as unknown as Config;

    const text = await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config,
        settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }),
        voiceModel: 'qwen3-asr-flash',
        lookupHost: lookupPublicHost,
        fetchFn,
      },
    );

    expect(text).toBe('');
  });
});
