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
import type { getChangelogUrl } from '../../changelog/changelogFetch.js';

export interface ReleaseNotesCommandOptions {
  readonly getUrl?: typeof getChangelogUrl;
  readonly description?: string;
  readonly isInteractive?: (context: CommandContext) => boolean;
}

/** A local information dialog; command input must not enter model history. */
export function createReleaseNotesCommand(
  options: ReleaseNotesCommandOptions = {},
): SlashCommand {
  return {
    name: 'release-notes',
    description:
      options.description ?? 'Show release notes for recent CLI versions',
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    isSafeConcurrent: true,
    hideInput: true,
    action: async (context) => {
      const isInteractive = options.isInteractive
        ? options.isInteractive(context)
        : context.services.agentContext?.config.isInteractive();
      if (!isInteractive) {
        return { type: 'custom_dialog', component: null };
      }
      const [{ ConnectedReleaseNotesDialog }, { createElement }] =
        await Promise.all([
          import('../../changelog/releaseNotesDialog.js'),
          import('react'),
        ]);
      return {
        type: 'custom_dialog',
        component: createElement(ConnectedReleaseNotesDialog, {
          getUrl: options.getUrl,
          onClose: () => context.ui.removeComponent(),
        }),
      };
    },
  };
}

export const releaseNotesCommand = createReleaseNotesCommand();
