/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionEndReason, SessionStartSource } from '@qwen-code/core';
import { CommandKind, type SlashCommand } from './types.js';
import { resetConversationSession } from './resetConversationSession.js';

export const newCommand: SlashCommand = {
  name: 'new',
  description: 'Start a new conversation',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  omitInputFromTranscript: true,
  action: async (context) =>
    resetConversationSession(context, {
      sessionEndReason: SessionEndReason.Clear,
      sessionStartSource: SessionStartSource.New,
    }),
};
