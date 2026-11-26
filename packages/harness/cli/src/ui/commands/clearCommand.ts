/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionEndReason, SessionStartSource } from '@qwen-code/core';
import { CommandKind, type SlashCommand } from './types.js';
import { resetConversationSession } from './resetConversationSession.js';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear the screen and start a new conversation',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  omitInputFromTranscript: true,
  action: async (context) =>
    resetConversationSession(context, {
      sessionEndReason: SessionEndReason.Clear,
      sessionStartSource: SessionStartSource.Clear,
    }),
};
