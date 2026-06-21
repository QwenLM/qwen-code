/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { voiceCommand } from './voiceCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import type { CommandContext } from './types.js';

function createSettings(
  merged: Record<string, unknown>,
  setValue = vi.fn(),
  options: Partial<LoadedSettings> = {},
): LoadedSettings {
  return {
    merged,
    isTrusted: false,
    workspace: { settings: {} },
    setValue,
    ...options,
  } as unknown as LoadedSettings;
}

describe('voiceCommand', () => {
  it('has the expected metadata', () => {
    expect(voiceCommand.name).toBe('voice');
    expect(voiceCommand.argumentHint).toBe('[hold|tap|off|status]');
  });

  it('prompts for a voice model before enabling', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings({}, setValue),
      },
    });

    const result = await voiceCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'warning',
      content:
        'No voice model selected. Run /model --voice to choose one before enabling voice dictation.',
    });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('enables hold-mode voice dictation when a voice model is selected', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings({ voiceModel: 'qwen3-asr-flash' }, setValue),
      },
    });

    const result = await voiceCommand.action!(context, '');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.mode',
      'hold',
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.enabled',
      true,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Voice dictation enabled (hold mode). Hold Space at an empty prompt to dictate with qwen3-asr-flash.',
    });
  });

  it('toggles voice dictation off when bare /voice is used while enabled', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings(
          { general: { voice: { enabled: true, mode: 'tap' } } },
          setValue,
        ),
      },
    });

    const result = await voiceCommand.action!(context, '');

    expect(setValue).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.enabled',
      false,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Voice dictation disabled.',
    });
  });

  it('enables tap mode when /voice tap is used', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings({ voiceModel: 'qwen3-asr-flash' }, setValue),
      },
    });

    const result = await voiceCommand.action!(context, 'tap');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.mode',
      'tap',
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.enabled',
      true,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using qwen3-asr-flash.',
    });
  });

  it('preserves tap mode when bare /voice re-enables voice dictation', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings(
          {
            voiceModel: 'qwen3-asr-flash',
            general: { voice: { enabled: false, mode: 'tap' } },
          },
          setValue,
        ),
      },
    });

    const result = await voiceCommand.action!(context, '');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.mode',
      'tap',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using qwen3-asr-flash.',
    });
  });

  it('disables voice dictation even when no voice model is selected', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings({}, setValue),
      },
    });

    const result = await voiceCommand.action!(context, 'off');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.voice.enabled',
      false,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Voice dictation disabled.',
    });
  });

  it('writes to workspace scope when workspace owns voice enabled', async () => {
    const setValue = vi.fn();
    const context = createMockCommandContext({
      services: {
        settings: createSettings(
          {
            voiceModel: 'qwen3-asr-flash',
            general: { voice: { enabled: false } },
          },
          setValue,
          {
            isTrusted: true,
            workspace: {
              settings: { general: { voice: { enabled: false } } },
            },
          } as Partial<LoadedSettings>,
        ),
      },
    });

    await voiceCommand.action!(context, 'hold');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'general.voice.enabled',
      true,
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'general.voice.mode',
      'hold',
    );
  });

  it('reports the current voice status', async () => {
    const context = createMockCommandContext({
      services: {
        settings: createSettings({
          voiceModel: 'qwen3-asr-flash',
          general: { voice: { enabled: true } },
        }),
      },
    }) as CommandContext;

    const result = await voiceCommand.action!(context, 'status');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Voice dictation: enabled (mode: hold, model: qwen3-asr-flash).',
    });
  });

  it('reports the configured mode in status', async () => {
    const context = createMockCommandContext({
      services: {
        settings: createSettings({
          voiceModel: 'qwen3-asr-flash',
          general: { voice: { enabled: true, mode: 'tap' } },
        }),
      },
    }) as CommandContext;

    const result = await voiceCommand.action!(context, 'status');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Voice dictation: enabled (mode: tap, model: qwen3-asr-flash).',
    });
  });

  it('returns usage for unknown arguments', async () => {
    const context = createMockCommandContext();

    const result = await voiceCommand.action!(context, 'maybe');

    expect(result).toEqual({
      type: 'message',
      messageType: 'warning',
      content: 'Usage: /voice [hold|tap|off|status]',
    });
  });
});
