/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { MessageType } from '../types.js';

/**
 * /web command - Start the Web GUI server
 */
export const webCommand: SlashCommand = {
  name: 'web',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Start Web GUI server in your browser');
  },
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | MessageActionReturn> => {
    const parsed = parseWebArgs(args);

    // Add initial message
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Starting Web GUI server...'),
      },
      Date.now(),
    );

    try {
      // Dynamic import of the web-app package
      const webAppModule = await import('@qwen-code/web-app');
      const { startServer } = webAppModule;

      const actualPort = await startServer({
        port: parsed.port,
        host: parsed.host,
        config: context.services.config,
      });

      const url = `http://${parsed.host === '0.0.0.0' ? 'localhost' : parsed.host}:${actualPort}`;

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Web GUI running at {{url}}', { url }),
        },
        Date.now(),
      );

      if (parsed.host === '0.0.0.0') {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Warning: Server is accessible from the network. Use with caution.',
            ),
          },
          Date.now(),
        );
      }

      if (parsed.open) {
        try {
          const open = (await import('open')).default;
          await open(url);
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t('Browser opened'),
            },
            Date.now(),
          );
        } catch {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t(
                'Could not open browser automatically. Please visit {{url}}',
                {
                  url,
                },
              ),
            },
            Date.now(),
          );
        }
      }

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Press Ctrl+C to stop the server'),
        },
        Date.now(),
      );
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to start Web GUI server: {{error}}', {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};

interface WebArgs {
  port: number;
  host: string;
  open: boolean;
}

/**
 * Parse command arguments
 */
function parseWebArgs(args: string): WebArgs {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const result: WebArgs = {
    port: 5494,
    host: '127.0.0.1',
    open: true,
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];

    if ((part === '--port' || part === '-p') && nextPart) {
      const port = parseInt(nextPart, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        result.port = port;
      }
      i++;
    } else if ((part === '--host' || part === '-h') && nextPart) {
      result.host = nextPart;
      i++;
    } else if (part === '--no-open') {
      result.open = false;
    }
  }

  return result;
}
