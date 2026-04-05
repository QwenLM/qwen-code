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
  SessionStartSource,
  ToolNames,
  SkillTool,
  type PermissionMode,
  ideContextStore,
} from '@qwen-code/qwen-code-core';

export const clearCommand: SlashCommand = {
  name: 'clear',
  altNames: ['reset', 'new'],
  get description() {
    return t('Clear conversation history and free up context');
  },
  kind: CommandKind.BUILT_IN,
  completion: async () => [
    {
      value: '--history',
      description: t(
        'Clear dialogue history (keep system prompt + memory + context)',
      ),
    },
    { value: '--all', description: t('Complete reset (like a new session)') },
  ],
  action: async (context, args): Promise<void | SlashCommandActionReturn> => {
    const isHistory = args.includes('--history');
    const isAll = args.includes('--all');

    if (!isHistory && !isAll) {
      // Clear UI only for immediate responsiveness
      context.ui.clear();
      return;
    }

    if (!context.overwriteConfirmed) {
      return {
        type: 'confirm_action',
        prompt: isAll
          ? t('Are you sure you want to completely reset the session?')
          : t('Are you sure you want to clear the conversation history?'),
        originalInvocation: {
          raw:
            context.invocation?.raw ||
            `/clear ${isAll ? '--all' : '--history'}`,
        },
      };
    }

    const { config } = context.services;

    if (config) {
      // Fire SessionEnd event (non-blocking to avoid UI lag)
      config
        .getHookSystem()
        ?.fireSessionEndEvent(SessionEndReason.Clear)
        .catch((err) => {
          config.getDebugLogger().warn(`SessionEnd hook failed: ${err}`);
        });

      const newSessionId = config.startNewSession();

      // Reset UI telemetry metrics for the new session
      uiTelemetryService.reset();

      // Clear loaded-skills tracking so /context doesn't show stale data
      const skillTool = config
        .getToolRegistry()
        ?.getAllTools()
        .find((tool) => tool.name === ToolNames.SKILL);
      if (skillTool instanceof SkillTool) {
        skillTool.clearLoadedSkills();
      }

      if (isAll) {
        ideContextStore.clear();
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

      // Fire SessionStart event (non-blocking to avoid UI lag)
      config
        .getHookSystem()
        ?.fireSessionStartEvent(
          SessionStartSource.Clear,
          config.getModel() ?? '',
          String(config.getApprovalMode()) as PermissionMode,
        )
        .catch((err) => {
          config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
        });
    } else {
      context.ui.setDebugMessage(t('Starting a new session and clearing.'));
      context.ui.clear();
    }
  },
};
