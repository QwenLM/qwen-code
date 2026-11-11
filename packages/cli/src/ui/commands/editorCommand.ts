/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type OpenDialogActionReturn,
  type SlashCommand,
} from './types.js';

export const editorCommand: SlashCommand = {
  name: 'editor',
  description: 'Set external editor preference',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  action: (): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'editor',
  }),
};
