/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';

export const corgiCommand: SlashCommand = {
  name: 'corgi',
  description: 'Toggles corgi mode',
  hidden: true,
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  isInstant: true,
  hideInput: true,
  action: (context) => {
    context.ui.toggleCorgiMode();
  },
};
