/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';
import type { PermissionMode } from '../nonInteractive/types.js';
import {
  DEFAULT_PAIRING_TOKEN_TTL_MS,
  DEFAULT_REMOTE_CONTROL_PORT,
} from '../remoteControl/protocol.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';

interface RemoteControlArgs {
  host?: string;
  port?: number;
  allowLan?: boolean;
  cwd?: string;
  model?: string;
  approvalMode?: PermissionMode;
  noUi?: boolean;
  tokenTtl?: number;
}

function findCliEntryPath(): string {
  const mainModule = process.argv[1];
  if (!mainModule) {
    throw new Error('Cannot determine CLI entry path');
  }
  return path.resolve(mainModule);
}

export const remoteControlCommand: CommandModule<object, RemoteControlArgs> = {
  command: 'remote-control',
  aliases: ['rc'],
  describe: 'Start a local Qwen remote-control server',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('host', {
        type: 'string',
        default: '127.0.0.1',
        describe: 'Host interface to bind',
      })
      .option('port', {
        type: 'number',
        default: DEFAULT_REMOTE_CONTROL_PORT,
        describe: 'Port to listen on; use 0 for a random free port',
      })
      .option('allow-lan', {
        type: 'boolean',
        default: false,
        describe: 'Allow binding to non-loopback interfaces',
      })
      .option('cwd', {
        type: 'string',
        describe: 'Default working directory for new worker sessions',
      })
      .option('model', {
        type: 'string',
        describe: 'Default model for new worker sessions',
      })
      .option('approval-mode', {
        type: 'string',
        choices: ['default', 'plan', 'auto-edit', 'yolo'],
        describe: 'Default approval mode for worker sessions',
      })
      .option('no-ui', {
        type: 'boolean',
        default: false,
        describe: 'Disable the built-in browser UI and serve only the API',
      })
      .option('token-ttl', {
        type: 'number',
        default: Math.floor(DEFAULT_PAIRING_TOKEN_TTL_MS / 1000),
        describe: 'Pairing token TTL in seconds',
      }),
  handler: async (argv: ArgumentsCamelCase<RemoteControlArgs>) => {
    const { RemoteControlServer } = await import(
      '../remoteControl/RemoteControlServer.js'
    );
    const server = new RemoteControlServer({
      host: argv.host,
      port: argv.port,
      allowLan: argv.allowLan,
      noUi: argv.noUi,
      cwd: path.resolve(argv.cwd ?? process.cwd()),
      cliEntryPath: findCliEntryPath(),
      defaultModel: argv.model,
      defaultPermissionMode: argv.approvalMode,
      tokenTtlMs: Math.max(1, argv.tokenTtl ?? 300) * 1000,
    });

    const info = await server.start();
    writeStdoutLine('[Remote Control] Server started');
    writeStdoutLine(`[Remote Control] URL: ${info.url}`);
    writeStdoutLine(`[Remote Control] WebSocket: ${info.wsUrl}`);
    if (info.lanUrls.length > 0) {
      writeStdoutLine('[Remote Control] LAN URLs:');
      for (const url of info.lanUrls) {
        writeStdoutLine(`[Remote Control]   ${url}`);
      }
    }
    writeStdoutLine(`[Remote Control] Pairing token: ${info.pairingToken}`);
    writeStdoutLine(
      `[Remote Control] Pairing token expires at: ${info.pairingExpiresAt}`,
    );
    if (argv.allowLan) {
      writeStderrLine(
        '[Remote Control] LAN mode is enabled. Only share the pairing token with trusted devices on this network.',
      );
    }

    const shutdown = async () => {
      await server.stop();
      process.exit(0);
    };
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });

    await new Promise<void>(() => {});
  },
};
