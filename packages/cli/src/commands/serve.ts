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

/**
 * Pause the current async function indefinitely. Used after the daemon
 * listener is up so yargs `parse()` never resolves — if it did, the
 * top-level CLI would fall through to the interactive (TUI) entry point
 * in `gemini.tsx`. SIGINT / SIGTERM in `runQwenServe` is the sole exit
 * route. Named so a future maintainer doesn't read the bare
 * `new Promise<never>(() => {})` as a bug (BRQQZ).
 */
function blockForever(): Promise<never> {
  return new Promise<never>(() => {});
}

interface ServeArgs {
  port: number;
  hostname: string;
  token?: string;
  'max-sessions': number;
  'max-connections': number;
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
          'Interface to bind. Loopback (127.0.0.1, localhost, ::1, [::1]) is auth-free; anything else requires a token.',
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
      .option('max-connections', {
        type: 'number',
        default: 256,
        description:
          'Listener-level TCP connection cap (server.maxConnections). Bounds raw ' +
          'sockets — slow/phantom SSE clients get rejected at accept time once full. ' +
          'Set to 0 to disable.',
      })
      .option('http-bridge', {
        type: 'boolean',
        default: true,
        description:
          'Stage 1 mode: one `qwen --acp` child per workspace behind the HTTP routes, ' +
          "with multiple sessions multiplexed onto each child via the agent's native " +
          '`newSession()`. Stage 2 native in-process mode is not yet implemented; ' +
          'this flag will become opt-in then.',
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
        maxConnections: argv['max-connections'],
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    await blockForever();
  },
};
