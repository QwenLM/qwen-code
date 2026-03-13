/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { RemoteControlServer } from '../../remote-control/server/RemoteControlServer.js';
import qrcode from 'qrcode-terminal';

let remoteControlServer: RemoteControlServer | null = null;

/**
 * Get the current remote control server instance
 */
function getServer(): RemoteControlServer | null {
  return remoteControlServer;
}

/**
 * Set the remote control server instance
 */
function setServer(server: RemoteControlServer | null): void {
  remoteControlServer = server;
}

export const remoteControlCommand: SlashCommand = {
  name: 'remote-control',
  get description() {
    return t(
      'Start a remote control server to connect to this session from a browser',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const executionMode = context.executionMode ?? 'interactive';

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    // Check if already running
    const existingServer = getServer();
    if (existingServer) {
      const connectionInfo = existingServer.getConnectionInfo();

      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Remote control server is already running.\n\n' +
            'Connect using:\n' +
            `  WebSocket: ${connectionInfo.url}\n` +
            `  Token: ${connectionInfo.token}\n\n` +
            'Stop with: /remote-control stop',
        ),
      };
    }

    // Parse arguments for custom port or session name
    const portMatch = args.match(/--port[= ](\d+)/);
    const nameMatch = args.match(/--name[= ](["']?)(.+?)\1/);
    const stopArg = args.trim() === 'stop';

    // Handle stop command
    if (stopArg) {
      const server = getServer();
      if (!server) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('Remote control server is not running.'),
        };
      }

      try {
        await server.stop();
        setServer(null);

        return {
          type: 'message',
          messageType: 'info',
          content: t('Remote control server stopped.'),
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to stop remote control server: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    // Start the server
    try {
      const port = portMatch ? parseInt(portMatch[1], 10) : 7373;
      const sessionName = nameMatch ? nameMatch[2] : undefined;

      const server = new RemoteControlServer({
        port,
        host: 'localhost',
        sessionName,
      });

      // Initialize with Qwen Code config
      await server.initialize(config);

      // Start the server
      await server.start();

      setServer(server);

      const connectionInfo = server.getConnectionInfo();

      // Generate QR code for easy connection
      const qrCodeUrl = `${connectionInfo.url}?token=${connectionInfo.token}`;

      let qrCodeDisplay = '';
      try {
        qrCodeDisplay = await new Promise<string>((resolve) => {
          qrcode.generate(qrCodeUrl, { small: true }, (code: string) => {
            resolve(code);
          });
        });
      } catch (_error) {
        // QR code generation failed, but that's OK
        qrCodeDisplay = '';
      }

      const message =
        t('Remote Control Server Started!\n\n') +
        t('Connect to this session from your browser or mobile device.\n\n') +
        t(
          'Security Notice: For production use, enable WSS (WebSocket Secure).\n\n',
        ) +
        (qrCodeDisplay ? `${qrCodeDisplay}\n` : '') +
        t('Connection Details:\n') +
        t('  WebSocket URL: {{url}}\n', { url: connectionInfo.url }) +
        t('  Auth Token: {{token}}\n', { token: connectionInfo.token }) +
        t('  Port: {{port}}\n', { port: port.toString() }) +
        t('\nNote: Enter the auth token when prompted after connecting.\n\n') +
        t('Stop the server with: /remote-control stop\n');

      // Display in UI if interactive
      if (executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: 'info',
            text: message,
          },
          Date.now(),
        );
      }

      return {
        type: 'message',
        messageType: 'info',
        content: message,
      };
    } catch (error) {
      setServer(null);

      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to start remote control server: {{error}}', {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};

/**
 * Get the running remote control server instance
 */
export function getRemoteControlServer(): RemoteControlServer | null {
  return getServer();
}

/**
 * Set the remote control server instance (for testing)
 */
export function setRemoteControlServer(
  server: RemoteControlServer | null,
): void {
  setServer(server);
}
