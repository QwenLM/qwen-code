/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenDialogActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const permissionsCommand: SlashCommand = {
  name: 'permissions',
  get description() {
    return t('Manage folder trust settings');
  },
  kind: CommandKind.BUILT_IN,
  action: (): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'permissions',
  }),
};
