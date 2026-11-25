/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OpenDialogActionReturn,
  CommandContext,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';

export const rewindCommand: SlashCommand = {
  name: 'rewind',
  altNames: ['checkpoint'],
  description: 'Open rewind selector',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  omitInputFromTranscript: true,
  action: async (
    _context: CommandContext,
    _args: string,
  ): Promise<OpenDialogActionReturn> => ({
    type: 'dialog',
    dialog: 'rewind',
  }),
};
