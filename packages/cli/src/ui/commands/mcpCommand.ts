/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  MessageActionReturn,
  OpenDialogActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  get description() {
    return t('Open MCP management dialog');
  },
  argumentHint: 'desc|nodesc|schema',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    _context,
    args = '',
  ): Promise<MessageActionReturn | OpenDialogActionReturn> => {
    const [subcommand, serverName] = args.trim().split(/\s+/);

    if (subcommand === 'auth' || subcommand === 'noauth') {
      return {
        type: 'message',
        messageType: 'warning',
        content: serverName
          ? t(
              "MCP OAuth is now managed in the /mcp dialog. Open /mcp, select '{{serverName}}', then use the Auth actions there.",
              { serverName },
            )
          : t(
              'MCP OAuth is now managed in the /mcp dialog. Open /mcp, select a server, then use the Auth actions there.',
            ),
      };
    }

    return {
      type: 'dialog',
      dialog: 'mcp',
    };
  },
};
