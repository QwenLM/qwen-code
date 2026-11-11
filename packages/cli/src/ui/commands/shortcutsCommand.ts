/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';

export const shortcutsCommand: SlashCommand = {
  name: 'shortcuts',
  altNames: [],
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  description: 'Toggle the shortcuts panel above the input',
  autoExecute: true,
  isInstant: true,
  hideInput: true,
  action: (context) => {
    context.ui.toggleShortcutsHelp();
  },
};
