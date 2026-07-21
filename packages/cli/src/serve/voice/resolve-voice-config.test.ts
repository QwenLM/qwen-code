/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
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
    const context = loadDaemonVoiceContext('/work/voice', {
      env: injectedEnv,
      workspaceTrusted: true,
    });

    expect(context.voiceModel).toBe('qwen3-asr-flash');
    expect(context.env).toBe(injectedEnv);
    expect(mocks.getAuthTypeFromEnv).toHaveBeenCalledWith(injectedEnv);
    expect(mocks.resolveCliGenerationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAuthType: AuthType.USE_OPENAI,
        env: injectedEnv,
      }),
    );
    expect(mocks.resolveVoiceTranscriptionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        env: injectedEnv,
        settings: expect.objectContaining({
          merged: expect.objectContaining({ voiceModel: 'qwen3-asr-flash' }),
        }),
        voiceModel: 'qwen3-asr-flash',
      }),
    );
    expect(mocks.loadSettings).toHaveBeenCalledWith('/work/voice', {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: false,
      workspaceTrusted: true,
    });
  });

  it('skips workspace settings when the runtime is untrusted', async () => {
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
    loadDaemonVoiceContext('/work/voice', {
      env: {},
      workspaceTrusted: false,
    });

    expect(mocks.loadSettings).toHaveBeenCalledWith('/work/voice', {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
    });
  });
});
