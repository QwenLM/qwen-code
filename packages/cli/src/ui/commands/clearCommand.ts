/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import {
  uiTelemetryService,
  SessionEndReason,
  ToolNames,
  ideContextStore,
} from '@qwen-code/qwen-code-core';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';

export const clearCommand: SlashCommand = {
  name: 'clear',
  altNames: ['reset', 'new'],
  get description() {
    return t(
      'Clear conversation history (use --all to also reset IDE/editor context)',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  completion: async (_context, partialArg) => {
    const suggestions = [
      {
        value: '--all',
        description: t(
          'Complete reset (also clears IDE/editor context store)',
        ),
      },
    ];
    const filtered = suggestions.filter((s) => s.value.startsWith(partialArg));
    return filtered.length > 0 ? filtered : null;
  },
  action: async (context, args): Promise<void | SlashCommandActionReturn> => {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const isAll = tokens.includes('--all');

    const { config } = context.services;

    // Check for blocking background work BEFORE asking for confirmation so the
    // user is never prompted "are you sure?" for a clear that will then
    // silently fail on the blocking guard.
    if (config && hasBlockingBackgroundWork(config)) {
      const content =
        "Stop the current session's running background tasks before starting a new session.";
      context.ui.setDebugMessage(content);
      if (context.executionMode !== 'interactive') {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content,
        };
      }
      return;
    }

    // Only --all requires confirmation, and only in interactive mode where a
    // confirm prompt can actually be rendered. Non-interactive/ACP scripts
    // that pass `--all` are treated as deliberate.
    if (
      isAll &&
      !context.overwriteConfirmed &&
      context.executionMode === 'interactive'
    ) {
      return {
        type: 'confirm_action',
        prompt: t('Are you sure you want to completely reset the session?'),
        originalInvocation: {
          raw: context.invocation?.raw || '/clear --all',
        },
      };
    }

    // Clear the IDE/editor context store synchronously, BEFORE any async work
    // that might throw (resetChat). If we deferred this until after
    // resetChat, a network hiccup would leave IDE context (open files,
    // selected text, workspace state) persisting across session boundaries
    // even though the user asked for a complete reset. ideContextStore is a
    // global module-level store, so this runs regardless of `config`.
    if (isAll) {
      try {
        ideContextStore.clear();
      } catch (err) {
        config?.getDebugLogger()?.warn(`ideContextStore.clear failed: ${err}`);
      }
    }

    if (config) {
      // Fire SessionEnd event (non-blocking to avoid UI lag)
      config
        .getHookSystem()
        ?.fireSessionEndEvent(SessionEndReason.Clear)
        .catch((err) => {
          config.getDebugLogger().warn(`SessionEnd hook failed: ${err}`);
        });

      // Abort old-session async work before creating the new session so
      // cancellation notifications cannot leak across the reset boundary.
      config.getBackgroundTaskRegistry().abortAll({ notify: false });
      config.getMonitorRegistry().abortAll({ notify: false });
      config.getBackgroundShellRegistry().abortAll();
      resetBackgroundStateForSessionSwitch(config);

      const newSessionId = config.startNewSession();

      // Reset UI telemetry metrics for the new session
      uiTelemetryService.reset();

      // Clear loaded-skills tracking so /context doesn't show stale data
      const skillTool = config
        .getToolRegistry()
        ?.getAllTools()
        .find((tool) => tool.name === ToolNames.SKILL);
      if (skillTool && 'clearLoadedSkills' in skillTool) {
        (skillTool as { clearLoadedSkills(): void }).clearLoadedSkills();
      }

      if (newSessionId && context.session.startNewSession) {
        context.session.startNewSession(newSessionId);
      }

      // Clear UI first for immediate responsiveness
      context.ui.clear();

      const geminiClient = config.getGeminiClient();
      if (geminiClient) {
        context.ui.setDebugMessage(
          t('Starting a new session, resetting chat, and clearing terminal.'),
        );
        // If resetChat fails, the exception will propagate and halt the command,
        // which is the correct behavior to signal a failure to the user.
        await geminiClient.resetChat();
      } else {
        context.ui.setDebugMessage(t('Starting a new session and clearing.'));
      }
    } else {
      context.ui.setDebugMessage(t('Starting a new session and clearing.'));
      context.ui.clear();
    }

    if (context.executionMode !== 'interactive') {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'Context cleared. Previous messages are no longer in context.',
      };
    }
    return;
  },
};
