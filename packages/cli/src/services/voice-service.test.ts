/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  LoadedSettings,
  SettingScope,
  type SettingsFile,
} from '../config/settings.js';
import type { Settings } from '../config/settingsSchema.js';
import {
  buildWorkspaceVoiceSettingsWrites,
  hasConfiguredBatchVoiceTranscriptionModel,
  transcribeWorkspaceVoiceAudio,
  validateWorkspaceVoiceConfig,
  validateWorkspaceVoiceModel,
  validateWorkspaceVoiceState,
  WorkspaceVoiceError,
} from './voice-service.js';

function settingsFile(settings: Settings): SettingsFile {
  return {
    settings,
    originalSettings: structuredClone(settings),
    path: '/settings.json',
  };
}

function makeSettings(opts: {
  user?: Settings;
  workspace?: Settings;
  isTrusted?: boolean;
}): LoadedSettings {
  return new LoadedSettings(
    settingsFile({}),
    settingsFile({}),
    settingsFile(opts.user ?? {}),
    settingsFile(opts.workspace ?? {}),
    opts.isTrusted ?? true,
    new Set(),
  );
}

function expectWorkspaceVoiceError(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WorkspaceVoiceError);
  expect(caught).toMatchObject({ code });
}

describe('voice service', () => {
  const originalDashscopeKey = process.env['DASHSCOPE_API_KEY'];

  afterEach(() => {
    if (originalDashscopeKey === undefined) {
      delete process.env['DASHSCOPE_API_KEY'];
    } else {
      process.env['DASHSCOPE_API_KEY'] = originalDashscopeKey;
    }
  });

  it('builds settings writes using voice and model persistence scopes', () => {
    const settings = makeSettings({
      workspace: {
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
        general: { voice: { enabled: false } },
      },
    });

    expect(
      buildWorkspaceVoiceSettingsWrites(settings, {
        enabled: true,
        mode: 'tap',
        language: 'english',
        voiceModel: 'qwen3-asr-flash',
      }),
    ).toEqual([
      {
        scope: SettingScope.Workspace,
        key: 'voiceModel',
        value: 'qwen3-asr-flash',
      },
      {
        scope: SettingScope.Workspace,
        key: 'general.voice.mode',
        value: 'tap',
      },
      {
        scope: SettingScope.Workspace,
        key: 'general.voice.language',
        value: 'english',
      },
      {
        scope: SettingScope.Workspace,
        key: 'general.voice.enabled',
        value: true,
      },
    ]);
  });

  it('uses user scope for voice settings when workspace trust is not explicit', () => {
    const settings = makeSettings({
      workspace: {
        general: { voice: { enabled: false } },
      },
    });

    expect(
      buildWorkspaceVoiceSettingsWrites(
        settings,
        {
          mode: 'tap',
          language: 'english',
          enabled: true,
        },
        { workspaceTrusted: false },
      ),
    ).toEqual([
      {
        scope: SettingScope.User,
        key: 'general.voice.mode',
        value: 'tap',
      },
      {
        scope: SettingScope.User,
        key: 'general.voice.language',
        value: 'english',
      },
      {
        scope: SettingScope.User,
        key: 'general.voice.enabled',
        value: true,
      },
    ]);
  });

  it('uses user scope when a trusted workspace does not own voice enabled', () => {
    const settings = makeSettings({
      workspace: {
        general: { voice: { mode: 'hold' } },
      },
    });

    expect(
      buildWorkspaceVoiceSettingsWrites(
        settings,
        { mode: 'tap' },
        { workspaceTrusted: true },
      ),
    ).toEqual([
      {
        scope: SettingScope.User,
        key: 'general.voice.mode',
        value: 'tap',
      },
    ]);
  });

  it('applies a workspace scope override to every voice setting', () => {
    const settings = makeSettings({ user: {} });

    expect(
      buildWorkspaceVoiceSettingsWrites(
        settings,
        {
          voiceModel: 'qwen3-asr-flash',
          mode: 'tap',
          language: 'english',
          enabled: true,
        },
        { scopeOverride: SettingScope.Workspace },
      ),
    ).toEqual([
      {
        scope: SettingScope.Workspace,
        key: 'voiceModel',
        value: 'qwen3-asr-flash',
      },
      {
        scope: SettingScope.Workspace,
        key: 'general.voice.mode',
        value: 'tap',
      },
      {
        scope: SettingScope.Workspace,
        key: 'general.voice.language',
        value: 'english',
      },
      {
        scope: SettingScope.Workspace,
        key: 'general.voice.enabled',
        value: true,
      },
    ]);
  });

  it('requires an effective voice model before enabling voice', () => {
    const settings = makeSettings({ user: {} });

    expect(() =>
      validateWorkspaceVoiceState(settings, { enabled: true }),
    ).toThrowError(WorkspaceVoiceError);
  });

  it('allows disabling voice without a configured voice model', () => {
    const settings = makeSettings({ user: {} });

    expect(() =>
      validateWorkspaceVoiceState(settings, { enabled: false }),
    ).not.toThrow();
  });

  it('detects configured batch transcription models', () => {
    const settings = makeSettings({
      user: {
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
        env: { DASHSCOPE_API_KEY: 'sk-secret' },
      },
    });

    expect(hasConfiguredBatchVoiceTranscriptionModel(settings)).toBe(true);
  });

  it('rejects unknown, duplicate, and unsupported voice model selections', () => {
    const settings = makeSettings({
      user: {
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
            {
              id: 'gpt-4o-mini',
              baseUrl: 'https://api.openai.example/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      },
    });

    expectWorkspaceVoiceError(
      () => validateWorkspaceVoiceModel(settings, 'not-configured'),
      'unknown_voice_model',
    );
    expectWorkspaceVoiceError(
      () => validateWorkspaceVoiceModel(settings, 'qwen3-asr-flash'),
      'ambiguous_voice_model',
    );
    expectWorkspaceVoiceError(
      () => validateWorkspaceVoiceModel(settings, 'gpt-4o-mini'),
      'unsupported_voice_model',
    );
  });

  it('wraps invalid voice model configuration errors', () => {
    const settings = makeSettings({
      user: {
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      },
    });

    expectWorkspaceVoiceError(
      () => validateWorkspaceVoiceConfig(settings, 'qwen3-asr-flash'),
      'invalid_voice_model',
    );
  });

  it('uses the supplied runtime environment for validation and transcription', async () => {
    process.env['DASHSCOPE_API_KEY'] = 'process-secret';
    const settings = makeSettings({
      user: {
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      },
    });
    const runtimeEnv = { DASHSCOPE_API_KEY: undefined };

    expectWorkspaceVoiceError(
      () =>
        validateWorkspaceVoiceState(
          settings,
          { enabled: true, voiceModel: 'qwen3-asr-flash' },
          { env: runtimeEnv },
        ),
      'invalid_voice_model',
    );
    await expect(
      transcribeWorkspaceVoiceAudio({
        workspaceCwd: '/workspace',
        settings,
        voiceModel: 'qwen3-asr-flash',
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav',
        env: runtimeEnv,
      }),
    ).rejects.toThrow('requires DASHSCOPE_API_KEY');
  });

  it('rejects realtime-only models for batch daemon transcription', async () => {
    const settings = makeSettings({
      user: {
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash-realtime',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
        env: { DASHSCOPE_API_KEY: 'sk-secret' },
      },
    });

    await expect(
      transcribeWorkspaceVoiceAudio({
        workspaceCwd: '/workspace',
        settings,
        voiceModel: 'qwen3-asr-flash-realtime',
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_voice_model',
    });
  });
});
