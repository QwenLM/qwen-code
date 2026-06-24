/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LoadedSettings,
  SettingScope,
  type SettingsFile,
} from '../config/settings.js';
import type { Settings } from '../config/settingsSchema.js';
import {
  buildWorkspaceVoiceSettingsWrites,
  hasConfiguredBatchVoiceTranscriptionModel,
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

describe('voice service', () => {
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
});
