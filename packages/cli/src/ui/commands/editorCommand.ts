/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type OpenDialogActionReturn,
  type SlashCommand,
} from './types.js';
import { t } from '../../i18n/index.js';

export const editorCommand: SlashCommand = {
  name: 'editor',
  get description() {
    return t('set external editor preference');
  },
  kind: CommandKind.BUILT_IN,
  action: (): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'editor',
  }),
};
