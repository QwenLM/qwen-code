/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  BTW_MAX_INPUT_LENGTH,
  buildBtwCacheSafeParams,
  runForkedAgent,
} from '@qwen-code/qwen-code-core';

function buildAdvisorPrompt(focus: string): string {
  return [
    '<system-reminder>',
    'You are acting as an ADVISOR — an independent senior reviewer giving a second opinion on the conversation so far. The transcript above may be truncated to the most recent turns; treat what is shown as the evidence available to you.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You have NO tools. Base every claim strictly on evidence present in the transcript; never claim to have verified something you could not observe.',
    '- Do not perform the task or write the implementation. Review only.',
    '- Be direct about problems: flawed assumptions, premature conclusions, unverified claims, risky next steps.',
    '- The main conversation is NOT interrupted; your review is shown to the user only.',
    '',
    'Respond in markdown with exactly these sections:',
    '## Verdict — one short paragraph: is the current approach or conclusion sound?',
    '## Risks — concrete risks or flawed assumptions, each citing transcript evidence. Write "None found" if none.',
    '## Missing evidence — claims asserted but not verified in the visible transcript (earlier verification may exist outside the shown window).',
    '## Recommendation — the single most valuable next action.',
    '</system-reminder>',
    '',
    focus || 'Review the conversation above.',
  ].join('\n');
}

function formatAdvisorError(error: unknown): string {
  return t('Advisor review failed: {{error}}', {
    error:
      error instanceof Error ? error.message : String(error || 'Unknown error'),
  });
}

async function askAdvisor(
  context: CommandContext,
  focus: string,
  abortSignal: AbortSignal,
): Promise<{ text: string; model: string }> {
  const { config } = context.services;
  if (!config) throw new Error(t('Config not loaded.'));

  const cacheSafeParams = buildBtwCacheSafeParams(config);
  if (!cacheSafeParams || cacheSafeParams.history.length === 0) {
    throw new Error(t('No conversation context available for /advisor'));
  }

  const advisorModel =
    context.services.settings.merged.advisorModel?.trim() || undefined;

  // Tools are always stripped (NO_TOOLS), matching /btw and the "You have NO
  // tools" framing of the advisor prompt. This accepts a cache-prefix miss in
  // exchange for guaranteeing the reviewer cannot answer with tool calls that
  // would be discarded and surface as an empty review.
  const result = await runForkedAgent({
    config,
    userMessage: buildAdvisorPrompt(focus),
    cacheSafeParams,
    ...(advisorModel ? { model: advisorModel } : {}),
    abortSignal,
    disableModelFallbacks: true,
  });

  return {
    text: result.text || t('No response received.'),
    model: result.model,
  };
}

export const advisorCommand: SlashCommand = {
  name: 'advisor',
  get description() {
    return t(
      'Get a second opinion on the current conversation from a reviewer model',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const focus = args.trim();

    if (focus.length > BTW_MAX_INPUT_LENGTH) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Focus too long (max {{max}} chars)', {
          max: String(BTW_MAX_INPUT_LENGTH),
        }),
      };
    }

    const { config } = context.services;
    const { ui } = context;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    if (!config.getModel()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No model configured.'),
      };
    }

    const abortSignal = context.abortSignal ?? new AbortController().signal;
    const executionMode = context.executionMode ?? 'interactive';

    if (executionMode !== 'interactive') {
      try {
        const review = await askAdvisor(context, focus, abortSignal);
        return { type: 'message', messageType: 'info', content: review.text };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatAdvisorError(error),
        };
      }
    }

    // Mirror /recap's guard: pendingItem alone misses an in-flight main turn,
    // which isIdleRef covers. Without it the advisor would review a stale
    // snapshot and park a blocking pendingItem on top of a live turn.
    const turnInFlight = !ui.isIdleRef.current || ui.pendingItem !== null;
    if (turnInFlight) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Another operation is in progress, wait for it to complete before running /advisor',
        ),
      };
    }

    try {
      ui.setPendingItem({
        type: MessageType.INFO,
        text: t('Consulting advisor...'),
      });

      const review = await askAdvisor(context, focus, abortSignal);

      if (abortSignal.aborted) return;

      ui.addItem(
        { type: MessageType.ADVISOR, text: review.text, model: review.model },
        Date.now(),
      );
    } catch (error) {
      if (abortSignal.aborted) return;

      ui.addItem(
        { type: MessageType.ERROR, text: formatAdvisorError(error) },
        Date.now(),
      );
    } finally {
      if (!abortSignal.aborted) ui.setPendingItem(null);
    }
  },
};
