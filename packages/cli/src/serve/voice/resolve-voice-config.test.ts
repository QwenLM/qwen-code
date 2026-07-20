/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, createCredentialStore } from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  getAuthTypeFromEnv: vi.fn(),
  resolveCliGenerationConfig: vi.fn(),
  resolveVoiceTranscriptionConfig: vi.fn(),
  isStreamingVoiceModel: vi.fn(),
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: mocks.loadSettings,
}));

vi.mock('../../utils/modelConfigUtils.js', () => ({
  getAuthTypeFromEnv: mocks.getAuthTypeFromEnv,
  resolveCliGenerationConfig: mocks.resolveCliGenerationConfig,
}));

vi.mock('../../services/voice-transcriber.js', () => ({
  resolveVoiceTranscriptionConfig: mocks.resolveVoiceTranscriptionConfig,
  isStreamingVoiceModel: mocks.isStreamingVoiceModel,
}));

const originalDashscopeApiKey = process.env['DASHSCOPE_API_KEY'];

describe('loadDaemonVoiceContext', () => {
  afterEach(() => {
    if (originalDashscopeApiKey === undefined) {
      delete process.env['DASHSCOPE_API_KEY'];
    } else {
      process.env['DASHSCOPE_API_KEY'] = originalDashscopeApiKey;
    }
    vi.resetModules();
    vi.resetAllMocks();
  });

  it('uses the injected runtime env for voice auth and model config resolution', async () => {
    const injectedEnv = {
      DASHSCOPE_API_KEY: 'runtime-key',
      OPENAI_API_KEY: 'runtime-openai-key',
    };
    process.env['DASHSCOPE_API_KEY'] = 'process-key';
    mocks.loadSettings.mockReturnValue({
      merged: {
        voiceModel: 'qwen3-asr-flash',
        modelProviders: {},
      },
    });
    mocks.getAuthTypeFromEnv.mockReturnValue(AuthType.USE_OPENAI);
    mocks.resolveCliGenerationConfig.mockReturnValue({
      generationConfig: {},
      sources: {},
    });
    mocks.isStreamingVoiceModel.mockReturnValue(false);

    const { loadDaemonVoiceContext } = await import(
      './resolve-voice-config.js'
    );
    const context = loadDaemonVoiceContext('/work/voice', { env: injectedEnv });

    expect(context.voiceModel).toBe('qwen3-asr-flash');
    // Without a credentialStore, env is a shallow copy of injectedEnv.
    expect(context.env).toEqual(injectedEnv);
    expect(mocks.getAuthTypeFromEnv).toHaveBeenCalledWith(injectedEnv);
    expect(mocks.resolveCliGenerationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAuthType: AuthType.USE_OPENAI,
        env: injectedEnv,
      }),
    );
    expect(mocks.resolveVoiceTranscriptionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          DASHSCOPE_API_KEY: 'runtime-key',
          OPENAI_API_KEY: 'runtime-openai-key',
        }),
        settings: expect.objectContaining({
          merged: expect.objectContaining({ voiceModel: 'qwen3-asr-flash' }),
        }),
        voiceModel: 'qwen3-asr-flash',
      }),
    );
    expect(mocks.loadSettings).toHaveBeenCalledWith('/work/voice', {
      skipLoadEnvironment: true,
    });
  });

  it('merges custom-provider keys from the credential store into the voice env', async () => {
    // process.env is scrubbed of QWEN_CUSTOM_API_KEY_* in the daemon; the
    // store is the only source. The voice transcriber reads credentials from
    // the env arg, so the store snapshot must be merged in.
    const store = createCredentialStore();
    store.set('QWEN_CUSTOM_API_KEY_MY_PROVIDER', 'store-secret');
    const injectedEnv: Record<string, string | undefined> = {
      DASHSCOPE_API_KEY: 'runtime-key',
    };
    mocks.loadSettings.mockReturnValue({
      merged: {
        voiceModel: 'qwen3-asr-flash',
        modelProviders: {},
      },
    });
    mocks.getAuthTypeFromEnv.mockReturnValue(AuthType.USE_OPENAI);
    mocks.resolveCliGenerationConfig.mockReturnValue({
      generationConfig: {},
      sources: {},
    });
    mocks.isStreamingVoiceModel.mockReturnValue(false);

    const { loadDaemonVoiceContext } = await import(
      './resolve-voice-config.js'
    );
    const context = loadDaemonVoiceContext('/work/voice', {
      env: injectedEnv,
      credentialStore: store,
    });

    // Custom-provider key from the store is present in the merged env that
    // downstream transcribers read; the original injectedEnv is untouched.
    expect(context.env).toMatchObject({
      DASHSCOPE_API_KEY: 'runtime-key',
      QWEN_CUSTOM_API_KEY_MY_PROVIDER: 'store-secret',
    });
    expect(injectedEnv['QWEN_CUSTOM_API_KEY_MY_PROVIDER']).toBeUndefined();
    // resolveVoiceTranscriptionConfig receives the merged env so custom-key
    // resolution succeeds.
    expect(mocks.resolveVoiceTranscriptionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          DASHSCOPE_API_KEY: 'runtime-key',
          QWEN_CUSTOM_API_KEY_MY_PROVIDER: 'store-secret',
        }),
      }),
    );
  });
});
