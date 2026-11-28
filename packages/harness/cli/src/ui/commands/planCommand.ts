/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import {
  coreEvents,
  runLogger,
  processSingleFileContent,
  partToString,
  readFileWithEncoding,
  isPlanStateBlockedByMode,
  PLAN_MODE_BLOCKED_MESSAGE,
} from '@qwen-code/core';
import { MessageType } from '../types.js';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyToClipboard } from '../utils/commandUtils.js';

async function copyAction(context: CommandContext) {
  const config = context.services.agentContext?.config;
  if (!config) {
    runLogger.debug('Plan copy command: config is not available in context');
    return;
  }

  const planPath = config.getApprovedPlanPath();

  if (!planPath) {
    coreEvents.emitFeedback('warning', 'No approved plan found to copy.');
    return;
  }

  try {
    const content = await readFileWithEncoding(planPath);
    await copyToClipboard(content);
    coreEvents.emitFeedback(
      'info',
      `Plan copied to clipboard (${path.basename(planPath)}).`,
    );
  } catch (error) {
    coreEvents.emitFeedback('error', `Failed to copy plan: ${error}`, error);
  }
}

async function openAction(context: CommandContext) {
  const config = context.services.agentContext?.config;
  if (!config) {
    runLogger.debug('Plan open command: config is not available in context');
    return;
  }

  // Prefer the approved plan path; fall back to the current session plan file.
  let planPath = config.getApprovedPlanPath();
  if (!planPath) {
    const plansDir = config.storage.getPlansDir();
    const sessionId = config.getSessionId();
    if (plansDir && sessionId) {
      planPath = config.planStateManager.getPlanFilePath(plansDir, sessionId);
    }
  }

  if (!planPath) {
    coreEvents.emitFeedback('warning', 'No plan file found to open.');
    return;
  }

  const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';

  try {
    // Open the plan file in $EDITOR (blocking — waits for editor to close).
    const result = spawnSync(editor, [planPath], { stdio: 'inherit' });

    if (result.error) {
      coreEvents.emitFeedback(
        'error',
        `Failed to open editor "${editor}": ${result.error.message}`,
        result.error,
      );
      return;
    }

    // After editing, re-read the plan and surface an update notification.
    try {
      const updatedContent = await readFileWithEncoding(planPath);
      coreEvents.emitFeedback(
        'info',
        `Plan file updated (${path.basename(planPath)}).`,
      );
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: updatedContent,
      });
    } catch {
      // File may not have been saved — silently ignore.
    }
  } catch (error) {
    coreEvents.emitFeedback(
      'error',
      `Failed to open plan in editor: ${error}`,
      error,
    );
  }
}

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Toggle Plan Mode (enter when off, exit when on)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      runLogger.debug('Plan command: config is not available in context');
      return;
    }

    // Toggle — if already in plan, exit it.
    if (config.isPlanMode()) {
      config.planStateManager.exit();
      config.notifyPlanStateChanged();
      coreEvents.emitFeedback('info', 'Exited Plan Mode.');
      return;
    }

    // This entry point bypasses the tool permission pipeline, so it consults
    // the shared plan-exclusion policy directly.
    if (isPlanStateBlockedByMode(config.getPermissionMode())) {
      coreEvents.emitFeedback('warning', PLAN_MODE_BLOCKED_MESSAGE);
      return;
    }

    // Enter plan state via PlanStateManager (not setPermissionMode).
    config.planStateManager.enter();
    config.resetPreApprovedPrompts?.();
    config.notifyPlanStateChanged();
    coreEvents.emitFeedback('info', 'Switched to Plan Mode.');

    if (context.invocation?.args) {
      return {
        type: 'submit_prompt',
        content: context.invocation.args,
      };
    }

    const approvedPlanPath = config.getApprovedPlanPath();

    if (!approvedPlanPath) {
      return;
    }

    try {
      const content = await processSingleFileContent(
        approvedPlanPath,
        config.storage.getPlansDir(),
        config.getFileSystemService(),
      );
      const fileName = path.basename(approvedPlanPath);

      coreEvents.emitFeedback('info', `Approved Plan: ${fileName}`);

      context.ui.addItem({
        type: MessageType.GEMINI,
        text: partToString(content.llmContent),
      });
      return;
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        `Failed to read approved plan at ${approvedPlanPath}: ${error}`,
        error,
      );
      return;
    }
  },
  subCommands: [
    {
      name: 'copy',
      description: 'Copy the currently approved plan to your clipboard',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
      action: copyAction,
    },
    {
      name: 'open',
      description: 'Open the current plan file in $EDITOR',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
      action: openAction,
    },
  ],
};
