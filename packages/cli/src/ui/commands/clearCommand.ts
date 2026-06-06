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
  ToolNames,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';
import process from 'node:process';

const debugLogger = createDebugLogger('CLEAR_COMMAND');

export const clearCommand: SlashCommand = {
  name: 'clear',
  altNames: ['reset', 'new'],
  get description() {
    return t('Clear conversation history and free up context');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, _args) => {
    const { config } = context.services;

    const memBefore = process.memoryUsage();
    debugLogger.debug(
      `[CLEAR_START] Starting clear command, ` +
        `heapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB, ` +
        `rss=${(memBefore.rss / 1024 / 1024).toFixed(1)}MB`,
    );

    if (config) {
      if (hasBlockingBackgroundWork(config)) {
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

    const memAfter = process.memoryUsage();
    const heapDiff = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
    const rssDiff = (memAfter.rss - memBefore.rss) / 1024 / 1024;
    debugLogger.debug(
      `[CLEAR_END] Clear command completed, ` +
        `heapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB, ` +
        `rss=${(memAfter.rss / 1024 / 1024).toFixed(1)}MB, ` +
        `heapDiff=${heapDiff.toFixed(1)}MB, ` +
        `rssDiff=${rssDiff.toFixed(1)}MB`,
    );

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
