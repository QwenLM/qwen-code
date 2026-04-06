/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type SlashCommand,
  CommandKind,
  type SlashCommandActionReturn,
} from './types.js';
import { t } from '../../i18n/index.js';

export const thinkbackCommand: SlashCommand = {
  name: 'thinkback',
  get description() {
    return t(
      'Review the key decisions, modifications, and bug fixes in the current session timeline.',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const { ui } = context;
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const geminiClient = config.getGeminiClient();
    if (!geminiClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No chat client available to generate thinkback.'),
      };
    }

    if (executionMode === 'interactive' && ui.pendingItem) {
      ui.addItem(
        {
          type: 'error' as const,
          text: t(
            'Already generating thinkback, wait for previous request to complete',
          ),
        },
        Date.now(),
      );
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Already generating thinkback, wait for previous request to complete',
        ),
      };
    }

    let fromTimeRange = '';
    let topicFilter = '';
    const fromMatch = args.match(/--from\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))/);
    const topicArgMatch = args.match(
      /--topic\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))/,
    );

    if (fromMatch) {
      fromTimeRange = fromMatch[1].replace(/^["']|["']$/g, '');
    }
    if (topicArgMatch) {
      topicFilter = topicArgMatch[1].replace(/^["']|["']$/g, '');
    }

    const getChatHistory = () => {
      const chat = geminiClient.getChat();
      return chat.getHistory(true);
    };

    const history = getChatHistory();
    if (history.length <= 2) {
      const msg = t('No conversation found to review.');
      if (executionMode === 'acp') {
        const messages = async function* () {
          yield { messageType: 'info' as const, content: msg };
        };
        return { type: 'stream_messages', messages: messages() };
      }
      return { type: 'message', messageType: 'info', content: msg };
    }

    const generateThinkbackMarkdown = async (): Promise<string> => {
      // NOTE: LLM prompts are intentionally NOT wrapped in t() — translating
      // prompts degrades model output quality.
      let prompt =
        "Please analyze the conversation history above and extract key events to create a timeline of this session.\nFocus on:\n1. File modifications (which files were changed and why)\n2. Bug fixes and error resolutions\n3. Architectural or key design decisions made\n\nFormat the output strictly as a timeline, for example:\n# Timeline Review\n- **Step 1** — [Decision/Fix/Change] description (files affected if any)\n- **Step 2** — [Decision/Fix/Change] description (files affected if any)\n\nIf you can't determine the exact time, use relative ordering or an approximation based on the flow.";

      if (fromTimeRange) {
        prompt += `\nOnly include events from the time period corresponding to: ${fromTimeRange}.`;
      }
      if (topicFilter) {
        prompt += `\nOnly focus on events related to the topic: ${topicFilter}.`;
      }

      prompt += '\nOutput directly without conversational filler.';

      const conversationContext = history.map((message) => ({
        role: message.role,
        parts: message.parts,
      }));

      const response = await geminiClient.generateContent(
        [
          ...conversationContext,
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        {},
        abortSignal ?? new AbortController().signal,
        config.getModel(),
      );

      const parts = response.candidates?.[0]?.content?.parts;
      const markdown =
        parts
          ?.map((part) => part.text)
          .filter((text): text is string => typeof text === 'string')
          .join('') || '';

      if (!markdown) {
        throw new Error(
          t(
            'Failed to generate thinkback - no text content received from LLM response',
          ),
        );
      }

      return markdown;
    };

    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          yield {
            messageType: 'info' as const,
            content: t('Generating thinkback timeline...'),
          };
          const markdown = await generateThinkbackMarkdown();
          yield {
            messageType: 'info' as const,
            content: markdown,
          };
        } catch (error) {
          yield {
            messageType: 'error' as const,
            content: error instanceof Error ? error.message : String(error),
          };
        }
      };

      return {
        type: 'stream_messages',
        messages: messages(),
      };
    }

    try {
      if (executionMode === 'interactive') {
        ui.setPendingItem({
          type: 'info',
          text: t('Generating thinkback timeline...'),
        });
      }

      const markdown = await generateThinkbackMarkdown();

      if (abortSignal?.aborted) {
        throw new DOMException('Thinkback generation cancelled.', 'AbortError');
      }

      if (executionMode === 'interactive') {
        ui.setPendingItem(null);
      }

      return {
        type: 'message',
        messageType: 'info',
        content: markdown,
      };
    } catch (error) {
      if (executionMode === 'interactive') {
        if (!abortSignal?.aborted) {
          ui.setPendingItem(null);
          ui.addItem(
            {
              type: 'error' as const,
              text: `❌ ${error instanceof Error ? error.message : String(error)}`,
            },
            Date.now(),
          );
        }
      }

      return {
        type: 'message',
        messageType: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
