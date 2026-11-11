/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
} from './types.js';
import {
  DiffBrowser,
  type DiffBrowserState,
} from '../components/DiffBrowser.js';
import { DiffFileView } from '../components/DiffFileView.js';
import type { DiffFile } from '../utils/gitDiff.js';

export const diffCommand: SlashCommand = {
  name: 'diff',
  description: 'Show uncommitted git changes',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: (context: CommandContext) => {
    // The layout unmounts the browser during full-screen previews. Keep its
    // state for this invocation only, so returning restores the review position.
    const browserState: DiffBrowserState = { query: '' };
    return {
      type: 'custom_dialog',
      component: (
        <DiffBrowser
          state={browserState}
          onClose={() => context.ui.removeComponent()}
          onOpenFile={(file: DiffFile) => {
            context.ui.setFullScreenComponent(
              <DiffFileView
                file={file}
                onClose={() => context.ui.removeFullScreenComponent()}
              />,
            );
          }}
        />
      ),
    };
  },
};
