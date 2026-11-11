/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCliSettingsService } from '../config/createCliSettingsService.js';

import type { AppPlugin } from '../app-plugins/types.js';
import type { SettingsService } from '@qwen-code/resource';
import type { StartFramework } from '../startup/frameworkFactory.js';
import {
  registerAppPluginRootOptions,
  registerAppPluginTerminalCommands,
  resolveAppPluginTerminalCommands,
  isAppPluginTerminalCommand,
} from '../app-plugins/commands.js';
import * as path from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import {
  Command,
  CommanderError,
  Option,
  InvalidArgumentError,
  type CommandUnknownOpts,
} from '@commander-js/extra-typings';
import {
  traceStartupStep,
  traceStartupStepAsync,
  BRAND_CLI_BIN,
  BRAND_CLI_NAME,
  BRAND_ENV_PREFIX,
  coreEvents,
  escapePath,
  getVersion,
  isHeadlessMode,
  runLogger,
  sessionLogger,
  startupProfiler,
  writeToStderr,
} from '@qwen-code/core';
import { createMcpCommand } from './mcp/index.js';
import { createPluginsCommand } from './plugins/index.js';
import { createSkillsCommand } from './skills/index.js';
import { createHooksCommand } from './hooks/index.js';
import { createAgentsCommand } from './agents/index.js';
import {
  damerauLevenshtein,
  findClosestCommand,
} from '../utils/commandSuggestion.js';
import {
  coerceCommaSeparated,
  coerceOptionalStringFlag,
} from '../utils/coerce.js';
import { normalizePermissionModeValue } from '../config/permissionMode.js';
import {
  applyEnvironmentDefaults,
  getStringArg,
  getTrimmedEnv,
} from '../config/cliEnvironment.js';
import {
  RootCommandExecutionError,
  StartupInputError,
  reportStartupInputError,
} from '../config/startupInputError.js';
import { stopParseArgsTimer } from '../utils/processStartClock.js';
import type { CliArgs } from '../config/config.js';
import {
  clearSettingsCache,
  loadEnvironment,
  getSettingsResolveOptions,
  restoreLoadedEnvironment,
  type LoadedSettings,
  type SettingSource,
} from '../config/settings.js';
import { isMultiSessionHost } from '../startup/determineStartupMode.js';
import { selectBuiltinExitOption } from '../startup/selectBuiltinExitOption.js';
import {
  resolveStartupWorkspace,
  type StartupWorkspace,
  type StartupWorkspaceArgs,
} from '../startup/startupWorkspace.js';

function readStartupWorkspaceArgs(
  program: CommandUnknownOpts,
  rawArgv: readonly string[],
  actionOptions: readonly Option[],
): StartupWorkspaceArgs | undefined {
  // 只复用 Commander 的参数名与参数个数，不执行校验回调、命令或环境默认值。
  // 单独的解析器避免污染正式解析的累加参数和 option 来源。
  const probe = new Command()
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('-h, --help');
  for (const option of program.options)
    probe.addOption(new Option(option.flags));
  for (const command of program.commands) {
    probe.addCommand(new Command(command.name()).aliases(command.aliases()));
  }
  let hasPluginAction = false;
  for (const option of actionOptions) {
    probe.on(`option:${option.name()}`, () => {
      hasPluginAction = true;
    });
  }
  try {
    const { operands } = probe.parseOptions([...rawArgv]);
    const opts = probe.opts() as Omit<StartupWorkspaceArgs, 'resume'> & {
      resume?: string | boolean;
      help?: boolean;
      version?: boolean;
    };
    if (
      opts.help ||
      opts.version ||
      hasPluginAction ||
      // 外部命令依赖项目 .env 完成发现，此时无法区分子命令与位置 prompt。
      // 等 Commander 确认进入根 action 后再处理，不能预先消费其 --resume。
      (operands.length > 0 &&
        (!isMultiSessionHost(opts) ||
          program.commands.some((command) =>
            getCommandNames(command).includes(operands[0]),
          )))
    ) {
      return undefined;
    }
    return {
      ...opts,
      resume: coerceOptionalStringFlag(opts.resume),
      sessionId:
        opts.sessionId ?? getTrimmedEnv(`${BRAND_ENV_PREFIX}SESSION_ID`),
    };
  } catch {
    // 缺少必需参数等错误交给正式解析统一报告。
    return undefined;
  }
}

function loadStartupSettings(
  resourceRoot: string,
  settingsService: SettingsService,
  settingSources?: readonly SettingSource[],
): LoadedSettings {
  return traceStartupStep('command_tree.settings', () => {
    const handle = startupProfiler.start('load_settings');
    const settings = settingsService.resolve(
      getSettingsResolveOptions(resourceRoot, settingSources),
    );
    handle?.end();
    settings.errors.forEach((error) =>
      coreEvents.emitFeedback('warning', error.message),
    );
    return settings;
  });
}

const PUBLIC_PERMISSION_MODE_VALUES = [
  'default',
  'accept_edits',
  'bypass_permissions',
  'dont_ask',
  'auto',
] as const;

function collect(val: string, prev: string[] | undefined): string[] {
  return prev ? [...prev, val] : [val];
}

function parseMaxTurns(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(
      '--max-turns must be a non-negative integer (0 disables the limit)',
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Command assembly helpers (moved from config.ts)
// ---------------------------------------------------------------------------

function getCommandNames(cmd: CommandUnknownOpts): string[] {
  const names = [cmd.name()];
  for (const alias of cmd.aliases()) {
    names.push(alias);
  }
  return names;
}

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--model',
  '--proxy',
  '--reasoning-effort',
  '--context-window',
  '-i',
  '--prompt-interactive',
  '-w',
  '--cwd',
  '--config-dir',
  '--workspace',
  '--worktree',
  '--permission-mode',
  '--allowed-mcp-server-names',
  '--tools',
  '--allowed-tools',
  '--disallowed-tools',
  '--permission-prompt-tool',
  '--attachment',
  '-e',
  '--extensions',
  '-o',
  '--output-format',
  '-f',
  '--input-format',
  '--max-output-tokens',
  '--fake-responses',
  '--record-responses',
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt',
  '--system-prompt-file',
  '--output-style',
  '--max-turns',
  '--max-model-request-retries',
  '--mcp-config',
  '--setting-sources',
  '--enable-builtin-skills',
  '--settings',
  '-r',
  '--resume',
  '--resume-session-at',
  '--resume-drops-turn',
  '-n',
  '--name',
  '--session-id',
  '--remote',
  '--delete-session',
  '--add-dir',
]);

function isExplicitHeadlessArgv(
  program: CommandUnknownOpts,
  rawArgv: readonly string[],
): boolean {
  // Parse option arity without dispatching commands or invoking option callbacks.
  // This also keeps flag-looking option values and tokens after `--` as data.
  const probe = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  for (const option of program.options) {
    probe.addOption(new Option(option.flags));
  }
  try {
    probe.parseOptions([...rawArgv]);
    const options = probe.opts() as {
      print?: boolean;
      prompt?: string;
      inputFormat?: string;
    };
    return Boolean(
      options['print'] ||
        options['prompt'] !== undefined ||
        options['inputFormat'] === 'stream-json',
    );
  } catch {
    // Report invalid argv through the real parser.
    return false;
  }
}

function buildAttachmentPrefix(
  attachments: string[] | undefined,
  baseDir: string,
): string {
  if (!attachments || attachments.length === 0) return '';

  const unique = new Set<string>();
  for (const attachment of attachments) {
    const trimmed = attachment.trim();
    if (!trimmed) continue;
    unique.add(
      path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed),
    );
  }

  const MAX_LEGACY_ATTACHMENTS = 5;
  if (unique.size > MAX_LEGACY_ATTACHMENTS) {
    throw new Error(
      `too many attachments, only ${MAX_LEGACY_ATTACHMENTS} allowed`,
    );
  }

  return Array.from(unique)
    .map((attachment) => `@${escapePath(attachment)}`)
    .join(' ');
}

function prependLegacyAttachments(
  text: string | undefined,
  attachmentPrefix: string,
): string | undefined {
  if (!attachmentPrefix) return text;
  if (!text) return attachmentPrefix;
  return `${attachmentPrefix} ${text}`.trim();
}

/**
 * Builds validated `CliArgs` from the raw Commander parse result.
 */
async function buildCliArgs(
  parsedResult: Record<string, unknown>,
  program: CommandUnknownOpts,
  rawArgv: readonly string[],
  suggestionCandidates: Array<{ name: string; aliases: readonly string[] }>,
): Promise<CliArgs> {
  const startupMessages: string[] = [];
  const deprecationWarnings: string[] = [];

  // Simulate yargs .strict() — reject unknown --flags that ended up in the
  // query positional due to allowUnknownOption(true).
  const queryRaw = parsedResult['query'] as string[] | undefined;
  if (queryRaw) {
    const unknownFlag = queryRaw.find(
      (arg) => arg.startsWith('--') && arg !== '--',
    );
    if (unknownFlag) {
      const flagName = unknownFlag.split('=')[0];
      await reportStartupInputError(`error: unknown option '${flagName}'`);
    }
  }

  // A single bare command-shaped token that matched no subcommand is likely a
  // mistyped command. When it is within edit distance 1 of a known command,
  // suggest the closest match and exit instead of silently sending the typo
  // to the model.
  const token = queryRaw?.length === 1 ? queryRaw[0] : undefined;
  const noCompetingIntent =
    !parsedResult['print'] &&
    !parsedResult['prompt'] &&
    !parsedResult['promptInteractive'] &&
    !parsedResult['continue'] &&
    !parsedResult['resume'] &&
    process.stdout.isTTY &&
    !rawArgv.includes('--');
  if (
    token !== undefined &&
    /^[a-zA-Z][a-zA-Z-]*$/.test(token) &&
    noCompetingIntent
  ) {
    const knownNames = new Set(
      suggestionCandidates.flatMap((candidate) => [
        candidate.name,
        ...candidate.aliases,
      ]),
    );
    const lower = token.toLowerCase();
    const match =
      lower !== token && knownNames.has(lower)
        ? lower
        : findClosestCommand(lower, suggestionCandidates, {
            maxEditDistance: 1,
          });
    if (match) {
      sessionLogger.event({
        level: 'info',
        kind: 'cli',
        type: 'cli.unknown_command_suggestion',
        data: {
          input_length: token.length,
          suggestion: match,
          distance: damerauLevenshtein(lower, match),
        },
      });
      const cliBin = BRAND_CLI_BIN;
      writeToStderr(
        `✖ unknown command "${token}"\n` +
          `  └ Did you mean ${cliBin} ${match}?\n\n` +
          `Run ${cliBin} --help to list commands, or ` +
          `${cliBin} -i "${token}" to send as a prompt.\n`,
      );
      sessionLogger.setExitContext({
        reason: 'input_error',
        exit_code: 1,
        message: `Unknown command: ${token}`,
        source: 'config.parseArgs',
      });
      throw new StartupInputError(`Unknown command: ${token}`);
    }
  }

  // Validate parsed options
  const opts = parsedResult;
  opts['explicitCliOptionNames'] = program.options
    .filter(
      (option) =>
        program.getOptionValueSource(option.attributeName()) === 'cli',
    )
    .map((option) => option.attributeName())
    .sort();
  opts['environmentOptionNames'] = applyEnvironmentDefaults(opts);

  if (opts['f'] && !opts['outputFormat']) {
    opts['outputFormat'] = opts['f'];
  }
  const outputFormat = opts['outputFormat'] as string | undefined;
  if (
    typeof outputFormat === 'string' &&
    !['text', 'json', 'stream-json'].includes(outputFormat)
  ) {
    await reportStartupInputError(
      `Invalid values:\n  Argument: output-format, Given: "${outputFormat}", Choices: "text", "json", "stream-json"`,
    );
  }

  const VALID_PERMISSION_MODES = [
    'default',
    'plan',
    'auto',
    'bypass_permissions',
    'accept_edits',
    'dont_ask',
  ];
  const rawPermissionMode = opts['permissionMode'];
  if (typeof rawPermissionMode === 'string') {
    opts['permissionMode'] = normalizePermissionModeValue(rawPermissionMode);
  }
  const permissionModeArg = opts['permissionMode'] as string | undefined;
  if (
    typeof permissionModeArg === 'string' &&
    !VALID_PERMISSION_MODES.includes(permissionModeArg)
  ) {
    await reportStartupInputError(
      `Invalid values:\n  Argument: permission-mode, Given: "${permissionModeArg}", Choices: ${VALID_PERMISSION_MODES.map((v) => `"${v}"`).join(', ')}`,
    );
  }

  const isProvided = (value: unknown) =>
    value !== undefined && value !== false && value !== '';
  const remoteModeCount = [
    opts['resume'],
    opts['continue'],
  ].filter(isProvided).length;
  if (remoteModeCount > 1) {
    await reportStartupInputError(
      'Cannot combine --continue, --resume, --remote, and --remote-session.',
    );
  }

  const queryArr = opts['query'] as string[] | undefined;
  const q: string | undefined =
    queryArr && queryArr.length > 0 ? queryArr.join(' ') : undefined;
  const promptArg = getStringArg(opts, 'prompt');
  const inputFormatArg = getStringArg(opts, 'inputFormat');
  const cwdArg = getStringArg(opts, 'cwd') || getStringArg(opts, 'workspace');
  if (cwdArg) {
    opts['cwd'] = cwdArg;
  }

  if (promptArg && q) {
    await reportStartupInputError(
      'Cannot use both a positional prompt and the --prompt flag together',
    );
  }

  if (promptArg && opts['promptInteractive']) {
    await reportStartupInputError(
      'Cannot use both --prompt and --prompt-interactive (-i) together',
    );
  }

  const shouldUseInteractivePrompt = !isHeadlessMode({
    prompt: promptArg,
    inputFormat: inputFormatArg,
    print: !!opts['print'],
  });

  if (q && !opts['prompt']) {
    if (shouldUseInteractivePrompt) {
      startupMessages.push(
        'Positional arguments now default to interactive mode. To run in non-interactive mode, use -p/--print.',
      );
      opts['promptInteractive'] = q;
    } else {
      opts['prompt'] = q;
    }
  }

  opts['query'] = q || undefined;
  opts['startupMessages'] = startupMessages;
  const usedDeprecatedPromptFlag = rawArgv.some(
    (arg) => arg === '--prompt' || arg.startsWith('--prompt='),
  );
  if (usedDeprecatedPromptFlag) {
    deprecationWarnings.push(
      'The --prompt flag is deprecated. Use -p/--print with a positional prompt or stdin.',
    );
  }
  opts['deprecationWarnings'] = deprecationWarnings;

  // Handle worktree coercion
  if (opts['worktree'] !== undefined) {
    const worktreeVal = opts['worktree'];
    if (worktreeVal === true || worktreeVal === '') {
      opts['worktree'] = Math.random().toString(36).substring(2, 10);
    } else if (typeof worktreeVal === 'string') {
      opts['worktree'] =
        worktreeVal.trim() || Math.random().toString(36).substring(2, 10);
    }
  }

  // Handle resume coercion: Commander returns true for --resume without value
  opts['resume'] = coerceOptionalStringFlag(opts['resume']);
  // Handle name coercion
  const rawName = opts['name'];
  if (rawName !== undefined && typeof rawName === 'string') {
    opts['name'] = rawName.trim();
  }
  // Coerce comma-separated arrays
  if (opts['allowedMcpServerNames']) {
    opts['allowedMcpServerNames'] = coerceCommaSeparated(
      opts['allowedMcpServerNames'] as string[],
    );
  }
  if (opts['extensions']) {
    opts['extensions'] = coerceCommaSeparated(opts['extensions'] as string[]);
  }
  if (opts['addDir']) {
    opts['addDir'] = coerceCommaSeparated(opts['addDir'] as string[]);
  }
  if (opts['settingSources']) {
    opts['settingSources'] = coerceCommaSeparated(
      opts['settingSources'] as string[],
    );
  }
  if (opts['enableBuiltinSkills']) {
    opts['enableBuiltinSkills'] = coerceCommaSeparated(
      opts['enableBuiltinSkills'] as string[],
    );
  }

  const attachmentBaseDir = cwdArg ?? process.cwd();
  const effectivePromptInteractiveArg = getStringArg(opts, 'promptInteractive');
  const effectivePromptArg = getStringArg(opts, 'prompt');
  const attachmentPrefix = buildAttachmentPrefix(
    (opts['attachment'] as string[] | undefined) ?? undefined,
    attachmentBaseDir,
  );
  if (attachmentPrefix) {
    if (!opts['prompt'] && !opts['promptInteractive'] && !q) {
      if (shouldUseInteractivePrompt) {
        opts['promptInteractive'] = attachmentPrefix;
      } else {
        opts['prompt'] = attachmentPrefix;
      }
    } else if (effectivePromptInteractiveArg) {
      opts['promptInteractive'] = prependLegacyAttachments(
        effectivePromptInteractiveArg,
        attachmentPrefix,
      );
      opts['query'] = prependLegacyAttachments(
        opts['query'] as string | undefined,
        attachmentPrefix,
      );
    } else if (effectivePromptArg) {
      opts['prompt'] = prependLegacyAttachments(
        effectivePromptArg,
        attachmentPrefix,
      );
    }
  }

  if (opts['dangerouslySkipPermissions'] || opts['yolo']) {
    opts['permissionMode'] = 'bypass_permissions';
  }

  return opts as unknown as CliArgs;
}

function propagateExitAndOutputSettings(cmd: CommandUnknownOpts): void {
  for (const child of cmd.commands) {
    child.configureOutput(cmd.configureOutput());
    child.configureHelp(cmd.configureHelp());
    child.exitOverride();
    propagateExitAndOutputSettings(child);
  }
}

/**
 * Builds the candidate pool for unknown-command typo suggestions from the
 * commands a user can actually discover: everything commander itself would
 * list in help (registered subcommands plus the implicit `help` command).
 * Internal commands are registered hidden, so they are excluded here for free
 * and can never be suggested.
 */
export function buildSuggestionCandidates(
  program: CommandUnknownOpts,
): Array<{ name: string; aliases: readonly string[] }> {
  const candidates = program
    .createHelp()
    .visibleCommands(program)
    .map((cmd) => ({ name: cmd.name(), aliases: cmd.aliases() as string[] }));
  // The root owns an action handler, so commander adds no implicit `help`
  // command to it; add the name explicitly so `hlep` still gets a suggestion.
  candidates.push({ name: 'help', aliases: [] });
  return candidates;
}

// ---------------------------------------------------------------------------
// Root command factory
// ---------------------------------------------------------------------------

export async function createCommand(
  settingsService: SettingsService = createCliSettingsService({
    environmentPolicy: 'session',
  }),
  declarations: ReadonlyArray<
    Pick<
      AppPlugin,
      'getTerminalCommands' | 'getRootOptions' | 'resolveTerminalCommands'
    >
  > = [],
  startFramework?: StartFramework,
): Promise<Command> {
  // --- Block A: root command creation ---

  const rawArgv = process.argv.slice(2);

  const program = new Command()
    .name(BRAND_CLI_BIN)
    .description(
      `${BRAND_CLI_NAME} - Defaults to interactive mode. Use -p/--print for non-interactive output.`,
    )
    .exitOverride()
    .configureOutput({
      writeErr: (str) => runLogger.error(str),
      writeOut: (str) => process.stdout.write(str),
    })
    .enablePositionalOptions()
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .argument('[query...]', 'Initial prompt.')
    .option('-d, --debug', 'Run in debug mode', false)
    .option(
      '-m, --model <model>',
      'Model for the current session. Default and New Models use model name; Custom uses modelID',
    )
    .addOption(
      new Option(
        '--proxy <url>',
        'Use an explicit proxy supplied by an SDK host',
      ).hideHelp(),
    )
    .option('--reasoning-effort <level>', 'Set reasoning effort level')
    .option(
      '--thinking <mode>',
      'Set thinking mode (auto, adaptive, enabled, or disabled)',
    )
    .option(
      '--thinking-budget <tokens>',
      'Set a fixed thinking token budget (implies --thinking enabled)',
    )
    .option(
      '--context-window <size>',
      'Explicit context window for supported models',
    )
    .addOption(
      new Option('--list-models', 'List available models for the current user'),
    )
    .addOption(
      new Option(
        '--prompt <text>',
        'Provide a prompt as an option value',
      ).hideHelp(),
    )
    .option(
      '-i, --prompt-interactive <text>',
      'Execute prompt and continue in interactive mode',
    )
    .option('-w, --cwd <dir>', 'Change working directory before startup')
    .option(
      '--config-dir <dir>',
      'Use a custom user-level config root for this run',
    )
    .addOption(new Option('--workspace <dir>').hideHelp())
    .option('--worktree [name]', 'Start in a new git worktree')
    .option(
      '--permission-mode <mode>',
      `Set the permission mode (choices: ${PUBLIC_PERMISSION_MODE_VALUES.join(', ')})`,
    )
    .option('--dangerously-skip-permissions', 'Bypass all permission checks')
    .addOption(
      new Option(
        '--messaging-socket-path <path>',
        'Bind cross-session peer messaging to a specific Unix socket path',
      ).hideHelp(),
    )
    .addOption(new Option('--yolo').hideHelp())
    .addOption(new Option('--acp', 'Starts the agent in ACP mode').hideHelp())
    .addOption(
      new Option(
        '--sdk',
        'Start the private SDK daemon protocol server',
      ).hideHelp(),
    )
    .option(
      '--allowed-mcp-server-names <name>',
      'Allowed MCP server names',
      collect,
    )
    .option(
      '--tools <tools...>',
      'Restrict available built-in tools ("" to disable all, "default" for all; use -p or -- to separate from query)',
    )
    .option('--allowed-tools <tool>', 'Tools to allow', collect)
    .option('--disallowed-tools <tool>', 'Tools to deny', collect)
    .addOption(
      new Option(
        '--permission-prompt-tool <tool>',
        'MCP tool or "stdio" for permission prompts',
      ).hideHelp(),
    )
    .option(
      '--attachment <file>',
      'Attach files to the initial prompt',
      collect,
    )
    .addOption(
      new Option('-e, --extensions <ext>', 'Extensions to use')
        .argParser(collect)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '-l, --list-extensions',
        'List all available extensions and exit',
      ).hideHelp(),
    )
    .option('--plugin-dir <dir>', 'Plugin directories to load', collect)
    .option('-c, --continue', 'Continue the most recent session')
    .option(
      '--fork-session',
      'Create a new session from a resumed conversation',
    )
    .option('-r, --resume [id]', 'Resume a previous session by identifier')
    .addOption(
      new Option(
        '--resume-session-at <uuid>',
        'Resume the conversation through a specific message UUID',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--resume-drops-turn <uuid>',
        'Guard a truncating resume against discarding another turn',
      ).hideHelp(),
    )
    .option('-n, --name <name>', 'Set a display name for this session')
    .option('--session-id <id>', 'Use a specific session ID')
    .option('--list-sessions', 'List available sessions and exit')
    .option('--delete-session <index>', 'Delete a session by index number')
    .option(
      '--add-dir <dir>',
      'Additional directories to include in the workspace',
      collect,
    )
    .addOption(new Option('--screen-reader').hideHelp())
    .addOption(new Option('--alternate-buffer').hideHelp())
    .option('-o, --output-format <format>', 'The format of the CLI output')
    .addOption(new Option('-f <format>').hideHelp())
    .option('--input-format <format>', 'The format of the CLI input')
    .addOption(new Option('-q, --quiet').default(false).hideHelp())
    .option('--max-output-tokens <size>', 'Set maximum model output tokens')
    .option(
      '-p, --print',
      'Print response and exit (non-interactive)',
      () => true,
    )
    .addOption(
      new Option(
        '--fake-responses <path>',
        'Path to fake model responses',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--record-responses <path>',
        'Path to record model responses',
      ).hideHelp(),
    )
    .addOption(new Option('--raw-output').hideHelp())
    .addOption(new Option('--accept-raw-output-risk').hideHelp())
    .addOption(
      new Option(
        '--include-partial-messages',
        'Include partial messages in stream-json',
      )
        .default(false)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--include-hook-events',
        'Include hook lifecycle events in stream-json output',
      )
        .default(false)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--session-mirror',
        'Emit transcript mirror frames for the Agent SDK',
      )
        .default(false)
        .hideHelp(),
    )
    .option(
      '--no-session-persistence',
      'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)',
    )
    .addOption(
      new Option(
        '--emit-reference-content',
        'Emit expanded @file reference content in stream-json user output',
      )
        .default(false)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--headless-fast-hooks',
        'Skip user hooks for this headless run',
      )
        .default(false)
        .hideHelp(),
    )
    .addOption(
      new Option('--bare', 'Start a minimal headless control session')
        .default(false)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--replay-user-messages',
        'Replay user messages in stream-json',
      )
        .default(false)
        .hideHelp(),
    )
    .option('--agent <name>', 'Agent for the current session')
    .option('--agents <json>', 'JSON object defining custom agents')
    .option(
      '--append-system-prompt <text>',
      'Append to the default system prompt',
    )
    .addOption(new Option('--append-system-prompt-file <path>').hideHelp())
    .option('--system-prompt <text>', 'System prompt for the session')
    .addOption(new Option('--system-prompt-file <path>').hideHelp())
    .option('--output-style <style>', 'Output style for this session')
    .addOption(
      new Option('--max-turns <count>', 'Maximum turns per query')
        .argParser(parseMaxTurns)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-model-request-retries <count>',
        'Maximum retries for Provider model requests',
      ),
    )
    .option(
      '--mcp-config <config>',
      'Load MCP servers from JSON file(s) or inline JSON',
      collect,
    )
    .option(
      '--strict-mcp-config',
      'Only use MCP servers from --mcp-config',
      false,
    )
    .addOption(
      new Option(
        '--allow-plugin-mcp',
        'Allow MCP servers from enabled plugins when using --strict-mcp-config',
      )
        .default(false)
        .hideHelp(),
    )
    .option(
      '--setting-sources <source>',
      'Setting sources to load (user, project, local)',
      collect,
    )
    .addOption(
      new Option(
        '--disable-builtin-skills',
        'Skip loading bundled/built-in skills',
      )
        .default(false)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--enable-builtin-skills <skills>',
        'Load only the named bundled/built-in skills (comma-separated or repeatable)',
      )
        .argParser(collect)
        .hideHelp(),
    )
    .option(
      '--settings <json>',
      'Load additional settings from a JSON file path or inline JSON string',
    )
    .version(await getVersion(), '-v, --version')
    .action(async (query, options) => {
      if (!builtinRootOptions.hasAction()) builtinRootOptions.validate(options);
      let cliArgs: CliArgs | undefined;
      if (builtinRootOptions.hasAction()) {
        const multiSessionHost = isMultiSessionHost(options);
        if (multiSessionHost) {
          // Discovery may have loaded project defaults before a plugin yields
          // to SDK/ACP. Validate these routes against the user environment.
          restoreLoadedEnvironment();
          loadStartupSettings(homedir(), settingsService, ['user']);
        }
        const validationOptions = { ...options };
        applyEnvironmentDefaults(validationOptions);
        const candidates = builtinRootOptions.validate(validationOptions);
        if (candidates.length > 0) {
          if (multiSessionHost) {
            // An eligible plugin (such as Worker) keeps its original workspace.
            restoreLoadedEnvironment();
            loadEnvironment(initialSettings.merged, initialResourceRoot);
          }
          // Normalize only after the action's environment has been selected.
          cliArgs = await buildCliArgs(
            { ...options, query },
            program,
            rawArgv,
            buildSuggestionCandidates(program),
          );
          const builtinExit = selectBuiltinExitOption(cliArgs);
          const productOwnsBuiltinExit =
            builtinExit !== undefined &&
            builtinRootOptions.replacedRootOptions.has(builtinExit);
          if (builtinExit === undefined || productOwnsBuiltinExit) {
            const action = builtinRootOptions.selectAction(candidates, {
              ...cliArgs,
            });
            if (action) {
              stopParseArgsTimer();
              try {
                await action(query);
              } catch (error) {
                if (error instanceof CommanderError) throw error;
                throw new RootCommandExecutionError(error);
              }
              return;
            }
          }
        }
      }
      if (!startupWorkspace) {
        // 环境仅用于命令发现。位置 prompt 确认属于根命令后，先撤销注入再解析
        // 会话，避免旧目录的环境值或 Settings 缓存泄漏到 Resume。
        restoreLoadedEnvironment();
        startupWorkspace = await resolveStartupWorkspace({
          ...options,
          resume: coerceOptionalStringFlag(options.resume),
          sessionId:
            options.sessionId ?? getTrimmedEnv(`${BRAND_ENV_PREFIX}SESSION_ID`),
        });
        if (
          path.resolve(startupWorkspace.resourceRoot) ===
          path.resolve(initialResourceRoot)
        ) {
          // 归属未变，只恢复解析期间撤销的环境；复用 Settings，避免重复迁移和告警。
          loadEnvironment(initialSettings.merged, initialResourceRoot);
        } else {
          clearSettingsCache();
          loadStartupSettings(
            startupWorkspace.resourceRoot,
            settingsService,
            isMultiSessionHost(options) ? ['user'] : undefined,
          );
          // A yielded action must not retain defaults from the previous workspace.
          cliArgs = undefined;
        }
      }
      const parsedResult = { ...options } as Record<string, unknown>;
      parsedResult['query'] = query;
      cliArgs ??= await buildCliArgs(
        parsedResult,
        program,
        rawArgv,
        buildSuggestionCandidates(program),
      );
      // argv is fully known here; the root command's startup tail follows.
      stopParseArgsTimer();
      // The startup tail is imported lazily so subcommand routes never pay for
      // the root command's module graph. Failures are tagged so main()'s
      // parse-error epilogue cannot mistake them for bad argv and drop their
      // exit code.
      const { handleRootCommand } = await traceStartupStepAsync(
        'command_tree.import_root_handler',
        () => import('../startup/rootCommandHandler.js'),
      );
      try {
        // main supplies the startup callback; parser-only callers stub the root handler.
        await handleRootCommand(
          cliArgs,
          startupWorkspace,
          settingsService,
          startFramework!,
        );
      } catch (error) {
        throw new RootCommandExecutionError(error);
      }
    });

  const builtinRootOptions = registerAppPluginRootOptions(
    program,
    declarations,
    settingsService,
    startFramework,
  );
  const explicitHeadless = isExplicitHeadlessArgv(program, rawArgv);
  // Commander selects subcommands before the root action. Explicit headless
  // input must reach that action even when the positional prompt is `login`.
  if (!explicitHeadless) {
    program
      .addCommand(createMcpCommand())
      .addCommand(createPluginsCommand())
      .addCommand(createSkillsCommand())
      .addCommand(createHooksCommand())
      .addCommand(createAgentsCommand());
    registerAppPluginTerminalCommands(
      program as unknown as Command,
      declarations,
      settingsService,
      startFramework,
    );
  }
  program.hook('preAction', async (_root, command) => {
    if (
      !startFramework ||
      command === program ||
      isAppPluginTerminalCommand(command)
    )
      return;
    // 普通子命令也进入同一个 Framework，但本地操作不启动登录或后台服务。
    const options = command.optsWithGlobals() as unknown as CliArgs;
    const input = {
      argv: options,
      settings: settingsService.resolve(
        getSettingsResolveOptions(process.cwd()),
      ),
      command: 'local' as const,
    };
    await startFramework('command', input);
  });

  const workspaceArgs = readStartupWorkspaceArgs(
    program,
    rawArgv,
    builtinRootOptions.actionOptions,
  );
  // CLI 负责启动设置及 .env；先读取，才能让会话探测看到环境中的 SESSION_ID。
  // 多会话宿主只读用户来源，不先加载启动目录的项目环境。
  const settingSources =
    workspaceArgs && isMultiSessionHost(workspaceArgs)
      ? (['user'] as const)
      : undefined;
  const launchResourceRoot = settingSources ? homedir() : process.cwd();
  const launchSettings = loadStartupSettings(
    launchResourceRoot,
    settingsService,
    settingSources,
  );
  if (workspaceArgs) {
    workspaceArgs.sessionId ??= getTrimmedEnv(`${BRAND_ENV_PREFIX}SESSION_ID`);
  }
  let startupWorkspace: StartupWorkspace | undefined = workspaceArgs
    ? await resolveStartupWorkspace(workspaceArgs)
    : undefined;
  const initialResourceRoot =
    startupWorkspace?.resourceRoot ?? launchResourceRoot;
  let initialSettings = launchSettings;
  if (path.resolve(initialResourceRoot) !== path.resolve(launchResourceRoot)) {
    // Resume / Worktree 换了归属，撤销旧目录环境后再加载；同目录直接复用。
    restoreLoadedEnvironment();
    clearSettingsCache();
    initialSettings = loadStartupSettings(
      initialResourceRoot,
      settingsService,
      settingSources,
    );
  }

  // Resolve product commands only after startup Settings and .env are loaded.
  await resolveAppPluginTerminalCommands(
    program as unknown as Command,
    declarations,
    {
      rawArgv: Object.freeze([...rawArgv]),
      explicitHeadless,
      valueOptionFlags: [
        ...GLOBAL_OPTIONS_WITH_VALUE,
        ...builtinRootOptions.valueOptionFlags,
      ],
    },
  );

  // commander's addCommand() — unlike the .command() factory — does not
  // propagate root settings to mounted commands, and the root is deliberately
  // lenient (allowUnknownOption, allowExcessArguments) so a full
  // copyInheritedSettings would leak that leniency to subcommands. After the
  // whole tree is assembled, one pass propagates only the exit and output
  // configuration from each parent to its descendants.
  propagateExitAndOutputSettings(program);

  return program as unknown as Command;
}
