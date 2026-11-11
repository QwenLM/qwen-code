/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { Help } from '../components/Help.js';

export const helpCommand: SlashCommand = {
  name: 'help',
  kind: CommandKind.BUILT_IN,
  description: 'Show application help and keyboard shortcuts',
  autoExecute: true,
  action: async (context) => ({
    type: 'custom_dialog',
    component: <Help onClose={() => context.ui.removeComponent()} />,
  }),
};
