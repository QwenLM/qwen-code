/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import { getVersion } from '@qwen-code/core';
import { CLI_TAGLINE } from '../../brand.js';
import { CommandKind, type SlashCommand } from './types.js';
import { AboutBox } from '../components/AboutBox.js';

export const aboutCommand: SlashCommand = {
  name: 'about',
  description: 'Show version info',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (context) => {
    const osVersion = process.platform;
    const modelVersion =
      context.services.agentContext?.config.getModel() || 'Unknown';
    const cliVersion = await getVersion();

    return {
      type: 'custom_dialog',
      component: (
        <AboutBox
          cliVersion={cliVersion}
          osVersion={osVersion}
          modelVersion={modelVersion}
          tagline={CLI_TAGLINE}
          onClose={() => context.ui.removeComponent()}
        />
      ),
    };
  },
};
