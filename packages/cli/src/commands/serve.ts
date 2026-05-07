/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { runQwenServe } from '../serve/index.js';
import type { ServeMode } from '../serve/types.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

interface ServeArgs {
  port: number;
  hostname: string;
  token?: string;
  'http-bridge': boolean;
  httpBridge: boolean;
}

export const serveCommand: CommandModule<unknown, ServeArgs> = {
  command: 'serve',
  describe:
    'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        default: 4170,
        description: 'TCP port to bind',
      })
      .option('hostname', {
        type: 'string',
        default: '127.0.0.1',
        description:
          'Interface to bind. Anything beyond 127.0.0.1/localhost requires a token.',
      })
      .option('token', {
        type: 'string',
        description:
          'Bearer token required on every request. Falls back to the QWEN_SERVER_TOKEN env var.',
      })
      .option('http-bridge', {
        type: 'boolean',
        default: true,
        description:
          'Stage 1 mode: per-session `qwen --acp` child process behind the HTTP routes. ' +
          'Stage 2 native in-process mode is not yet implemented; this flag will become opt-in then.',
      }) as unknown as Argv<ServeArgs>,
  handler: async (argv) => {
    const mode: ServeMode = argv.httpBridge ? 'http-bridge' : 'native';
    if (mode === 'native') {
      writeStderrLine(
        'qwen serve: --no-http-bridge (native mode) is not yet implemented; ' +
          'falling back to http-bridge.',
      );
    }
    try {
      await runQwenServe({
        port: argv.port,
        hostname: argv.hostname,
        token: argv.token,
        mode: 'http-bridge',
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    // Block here so yargs `parse()` never resolves and we never fall through
    // to the interactive-mode path in gemini.tsx. The listener's SIGINT/SIGTERM
    // handlers in runQwenServe are the sole exit route.
    await new Promise<never>(() => {});
  },
};
