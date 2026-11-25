/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /btw — Quick side question without interrupting the main conversation.
 *
 * With a question, starts a transient single-turn query in `btwHistoryStore`
 * (sharing the parent's system prompt, message history, and tool schemas for
 * prompt-cache alignment) and opens `BtwDialog` over it. Without a question,
 * reopens the newest running side question, else the last answer.
 */

import type { Message } from '@qwen-code/core';
import { CommandKind, type SlashCommand } from './types.js';
import { BtwDialog } from '../components/BtwDialog.js';
import { btwHistoryStore } from '../state/btwHistoryStore.js';
import { persistentState } from '../../utils/persistentState.js';

export const btwCommand: SlashCommand = {
  name: 'btw',
  description:
    'Ask a quick side question without interrupting the main conversation',
  kind: CommandKind.BUILT_IN,
  autoExecute: false, // autocomplete into prompt, user types question after
  isSafeConcurrent: true, // can run while agent is busy
  hideInput: true, // don't show /btw input in conversation feed
  takesArgs: true,
  argumentHint: '[question]',

  action: async (context, args) => {
    const agentContext = context.services.agentContext;
    const config = agentContext?.config;
    btwHistoryStore.bindSession(config?.getSessionId());

    const onClose = () => context.ui.removeComponent();
    const question = args.trim();

    if (!question) {
      const requestId = btwHistoryStore.getReopenTargetId();
      if (!requestId) {
        return {
          type: 'message' as const,
          messageType: 'info' as const,
          content: 'Ask a quick side question: /btw `<question>`',
        };
      }
      return {
        type: 'custom_dialog' as const,
        component: <BtwDialog requestId={requestId} onClose={onClose} />,
      };
    }

    persistentState.update('btwUseCount', (current) => ({
      value: (current ?? 0) + 1,
      result: true,
    }));

    // The request starts before the dialog opens. If another dialog is open
    // the processor rejects this one, but the question keeps running and a
    // bare /btw shows it later.
    const cacheSafeQuerySnapshot =
      agentContext?.getCacheSafeQuerySnapshot?.() ?? undefined;
    if (!config)
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: 'The session is not ready for a side question.',
      };
    const requestId = btwHistoryStore.ask(question, {
      config,
      cacheSafeQuerySnapshot,
      ...(!cacheSafeQuerySnapshot
        ? {
            parentToolSchemas: agentContext?.getParentToolSchemas?.(),
            messages: (context.messages ?? []) as Message[],
          }
        : {}),
      sessionId: config?.getSessionId(),
    });

    return {
      type: 'custom_dialog' as const,
      component: <BtwDialog requestId={requestId} onClose={onClose} />,
    };
  },
};
