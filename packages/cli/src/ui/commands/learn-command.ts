/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  buildLearnSkillPrompt,
  buildLearnVideoSkillRequest,
  expandHomeDir,
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
          'Usage: /learn <path|URL|text> [focus]\nExamples:\n  /learn https://docs.example.com/api\n  /learn ~/projects/acme-sdk\n  /learn Our deploy process: ssh to prod, run migrate, restart',
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
            'YouTube page URLs cannot be sent as native video input. Download the video into your workspace and pass the local video file path to /learn.',
          ),
        };
      }

      const authType = config.getContentGeneratorConfig()?.authType;
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
        let parts: Array<string | Part>;
        try {
          parts = await readPathFromWorkspace(
            expandHomeDir(video.source),
            config,
          );
        } catch {
          // The first token looked like a video path but does not resolve in
          // the workspace — e.g. prose such as "demo.mov is how we record …",
          // or a file the user has not copied into the workspace. Learn the raw
          // input as text instead of dead-ending on a hard error.
          return {
            type: 'submit_prompt',
            content: await buildLearnSkillPrompt(rawInput, projectRoot),
          };
        }

        localVideoPart = parts.find(
          (part): part is Part =>
            typeof part !== 'string' &&
            part.inlineData?.mimeType?.startsWith('video/') === true,
        );
        // Defence-in-depth: the fileUtils MIME mapping now stamps a video type
        // for every extension the parser accepts, so mime/lite no longer needs
        // help here. Only relabel when the read produced exactly one inline
        // part, so a directory (e.g. "clips.mp4/") is never relabelled as a
        // single video.
        if (!localVideoPart) {
          const inlineParts = parts.filter(
            (part): part is Part =>
              typeof part !== 'string' && part.inlineData != null,
          );
          if (inlineParts.length === 1 && inlineParts[0].inlineData) {
            inlineParts[0].inlineData.mimeType = video.mimeType;
            localVideoPart = inlineParts[0];
          }
        }

        if (!localVideoPart) {
          const errorDetail = parts
            .filter((p): p is string => typeof p === 'string')
            .join(' ');
          return {
            type: 'message',
            messageType: 'error',
            content: errorDetail
              ? `${t('The local video could not be attached for /learn.')} ${errorDetail}`
              : t('The local video could not be attached for /learn.'),
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
