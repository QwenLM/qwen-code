/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, Arguments } from 'yargs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { RemoteControlServer } from '../../remote-control/server/RemoteControlServer.js';
import { loadCliConfig } from '../../config/config.js';
import { loadSettings } from '../../config/settings.js';
import qrcode from 'qrcode-terminal';

let server: RemoteControlServer | null = null;

export const remoteControlCommand = {
  command: 'remote-control [name]',
  describe:
    'Start a remote control server to connect to this session from a browser',
  builder: (yargsInstance: Argv) =>
    yargsInstance
      .positional('name', {
        describe: 'Optional name for the session',
        type: 'string',
        default: undefined,
      })
      .option('port', {
        describe: 'Port to run the server on',
        type: 'number',
        default: 7373,
      })
      .option('host', {
        describe: 'Host to bind the server to',
        type: 'string',
        default: 'localhost',
      })
      .option('stop', {
        describe: 'Stop the running remote control server',
        type: 'boolean',
        default: false,
      })
      .example(
        '$0 remote-control',
        'Start remote control server on default port',
      )
      .example(
        '$0 remote-control "My Project"',
        'Start server with custom session name',
      )
      .example('$0 remote-control --port 8080', 'Start server on port 8080')
      .example('$0 remote-control --stop', 'Stop the running server'),
  handler: async (argv: Arguments) => {
    const stop = argv['stop'] as boolean;

    // Handle stop command
    if (stop) {
      if (!server) {
        // eslint-disable-next-line no-console
        console.log('Remote control server is not running.');
        return;
      }

      try {
        await server.stop();
        server = null;
        // eslint-disable-next-line no-console
        console.log('Remote control server stopped.');
        return;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          'Failed to stop remote control server:',
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      }
    }

    try {
      // Load configuration
      const settings = loadSettings();
      const config = await loadCliConfig(
        settings.merged,
        {
          query: undefined,
          model: undefined,
          sandbox: undefined,
          sandboxImage: undefined,
          debug: undefined,
          prompt: undefined,
          promptInteractive: undefined,
          yolo: undefined,
          approvalMode: undefined,
          telemetry: undefined,
          checkpointing: undefined,
          telemetryTarget: undefined,
          telemetryOtlpEndpoint: undefined,
          telemetryOtlpProtocol: undefined,
          telemetryLogPrompts: undefined,
          telemetryOutfile: undefined,
          allowedMcpServerNames: undefined,
          allowedTools: undefined,
          acp: undefined,
          experimentalAcp: undefined,
          experimentalLsp: undefined,
          experimentalHooks: undefined,
          extensions: undefined,
          listExtensions: undefined,
          openaiLogging: undefined,
          openaiApiKey: undefined,
          openaiBaseUrl: undefined,
          openaiLoggingDir: undefined,
          proxy: undefined,
          includeDirectories: undefined,
          tavilyApiKey: undefined,
          googleApiKey: undefined,
          googleSearchEngineId: undefined,
          webSearchDefault: undefined,
          screenReader: undefined,
          inputFormat: undefined,
          outputFormat: undefined,
          includePartialMessages: undefined,
          chatRecording: undefined,
          resume: undefined,
          sessionId: undefined,
          continue: undefined,
          maxSessionTurns: undefined,
          coreTools: undefined,
          excludeTools: undefined,
          authType: undefined,
          channel: undefined,
        },
        process.cwd(),
      );

      const port = argv['port'] as number;
      const host = argv['host'] as string;
      const name = argv['name'] as string | undefined;

      // Create and start server
      server = new RemoteControlServer({
        port,
        host,
        sessionName: name,
      });

      await server.initialize(config);
      await server.start();

      const connectionInfo = server.getConnectionInfo();

      // eslint-disable-next-line no-console
      console.log('\nRemote Control Server Started!\n');
      // eslint-disable-next-line no-console
      console.log(
        'Connect to this session from your browser or mobile device.\n',
      );
      // eslint-disable-next-line no-console
      console.log(
        'Security Notice: For production use, enable WSS (WebSocket Secure).\n',
      );

      try {
        await new Promise<void>((resolve) => {
          qrcode.generate(
            connectionInfo.url,
            { small: true },
            (code: string) => {
              // eslint-disable-next-line no-console
              console.log('Scan QR Code to connect:');
              // eslint-disable-next-line no-console
              console.log(code);
              resolve();
            },
          );
        });
      } catch (_error) {
        // QR code generation failed, but that's OK
      }

      // eslint-disable-next-line no-console
      console.log('Connection Details:');
      // eslint-disable-next-line no-console
      console.log(`  WebSocket URL: ${connectionInfo.url}`);
      // eslint-disable-next-line no-console
      console.log(`  Auth Token: ${connectionInfo.token}`);
      // eslint-disable-next-line no-console
      console.log(`  Port: ${connectionInfo.port}`);
      // eslint-disable-next-line no-console
      console.log(
        '\nNote: Enter the auth token when prompted after connecting.\n',
      );
      // eslint-disable-next-line no-console
      console.log('Press Ctrl+C to stop the server.\n');

      // Keep the process running
      process.on('SIGINT', async () => {
        // eslint-disable-next-line no-console
        console.log('\nShutting down remote control server...');
        if (server) {
          await server.stop();
          server = null;
        }
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        if (server) {
          await server.stop();
          server = null;
        }
        process.exit(0);
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        'Failed to start remote control server:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  },
};

// Allow running as standalone command
if (require.main === module) {
  yargs(hideBin(process.argv))
    .command(remoteControlCommand)
    .demandCommand(1)
    .help()
    .parse();
}
