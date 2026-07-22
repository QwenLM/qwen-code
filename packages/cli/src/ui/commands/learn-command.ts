/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  buildLearnSkillPrompt,
  buildLearnVideoSkillRequest,
  parseLearnVideoInput,
  readPathFromWorkspace,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import { t } from '../../i18n/index.js';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

export const learnCommand: SlashCommand = {
  name: 'learn',
  get description() {
    return t(
      'Create a reusable skill from a knowledge source (file, URL, conversation, or text).',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  argumentHint: '<path|URL|text> [focus]',
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const rawInput = args.trim();
    if (!rawInput) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Usage: /learn <path|URL|text>\nExamples:\n  /learn https://docs.example.com/api\n  /learn ~/projects/acme-sdk\n  /learn Our deploy process: ssh to prod, run migrate, restart',
        ),
      };
    }

    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const projectRoot = config.getProjectRoot();
    const video = parseLearnVideoInput(rawInput);

    if (video) {
      if (video.kind === 'youtube') {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'YouTube page URLs cannot be sent as native video input. Download the video and pass a local video file to /learn.',
          ),
        };
      }

      const authType = config.getContentGeneratorConfig().authType;
      const supportsVideoTransport =
        authType === AuthType.USE_OPENAI || authType === AuthType.QWEN_OAUTH;
      if (
        config.getEffectiveInputModalities().video !== true ||
        !supportsVideoTransport
      ) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'The current model or provider does not support native video input for /learn. Switch to a video-capable model on an OpenAI-compatible provider and try again.',
          ),
        };
      }

      let localVideoPart: Part | undefined;
      if (video.kind === 'local') {
        try {
          const parts = await readPathFromWorkspace(video.source, config);
          localVideoPart = parts.find(
            (part): part is Part =>
              typeof part !== 'string' &&
              part.inlineData?.mimeType?.startsWith('video/') === true,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return {
            type: 'message',
            messageType: 'error',
            content: `${t(
              'The local video could not be attached for /learn.',
            )} ${reason}`,
          };
        }

        if (!localVideoPart) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('The local video could not be attached for /learn.'),
          };
        }
      }

      return {
        type: 'submit_prompt',
        content: await buildLearnVideoSkillRequest(
          video,
          projectRoot,
          localVideoPart,
        ),
      };
    }

    return {
      type: 'submit_prompt',
      content: await buildLearnSkillPrompt(rawInput, projectRoot),
    };
  },
};
