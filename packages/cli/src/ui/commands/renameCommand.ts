/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core';
import { getResponseText } from '@qwen-code/qwen-code-core';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

const MAX_TITLE_LENGTH = 200;

/**
 * Extracts a short text summary from conversation history for title generation.
 * Takes the last few user/assistant messages, truncated to ~1000 chars.
 */
function extractConversationText(history: Content[]): string {
  const texts: string[] = [];
  // Walk backwards to get the most recent context
  for (let i = history.length - 1; i >= 0 && texts.length < 6; i--) {
    const content = history[i];
    const role = content.role === 'user' ? 'User' : 'Assistant';
    for (const part of content.parts ?? []) {
      if ('text' in part && part.text) {
        texts.unshift(`${role}: ${part.text}`);
        break;
      }
    }
  }
  const joined = texts.join('\n');
  return joined.length > 1000 ? joined.slice(-1000) : joined;
}

/**
 * Calls the LLM to generate a short session title from conversation history.
 */
async function generateSessionTitle(
  config: Config,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const history = config.getGeminiClient().getHistory(true);
    const conversationText = extractConversationText(history);
    if (!conversationText) {
      return null;
    }

    const response = await config.getContentGenerator().generateContent(
      {
        model: config.getModel(),
        contents: [
          {
            role: 'user',
            parts: [{ text: conversationText }],
          },
        ],
        config: {
          systemInstruction: {
            role: 'user',
            parts: [
              {
                text: 'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client". Reply with ONLY the kebab-case name, nothing else.',
              },
            ],
          },
          abortSignal: signal,
        },
      },
      'rename_generate_title',
    );

    const text = getResponseText(response)?.trim();
    if (!text) {
      return null;
    }
    // Clean up: take first line, remove quotes/backticks, enforce kebab-case-ish
    const cleaned = text.split('\n')[0].replace(/["`']/g, '').trim();
    return cleaned.length > 0 && cleaned.length <= MAX_TITLE_LENGTH
      ? cleaned
      : null;
  } catch {
    return null;
  }
}

export const renameCommand: SlashCommand = {
  name: 'rename',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Rename the current conversation');
  },
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config is not available.'),
      };
    }

    let name = args.trim().replace(/[\r\n]+/g, ' ');

    // If no name provided, auto-generate one from conversation history
    if (!name) {
      context.ui.setPendingItem({
        type: 'info',
        text: t('Generating session name…'),
      });
      const generated = await generateSessionTitle(config, context.abortSignal);
      context.ui.setPendingItem(null);
      if (!generated) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Could not generate a title. Usage: /rename <name>'),
        };
      }
      name = generated;
    }

    if (name.length > MAX_TITLE_LENGTH) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Name is too long. Maximum {{max}} characters.', {
          max: String(MAX_TITLE_LENGTH),
        }),
      };
    }

    // Record the custom title in the current session's JSONL file
    const chatRecordingService = config.getChatRecordingService();
    if (chatRecordingService) {
      chatRecordingService.recordCustomTitle(name);
    } else {
      // Fallback: write via SessionService for non-recording sessions
      const sessionId = config.getSessionId();
      const sessionService = config.getSessionService();
      const success = await sessionService.renameSession(sessionId, name);
      if (!success) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to rename session.'),
        };
      }
    }

    // Update the UI tag in the input prompt
    context.ui.setSessionName(name);

    return {
      type: 'message',
      messageType: 'info',
      content: t('Session renamed to "{{name}}"', { name }),
    };
  },
};
