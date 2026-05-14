/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenDialogActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const manageModelsCommand: SlashCommand = {
  name: 'manage-models',
  get description() {
    return t(
      'Browse dynamic model catalogs and choose which models stay enabled locally',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'manage-models',
  }),
};
