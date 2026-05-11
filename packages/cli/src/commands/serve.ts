/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
// Type-only imports — no runtime cost. The serve module pulls in express +
// body-parser + qs + the daemon transport stack; static-importing it from
// here would tax every `qwen` invocation (interactive, mcp, channel, etc.)
// with ~50ms of cold ESM resolution. The runtime import is deferred to the
// handler below so it only loads when the user actually runs `qwen serve`.
import { writeStderrLine } from '../utils/stdioHelpers.js';

interface ServeArgs {
  port: number;
  hostname: string;
  token?: string;
  'max-sessions': number;
  // Read from the kebab-case key only — the camelCase mirror that yargs
  // synthesizes is convenient for handlers but type-confusing here. The
  // handler reads `argv['http-bridge']` directly.
  'http-bridge': boolean;
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
        description:
          'TCP port to bind (use 0 for an OS-assigned ephemeral port)',
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
      .option('max-sessions', {
        type: 'number',
        default: 20,
        description:
          'Cap on concurrent live sessions. New spawn requests beyond this return 503; ' +
          'attach to existing sessions still works. Set to 0 to disable.',
      })
      .option('http-bridge', {
        type: 'boolean',
        default: true,
        description:
          'Stage 1 mode: per-session `qwen --acp` child process behind the HTTP routes. ' +
          'Stage 2 native in-process mode is not yet implemented; this flag will become opt-in then.',
      }) as unknown as Argv<ServeArgs>,
  handler: async (argv) => {
    if (!argv['http-bridge']) {
      writeStderrLine(
        'qwen serve: --no-http-bridge (native mode) is not yet implemented; ' +
          'falling back to http-bridge.',
      );
    }
    if (argv.token) {
      // `--token` is visible to any local user via `/proc/<pid>/cmdline`
      // (Linux default; only suppressed under `hidepid=2`). Steer
      // operators toward the env-var path which uses
      // `/proc/<pid>/environ` (owner-only).
      writeStderrLine(
        'qwen serve: --token is visible in the process command line; ' +
          'prefer the QWEN_SERVER_TOKEN env var for any non-trivial ' +
          'deployment.',
      );
    }
    // Lazy-load the serve module so non-serve invocations don't pay for
    // express + body-parser + qs in their startup path.
    const { runQwenServe } = await import('../serve/index.js');
    try {
      await runQwenServe({
        port: argv.port,
        hostname: argv.hostname,
        token: argv.token,
        mode: 'http-bridge',
        maxSessions: argv['max-sessions'],
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
