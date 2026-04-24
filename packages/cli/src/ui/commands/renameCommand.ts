/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  getResponseText,
  SESSION_TITLE_MAX_LENGTH,
  stripTerminalControlSequences,
  tryGenerateSessionTitle,
  type Config,
  type SessionTitleFailureReason,
} from '@qwen-code/qwen-code-core';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

const MAX_TITLE_LENGTH = SESSION_TITLE_MAX_LENGTH;

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
 * Calls the LLM to generate a short kebab-case session title from conversation
 * history. Used when `/rename` is invoked with no arguments — produces a
 * filesystem-style name for sessions the user wants to keep long-term.
 */
async function generateKebabTitle(
  config: Config,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const history = config.getGeminiClient().getHistory(true);
    const conversationText = extractConversationText(history);
    if (!conversationText) {
      return null;
    }

    // Prefer the fast model for title generation — it's much cheaper and
    // faster than the main model, and title generation is a small bounded
    // task that doesn't need main-model reasoning. Falls back to the main
    // model when no fast model is configured so this path never fails to
    // start.
    const model = config.getFastModel() ?? config.getModel();
    const response = await config.getContentGenerator().generateContent(
      {
        model,
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
    // Clean up: strip ANSI / control sequences via the shared helper
    // (same security concern as the sentence-case path — the title renders
    // directly in the picker), then take the first line and drop quotes.
    const cleaned = stripTerminalControlSequences(text)
      .split('\n')[0]
      .replace(/["`']/g, '')
      .trim();
    return cleaned.length > 0 && cleaned.length <= MAX_TITLE_LENGTH
      ? cleaned
      : null;
  } catch {
    return null;
  }
}

/**
 * Translate a title-generation failure reason into a human-actionable
 * message. Exists so `/rename --auto` doesn't collapse to a generic "could
 * not generate" that leaves the user guessing about the cause.
 */
function autoFailureMessage(reason: SessionTitleFailureReason): string {
  switch (reason) {
    case 'no_fast_model':
      return t(
        '/rename --auto requires a fast model. Configure one with `/model --fast <model>`.',
      );
    case 'empty_history':
      return t(
        'No conversation to title yet — send at least one message first.',
      );
    case 'empty_result':
      return t(
        'The fast model returned no usable title. Try `/rename <name>` to set one yourself.',
      );
    case 'aborted':
      return t('Title generation was cancelled.');
    case 'model_error':
      return t(
        'The fast model could not generate a title (rate limit, auth, or network error). Check debug log or try again.',
      );
    case 'no_client':
      return t('Session is still initializing — try again in a moment.');
    default:
      return t('Could not generate a title.');
  }
}

/**
 * Parse `--auto` out of the args. Kept simple rather than bringing in an
 * argv parser — we only have one flag.
 *
 * Rules:
 * - `--auto` (case-insensitive) sets auto=true.
 * - `--` terminates flag parsing; everything after is positional, so users
 *   can legitimately name sessions starting with `--` via `/rename -- --foo`.
 * - Any other `--xxx` before `--` bubbles up as `unknownFlag` for a clean
 *   error, rather than silently becoming part of the title (`--Auto` typo,
 *   `--help` expectation, etc.).
 */
function parseArgs(raw: string): {
  auto: boolean;
  positional: string;
  unknownFlag?: string;
} {
  const trimmed = raw.trim().replace(/[\r\n]+/g, ' ');
  if (!trimmed) return { auto: false, positional: '' };
  const parts = trimmed.split(/\s+/);
  let auto = false;
  let unknownFlag: string | undefined;
  let flagsDone = false;
  const rest: string[] = [];
  for (const p of parts) {
    if (!flagsDone && p === '--') {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && p.startsWith('--')) {
      if (p.toLowerCase() === '--auto') {
        auto = true;
        continue;
      }
      if (!unknownFlag) unknownFlag = p;
      continue;
    }
    rest.push(p);
  }
  return { auto, positional: rest.join(' '), unknownFlag };
}

export const renameCommand: SlashCommand = {
  name: 'rename',
  altNames: ['tag'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t(
      'Rename the current conversation. --auto lets the fast model pick a title.',
    );
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

    const { auto, positional, unknownFlag } = parseArgs(args);
    if (unknownFlag) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Unknown flag "{{flag}}". Supported: --auto. To use this as a literal name, run `/rename -- {{flag}}`.',
          { flag: unknownFlag },
        ),
      };
    }
    let name = positional;
    // Track where the title came from so the session picker can dim
    // auto-generated titles; explicit user text stays 'manual'.
    let titleSource: 'auto' | 'manual' = 'manual';

    if (auto) {
      // Explicit user-triggered auto-title. This overwrites whatever title
      // is currently set (manual or auto) because the user asked for it.
      // Requires a configured fast model — we don't silently fall back to
      // the main model here because `--auto` is a deliberate opt-in to the
      // sentence-case fast-model flow, and surprising a user with a main-
      // model call would defeat the purpose.
      if (!config.getFastModel()) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            '/rename --auto requires a fast model. Configure one with `/model --fast <model>`.',
          ),
        };
      }
      if (positional) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            '/rename --auto does not take a name. Use `/rename <name>` to set a name yourself.',
          ),
        };
      }
      const dots = ['.', '..', '...'];
      let dotIndex = 0;
      const baseText = t('Regenerating session title');
      context.ui.setPendingItem({
        type: 'info',
        text: baseText + dots[dotIndex],
      });
      const timer = setInterval(() => {
        dotIndex = (dotIndex + 1) % dots.length;
        context.ui.setPendingItem({
          type: 'info',
          text: baseText + dots[dotIndex],
        });
      }, 500);
      // try/finally ensures the spinner stops even if tryGenerateSessionTitle
      // ever throws (it currently swallows internally, but defensively so
      // future regressions don't leak an interval timer).
      let outcome: Awaited<ReturnType<typeof tryGenerateSessionTitle>>;
      try {
        outcome = await tryGenerateSessionTitle(
          config,
          context.abortSignal ?? new AbortController().signal,
        );
      } finally {
        clearInterval(timer);
        context.ui.setPendingItem(null);
      }
      if (!outcome.ok) {
        return {
          type: 'message',
          messageType: 'error',
          content: autoFailureMessage(outcome.reason),
        };
      }
      name = outcome.title;
      titleSource = 'auto';
    } else if (!name) {
      // Legacy no-arg behavior: kebab-case, generated via the main content
      // generator with fallback to fastModel. Preserved as-is for users who
      // prefer filesystem-style names.
      const dots = ['.', '..', '...'];
      let dotIndex = 0;
      const baseText = t('Generating session name');
      context.ui.setPendingItem({
        type: 'info',
        text: baseText + dots[dotIndex],
      });
      const timer = setInterval(() => {
        dotIndex = (dotIndex + 1) % dots.length;
        context.ui.setPendingItem({
          type: 'info',
          text: baseText + dots[dotIndex],
        });
      }, 500);
      let generated: string | null;
      try {
        generated = await generateKebabTitle(config, context.abortSignal);
      } finally {
        clearInterval(timer);
        context.ui.setPendingItem(null);
      }
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
      const ok = chatRecordingService.recordCustomTitle(name, titleSource);
      if (!ok) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to rename session.'),
        };
      }
    } else {
      // Fallback: write via SessionService for non-recording sessions
      const sessionId = config.getSessionId();
      const sessionService = config.getSessionService();
      const success = await sessionService.renameSession(
        sessionId,
        name,
        titleSource,
      );
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
