/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger, ToolNames } from '@qwen-code/qwen-code-core';
import type { AgentParams } from '@qwen-code/qwen-code-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

const debugLogger = createDebugLogger('FORK_COMMAND');

/** Short, human-readable label for the background-tasks panel. */
function deriveForkDescription(directive: string): string {
  const oneLine = directive.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

function hasFailedDisplayStatus(
  display: unknown,
): display is { status: 'failed' } {
  return (
    display !== null &&
    typeof display === 'object' &&
    'status' in display &&
    (display as { status?: unknown }).status === 'failed'
  );
}

export const forkCommand: SlashCommand = {
  name: 'fork',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  get description() {
    return t('Spawn a background agent that inherits the full conversation');
  },
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const directive = args.trim();
    if (!directive) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Please provide a directive. Usage: /fork <directive>'),
      };
    }

    const { config } = context.services;
    const { ui } = context;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config is not available.'),
      };
    }

    // Guard: streaming or awaiting tool confirmation — forking mid-flight
    // would snapshot an inconsistent conversation state.
    if (ui.isIdleRef?.current === false) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot fork while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.',
        ),
      };
    }

    if (!config.getModel()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No model configured.'),
      };
    }

    // Guard: a fork inherits the conversation history; there must be one.
    let hasHistory = false;
    try {
      hasHistory = (config.getGeminiClient().getHistory(true) ?? []).length > 0;
    } catch (error) {
      debugLogger.debug('Failed to read history before /fork:', error);
      hasHistory = false;
    }
    if (!hasHistory) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Cannot fork before the first conversation turn.'),
      };
    }

    // Route through the Agent tool's background path (omitting subagent_type
    // selects the implicit FORK_AGENT). This reuses the full background
    // machinery: registration in the BackgroundTaskRegistry, live activity
    // streaming, a JSONL transcript, completion stats, and a terminal
    // task-notification — all surfaced by the existing background-tasks
    // pill/dialog (↑/↓ to select, view details, `x` to stop). The fork
    // inherits the parent system prompt, history, tools, and model.
    const agentTool = config.getToolRegistry().getTool(ToolNames.AGENT);
    if (!agentTool) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('The agent tool is unavailable; cannot fork.'),
      };
    }

    const params: AgentParams = {
      description: deriveForkDescription(directive),
      prompt: directive,
      run_in_background: true,
    };

    let result;
    try {
      // The background path registers the agent and starts it detached, then
      // resolves promptly — it does not block on the fork finishing. The
      // background run owns its own AbortController; this signal only covers
      // the synchronous launch/registration, so a fresh one is sufficient.
      result = await agentTool
        .build(params)
        .execute(new AbortController().signal);
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to launch fork: {{error}}', {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }

    // A failed launch (e.g. the background-agent concurrency cap is reached, or
    // registration throws) does NOT reject — the Agent tool returns a result
    // whose display status is 'failed'. Surface that instead of a misleading
    // success message.
    const display = result?.returnDisplay;
    if (hasFailedDisplayStatus(display)) {
      const reason =
        typeof result.llmContent === 'string' && result.llmContent.trim()
          ? result.llmContent.trim()
          : t('the background agent could not be started.');
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to launch fork: {{error}}', { error: reason }),
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'Forked into a background agent. It inherits this conversation and runs without blocking — track it in the background tasks panel; it reports back when done.',
      ),
    };
  },
};
