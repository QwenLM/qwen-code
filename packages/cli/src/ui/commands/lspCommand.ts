/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Format LSP server status with an icon.
 */
function statusIcon(status: string): string {
  switch (status) {
    case 'READY':
      return '✅';
    case 'IN_PROGRESS':
      return '⏳';
    case 'FAILED':
      return '❌';
    case 'NOT_STARTED':
      return '⚪';
    default:
      return '❓';
  }
}

export const lspCommand: SlashCommand = {
  name: 'lsp',
  get description() {
    return t('Show LSP server status. Usage: /lsp [status]');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive'] as const,
  action: async (context: CommandContext, _args?: string): Promise<void> => {
    const config = context.services.config;

    if (!config) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: t('Config not available.') },
        Date.now(),
      );
      return;
    }

    if (!config.isLspEnabled()) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t(
            'LSP is not enabled. Start Qwen Code with `--experimental-lsp` to enable LSP support.',
          ),
        },
        Date.now(),
      );
      return;
    }

    const client = config.getLspClient();
    if (!client) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t(
            "LSP is enabled but no client is connected. Check debug logs: `grep '[LSP]' ~/.qwen/debug/latest`",
          ),
        },
        Date.now(),
      );
      return;
    }

    // Get server status via the client
    const servers = client.getServerStatus();

    if (servers.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t(
            'No LSP servers configured. Add a `.lsp.json` file to your project root. See `/help` for details.',
          ),
        },
        Date.now(),
      );
      return;
    }

    // Build status table
    const lines: string[] = ['**LSP Server Status**', ''];
    lines.push('| Server | Command | Languages | Status |');
    lines.push('|--------|---------|-----------|--------|');

    for (const server of servers) {
      const icon = statusIcon(server.status);
      const cmd = server.command ?? '(n/a)';
      const langs = server.languages.join(', ') || '(auto)';
      const statusText = server.error
        ? `${icon} ${server.status} — ${server.error}`
        : `${icon} ${server.status}`;
      lines.push(`| ${server.name} | \`${cmd}\` | ${langs} | ${statusText} |`);
    }

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
  },
};
