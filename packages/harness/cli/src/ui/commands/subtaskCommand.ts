/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /subtask — Send a subagent off with your full context; its result comes back
 * here.
 *
 * Spawns an in-session async fork subagent directly (bypassing the model): the
 * child inherits the parent's full conversation context + rendered system
 * prompt, executes ONE directive in the background, and reports back via a
 * `<task-notification>` (also visible in `/tasks`).
 */

import {
  isAgentSessionsEnabled,
  isInForkChild,
  spawnForkSubtask,
  type Message,
} from '@qwen-code/core';
import { CommandKind, type SlashCommand } from './types.js';

export const subtaskCommand: SlashCommand = {
  name: 'subtask',
  description:
    'Send a subagent off with your full context; its result comes back here',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  isSafeConcurrent: true,
  takesArgs: true,
  argumentHint: '<directive>',
  action: async (context, args) => {
    const directive = args.trim();
    if (!directive) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Send a subagent off with your context: /subtask <directive>',
      };
    }

    if (!isAgentSessionsEnabled()) {
      return {
        type: 'message',
        messageType: 'info',
        content: '/subtask requires agent sessions, which are disabled.',
      };
    }

    const agentContext = context.services.agentContext;
    if (!agentContext) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Session context not available.',
      };
    }

    // The fork requires a non-empty rendered system prompt, which only exists
    // after the first completed turn. `??` in the fork branch does not catch
    // an empty string, so guard on both empty and undefined here.
    if (!agentContext.getSystemPrompt?.()?.length) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Cannot start a subtask before the first conversation turn.',
      };
    }

    // Read the same message source the helper/fork reads, so this clean D4
    // message and the helper's backstop can't diverge.
    const messages = (agentContext.getConversationMessages?.() ??
      []) as Message[];
    if (isInForkChild(messages)) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Cannot start a subtask from inside a forked worker.',
      };
    }

    try {
      const { name, agentId } = await spawnForkSubtask(agentContext, directive);
      const idSuffix = agentId ? ` (${agentId.slice(-4)})` : '';
      return {
        type: 'local_command_result',
        text: `⑂ forked ${name}${idSuffix} — you'll be notified when it finishes.`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          error instanceof Error
            ? `Failed to start subtask: ${error.message}`
            : 'Failed to start subtask.',
      };
    }
  },
};
