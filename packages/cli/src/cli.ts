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
import {
  DEFAULT_COMMAND,
  DEFAULT_COMMAND_DESC,
  QUERY_POSITIONAL,
  TOP_LEVEL_DEPRECATED_OPTIONS,
  TOP_LEVEL_HELP_OPTIONS,
  TOP_LEVEL_USAGE,
} from './config/top-level-options.js';
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

function flagName(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

function optionAliases(config: Options): string[] {
  const alias = config.alias;
  if (!alias) {
    return [];
  }
  return typeof alias === 'string' ? [alias] : [...alias];
}

function optionFlagNames(option: string, config: Options): string[] {
  return [flagName(option), ...optionAliases(config).map(flagName)];
}

const VALUE_FLAGS = new Set(
  TOP_LEVEL_HELP_OPTIONS.flatMap(([option, config]) =>
    config.type === 'string' ||
    config.type === 'number' ||
    config.type === 'array'
      ? optionFlagNames(option, config)
      : [],
  ),
);
// Value-taking options registered outside TOP_LEVEL_HELP_OPTIONS: hidden options
// are inline-registered in config.ts and never appear in the help-display
// list. The scanner must still consume their values, otherwise the value
// becomes the first positional and defeats a later --help/--version fast path.
VALUE_FLAGS.add('--sandbox-session-id');

// The exact value-taking-flag spellings the pre-PR hasFlag scan hardcoded.
// hasVersionToken must skip value slots for THIS set only: flags that only
// the derived VALUE_FLAGS knows (--worktree, --proxy, -e, --auth-type,
// --session-id, --exclude-tools, ...) were absent from the base scan, so base
// COUNTED a `-v`/`--version` sitting in their value slot and printed the
// version. Skipping those slots here would drop the intercept and hand the
// argv to the full parser (corrupted `mcp add` settings writes, swallowed
// `-e` values, exit-1 Unknown-argument on `--proxy -v mcp remove ...`).
const BASE_VALUE_FLAGS = new Set([
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

// Every flag spelling the exact-token scanner is allowed to recognize: the
// full option/alias surface from the shared top-level definitions (same
// derivation pattern as VALUE_FLAGS) plus the help/version flags registered
// inline in the parser builder and the hidden options registered inline in
// config.ts. Anything outside this set can carry flag state the scanner
// cannot model.
const KNOWN_FAST_PATH_FLAGS = new Set(
  TOP_LEVEL_HELP_OPTIONS.flatMap(([option, config]) =>
    optionFlagNames(option, config),
  ),
);
for (const flag of ['--help', '-h', '--version', '-v']) {
  KNOWN_FAST_PATH_FLAGS.add(flag);
}
KNOWN_FAST_PATH_FLAGS.add('--sandbox-session-id');
// Hidden boolean options registered inline in config.ts; like the sandbox
// option above they are valid top-level flags the scanner should admit
// instead of demoting (e.g. `qwen --experimental-acp --help`).
KNOWN_FAST_PATH_FLAGS.add('--experimental-acp');
KNOWN_FAST_PATH_FLAGS.add('--experimental-skills');

function isValueToken(arg: string | undefined): arg is string {
  return arg !== undefined && arg !== '--' && !arg.startsWith('-');
}

// Structural fast-path gate. The exact-token scanner cannot model yargs'
// last-wins, order-dependent flag state, and every prior misfire class came
// from approximating it token-by-token (`--help --no-help`, `--version=false`,
// `---help`, ...). So instead of enumerating entrance classes, close the
// grammar: the help/version fast paths fire ONLY when every argv token is
// known-safe — an exact registered flag spelling from KNOWN_FAST_PATH_FLAGS,
// a value consumed by a value-taking flag, or `--` (everything after it is
// positional data). Any other token demotes to the slow path (the full
// parser itself — direction-safe by construction, it prints exactly what it
// would have printed anyway). The set stores only bare registered spellings,
// so the membership check alone rejects `=`-form resets (`--version=false`),
// `--no-` negations (`--help --no-help`), short-option clusters (`-dh`),
// three-plus-dash tokens (`---help`), and unknown flags — every shape
// yargs-parser treats specially and the scanner cannot model. Residual
// conservatism is intentional: value-taking options still consume at most
// ONE following token, so multi-value array invocations such as
// `--extensions a b --help` also demote to the slow path, which prints the
// same top-level options plus the full parser's command/positional sections.
function argvSafeForFastPath(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      return true; // the rest is positional data and cannot set flags
    }
    if (!token.startsWith('-')) {
      return false; // a positional breaks the flag-only fast-path grammar
    }
    if (!KNOWN_FAST_PATH_FLAGS.has(token)) {
      return false;
    }
    i = skipOptionValues(argv, i);
  }
  return true;
}

function skipOptionValues(argv: readonly string[], index: number): number {
  const raw = argv[index]!;
  const eq = raw.indexOf('=');
  const flag = eq === -1 ? raw : raw.slice(0, eq);
  if (!VALUE_FLAGS.has(flag)) {
    return index;
  }
  // At most one token: yargs detects commands in an early pass where these
  // options are still unknown (they are declared in the default command's
  // builder), and an unknown option takes at most one value there — a
  // `--flag=value` token carries its value inside itself and consumes none.
  // Consuming greedily would swallow a command token sitting after the
  // values and misfire the top-level help fast path on it.
  return eq === -1 && isValueToken(argv[index + 1]) ? index + 1 : index;
}

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
    // Base parity (mirrors hasVersionToken): the pre-PR scan skipped the
    // token after the base's hardcoded value flags unconditionally, even
    // the `--` sentinel, so `qwen --model -- --help` still routed to help.
    if (BASE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    i = skipOptionValues(argv, i);
    if (arg === long || arg === short) {
      return true;
    }
  }
  return false;
}

// True when argv carries a `-v`/`--version` token before any `--`.
// Mirrors the pre-PR hasFlag scan exactly: the token
// following one of the base's hardcoded value-taking flags
// (BASE_VALUE_FLAGS) is skipped unconditionally (even when it starts with
// `-`), so a version token sitting in one of THOSE value slots is NOT
// counted — `qwen -p -v -h` and `qwen --resume -v --help` printed
// top-level help on base, not the version. The derived VALUE_FLAGS set is
// deliberately NOT used here: flags it adds were absent from the base
// scan, which counted a version token in their value slot (`qwen --proxy
// -v ...` printed the version), so this scan must count it too. Tokens
// after `--` are positional data and never count.
function hasVersionToken(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      return false;
    }
    if (BASE_VALUE_FLAGS.has(arg)) {
      i++; // skip the value slot; the loop increment consumes the token
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      return true;
    }
  }
  return false;
}

async function buildTopLevelHelpParser() {
  const { default: yargs } = await import('yargs');
  const parser = yargs([])
    .locale('en')
    .scriptName('qwen')
    .usage(TOP_LEVEL_USAGE)
    .version(process.env['CLI_VERSION'] || 'unknown')
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .demandCommand(0, 0);

  for (const [option, config] of TOP_LEVEL_HELP_OPTIONS) {
    parser.option(option, config);
  }
  for (const [option, message] of Object.entries(
    TOP_LEVEL_DEPRECATED_OPTIONS,
  )) {
    parser.deprecateOption(option, message);
  }

  // Registered first, mirroring the real parser, so the rendered command list
  // leads with the default command and its `query` positional. Without it the
  // fast-path help silently dropped both the `[default]` row and the whole
  // Positionals section that the full parser prints.
  parser.command(DEFAULT_COMMAND, DEFAULT_COMMAND_DESC, (defaultCmd) =>
    defaultCmd.positional('query', QUERY_POSITIONAL),
  );

  for (const [command, description] of TOP_LEVEL_COMMANDS) {
    parser.command(command, description);
  }

  // Mirror config.ts, which wraps the rendered help at the terminal width;
  // without it yargs falls back to 80 columns.
  parser.wrap(parser.terminalWidth());

  return parser;
}

function firstPositionalArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      return undefined;
    }
    // Base parity: same unconditional BASE value-slot skip as hasFlag, so
    // a sentinel sitting in one of those slots never ends the scan early.
    if (BASE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    i = skipOptionValues(argv, i);
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

  // Base-parity version intercept (structural close). Base printed the
  // version for any `-v`/`--version` token its hasFlag scan reached, no
  // matter what else the argv carries — command-prefixed (`mcp remove
  // victim -v help`, `mcp add name cmd server.js -v`), help tokens
  // (`---help -v`, `-v help`, `--h -v`), real options with h-prefixed
  // names (`review fetch-pr … --host x -v`), option-shifted command argv
  // (`mcp --debug add … -v`). Verified by A/B probes against the base
  // binary. Printing the version is side-effect-free, while demoting to
  // the full parser EXECUTES subcommands (observed: `mcp remove victim -v
  // help` deleted the server and its OAuth creds on the full parser) — so
  // the fail-closed direction is to intercept. The scan mirrors base's
  // hasFlag exactly: it skips the value slot of the base's hardcoded
  // value-taking flags only (BASE_VALUE_FLAGS), so a version token
  // sitting in one of those slots is NOT counted (`qwen -p -v -h` and
  // `qwen --resume -v --help` printed top-level help on base, and
  // `qwen --model -v` demoted to the full parser). Flags the base scan
  // did not know (--worktree, --proxy, -e, --auth-type, ...) never
  // consumed a value slot there, so a version token in their value slot
  // WAS counted and IS intercepted here. The scan models no help state
  // (base printed the version for every other help-token sibling probed).
  // Escape surface: tokens after `--` (positional data, e.g. `mcp add
  // name cmd -- -v`, which the mcp fast path persists verbatim),
  // `=`-form tokens (`--model=-v` is one token, not an exact match), and
  // version tokens sitting in a BASE_VALUE_FLAGS value slot.
  if (hasVersionToken(argv)) {
    return 'version';
  }

  // Structural gate: unless every token is inside the known-safe grammar,
  // the help fast path demotes to the slow path (see argvSafeForFastPath).
  const fastPathSafe = argvSafeForFastPath(argv);

  const firstPositional = firstPositionalArg(argv);
  if (
    fastPathSafe &&
    hasFlag(argv, '--help', '-h') &&
    firstPositional === undefined
  ) {
    return 'help';
  }

  const firstArg = argv[0];
  if (firstArg === 'serve') {
    return 'serve';
  }
  // Version-bearing mcp argv never reaches here: the intercept above owns
  // every exact version token before `--`, and post-`--` tokens are
  // positional data the fast path persists verbatim.
  if (firstArg === 'mcp') {
    return 'mcp';
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
  const argv: readonly string[] = normalizeMcpFastPathArgv(
    normalizeServeFastPathArgv(rawArgv),
  );
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
