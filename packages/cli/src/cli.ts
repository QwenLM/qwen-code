/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArgumentsCamelCase, Argv, Options } from 'yargs';
import { normalizeServeFastPathArgv } from './utils/serve-fast-path-argv.js';
import { initStartupProfiler } from './utils/startupProfiler.js';
import { initCpuProfiler } from './utils/cpuProfiler.js';
import {
  handleUncaughtException,
  isExpectedPtyRaceError,
} from './utils/uncaught-exception-handler.js';

// Preserve the old entrypoint's profiling baseline before route-specific
// dynamic imports or command handling shift startup measurements.
initStartupProfiler();
initCpuProfiler();

type BootstrapRoute = 'serve' | 'mcp' | 'help' | 'version' | 'default';

export const TOP_LEVEL_COMMANDS = [
  ['auth', 'Configure authentication (removed)'],
  ['channel <command>', 'Manage messaging channels (Telegram, Discord, etc.)'],
  ['extensions <command>', 'Manage Qwen Code extensions.'],
  ['hooks', 'Manage Qwen Code hooks (use /hooks in interactive mode).'],
  ['mcp', 'Manage MCP servers'],
  [
    'review <command>',
    'Run a review non-interactively (`run`), plus the internal helpers used by the /review skill (PR worktree setup, context fetch, rules loading, presubmit checks, cleanup)',
  ],
  [
    'serve',
    'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
  ],
  ['sessions <command>', 'Manage Qwen Code sessions'],
  ['update', 'Check for Qwen Code updates and install if available'],
] as const;

export const MCP_COMMANDS = [
  ['add <name> <commandOrUrl> [args...]', 'Add a server'],
  ['remove <name>', 'Remove a server'],
  ['list', 'List all configured MCP servers'],
  ['reconnect [server-name]', 'Reconnect to MCP servers'],
  ['approve [name]', 'Approve a pending MCP server'],
  ['reject [name]', 'Reject a pending MCP server'],
] as const;

const TOP_LEVEL_HELP_OPTIONS = [
  ['model', { alias: 'm', type: 'string', description: 'Model' }],
  [
    'fallback-model',
    {
      type: 'array',
      description:
        'Fallback model(s) for capacity errors, repeatable or comma-separated (max 3)',
    },
  ],
  [
    'prompt',
    {
      alias: 'p',
      type: 'string',
      description: 'Prompt. Appended to input on stdin (if any).',
    },
  ],
  [
    'prompt-interactive',
    {
      alias: 'i',
      type: 'string',
      description:
        'Execute the provided prompt and continue in interactive mode',
    },
  ],
  [
    'safe-mode',
    {
      type: 'boolean',
      description:
        'Disable all customizations (context files, hooks, extensions, skills, MCP servers) for troubleshooting.',
    },
  ],
  [
    'sandbox',
    {
      alias: 's',
      type: 'boolean',
      description: 'Run in sandbox?',
    },
  ],
  [
    'output-format',
    {
      alias: 'o',
      type: 'string',
      choices: ['text', 'json', 'stream-json'],
      description: 'The format of the CLI output.',
    },
  ],
  [
    'continue',
    {
      alias: 'c',
      type: 'boolean',
      description: 'Resume the most recent session for the current project.',
    },
  ],
  [
    'resume',
    {
      alias: 'r',
      type: 'string',
      description:
        'Resume a specific session by its ID. Use without an ID to show session picker.',
    },
  ],
] as const satisfies ReadonlyArray<readonly [string, Options]>;

const VALUE_FLAGS = new Set([
  '--model',
  '-m',
  '--fallback-model',
  '--prompt',
  '-p',
  '--prompt-interactive',
  '-i',
  '--output-format',
  '-o',
  '--resume',
  '-r',
]);

function writeStdoutLine(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

function hasFlag(
  argv: readonly string[],
  long: string,
  short: string,
): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      return false;
    }
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === long || arg === short) {
      return true;
    }
  }
  return false;
}

async function buildTopLevelHelpParser() {
  const { default: yargs } = await import('yargs');
  const parser = yargs([])
    .scriptName('qwen')
    .usage(
      'Usage: qwen [options] [command]\n\nQwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
    )
    .version(process.env['CLI_VERSION'] || 'unknown')
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .demandCommand(0, 0);

  for (const [option, config] of TOP_LEVEL_HELP_OPTIONS) {
    parser.option(option, config);
  }

  for (const [command, description] of TOP_LEVEL_COMMANDS) {
    parser.command(command, description);
  }

  return parser;
}

function firstPositionalArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      return undefined;
    }
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
}

function normalizeMcpFastPathArgv(argv: readonly string[]): readonly string[] {
  if (argv[0] === 'mcp' && argv[1] === '--') {
    return [argv[0], ...argv.slice(2)];
  }
  return argv;
}

export function resolveBootstrapRoute(
  rawArgv: readonly string[],
): BootstrapRoute {
  const argv = normalizeServeFastPathArgv(rawArgv);

  if (hasFlag(argv, '--version', '-v')) {
    return 'version';
  }

  const firstArg = argv[0];
  if (firstArg === 'serve') {
    return 'serve';
  }
  if (firstArg === 'mcp') {
    return 'mcp';
  }

  const firstPositional = firstPositionalArg(argv);
  if (hasFlag(argv, '--help', '-h') && firstPositional === undefined) {
    return 'help';
  }

  return 'default';
}

async function printTopLevelHelp(): Promise<void> {
  const help = await (await buildTopLevelHelpParser()).getHelp();
  writeStdoutLine(help);
}

function printMcpHelp(): void {
  const lines = [
    'Usage: qwen mcp <command>',
    '',
    'Manage MCP servers',
    '',
    'Commands:',
    ...MCP_COMMANDS.map(
      ([command, description]) => `  qwen mcp ${command}  ${description}`,
    ),
  ];
  writeStdoutLine(lines.join('\n'));
}

async function printBootstrapVersion(): Promise<void> {
  if (process.env['CLI_VERSION']) {
    writeStdoutLine(process.env['CLI_VERSION']);
    return;
  }

  const { getCliVersion } = await import('./utils/version.js');
  writeStdoutLine(await getCliVersion());
}

async function runMcpFastPath(rawArgv: readonly string[]): Promise<void> {
  const argv = normalizeMcpFastPathArgv(normalizeServeFastPathArgv(rawArgv));
  const hasSubcommand = argv.length > 1 && !argv[1]!.startsWith('-');
  if (!hasSubcommand) {
    printMcpHelp();
    return;
  }

  const [{ default: yargsInstance }, { mcpCommand }] = await Promise.all([
    import('yargs'),
    import('./commands/mcp.js'),
  ]);

  const parser = yargsInstance([])
    .scriptName('qwen')
    .command(mcpCommand)
    .version(false)
    .help()
    .alias('h', 'help')
    .strict()
    .strictCommands()
    .demandCommand(1, 'You need at least one command before continuing.')
    .fail((message: string | null, error: Error | undefined, yargs: Argv) => {
      writeStderrLine(message || error?.message || 'Unknown argument error');
      yargs.showHelp();
      process.exitCode = 1;
    })
    .exitProcess(false);

  if (hasFlag(argv.slice(2), '--help', '-h')) {
    await parseYargsHelp(parser, argv);
    return;
  }

  await parseYargsCommand(parser, argv);
}

async function parseYargsHelp(
  parser: Argv,
  argv: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    parser.parse(
      argv,
      (error: Error | undefined, _argv: ArgumentsCamelCase, output: string) => {
        if (output) {
          writeStdoutLine(output);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

async function parseYargsCommand(
  parser: Argv,
  argv: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve) => {
    parser.parse(
      argv,
      (error: Error | undefined, _argv: ArgumentsCamelCase, output: string) => {
        if (output) {
          writeStdoutLine(output);
        }
        if (error) {
          writeStderrLine(error.message);
          process.exitCode = 1;
        }
        resolve();
      },
    );
  });
}

export async function runCliEntry(
  rawArgv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const managedUpdateVersion =
    process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'];
  if (managedUpdateVersion) {
    delete process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'];
    delete process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'];
    const { installManagedNpmUpdate } = await import(
      './utils/managed-npm-update.js'
    );
    await installManagedNpmUpdate(managedUpdateVersion);
    return;
  }

  const argv = normalizeServeFastPathArgv(rawArgv);
  const route = resolveBootstrapRoute(argv);
  if (route !== 'serve') {
    // This credential belongs only to `qwen serve`. Scrub it before any other
    // subcommand handler can start a child process during yargs parsing. The
    // serve route keeps it until either the fast path or full serve handler
    // has captured it into daemon-local options.
    delete process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'];
  }

  if (route === 'version') {
    await printBootstrapVersion();
    return;
  }

  if (route === 'serve') {
    const { tryRunServeFastPath } = await import('./serve/fast-path.js');
    if (await tryRunServeFastPath(argv)) {
      return;
    }
  } else if (route === 'mcp') {
    await runMcpFastPath(argv);
    return;
  } else if (route === 'help') {
    await printTopLevelHelp();
    return;
  }

  const acpStartupProfiler = rawArgv.some(
    (arg) => arg === '--acp' || arg === '--experimental-acp',
  )
    ? await import('./utils/acp-startup-profiler.js')
    : undefined;
  acpStartupProfiler?.initializeAcpStartupProfiler();
  acpStartupProfiler?.markAcpStartup('geminiImportStart');
  const { main } = await import('./llm.js');
  acpStartupProfiler?.markAcpStartup('geminiImportEnd');
  await main();
}

export async function handleCriticalError(error: unknown): Promise<void> {
  const [{ FatalError }, { AlreadyReportedError }] = await Promise.all([
    import('./utils/deferred-core-runtime.js'),
    import('./utils/errors.js'),
  ]);

  if (error instanceof FatalError) {
    let errorMessage = error.message;
    if (!process.env['NO_COLOR']) {
      errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
    }
    writeStderrLine(errorMessage);
    process.exit(error.exitCode);
  }
  if (error instanceof AlreadyReportedError) {
    process.exit(error.exitCode);
  }
  writeStderrLine('An unexpected critical error occurred:');
  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
  } else {
    writeStderrLine(String(error));
  }
  process.exit(1);
}

function writeStderrLine(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

/**
 * The entry a subprocess should call to reach THIS build, consumed by shell
 * children as `"${QWEN_CODE_CLI:-qwen}"` (see getShellContextEnvVars in core).
 * The npm bin wrapper (scripts/cli-entry.js) stamps installed launches, but a
 * workspace launch — a direct `node dist/index.js` — never passes through
 * it (the npm `start` and `dev` scripts stamp QWEN_CODE_CLI in their own
 * launchers), so every skill shell-out resolved `qwen` off PATH: a different
 * install, silently.
 *
 * Stamps the bin entry (dist/index.js), not this module: cli.ts compiles to
 * dist/src/cli.js, which carries no shebang, and the spawn-time filter blanks
 * an entry a shell cannot exec. Skipped when the derived path does not exist
 * (dev runs execute .ts sources with no built entry; the bare-`qwen` fallback
 * is the pre-existing behavior there) and when the module was not loaded from
 * the filesystem at all — under test runners, Vite statically rewrites the
 * new URL(…, import.meta.url) expression to a non-file URL, and the stamp
 * must never take the CLI down.
 *
 * The execute bit is granted here when missing, best-effort: the stamped file
 * must be shell-execable, but tsc emits dist/index.js as 0644 and only npm's
 * bin-link ever chmods it — on a plain `npm run build` checkout the spawn
 * filter would blank the stamp and the version skew this exists to fix would
 * survive. A failed chmod keeps the old fallback: the filter writes '' and
 * subprocesses run `qwen`.
 *
 * First writer wins, unlike the wrapper's unconditional assignment: an
 * already-set value may come from an outer launcher in THIS process —
 * cli-entry.js selecting a standalone shim, or the desktop app's vendored
 * bundle — which knows launch details this module cannot see and must not be
 * overwritten. The cost is that a value inherited from a PARENT qwen session
 * also survives, since the two cases are indistinguishable here; the primary
 * skew scenario — a workspace launch from a plain terminal — has the slot
 * unset either way. Empty counts as unset: a parent session's spawn filter
 * writes '' for an entry its shell could not exec, and that verdict is about
 * the parent's entry, not this build's.
 *
 * scripts/dev.js and scripts/start.js assign QWEN_CODE_CLI unconditionally —
 * the opposite policy on purpose, not an oversight: those files ARE the outer
 * launcher (they spawn the CLI as a child and must re-point an inherited value
 * at this build), whereas this module runs in-process AFTER an outer launcher
 * may already have stamped, so it yields. The bundled `node dist/cli.js` launch
 * (the desktop error message's instruction) is not stamped either — cli.js sits
 * at the package root, so the derived ../index.js does not exist and the
 * existence check skips it, consistent with this PR's workspace-entry scope.
 */
export function stampCliEntryEnv(entryPath?: string): void {
  if (process.env['QWEN_CODE_CLI']) {
    return;
  }
  let entry = entryPath;
  if (entry === undefined) {
    // dist/src/cli.js → dist/index.js. In dev (src/cli.ts) this lands on the
    // unbuilt packages/cli/index.js and the existence check below skips it.
    const entryUrl = new URL('../index.js', import.meta.url);
    if (entryUrl.protocol !== 'file:') {
      return;
    }
    entry = fileURLToPath(entryUrl);
  }
  if (existsSync(entry)) {
    try {
      accessSync(entry, constants.X_OK);
    } catch {
      try {
        // Add exec bits to whatever mode the build/umask chose, rather than
        // setting 0o755 — a deliberately-private 0o600 checkout becomes
        // execable without also becoming world-readable.
        chmodSync(entry, statSync(entry).mode | 0o111);
      } catch {
        // Not chmoddable (read-only checkout): the spawn filter blanks the
        // stamp and subprocesses fall back to `qwen`, as before this stamp.
      }
    }
    process.env['QWEN_CODE_CLI'] = entry;
  }
}

// handleUncaughtException and isExpectedPtyRaceError live in
// ./utils/uncaught-exception-handler.js and are re-exported here for existing
// importers (cli.test.ts). llm.tsx must import them from that leaf module
// directly: a static import of this entry file from a module the bundle loads
// lazily makes esbuild hoist this entry into a shared chunk, which silently
// disables the bootstrap guard at the bottom.
export { handleUncaughtException, isExpectedPtyRaceError };

export async function runCliEntryPoint(
  run: () => Promise<void> = runCliEntry,
  handleError: (error: unknown) => Promise<void> = handleCriticalError,
): Promise<void> {
  stampCliEntryEnv();

  process.on('uncaughtException', handleUncaughtException);

  try {
    await run();
  } catch (error) {
    try {
      await handleError(error);
    } catch (handlerError) {
      writeStderrLine('An unexpected critical error occurred:');
      writeStderrLine('Original error:');
      if (error instanceof Error) {
        writeStderrLine(error.stack ?? error.message);
      } else {
        writeStderrLine(String(error));
      }
      writeStderrLine('Error handler failed:');
      if (handlerError instanceof Error) {
        writeStderrLine(handlerError.stack ?? handlerError.message);
      } else {
        writeStderrLine(String(handlerError));
      }
      process.exit(1);
    }
  }
}

let isMain = false;
if (process.argv[1] !== undefined) {
  try {
    const argvRealHref = pathToFileURL(realpathSync(process.argv[1])).href;
    const argvHref = pathToFileURL(process.argv[1]).href;
    isMain = import.meta.url === argvHref || import.meta.url === argvRealHref;
  } catch {
    isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain) {
  void runCliEntryPoint();
}
