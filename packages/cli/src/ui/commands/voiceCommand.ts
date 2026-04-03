/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import { detectBackend } from '../../services/audioCapture.js';

export const DEFAULT_STT_ENDPOINT =
  'http://localhost:8000/v1/audio/transcriptions';

export const voiceCommand: SlashCommand = {
  name: 'voice',
  description: 'Manage voice input (push-to-talk)',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'status',
      description: 'Show voice input status',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext): SlashCommandActionReturn => {
        const settings = context.services.settings.merged;
        const enabled = settings.voice?.enabled ?? false;
        const endpoint = settings.voice?.sttEndpoint ?? DEFAULT_STT_ENDPOINT;
        const backend = detectBackend();

        const lines = [
          `Voice input: ${enabled ? 'enabled' : 'disabled'}`,
          `STT endpoint: ${endpoint}`,
          `Audio backend: ${backend}`,
        ];

        if (backend === 'none') {
          lines.push(
            'No audio capture backend found. Install sox (recommended) or alsa-utils.',
          );
        }

        return {
          type: 'message',
          messageType: 'info',
          content: lines.join('\n'),
        };
      },
    },
  ],
  action: (
    context: CommandContext,
    _args: string,
  ): SlashCommandActionReturn => {
    const settings = context.services.settings.merged;
    const currentlyEnabled = settings.voice?.enabled ?? false;
    const newValue = !currentlyEnabled;

    context.services.settings.setValue(
      SettingScope.User,
      'voice.enabled',
      newValue,
    );

    return {
      type: 'message',
      messageType: 'info',
      content: newValue ? 'Voice input enabled.' : 'Voice input disabled.',
    };
  },
};
