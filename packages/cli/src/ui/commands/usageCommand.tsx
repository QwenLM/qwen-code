/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { openUsageStatusPanel } from './statusCommand.js';

export const usageCommand: SlashCommand = {
  name: 'usage',
  description: 'Show usage statistics for the current session',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: (context) => openUsageStatusPanel(context, 'usage'),
};
