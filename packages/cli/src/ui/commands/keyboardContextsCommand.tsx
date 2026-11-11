/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDevelopment } from '../../installation/source.js';
import { CommandKind, type SlashCommand } from './types.js';
import { KeyboardDebugPanel } from '../components/KeyboardDebugPanel.js';

/**
 * /keyboard-contexts — Phase 3, Step 3.4 debug command.
 *
 * Shows a compact view of all 15 keyboard contexts with their
 * active/inactive state and layer priority. Lighter alternative
 * to /keyboard-debug when you only need to see context states.
 *
 * Only available in development builds.
 */
export const keyboardContextsCommand: SlashCommand | null = isDevelopment
  ? {
      name: 'keyboard-contexts',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      description: 'Show all keyboard contexts and their active/inactive state',
      autoExecute: true,
      hidden: true,
      action: (context) => ({
        type: 'custom_dialog',
        component: (
          <KeyboardDebugPanel
            mode="contexts"
            onClose={() => context.ui.removeComponent()}
          />
        ),
      }),
    }
  : null;
