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
  persistSessionUsage,
  createDebugLogger,
  SessionStartSource,
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
  supportedModes: ['interactive', 'non_interactive'] as const,
  action: async (context, _args) => {
    const { config } = context.services;

    const memBefore = process.memoryUsage();
    if (debugLogger.isEnabled()) {
      debugLogger.debug(
        `[CLEAR_START] Starting clear command, ` +
          `heapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB, ` +
          `rss=${(memBefore.rss / 1024 / 1024).toFixed(1)}MB`,
      );
    }

    if (config) {
      if (hasBlockingBackgroundWork(config)) {
        const content =
          "Stop the current session's running background tasks before starting a new session.";
        context.ui.setDebugMessage(content);
        // Return the error in every mode. Interactive mode used to bail
        // with only the transient debug line above, so a blocked /clear
        // looked like the command silently did nothing (issue #5949).
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content,
        };
      }

      // Fire SessionEnd event (non-blocking to avoid UI lag)
      config
        .getHookSystem()
        ?.fireSessionEndEvent(SessionEndReason.Clear)
        .catch((err) => {
          config.getDebugLogger().warn(`SessionEnd hook failed: ${err}`);
        });

      // Persist current session's usage before resetting metrics
      const metrics = uiTelemetryService.getMetrics();
      const hasActivity = Object.values(metrics.models).some(
        (m) => m.api.totalRequests > 0,
      );
      if (hasActivity) {
        try {
          persistSessionUsage({
            sessionId: config.getSessionId(),
            startTime: context.session.stats.sessionStartTime ?? new Date(),
            endTime: new Date(),
            project: config.getProjectRoot(),
            metrics,
          });
        } catch {
          // Best-effort — don't block /clear
        }
      }

      const hadUnpersistedRecording =
        config.getChatRecordingService?.()?.hasWriteFailure?.() ?? false;
      const transition = await config.prepareSessionTransition(
        undefined,
        undefined,
        {
          sessionStartSource: SessionStartSource.Clear,
          requireNew: true,
        },
      );
      try {
        await transition.commit(() => {
          context.session.startNewSession?.(transition.sessionId);
          context.ui.clear();
          context.ui.setDebugMessage(
            hadUnpersistedRecording
              ? t(
                  'Started a new session. Some changes in the previous session could not be saved.',
                )
              : t(
                  'Starting a new session, resetting chat, and clearing terminal.',
                ),
          );
        });
      } catch (error) {
        await transition.rollback();
        throw error;
      }
      try {
        config.getBackgroundTaskRegistry().abortAll({ notify: false });
        config.getMonitorRegistry().abortAll({ notify: false });
        config.getBackgroundShellRegistry().abortAll();
        resetBackgroundStateForSessionSwitch(config);
      } catch (error) {
        config
          .getDebugLogger()
          .warn(`Failed to reset background state after /clear: ${error}`);
      }
      const skillTool = config
        .getToolRegistry()
        ?.getAllTools()
        .find((tool) => tool.name === ToolNames.SKILL);
      if (skillTool && 'clearLoadedSkills' in skillTool) {
        try {
          (skillTool as { clearLoadedSkills(): void }).clearLoadedSkills();
        } catch (error) {
          config
            .getDebugLogger()
            .warn(`Failed to clear loaded skills after /clear: ${error}`);
        }
      }
    } else {
      context.ui.setDebugMessage(t('Starting a new session and clearing.'));
      context.ui.clear();
    }

    const memAfter = process.memoryUsage();
    if (debugLogger.isEnabled()) {
      const heapDiff = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
      const rssDiff = (memAfter.rss - memBefore.rss) / 1024 / 1024;
      debugLogger.debug(
        `[CLEAR_END] Clear command completed, ` +
          `heapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB, ` +
          `rss=${(memAfter.rss / 1024 / 1024).toFixed(1)}MB, ` +
          `heapDiff=${heapDiff.toFixed(1)}MB, ` +
          `rssDiff=${rssDiff.toFixed(1)}MB`,
      );
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
