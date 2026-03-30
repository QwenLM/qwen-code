/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import {
  uiTelemetryService,
  SessionEndReason,
  SessionStartSource,
  ToolNames,
  SkillTool,
  type PermissionMode,
} from '@qwen-code/qwen-code-core';

export const clearCommand: SlashCommand = {
  name: 'clear',
  altNames: ['reset', 'new'],
  get description() {
    return t('Clear conversation history and free up context');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
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
