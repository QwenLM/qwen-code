/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SESSION_TITLE_MAX_LENGTH,
  tryGenerateSessionTitle,
  type SessionTitleFailureReason,
} from '@qwen-code/qwen-code-core';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

const MAX_TITLE_LENGTH = SESSION_TITLE_MAX_LENGTH;

/**
 * Translate a title-generation failure reason into a human-actionable
 * message. Used by both `/rename` (no args) and `/rename --auto` since they
 * share the same fast-model `tryGenerateSessionTitle` pipeline.
 */
function titleFailureMessage(reason: SessionTitleFailureReason): string {
  switch (reason) {
    case 'no_fast_model':
      return t(
        'Auto-generating a title requires a fast model. Configure one with `/model --fast <model>`, or pass a name: `/rename <name>`.',
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
        'The fast model could not generate a title (rate limit, auth, network error, or unexpected response format). Check debug log or try again.',
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
  argumentHint: '[--auto] [<name>]',
  completion: async (_context, partialArg) => {
    // Only `--auto` is a structured option — the rest is a free-text
    // title and shouldn't be auto-completed (we don't want the picker to
    // try to "guess" what name the user wants). Match /model's empty-arg
    // contract too: return null so the completion menu stays closed
    // until the user starts typing a flag.
    const trimmed = partialArg.trim();
    if (trimmed && '--auto'.startsWith(trimmed)) {
      return [
        {
          value: '--auto',
          description: t(
            'Let the fast model generate a sentence-case title from the conversation so far.',
          ),
        },
      ];
    }
    return null;
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
    // auto-generated titles; only explicit user text stays 'manual'.
    const titleSource: 'auto' | 'manual' = name ? 'manual' : 'auto';

    if (auto && positional) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          '/rename --auto does not take a name. Use `/rename <name>` to set a name yourself.',
        ),
      };
    }

    if (!name) {
      // Both `/rename` (no args) and `/rename --auto` go through the same
      // schema-enforced sentence-case pipeline backed by the fast model.
      // The flag is now just an explicitness marker (no semantic divergence
      // beyond the spinner copy), so users who type `/rename` get the same
      // quality of title without remembering the flag.
      const dots = ['.', '..', '...'];
      let dotIndex = 0;
      const baseText = t('Generating session title');
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
          content: titleFailureMessage(outcome.reason),
        };
      }
      name = outcome.title;
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
