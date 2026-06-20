/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { CommandKind, type SlashCommand } from './types.js';
import { getVoiceUnavailableReason } from '../voice/voiceAvailability.js';

type VoiceMode = 'hold' | 'tap';

function getVoiceModel(settings: {
  merged?: { voiceModel?: unknown };
}): string | undefined {
  const value = settings.merged?.voiceModel;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isVoiceEnabled(settings: {
  merged?: { general?: { voice?: { enabled?: unknown } } };
}): boolean {
  return settings.merged?.general?.voice?.enabled === true;
}

function getVoiceMode(settings: {
  merged?: { general?: { voice?: { mode?: unknown } } };
}): VoiceMode {
  return settings.merged?.general?.voice?.mode === 'tap' ? 'tap' : 'hold';
}

function getVoiceScope(settings: {
  isTrusted?: boolean;
  workspace?: { settings?: { general?: { voice?: { enabled?: unknown } } } };
}): SettingScope {
  return settings.isTrusted === true &&
    typeof settings.workspace?.settings?.general?.voice?.enabled === 'boolean'
    ? SettingScope.Workspace
    : SettingScope.User;
}

export const voiceCommand: SlashCommand = {
  name: 'voice',
  get description() {
    return t('Toggle voice dictation input');
  },
  argumentHint: '[hold|tap|off|status]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context, args) => {
    const settings = context.services.settings;
    const command = args.trim().toLowerCase();

    if (command === 'status') {
      const voiceModel = getVoiceModel(settings);
      const status = isVoiceEnabled(settings) ? 'enabled' : 'disabled';
      const modelText = voiceModel
        ? `model: ${voiceModel}`
        : 'no voice model selected';
      return {
        type: 'message',
        messageType: 'info',
        content: `Voice dictation: ${status} (mode: ${getVoiceMode(settings)}, ${modelText}).`,
      };
    }

    if (command === 'off') {
      settings.setValue(
        getVoiceScope(settings),
        'general.voice.enabled',
        false,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: 'Voice dictation disabled.',
      };
    }

    if (command !== '' && command !== 'hold' && command !== 'tap') {
      return {
        type: 'message',
        messageType: 'warning',
        content: 'Usage: /voice [hold|tap|off|status]',
      };
    }

    const voiceModel = getVoiceModel(settings);
    if (!voiceModel) {
      return {
        type: 'message',
        messageType: 'warning',
        content:
          'No voice model selected. Run /model --voice to choose one before enabling voice dictation.',
      };
    }

    const unavailableReason = getVoiceUnavailableReason();
    if (unavailableReason) {
      return {
        type: 'message',
        messageType: 'warning',
        content: unavailableReason,
      };
    }

    const scope = getVoiceScope(settings);
    const mode: VoiceMode = command === 'tap' ? 'tap' : 'hold';
    settings.setValue(scope, 'general.voice.mode', mode);
    settings.setValue(scope, 'general.voice.enabled', true);
    return {
      type: 'message',
      messageType: 'info',
      content:
        mode === 'tap'
          ? `Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using ${voiceModel}.`
          : `Voice dictation enabled (hold mode). Hold Space at an empty prompt to dictate with ${voiceModel}.`,
    };
  },
};
