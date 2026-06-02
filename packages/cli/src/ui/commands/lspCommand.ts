/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';

function emitMessage(
  context: CommandContext,
  messageType: 'info' | 'error',
  content: string,
): MessageActionReturn | void {
  if (context.executionMode !== 'interactive') {
    return {
      type: 'message',
      messageType,
      content,
    };
  }

  context.ui.addItem(
    {
      type: messageType === 'error' ? MessageType.ERROR : MessageType.INFO,
      text: content,
    },
    Date.now(),
  );
}

export const lspCommand: SlashCommand = {
  name: 'lsp',
  get description() {
    return t('Show LSP server status. Usage: /lsp [status]');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive'] as const,
  action: async (
    context: CommandContext,
    _args?: string,
  ): Promise<MessageActionReturn | void> => {
    const config = context.services.config;

    if (!config) {
      return emitMessage(context, 'error', t('Config not available.'));
    }

    if (!config.isLspEnabled()) {
      return emitMessage(
        context,
        'info',
        t(
          'LSP is not enabled. Start Qwen Code with `--experimental-lsp` to enable LSP support.',
        ),
      );
    }

    const client = config.getLspClient();
    if (!client) {
      return emitMessage(
        context,
        'info',
        t(
          'LSP is enabled but no client is connected. Check debug logs under `${QWEN_RUNTIME_DIR:-~/.qwen}/debug/` or see the LSP troubleshooting docs.',
        ),
      );
    }

    if (!client.getServerStatus) {
      return emitMessage(
        context,
        'info',
        t('LSP is enabled, but server status is unavailable.'),
      );
    }

    const servers = client.getServerStatus();

    if (servers.length === 0) {
      return emitMessage(
        context,
        'info',
        t(
          'No LSP servers configured. Add a `.lsp.json` file to your project root. See `/help` for details.',
        ),
      );
    }

    const lines: string[] = ['**LSP Server Status**', ''];
    lines.push('| Server | Command | Languages | Status |');
    lines.push('|--------|---------|-----------|--------|');

    for (const server of servers) {
      const cmd = server.command ?? '(n/a)';
      const langs = server.languages.join(', ') || '(auto)';
      const statusText = server.error
        ? `${server.status} - ${server.error}`
        : server.status;
      lines.push(`| ${server.name} | \`${cmd}\` | ${langs} | ${statusText} |`);
    }

    return emitMessage(context, 'info', lines.join('\n'));
  },
};
