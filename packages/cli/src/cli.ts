/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { pathToFileURL } from 'node:url';
import type { ArgumentsCamelCase, Argv } from 'yargs';
import { normalizeServeFastPathArgv } from './serve/fast-path-argv.js';

type BootstrapRoute = 'serve' | 'mcp' | 'help' | 'version' | 'default';

export const TOP_LEVEL_COMMANDS = [
  ['auth', 'Configure authentication (removed)'],
  ['channel <command>', 'Manage messaging channels (Telegram, Discord, etc.)'],
  ['extensions <command>', 'Manage Qwen Code extensions.'],
  ['hooks', 'Manage Qwen Code hooks (use /hooks in interactive mode).'],
  ['mcp', 'Manage MCP servers'],
  [
    'review <command>',
    'Internal helpers used by the /review skill (PR worktree setup, context fetch, rules loading, presubmit checks, cleanup)',
  ],
  [
    'serve',
    'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
  ],
  ['sessions <command>', 'Manage Qwen Code sessions'],
] as const;

const MCP_COMMANDS = [
  ['add <name> <commandOrUrl> [args...]', 'Add a server'],
  ['remove <name>', 'Remove a server'],
  ['list', 'List all configured MCP servers'],
  ['reconnect [server-name]', 'Reconnect to MCP servers'],
  ['approve [name]', 'Approve a pending MCP server'],
  ['reject [name]', 'Reject a pending MCP server'],
] as const;

function writeStdoutLine(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

function hasFlag(
  argv: readonly string[],
  long: string,
  short: string,
): boolean {
  for (const arg of argv) {
    if (arg === '--') {
      return false;
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

  for (const [command, description] of TOP_LEVEL_COMMANDS) {
    parser.command(command, description);
  }

  return parser;
}

function firstPositionalArg(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg === '--') {
      return undefined;
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
}

export function resolveBootstrapRoute(
  rawArgv: readonly string[],
): BootstrapRoute {
  const argv = normalizeServeFastPathArgv(rawArgv);

  if (hasFlag(argv, '--version', '-v')) {
    return 'version';
  }

  const firstPositional = firstPositionalArg(argv);
  if (firstPositional === 'serve') {
    return 'serve';
  }
  if (firstPositional === 'mcp') {
    return 'mcp';
  }

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
  const argv = normalizeServeFastPathArgv(rawArgv);
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
    .exitProcess(false);

  if (hasFlag(argv.slice(2), '--help', '-h')) {
    await parseYargsHelp(parser, argv);
    return;
  }

  await parser.parseAsync(argv);
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

async function initializeProfilers(): Promise<void> {
  const [{ initStartupProfiler }, { initCpuProfiler }] = await Promise.all([
    import('./utils/startupProfiler.js'),
    import('./utils/cpuProfiler.js'),
  ]);
  initStartupProfiler();
  initCpuProfiler();
}

export async function runCliEntry(
  rawArgv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const argv = normalizeServeFastPathArgv(rawArgv);
  const route = resolveBootstrapRoute(argv);

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

  await initializeProfilers();
  const { main } = await import('./gemini.js');
  await main();
}

function getErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isExpectedPtyRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  const code = getErrnoCode(error);

  if (
    (code === 'EIO' && message.includes('read')) ||
    message.includes('read EIO')
  ) {
    return true;
  }

  if (
    (code === 'EAGAIN' && message.includes('read')) ||
    message.includes('read EAGAIN')
  ) {
    return true;
  }

  return (
    message.includes('ioctl(2) failed, EBADF') ||
    message.includes('Cannot resize a pty that has already exited')
  );
}

async function handleCriticalError(error: unknown): Promise<void> {
  const [{ FatalError }, { AlreadyReportedError }] = await Promise.all([
    import('@qwen-code/qwen-code-core'),
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

export async function runCliEntryPoint(): Promise<void> {
  process.on('uncaughtException', (error) => {
    if (isExpectedPtyRaceError(error)) {
      return;
    }

    if (error instanceof Error) {
      writeStderrLine(error.stack ?? error.message);
    } else {
      writeStderrLine(String(error));
    }
    process.exit(1);
  });

  await runCliEntry().catch((error: unknown) => {
    void handleCriticalError(error).catch((handlerError: unknown) => {
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
    });
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCliEntryPoint();
}
