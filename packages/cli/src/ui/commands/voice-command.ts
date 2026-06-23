/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';
import { CommandKind, type SlashCommand } from './types.js';
import { getVoiceUnavailableReason } from '../voice/voice-availability.js';
import {
  getVoiceSettingsScope,
  isVoiceEnabled,
  readVoiceMode,
  readVoiceModel,
  type VoiceMode,
} from '../../services/voice-settings.js';

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
      const voiceModel = readVoiceModel(settings);
      const status = isVoiceEnabled(settings) ? 'enabled' : 'disabled';
      const modelText = voiceModel
        ? t('model: {{voiceModel}}', { voiceModel })
        : t('no voice model selected');
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Voice dictation: {{status}} (mode: {{mode}}, {{modelText}}).',
          {
            status,
            mode: readVoiceMode(settings),
            modelText,
          },
        ),
      };
    }

    if (command === 'off') {
      settings.setValue(
        getVoiceSettingsScope(settings),
        'general.voice.enabled',
        false,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: t('Voice dictation disabled.'),
      };
    }

    if (command !== '' && command !== 'hold' && command !== 'tap') {
      return {
        type: 'message',
        messageType: 'warning',
        content: t('Usage: /voice [hold|tap|off|status]'),
      };
    }

    if (command === '' && isVoiceEnabled(settings)) {
      settings.setValue(
        getVoiceSettingsScope(settings),
        'general.voice.enabled',
        false,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: t('Voice dictation disabled.'),
      };
    }

    const voiceModel = readVoiceModel(settings);
    if (!voiceModel) {
      return {
        type: 'message',
        messageType: 'warning',
        content: t(
          'No voice model selected. Run /model --voice to choose one before enabling voice dictation.',
        ),
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

    const scope = getVoiceSettingsScope(settings);
    const mode: VoiceMode =
      command === 'tap'
        ? 'tap'
        : command === 'hold'
          ? 'hold'
          : readVoiceMode(settings);
    settings.setValue(scope, 'general.voice.mode', mode);
    settings.setValue(scope, 'general.voice.enabled', true);
    return {
      type: 'message',
      messageType: 'info',
      content:
        mode === 'tap'
          ? t(
              'Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using {{voiceModel}}.',
              { voiceModel },
            )
          : t(
              'Voice dictation enabled (hold mode). Hold Space at an empty prompt to dictate with {{voiceModel}}.',
              { voiceModel },
            ),
    };
  },
};
