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
 * /keyboard-debug — Phase 3, Step 3.4 debug command.
 *
 * Shows the full keyboard debug panel: active contexts, registered action
 * handlers, fallback handlers, and context bindings for all active contexts.
 *
 * Only available in development builds.
 */
export const keyboardDebugCommand: SlashCommand | null = isDevelopment
  ? {
      name: 'keyboard-debug',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      description:
        'Show keyboard context routing debug info (contexts, handlers, bindings)',
      autoExecute: true,
      hidden: true,
      action: (context) => ({
        type: 'custom_dialog',
        component: (
          <KeyboardDebugPanel
            mode="full"
            onClose={() => context.ui.removeComponent()}
          />
        ),
      }),
    }
  : null;
