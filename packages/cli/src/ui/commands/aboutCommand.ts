/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemAbout } from '../types.js';
import { getExtendedSystemInfo } from '../../utils/systemInfo.js';

export const aboutCommand: SlashCommand = {
  name: 'about',
  description: 'show version info',
  kind: CommandKind.BUILT_IN,
  action: async (context) => {
    const systemInfo = await getExtendedSystemInfo(context);

    const aboutItem: Omit<HistoryItemAbout, 'id'> = {
      type: MessageType.ABOUT,
      systemInfo,
    };

    context.ui.addItem(aboutItem, Date.now());
  },
};
