/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OpenDialogActionReturn,
  CommandContext,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';

export const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume a session by identifier, or open the session browser',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  omitInputFromTranscript: true,
  action: async (
    _context: CommandContext,
    args: string,
  ): Promise<OpenDialogActionReturn> => ({
    type: 'dialog',
    dialog: 'sessionBrowser',
    props: {
      resumeTarget: args.trim() || undefined,
    },
  }),
};
