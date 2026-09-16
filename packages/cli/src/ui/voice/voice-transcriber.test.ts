/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  allowedInsecureVoiceBaseUrls?: string[],
): LoadedSettings {
  return {
    merged: {
      env,
      security: {
        auth: { apiKey },
        ...(allowedInsecureVoiceBaseUrls
          ? { allowedInsecureVoiceBaseUrls }
          : {}),
      },
    },
  } as unknown as LoadedSettings;
}

async function lookupPublicHost(): Promise<{ address: string }> {
  return { address: '8.8.8.8' };
}

describe('voice-transcriber', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
    // Without this, tests that resolve through process.env read the machine's
    // real DASHSCOPE_API_KEY (the documented standard setup) and fail.
    vi.stubEnv('DASHSCOPE_API_KEY', '');
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

  it('uses the supplied env snapshot for model API keys', () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'process-key');
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
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
        env: { DASHSCOPE_API_KEY: 'runtime-key' },
      }),
    ).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl: 'https://dashscope.example/v1',
      apiKey: 'runtime-key',
    });
  });

  it('reports a missing envKey instead of crashing when it names an Object.prototype member', () => {
    // Object.hasOwn keeps inherited prototype members (an envKey like
    // "constructor") from reaching .trim() as a function.
    for (const envKey of ['constructor', 'toString', '__proto__']) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.example/v1',
          envKey,
        },
      ]);

      expect(() =>
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings(),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(`Voice model 'qwen3-asr-flash' requires ${envKey}.`);
    }
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

  it('propagates an exact private URL opt-in to realtime stream config', () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1';
    const streamConfig = resolveVoiceStreamConfig({
      config: createConfig([
        {
          id: 'qwen3-asr-flash-realtime',
          label: 'Private Qwen ASR Realtime',
          authType: AuthType.USE_OPENAI,
          baseUrl,
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }, undefined, [
        baseUrl,
      ]),
      voiceModel: 'qwen3-asr-flash-realtime',
    });

    expect(streamConfig.allowInsecureBaseUrl).toBe(true);
  });

  it('threads a custom keyterms file term into the realtime keytermsContext', () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'voice-transcriber-keyterms-'),
    );
    const qwenDir = path.join(workspaceDir, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), 'Paraformer\n');
    try {
      const settings = {
        isTrusted: true,
        workspace: { path: path.join(qwenDir, 'settings.json') },
        merged: {
          env: { DASHSCOPE_API_KEY: 'sk-test' },
          security: { auth: {} },
        },
      } as unknown as LoadedSettings;

      const streamConfig = resolveVoiceStreamConfig({
        config: createConfig([
          {
            id: 'qwen3-asr-flash-realtime',
            label: 'Qwen ASR Realtime',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://dashscope.example/v1',
            envKey: 'DASHSCOPE_API_KEY',
          },
        ]),
        settings,
        voiceModel: 'qwen3-asr-flash-realtime',
      });

      expect(streamConfig.keytermsContext).toContain('Paraformer');
      expect(streamConfig.keytermsContext).toContain('Qwen'); // globals too
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('threads a custom keyterms file term into the batch keytermsContext', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'voice-transcriber-keyterms-'),
    );
    const qwenDir = path.join(workspaceDir, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), 'Paraformer\n');
    try {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: vi
          .fn()
          .mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
      });
      const settings = {
        isTrusted: true,
        workspace: { path: path.join(qwenDir, 'settings.json') },
        merged: {
          env: { DASHSCOPE_API_KEY: 'sk-test' },
          security: { auth: {} },
        },
      } as unknown as LoadedSettings;

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
          settings,
          voiceModel: 'qwen3-asr-flash',
          lookupHost: lookupPublicHost,
          fetchFn,
        },
      );

      const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
      const sys = body.messages.find(
        (m: { role: string }) => m.role === 'system',
      );
      expect(sys.content[0].text).toContain('Paraformer');
      expect(sys.content[0].text).toContain('Qwen'); // globals too
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
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

  it('rejects unsupported URL schemes even when exactly allowlisted', () => {
    const baseUrl = 'ftp://voice.region-a.internal.example/v1';
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Private Qwen ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl,
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings({}, undefined, [baseUrl]),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(/must use an http or https baseUrl/);
  });

  it('allows an exact trusted HTTP private voice base URL', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1';
    const resolved = resolveVoiceTranscriptionConfig({
      config: createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Private Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: `${baseUrl}/`,
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      settings: createSettings({ DASHSCOPE_API_KEY: 'sk-test' }, undefined, [
        baseUrl,
      ]),
      voiceModel: 'qwen3-asr-flash',
    });

    expect(resolved).toEqual({
      model: 'qwen3-asr-flash',
      baseUrl,
      apiKey: 'sk-test',
      allowInsecureBaseUrl: true,
    });
    await expect(
      assertVoiceBaseUrlNetworkAllowed(resolved, async () => ({
        address: '10.23.45.67',
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertVoiceBaseUrlNetworkAllowed(resolved, async () => ({
        address: '64:ff9b::a17:2d43',
      })),
    ).resolves.toBeUndefined();
  });

  it('requires allowlist entries to include an explicit scheme and full path', () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1';

    for (const allowedBaseUrl of [
      'voice.region-a.internal.example/v1',
      'http://voice.region-a.internal.example',
    ]) {
      expect(() =>
        resolveVoiceTranscriptionConfig({
          config: createConfig([
            {
              id: 'qwen3-asr-flash',
              label: 'Private Qwen ASR',
              authType: AuthType.USE_OPENAI,
              baseUrl,
            },
          ]),
          settings: createSettings({}, undefined, [allowedBaseUrl]),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(/security\.allowedInsecureVoiceBaseUrls/);
    }
  });

  it('allows an exactly trusted IPv4-mapped private voice base URL', async () => {
    const baseUrl = 'http://[::ffff:10.23.45.67]/v1';
    const resolved = resolveVoiceTranscriptionConfig({
      config: createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Private Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ]),
      settings: createSettings({}, undefined, [baseUrl]),
      voiceModel: 'qwen3-asr-flash',
    });

    await expect(
      assertVoiceBaseUrlNetworkAllowed(resolved),
    ).resolves.toBeUndefined();
  });

  it('keeps metadata DNS results blocked for a trusted voice URL', async () => {
    const trusted = {
      model: 'qwen3-asr-flash',
      baseUrl: 'http://voice.internal.example/v1',
      allowInsecureBaseUrl: true,
    };

    for (const address of [
      '0.0.0.0',
      '169.254.169.254',
      '100.100.100.200',
      '::',
      '::a9fe:a9fe',
      '::6464:64c8',
      '::5db8',
      'fe80::1',
      'fd00:ec2::254',
      '::ffff:a9fe:a9fe',
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
      'fd00:0ec2:0000:0000:0000:0000:0000:0254',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed(trusted, async () => ({ address })),
      ).rejects.toThrow('resolved to an address that is always blocked');
    }
  });

  it('rejects loopback DNS results for a trusted voice URL with loopback guidance', async () => {
    const trusted = {
      model: 'qwen3-asr-flash',
      baseUrl: 'http://voice.internal.example/v1',
      allowInsecureBaseUrl: true,
    };

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
        assertVoiceBaseUrlNetworkAllowed(trusted, async () => ({ address })),
      ).rejects.toThrow(/loopback/);
    }
  });

  it('rejects a multi-record DNS answer when any record is blocked', async () => {
    // Production lookups (dnsLookup with { all: true }) always return an
    // array; a blocked record hidden among legitimate ones must reject the
    // whole answer even when another record would pass on its own.
    const trusted = {
      model: 'qwen3-asr-flash',
      baseUrl: 'http://voice.internal.example/v1',
      allowInsecureBaseUrl: true,
    };

    await expect(
      assertVoiceBaseUrlNetworkAllowed(trusted, async () => [
        { address: '8.8.8.8' },
        { address: '169.254.169.254' },
      ]),
    ).rejects.toThrow('resolved to an address that is always blocked');

    await expect(
      assertVoiceBaseUrlNetworkAllowed(
        {
          model: 'qwen3-asr-flash',
          baseUrl: 'http://voice.internal.example/v1',
        },
        async () => [{ address: '8.8.8.8' }, { address: '10.23.45.67' }],
      ),
    ).rejects.toThrow(/private-network/);

    await expect(
      assertVoiceBaseUrlNetworkAllowed(trusted, async () => [
        { address: '8.8.8.8' },
        { address: '10.23.45.67' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('requires the trusted voice base URL to match host, port, and path', () => {
    for (const baseUrl of [
      'http://voice.region-b.internal.example/v1',
      'http://voice.region-a.internal.example:8080/v1',
      'http://voice.region-a.internal.example/v2',
    ]) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Private Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ]);

      expect(() =>
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings({}, undefined, [
            'http://voice.region-a.internal.example/v1',
          ]),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(/must use an https baseUrl/);
    }
  });

  it('matches allowlist paths case-sensitively', () => {
    expect(() =>
      resolveVoiceTranscriptionConfig({
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Private Qwen ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://voice.region-a.internal.example/v1',
          },
        ]),
        settings: createSettings({}, undefined, [
          'http://voice.region-a.internal.example/V1',
        ]),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(/security\.allowedInsecureVoiceBaseUrls/);
  });

  it('does not apply an HTTP exception to the HTTPS variant', async () => {
    const resolved = resolveVoiceTranscriptionConfig({
      config: createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Private Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://voice.region-a.internal.example/v1',
        },
      ]),
      settings: createSettings({}, undefined, [
        'http://voice.region-a.internal.example/v1',
      ]),
      voiceModel: 'qwen3-asr-flash',
    });

    expect(resolved.allowInsecureBaseUrl).toBeUndefined();
    await expect(
      assertVoiceBaseUrlNetworkAllowed(resolved, async () => ({
        address: '10.23.45.67',
      })),
    ).rejects.toThrow(/private-network address/);
  });

  it('keeps metadata and link-local addresses blocked after an exact opt-in', () => {
    for (const blockedBaseUrl of [
      'http://0.0.0.0/v1',
      'http://169.254.169.254/v1',
      'http://100.100.100.200/v1',
      'http://[::]/v1',
      'http://[64:ff9b::a9fe:a9fe]/v1',
      'http://[64:ff9b::6464:64c8]/v1',
      'http://[64:ff9b::]/v1',
      'http://[64:ff9b::1]/v1',
      'http://[64:ff9b:1::a9fe:a9fe]/v1',
      'http://[64:ff9b:1:1::1]/v1',
      'http://[2002:a9fe:a9fe::1]/v1',
      'http://[2002:8000::1]/v1',
      'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/v1',
      'http://[2001:100::1]/v1',
      'http://[fd00:ec2::254]/v1',
      'http://[fd00:0ec2:0000:0000:0000:0000:0000:0254]/v1',
      'http://[fe80::1]/v1',
    ]) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Blocked ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: blockedBaseUrl,
        },
      ]);

      expect(() =>
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings({}, undefined, [blockedBaseUrl]),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(/private-network baseUrl/);
    }
  });

  it('names the accepted loopback spellings for non-canonical loopback literals', () => {
    // Loopback-range literals outside localhost/127.0.0.1/[::1] stay blocked
    // (even when allowlisted), but the error must point at the accepted
    // spellings instead of mislabeling them as private-network addresses.
    for (const baseUrl of [
      'http://127.0.0.5/v1',
      'http://[::ffff:127.0.0.1]/v1',
      'http://[64:ff9b::7f00:1]/v1',
    ]) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Loopback ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ]);

      expect(() =>
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings({}, undefined, [baseUrl]),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(
        "Voice model 'qwen3-asr-flash' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].",
      );
    }
  });

  it('names the accepted loopback spellings when a network check sees a loopback literal', async () => {
    for (const baseUrl of [
      'http://127.0.0.5/v1',
      'http://[::ffff:127.0.0.1]/v1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed({
          model: 'qwen3-asr-flash',
          baseUrl,
        }),
      ).rejects.toThrow(
        /uses a loopback address outside the accepted spellings/,
      );
    }
  });

  it('rejects private-network voice URLs', () => {
    for (const baseUrl of [
      'https://10.0.0.5/v1',
      'https://172.16.0.5/v1',
      'https://192.168.1.5/v1',
      'https://169.254.169.254/v1',
      'https://0.0.0.0/v1',
      'https://[fe80::1]/v1',
      'https://[fea0::1]/v1',
      'https://[febf::ff]/v1',
      'https://[fc00::1]/v1',
      'https://[fd12::1]/v1',
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

  it('includes the allowlist hint for private-network but not always-blocked addresses', () => {
    const privateConfig = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Private ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://10.0.0.5/v1',
      },
    ]);
    expect(() =>
      resolveVoiceTranscriptionConfig({
        config: privateConfig,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(/security\.allowedInsecureVoiceBaseUrls/);

    for (const blockedBaseUrl of [
      'https://169.254.169.254/v1',
      'http://169.254.169.254/v1',
      'http://[fe80::1]/v1',
      'http://0.0.0.0/v1',
    ]) {
      const blockedConfig = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Blocked ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl: blockedBaseUrl,
        },
      ]);
      expect(() =>
        resolveVoiceTranscriptionConfig({
          config: blockedConfig,
          settings: createSettings(),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow(/private-network baseUrl\.$/);
    }
  });

  it('names the exact normalized URL to allowlist in both rejection messages', () => {
    // Default ports and trailing slashes normalize away before matching, so
    // the message must carry the canonical string the operator has to paste.
    const cleartextConfig = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Private ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://voice.region-a.internal.example:80/v1/',
      },
    ]);
    expect(() =>
      resolveVoiceTranscriptionConfig({
        config: cleartextConfig,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(
      /add its exact complete normalized URL \(http:\/\/voice\.region-a\.internal\.example\/v1\) to security\.allowedInsecureVoiceBaseUrls\. This setting is only honored from User, System, or SystemDefaults scope settings; Workspace entries are ignored\./,
    );

    const privateConfig = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Private ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://10.0.0.5:443/v1/',
      },
    ]);
    expect(() =>
      resolveVoiceTranscriptionConfig({
        config: privateConfig,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toThrow(
      /add its exact complete normalized URL \(https:\/\/10\.0\.0\.5\/v1\) to security\.allowedInsecureVoiceBaseUrls\. This setting is only honored from User, System, or SystemDefaults scope settings; Workspace entries are ignored\./,
    );
  });

  it('does not classify an IPv4-mapped public address as private', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Public ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://[::ffff:93.184.216.34]/v1',
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).not.toThrow();
  });

  it('does not over-block public-looking IPv6 literals with fc prefix', () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Public ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://[fc::1]/v1',
      },
    ]);

    expect(() =>
      resolveVoiceTranscriptionConfig({
        config,
        settings: createSettings(),
        voiceModel: 'qwen3-asr-flash',
      }),
    ).not.toThrow();
  });

  it('reaches the batch transport for an allowlisted private IP-literal gateway', async () => {
    // Default-wiring pin: the allowlist opt-in resolved by the config
    // resolver must travel into the network guard, so an allowlisted private
    // gateway reaches fetch instead of failing the guard.
    const baseUrl = 'http://10.0.0.8/v1';
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
    });

    const text = await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Private Qwen ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl,
          },
        ]),
        settings: createSettings({}, undefined, [baseUrl]),
        voiceModel: 'qwen3-asr-flash',
        fetchFn,
      },
    );

    expect(text).toBe('ok');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][0]).toBe(`${baseUrl}/chat/completions`);
  });

  it('reaches the batch transport for an allowlisted host resolving privately', async () => {
    const baseUrl = 'http://voice.region-a.internal.example/v1';
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
    });

    await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config: createConfig([
          {
            id: 'qwen3-asr-flash',
            label: 'Private Qwen ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl,
          },
        ]),
        settings: createSettings({}, undefined, [baseUrl]),
        voiceModel: 'qwen3-asr-flash',
        lookupHost: vi.fn().mockResolvedValue({ address: '10.0.0.8' }),
        fetchFn,
      },
    );

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects voice model hosts that resolve to private-network IPs', async () => {
    const onEgress = vi.fn();

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
          onEgress,
        },
      ),
    ).rejects.toThrow(/private-network address/);
    expect(onEgress).not.toHaveBeenCalled();
  });

  it('canonicalizes expanded IPv6 DNS results before applying network policy', async () => {
    const config = {
      model: 'qwen3-asr-flash',
      baseUrl: 'https://asr.example/v1',
    };

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
        assertVoiceBaseUrlNetworkAllowed(config, async () => ({ address })),
      ).rejects.toThrow(/private-network address/);
    }

    for (const address of [
      '64:ff9b::5db8:d822',
      '64:ff9b:2::1',
      '2001:200::1',
      '2003::1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed(config, async () => ({ address })),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects private-network IP literal voice URLs during network checks', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://169.254.169.254/v1',
      }),
    ).rejects.toThrow(/private-network address/);
  });

  it('rejects private IPv4-compatible IPv6 voice URLs during network checks', async () => {
    await expect(
      assertVoiceBaseUrlNetworkAllowed({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://[::192.168.1.1]/v1',
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

  it('aborts a pending DNS safety lookup', async () => {
    const controller = new AbortController();
    const check = assertVoiceBaseUrlNetworkAllowed(
      {
        model: 'qwen3-asr-flash',
        baseUrl: 'https://asr.example/v1',
      },
      () => new Promise(() => undefined),
      controller.signal,
    );

    controller.abort(new Error('Workspace runtime was removed'));

    await expect(check).rejects.toThrow('Workspace runtime was removed');
  });

  it('allows explicit loopback voice URLs without DNS lookup', async () => {
    const config = createConfig([
      {
        id: 'qwen3-asr-flash',
        label: 'Local ASR',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:8080/v1',
      },
    ]);

    const resolved = resolveVoiceTranscriptionConfig({
      config,
      settings: createSettings(),
      voiceModel: 'qwen3-asr-flash',
    });
    expect(resolved.baseUrl).toBe('http://localhost:8080/v1');

    const lookupHost = vi.fn().mockRejectedValue(new Error('unexpected DNS'));
    for (const baseUrl of [
      resolved.baseUrl,
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
    ]) {
      await expect(
        assertVoiceBaseUrlNetworkAllowed(
          { model: 'qwen3-asr-flash', baseUrl },
          lookupHost,
        ),
      ).resolves.toBeUndefined();
    }
    expect(lookupHost).not.toHaveBeenCalled();
  });

  it('rejects voice base URLs with embedded credentials', () => {
    for (const baseUrl of [
      'https://user:secret@dashscope.aliyuncs.com/compatible-mode/v1',
      'https://dashscope.aliyuncs.com@evil.com/compatible-mode/v1',
    ]) {
      const config = createConfig([
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ]);

      expect(() =>
        resolveVoiceTranscriptionConfig({
          config,
          settings: createSettings({}, 'sk-primary'),
          voiceModel: 'qwen3-asr-flash',
        }),
      ).toThrow('must not contain embedded credentials');
    }
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

  it('drops a keyterm echo even when user keyterms make the set large', () => {
    const keyterms = [
      'grep',
      'regex',
      'typescript',
      'json',
      'oauth',
      'subagent',
      'worktree',
      'endpoint',
      'middleware',
      'schema',
      ...Array.from({ length: 190 }, (_, i) => `customterm${i}`),
    ];

    expect(
      isKeytermEcho(
        'grep regex typescript json oauth subagent worktree endpoint middleware schema',
        keyterms.join(' '),
      ),
    ).toBe(true);
  });

  it('posts audio to chat/completions as input_audio content', async () => {
    const onEgress = vi.fn();
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
        onEgress,
      },
    );

    expect(text).toBe('hello world');
    expect(onEgress).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://dashscope.example/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-test',
    );
    expect(init.redirect).toBe('manual');
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

  it('rejects redirected ASR responses without following them', async () => {
    const response = {
      ok: false,
      status: 307,
      statusText: 'Temporary Redirect',
      text: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(response);

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
    ).rejects.toThrow('Voice transcription request redirected.');

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
    expect(response.text).not.toHaveBeenCalled();
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
