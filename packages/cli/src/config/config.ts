/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  AuthType,
  Config,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  FileDiscoveryService,
  FileEncoding,
  getCurrentGeminiMdFilename,
  loadServerHierarchicalMemory,
  setGeminiMdFilename as setServerGeminiMdFilename,
  resolveTelemetrySettings,
  FatalConfigError,
  Storage,
  InputFormat,
  OutputFormat,
  isToolEnabled,
  SessionService,
  ideContextStore,
  type ResumedSessionData,
  type LspClient,
  type ToolName,
  EditTool,
  ShellTool,
  WriteFileTool,
  NativeLspClient,
  createDebugLogger,
  NativeLspService,
} from '@qwen-code/qwen-code-core';
import { extensionsCommand } from '../commands/extensions.js';
import type { Settings } from './settings.js';
import {
  resolveCliGenerationConfig,
  getAuthTypeFromEnv,
} from '../utils/modelConfigUtils.js';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

import { resolvePath } from '../utils/resolvePath.js';
import { getCliVersion } from '../utils/version.js';
import { loadSandboxConfig } from './sandboxConfig.js';
import { appEvents } from '../utils/events.js';
import { mcpCommand } from '../commands/mcp.js';

// UUID v4 regex pattern for validation
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates if a string is a valid UUID format
 * @param value - The string to validate
 * @returns True if the string is a valid UUID, false otherwise
 */
function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

import { isWorkspaceTrusted } from './trustedFolders.js';
import { buildWebSearchConfig } from './webSearch.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

const debugLogger = createDebugLogger('CONFIG');

const VALID_APPROVAL_MODE_VALUES = [
  'plan',
  'default',
  'auto-edit',
  'yolo',
] as const;

function formatApprovalModeError(value: string): Error {
  return new Error(
    `Invalid approval mode: ${value}. Valid values are: ${VALID_APPROVAL_MODE_VALUES.join(
      ', ',
    )}`,
  );
}

function parseApprovalModeValue(value: string): ApprovalMode {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'plan':
      return ApprovalMode.PLAN;
    case 'default':
      return ApprovalMode.DEFAULT;
    case 'yolo':
      return ApprovalMode.YOLO;
    case 'auto_edit':
    case 'autoedit':
    case 'auto-edit':
      return ApprovalMode.AUTO_EDIT;
    default:
      throw formatApprovalModeError(value);
  }
}

export interface CliArgs {
  query: string | undefined;
  model: string | undefined;
  sandbox: boolean | string | undefined;
  sandboxImage: string | undefined;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  yolo: boolean | undefined;
  approvalMode: string | undefined;
  telemetry: boolean | undefined;
  checkpointing: boolean | undefined;
  telemetryTarget: string | undefined;
  telemetryOtlpEndpoint: string | undefined;
  telemetryOtlpProtocol: string | undefined;
  telemetryLogPrompts: boolean | undefined;
  telemetryOutfile: string | undefined;
  allowedMcpServerNames: string[] | undefined;
  allowedTools: string[] | undefined;
  acp: boolean | undefined;
  experimentalAcp: boolean | undefined;
  experimentalLsp: boolean | undefined;
  extensions: string[] | undefined;
  listExtensions: boolean | undefined;
  openaiLogging: boolean | undefined;
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  openaiLoggingDir: string | undefined;
  proxy: string | undefined;
  includeDirectories: string[] | undefined;
  tavilyApiKey: string | undefined;
  googleApiKey: string | undefined;
  googleSearchEngineId: string | undefined;
  webSearchDefault: string | undefined;
  screenReader: boolean | undefined;
  vlmSwitchMode: string | undefined;
  inputFormat?: string | undefined;
  outputFormat: string | undefined;
  includePartialMessages?: boolean;
  /**
   * If chat recording is disabled, the chat history would not be recorded,
   * so --continue and --resume would not take effect.
   */
  chatRecording: boolean | undefined;
  /** Resume the most recent session for the current project */
  continue: boolean | undefined;
  /** Resume a specific session by its ID */
  resume: string | undefined;
  /** Specify a session ID without session resumption */
  sessionId: string | undefined;
  maxSessionTurns: number | undefined;
  coreTools: string[] | undefined;
  excludeTools: string[] | undefined;
  authType: string | undefined;
  channel: string | undefined;
}

function normalizeOutputFormat(
  format: string | OutputFormat | undefined,
): OutputFormat | undefined {
  if (!format) {
    return undefined;
  }
  if (format === OutputFormat.STREAM_JSON) {
    return OutputFormat.STREAM_JSON;
  }
  if (format === 'json' || format === OutputFormat.JSON) {
    return OutputFormat.JSON;
  }
  return OutputFormat.TEXT;
}

export async function parseArguments(): Promise<CliArgs> {
  let rawArgv = hideBin(process.argv);

  // hack: if the first argument is the CLI entry point, remove it
  if (
    rawArgv.length > 0 &&
    (rawArgv[0].endsWith('/dist/qwen-cli/cli.js') ||
      rawArgv[0].endsWith('/dist/cli.js') ||
      rawArgv[0].endsWith('/dist/cli/cli.js'))
  ) {
    rawArgv = rawArgv.slice(1);
  }

  const yargsInstance = yargs(rawArgv)
    .locale('en')
    .scriptName('qwen')
    .usage(
      'Usage: qwen [options] [command]\n\nQwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
    )
    .option('telemetry', {
      type: 'boolean',
      description:
        'Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.',
    })
    .option('telemetry-target', {
      type: 'string',
      choices: ['local', 'gcp'],
      description:
        'Set the telemetry target (local or gcp). Overrides settings files.',
    })
    .option('telemetry-otlp-endpoint', {
      type: 'string',
      description:
        'Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.',
    })
    .option('telemetry-otlp-protocol', {
      type: 'string',
      choices: ['grpc', 'http'],
      description:
        'Set the OTLP protocol for telemetry (grpc or http). Overrides settings files.',
    })
    .option('telemetry-log-prompts', {
      type: 'boolean',
      description:
        'Enable or disable logging of user prompts for telemetry. Overrides settings files.',
    })
    .option('telemetry-outfile', {
      type: 'string',
      description: 'Redirect all telemetry output to the specified file.',
    })
    .deprecateOption(
      'telemetry',
      'Use the "telemetry.enabled" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-target',
      'Use the "telemetry.target" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-otlp-endpoint',
      'Use the "telemetry.otlpEndpoint" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-otlp-protocol',
      'Use the "telemetry.otlpProtocol" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-log-prompts',
      'Use the "telemetry.logPrompts" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-outfile',
      'Use the "telemetry.outfile" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .option('debug', {
      alias: 'd',
      type: 'boolean',
      description: 'Run in debug mode?',
      default: false,
    })
    .option('proxy', {
      type: 'string',
      description: 'Proxy for Qwen Code, like schema://user:password@host:port',
    })
    .deprecateOption(
      'proxy',
      'Use the "proxy" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .option('chat-recording', {
      type: 'boolean',
      description:
        'Enable chat recording to disk. If false, chat history is not saved and --continue/--resume will not work.',
    })
    .command('$0 [query..]', 'Launch Qwen Code CLI', (yargsInstance: Argv) =>
      yargsInstance
        .positional('query', {
          description:
            'Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive.',
        })
        .option('model', {
          alias: 'm',
          type: 'string',
          description: `Model`,
        })
        .option('prompt', {
          alias: 'p',
          type: 'string',
          description: 'Prompt. Appended to input on stdin (if any).',
        })
        .option('prompt-interactive', {
          alias: 'i',
          type: 'string',
          description:
            'Execute the provided prompt and continue in interactive mode',
        })
        .option('sandbox', {
          alias: 's',
          type: 'boolean',
          description: 'Run in sandbox?',
        })
        .option('sandbox-image', {
          type: 'string',
          description: 'Sandbox image URI.',
        })
        .option('yolo', {
          alias: 'y',
          type: 'boolean',
          description:
            'Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?',
          default: false,
        })
        .option('approval-mode', {
          type: 'string',
          choices: ['plan', 'default', 'auto-edit', 'yolo'],
          description:
            'Set the approval mode: plan (plan only), default (prompt for approval), auto-edit (auto-approve edit tools), yolo (auto-approve all tools)',
        })
        .option('checkpointing', {
          type: 'boolean',
          description: 'Enables checkpointing of file edits',
          default: false,
        })
        .option('acp', {
          type: 'boolean',
          description: 'Starts the agent in ACP mode',
        })
        .option('experimental-acp', {
          type: 'boolean',
          description:
            'Starts the agent in ACP mode (deprecated, use --acp instead)',
          hidden: true,
        })
        .option('experimental-skills', {
          type: 'boolean',
          description:
            'Deprecated: Skills are now enabled by default. This flag is ignored.',
          hidden: true,
        })
        .option('experimental-lsp', {
          type: 'boolean',
          description:
            'Enable experimental LSP (Language Server Protocol) feature for code intelligence',
          default: false,
        })
        .option('channel', {
          type: 'string',
          choices: ['VSCode', 'ACP', 'SDK', 'CI'],
          description: 'Channel identifier (VSCode, ACP, SDK, CI)',
        })
        .option('allowed-mcp-server-names', {
          type: 'array',
          string: true,
          description: 'Allowed MCP server names',
          coerce: (mcpServerNames: string[]) =>
            // Handle comma-separated values
            mcpServerNames.flatMap((mcpServerName) =>
              mcpServerName.split(',').map((m) => m.trim()),
            ),
        })
        .option('allowed-tools', {
          type: 'array',
          string: true,
          description: 'Tools that are allowed to run without confirmation',
          coerce: (tools: string[]) =>
            // Handle comma-separated values
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('extensions', {
          alias: 'e',
          type: 'array',
          string: true,
          description:
            'A list of extensions to use. If not provided, all extensions are used.',
          coerce: (extensions: string[]) =>
            // Handle comma-separated values
            extensions.flatMap((extension) =>
              extension.split(',').map((e) => e.trim()),
            ),
        })
        .option('list-extensions', {
          alias: 'l',
          type: 'boolean',
          description: 'List all available extensions and exit.',
        })
        .option('include-directories', {
          type: 'array',
          string: true,
          description:
            'Additional directories to include in the workspace (comma-separated or multiple --include-directories)',
          coerce: (dirs: string[]) =>
            // Handle comma-separated values
            dirs.flatMap((dir) => dir.split(',').map((d) => d.trim())),
        })
        .option('openai-logging', {
          type: 'boolean',
          description:
            'Enable logging of OpenAI API calls for debugging and analysis',
        })
        .option('openai-logging-dir', {
          type: 'string',
          description:
            'Custom directory path for OpenAI API logs. Overrides settings files.',
        })
        .option('openai-api-key', {
          type: 'string',
          description: 'OpenAI API key to use for authentication',
        })
        .option('openai-base-url', {
          type: 'string',
          description: 'OpenAI base URL (for custom endpoints)',
        })
        .option('tavily-api-key', {
          type: 'string',
          description: 'Tavily API key for web search',
        })
        .option('google-api-key', {
          type: 'string',
          description: 'Google Custom Search API key',
        })
        .option('google-search-engine-id', {
          type: 'string',
          description: 'Google Custom Search Engine ID',
        })
        .option('web-search-default', {
          type: 'string',
          description:
            'Default web search provider (dashscope, tavily, google)',
        })
        .option('screen-reader', {
          type: 'boolean',
          description: 'Enable screen reader mode for accessibility.',
        })
        .option('vlm-switch-mode', {
          type: 'string',
          choices: ['once', 'session', 'persist'],
          description:
            'Default behavior when images are detected in input. Values: once (one-time switch), session (switch for entire session), persist (continue with current model). Overrides settings files.',
          default: process.env['VLM_SWITCH_MODE'],
        })
        .option('input-format', {
          type: 'string',
          choices: ['text', 'stream-json'],
          description: 'The format consumed from standard input.',
          default: 'text',
        })
        .option('output-format', {
          alias: 'o',
          type: 'string',
          description: 'The format of the CLI output.',
          choices: ['text', 'json', 'stream-json'],
        })
        .option('include-partial-messages', {
          type: 'boolean',
          description:
            'Include partial assistant messages when using stream-json output.',
          default: false,
        })
        .option('continue', {
          alias: 'c',
          type: 'boolean',
          description:
            'Resume the most recent session for the current project.',
          default: false,
        })
        .option('resume', {
          alias: 'r',
          type: 'string',
          description:
            'Resume a specific session by its ID. Use without an ID to show session picker.',
        })
        .option('session-id', {
          type: 'string',
          description: 'Specify a session ID for this run.',
        })
        .option('max-session-turns', {
          type: 'number',
          description: 'Maximum number of session turns',
        })
        .option('core-tools', {
          type: 'array',
          string: true,
          description: 'Core tool paths',
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('exclude-tools', {
          type: 'array',
          string: true,
          description: 'Tools to exclude',
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('allowed-tools', {
          type: 'array',
          string: true,
          description: 'Tools to allow, will bypass confirmation',
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('auth-type', {
          type: 'string',
          choices: [
            AuthType.USE_OPENAI,
            AuthType.USE_ANTHROPIC,
            AuthType.QWEN_OAUTH,
            AuthType.USE_GEMINI,
            AuthType.USE_VERTEX_AI,
          ],
          description: 'Authentication type',
        })
        .deprecateOption(
          'sandbox-image',
          'Use the "tools.sandbox" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'checkpointing',
          'Use the "general.checkpointing.enabled" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'prompt',
          'Use the positional prompt instead. This flag will be removed in a future version.',
        )
        // Ensure validation flows through .fail() for clean UX
        .fail((msg: string, err: Error | undefined, yargs: Argv) => {
          writeStderrLine(msg || err?.message || 'Unknown error');
          yargs.showHelp();
          process.exit(1);
        })
        .check((argv: { [x: string]: unknown }) => {
          // The 'query' positional can be a string (for one arg) or string[] (for multiple).
          // This guard safely checks if any positional argument was provided.
          const query = argv['query'] as string | string[] | undefined;
          const hasPositionalQuery = Array.isArray(query)
            ? query.length > 0
            : !!query;

          if (argv['prompt'] && hasPositionalQuery) {
            return 'Cannot use both a positional prompt and the --prompt (-p) flag together';
          }
          if (argv['prompt'] && argv['promptInteractive']) {
            return 'Cannot use both --prompt (-p) and --prompt-interactive (-i) together';
          }
          if (argv['yolo'] && argv['approvalMode']) {
            return 'Cannot use both --yolo (-y) and --approval-mode together. Use --approval-mode=yolo instead.';
          }
          if (
            argv['includePartialMessages'] &&
            argv['outputFormat'] !== OutputFormat.STREAM_JSON
          ) {
            return '--include-partial-messages requires --output-format stream-json';
          }
          if (
            argv['inputFormat'] === 'stream-json' &&
            argv['outputFormat'] !== OutputFormat.STREAM_JSON
          ) {
            return '--input-format stream-json requires --output-format stream-json';
          }
          if (argv['continue'] && argv['resume']) {
            return 'Cannot use both --continue and --resume together. Use --continue to resume the latest session, or --resume <sessionId> to resume a specific session.';
          }
          if (argv['sessionId'] && (argv['continue'] || argv['resume'])) {
            return 'Cannot use --session-id with --continue or --resume. Use --session-id to start a new session with a specific ID, or use --continue/--resume to resume an existing session.';
          }
          if (argv['sessionId'] && !isValidUUID(argv['sessionId'] as string)) {
            return `Invalid --session-id: "${argv['sessionId']}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`;
          }
          if (argv['resume'] && !isValidUUID(argv['resume'] as string)) {
            return `Invalid --resume: "${argv['resume']}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`;
          }
          return true;
        }),
    )
    // Register MCP subcommands
    .command(mcpCommand)
    // Register Extension subcommands
    .command(extensionsCommand);

  yargsInstance
    .version(await getCliVersion()) // This will enable the --version flag based on package.json
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .demandCommand(0, 0); // Allow base command to run with no subcommands

  yargsInstance.wrap(yargsInstance.terminalWidth());
  const result = await yargsInstance.parse();

  // If yargs handled --help/--version it will have exited; nothing to do here.

  // Handle case where MCP subcommands are executed - they should exit the process
  // and not return to main CLI logic
  if (
    result._.length > 0 &&
    (result._[0] === 'mcp' || result._[0] === 'extensions')
  ) {
    // MCP commands handle their own execution and process exit
    process.exit(0);
  }

  // Normalize query args: handle both quoted "@path file" and unquoted @path file
  const queryArg = (result as { query?: string | string[] | undefined }).query;
  const q: string | undefined = Array.isArray(queryArg)
    ? queryArg.join(' ')
    : queryArg;

  // Route positional args: explicit -i flag -> interactive; else -> one-shot (even for @commands)
  if (q && !result['prompt']) {
    const hasExplicitInteractive =
      result['promptInteractive'] === '' || !!result['promptInteractive'];
    if (hasExplicitInteractive) {
      result['promptInteractive'] = q;
    } else {
      result['prompt'] = q;
    }
  }

  // Keep CliArgs.query as a string for downstream typing
  (result as Record<string, unknown>)['query'] = q || undefined;

  // The import format is now only controlled by settings.memoryImportFormat
  // We no longer accept it as a CLI argument

  // Handle deprecated --experimental-acp flag
  if (result['experimentalAcp']) {
    writeStderrLine(
      '\x1b[33m⚠ Warning: --experimental-acp is deprecated and will be removed in a future release. Please use --acp instead.\x1b[0m',
    );
    // Map experimental-acp to acp if acp is not explicitly set
    if (!result['acp']) {
      (result as Record<string, unknown>)['acp'] = true;
    }
  }

  // Apply ACP fallback: if acp or experimental-acp is present but no explicit --channel, treat as ACP
  if ((result['acp'] || result['experimentalAcp']) && !result['channel']) {
    (result as Record<string, unknown>)['channel'] = 'ACP';
  }

  return result as unknown as CliArgs;
}

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalGeminiMemory(
  currentWorkingDirectory: string,
  includeDirectoriesToReadGemini: readonly string[] = [],
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
  folderTrust: boolean,
  memoryImportFormat: 'flat' | 'tree' = 'tree',
): Promise<{ memoryContent: string; fileCount: number }> {
  // FIX: Use real, canonical paths for a reliable comparison to handle symlinks.
  const realCwd = fs.realpathSync(path.resolve(currentWorkingDirectory));
  const realHome = fs.realpathSync(path.resolve(homedir()));
  const isHomeDirectory = realCwd === realHome;

  // If it is the home directory, pass an empty string to the core memory
  // function to signal that it should skip the workspace search.
  const effectiveCwd = isHomeDirectory ? '' : currentWorkingDirectory;

  // Directly call the server function with the corrected path.
  return loadServerHierarchicalMemory(
    effectiveCwd,
    includeDirectoriesToReadGemini,
    fileService,
    extensionContextFilePaths,
    folderTrust,
    memoryImportFormat,
  );
}

export function isDebugMode(argv: CliArgs): boolean {
  return (
    argv.debug ||
    [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    )
  );
}

export async function loadCliConfig(
  settings: Settings,
  argv: CliArgs,
  cwd: string = process.cwd(),
  overrideExtensions?: string[],
): Promise<Config> {
  const debugMode = isDebugMode(argv);

  const ideMode = settings.ide?.enabled ?? false;

  const folderTrust = settings.security?.folderTrust?.enabled ?? false;
  const trustedFolder = isWorkspaceTrusted(settings)?.isTrusted ?? true;

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setGeminiMdFilename.
  // However, loadHierarchicalGeminiMemory is called *before* createServerConfig.
  if (settings.context?.fileName) {
    setServerGeminiMdFilename(settings.context.fileName);
  } else {
    // Reset to default if not provided in settings.
    setServerGeminiMdFilename(getCurrentGeminiMdFilename());
  }

  // Automatically load output-language.md if it exists
  let outputLanguageFilePath: string | undefined = path.join(
    Storage.getGlobalQwenDir(),
    'output-language.md',
  );
  if (fs.existsSync(outputLanguageFilePath)) {
    // output-language.md found - will be added to context files
  } else {
    outputLanguageFilePath = undefined;
  }

  const fileService = new FileDiscoveryService(cwd);

  const includeDirectories = (settings.context?.includeDirectories || [])
    .map(resolvePath)
    .concat((argv.includeDirectories || []).map(resolvePath));

  // LSP configuration: enabled only via --experimental-lsp flag
  const lspEnabled = argv.experimentalLsp === true;
  let lspClient: LspClient | undefined;
  const question = argv.promptInteractive || argv.prompt || '';
  const inputFormat: InputFormat =
    (argv.inputFormat as InputFormat | undefined) ?? InputFormat.TEXT;
  const argvOutputFormat = normalizeOutputFormat(
    argv.outputFormat as string | OutputFormat | undefined,
  );
  const settingsOutputFormat = normalizeOutputFormat(settings.output?.format);
  const outputFormat =
    argvOutputFormat ?? settingsOutputFormat ?? OutputFormat.TEXT;
  const outputSettingsFormat: OutputFormat =
    outputFormat === OutputFormat.STREAM_JSON
      ? settingsOutputFormat &&
        settingsOutputFormat !== OutputFormat.STREAM_JSON
        ? settingsOutputFormat
        : OutputFormat.TEXT
      : (outputFormat as OutputFormat);
  const includePartialMessages = Boolean(argv.includePartialMessages);

  // Determine approval mode with backward compatibility
  let approvalMode: ApprovalMode;
  if (argv.approvalMode) {
    approvalMode = parseApprovalModeValue(argv.approvalMode);
  } else if (argv.yolo) {
    approvalMode = ApprovalMode.YOLO;
  } else if (settings.tools?.approvalMode) {
    approvalMode = parseApprovalModeValue(settings.tools.approvalMode);
  } else {
    approvalMode = ApprovalMode.DEFAULT;
  }

  // Force approval mode to default if the folder is not trusted.
  if (
    !trustedFolder &&
    approvalMode !== ApprovalMode.DEFAULT &&
    approvalMode !== ApprovalMode.PLAN
  ) {
    writeStderrLine(
      `Approval mode overridden to "default" because the current folder is not trusted.`,
    );
    approvalMode = ApprovalMode.DEFAULT;
  }

  let telemetrySettings;
  try {
    telemetrySettings = await resolveTelemetrySettings({
      argv,
      env: process.env as unknown as Record<string, string | undefined>,
      settings: settings.telemetry,
    });
  } catch (err) {
    if (err instanceof FatalConfigError) {
      throw new FatalConfigError(
        `Invalid telemetry configuration: ${err.message}.`,
      );
    }
    throw err;
  }

  // Interactive mode determination with priority:
  // 1. If promptInteractive (-i flag) is provided, it is explicitly interactive
  // 2. If outputFormat is stream-json or json (no matter input-format) along with query or prompt, it is non-interactive
  // 3. If no query or prompt is provided, check isTTY: TTY means interactive, non-TTY means non-interactive
  const hasQuery = !!argv.query;
  const hasPrompt = !!argv.prompt;
  let interactive: boolean;
  if (argv.promptInteractive) {
    // Priority 1: Explicit -i flag means interactive
    interactive = true;
  } else if (
    (outputFormat === OutputFormat.STREAM_JSON ||
      outputFormat === OutputFormat.JSON) &&
    (hasQuery || hasPrompt)
  ) {
    // Priority 2: JSON/stream-json output with query/prompt means non-interactive
    interactive = false;
  } else if (!hasQuery && !hasPrompt) {
    // Priority 3: No query or prompt means interactive only if TTY (format arguments ignored)
    interactive = process.stdin.isTTY ?? false;
  } else {
    // Default: If we have query/prompt but output format is TEXT, assume non-interactive
    // (fallback for edge cases where query/prompt is provided with TEXT output)
    interactive = false;
  }
  // In non-interactive mode, exclude tools that require a prompt.
  // However, if stream-json input is used, control can be requested via JSON messages,
  // so tools should not be excluded in that case.
  const extraExcludes: string[] = [];
  const resolvedCoreTools = argv.coreTools || settings.tools?.core || [];
  const resolvedAllowedTools =
    argv.allowedTools || settings.tools?.allowed || [];
  const isExplicitlyEnabled = (toolName: ToolName): boolean => {
    if (resolvedCoreTools.length > 0) {
      if (isToolEnabled(toolName, resolvedCoreTools, [])) {
        return true;
      }
    }
    if (resolvedAllowedTools.length > 0) {
      if (isToolEnabled(toolName, resolvedAllowedTools, [])) {
        return true;
      }
    }
    return false;
  };
  const excludeUnlessExplicit = (toolName: ToolName): void => {
    if (!isExplicitlyEnabled(toolName)) {
      extraExcludes.push(toolName);
    }
  };

  // ACP mode check: must include both --acp (current) and --experimental-acp (deprecated).
  // Without this check, edit, write_file, run_shell_command would be excluded in ACP mode.
  const isAcpMode = argv.acp || argv.experimentalAcp;
  if (!interactive && !isAcpMode && inputFormat !== InputFormat.STREAM_JSON) {
    switch (approvalMode) {
      case ApprovalMode.PLAN:
      case ApprovalMode.DEFAULT:
        // In default non-interactive mode, all tools that require approval are excluded,
        // unless explicitly enabled via coreTools/allowedTools.
        excludeUnlessExplicit(ShellTool.Name as ToolName);
        excludeUnlessExplicit(EditTool.Name as ToolName);
        excludeUnlessExplicit(WriteFileTool.Name as ToolName);
        break;
      case ApprovalMode.AUTO_EDIT:
        // In auto-edit non-interactive mode, only tools that still require a prompt are excluded.
        excludeUnlessExplicit(ShellTool.Name as ToolName);
        break;
      case ApprovalMode.YOLO:
        // No extra excludes for YOLO mode.
        break;
      default:
        // This should never happen due to validation earlier, but satisfies the linter
        break;
    }
  }

  const excludeTools = mergeExcludeTools(
    settings,
    extraExcludes.length > 0 ? extraExcludes : undefined,
    argv.excludeTools,
  );

  let allowedMcpServers: Set<string> | undefined;
  let excludedMcpServers: Set<string> | undefined;
  if (argv.allowedMcpServerNames) {
    allowedMcpServers = new Set(argv.allowedMcpServerNames.filter(Boolean));
    excludedMcpServers = undefined;
  } else {
    allowedMcpServers = settings.mcp?.allowed
      ? new Set(settings.mcp.allowed.filter(Boolean))
      : undefined;
    excludedMcpServers = settings.mcp?.excluded
      ? new Set(settings.mcp.excluded.filter(Boolean))
      : undefined;
  }

  const selectedAuthType =
    (argv.authType as AuthType | undefined) ||
    settings.security?.auth?.selectedType ||
    /* getAuthTypeFromEnv means no authType was explicitly provided, we infer the authType from env vars */
    getAuthTypeFromEnv();

  // Unified resolution of generation config with source attribution
  const resolvedCliConfig = resolveCliGenerationConfig({
    argv: {
      model: argv.model,
      openaiApiKey: argv.openaiApiKey,
      openaiBaseUrl: argv.openaiBaseUrl,
      openaiLogging: argv.openaiLogging,
      openaiLoggingDir: argv.openaiLoggingDir,
    },
    settings,
    selectedAuthType,
    env: process.env as Record<string, string | undefined>,
  });

  const { model: resolvedModel } = resolvedCliConfig;

  const sandboxConfig = await loadSandboxConfig(settings, argv);
  const screenReader =
    argv.screenReader !== undefined
      ? argv.screenReader
      : (settings.ui?.accessibility?.screenReader ?? false);

  const vlmSwitchMode =
    argv.vlmSwitchMode || settings.experimental?.vlmSwitchMode;

  let sessionId: string | undefined;
  let sessionData: ResumedSessionData | undefined;

  if (argv.continue || argv.resume) {
    const sessionService = new SessionService(cwd);
    if (argv.continue) {
      sessionData = await sessionService.loadLastSession();
      if (sessionData) {
        sessionId = sessionData.conversation.sessionId;
      }
    }

    if (argv.resume) {
      sessionId = argv.resume;
      sessionData = await sessionService.loadSession(argv.resume);
      if (!sessionData) {
        const message = `No saved session found with ID ${argv.resume}. Run \`qwen --resume\` without an ID to choose from existing sessions.`;
        writeStderrLine(message);
        process.exit(1);
      }
    }
  } else if (argv['sessionId']) {
    // Use provided session ID without session resumption
    // Check if session ID is already in use
    const sessionService = new SessionService(cwd);
    const exists = await sessionService.sessionExists(argv['sessionId']);
    if (exists) {
      const message = `Error: Session Id ${argv['sessionId']} is already in use.`;
      writeStderrLine(message);
      process.exit(1);
    }
    sessionId = argv['sessionId'];
  }

  const modelProvidersConfig = settings.modelProviders;

  const config = new Config({
    sessionId,
    sessionData,
    embeddingModel: DEFAULT_QWEN_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: cwd,
    includeDirectories,
    loadMemoryFromIncludeDirectories:
      settings.context?.loadFromIncludeDirectories || false,
    importFormat: settings.context?.importFormat || 'tree',
    debugMode,
    question,
    coreTools: argv.coreTools || settings.tools?.core || undefined,
    allowedTools: argv.allowedTools || settings.tools?.allowed || undefined,
    excludeTools,
    toolDiscoveryCommand: settings.tools?.discoveryCommand,
    toolCallCommand: settings.tools?.callCommand,
    mcpServerCommand: settings.mcp?.serverCommand,
    mcpServers: settings.mcpServers || {},
    allowedMcpServers: allowedMcpServers
      ? Array.from(allowedMcpServers)
      : undefined,
    excludedMcpServers: excludedMcpServers
      ? Array.from(excludedMcpServers)
      : undefined,
    approvalMode,
    accessibility: {
      ...settings.ui?.accessibility,
      screenReader,
    },
    telemetry: telemetrySettings,
    usageStatisticsEnabled: settings.privacy?.usageStatisticsEnabled ?? true,
    fileFiltering: settings.context?.fileFiltering,
    checkpointing:
      argv.checkpointing || settings.general?.checkpointing?.enabled,
    proxy:
      argv.proxy ||
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'],
    cwd,
    fileDiscoveryService: fileService,
    bugCommand: settings.advanced?.bugCommand,
    model: resolvedModel,
    outputLanguageFilePath,
    sessionTokenLimit: settings.model?.sessionTokenLimit ?? -1,
    maxSessionTurns:
      argv.maxSessionTurns ?? settings.model?.maxSessionTurns ?? -1,
    experimentalZedIntegration: argv.acp || argv.experimentalAcp || false,
    listExtensions: argv.listExtensions || false,
    overrideExtensions: overrideExtensions || argv.extensions,
    noBrowser: !!process.env['NO_BROWSER'],
    authType: selectedAuthType,
    inputFormat,
    outputFormat,
    includePartialMessages,
    modelProvidersConfig,
    generationConfigSources: resolvedCliConfig.sources,
    generationConfig: resolvedCliConfig.generationConfig,
    cliVersion: await getCliVersion(),
    webSearch: buildWebSearchConfig(argv, settings, selectedAuthType),
    summarizeToolOutput: settings.model?.summarizeToolOutput,
    ideMode,
    chatCompression: settings.model?.chatCompression,
    folderTrust,
    interactive,
    trustedFolder,
    useRipgrep: settings.tools?.useRipgrep,
    useBuiltinRipgrep: settings.tools?.useBuiltinRipgrep,
    shouldUseNodePtyShell: settings.tools?.shell?.enableInteractiveShell,
    skipNextSpeakerCheck: settings.model?.skipNextSpeakerCheck,
    skipLoopDetection: settings.model?.skipLoopDetection ?? false,
    skipStartupContext: settings.model?.skipStartupContext ?? false,
    vlmSwitchMode,
    truncateToolOutputThreshold: settings.tools?.truncateToolOutputThreshold,
    truncateToolOutputLines: settings.tools?.truncateToolOutputLines,
    enableToolOutputTruncation: settings.tools?.enableToolOutputTruncation,
    eventEmitter: appEvents,
    gitCoAuthor: settings.general?.gitCoAuthor,
    output: {
      format: outputSettingsFormat,
    },
    channel: argv.channel,
    // Precedence: explicit CLI flag > settings file > default(true).
    // NOTE: do NOT set a yargs default for `chat-recording`, otherwise argv will
    // always be true and the settings file can never disable recording.
    chatRecording:
      argv.chatRecording ?? settings.general?.chatRecording ?? true,
    defaultFileEncoding:
      settings.general?.defaultFileEncoding ?? FileEncoding.UTF8,
    lsp: {
      enabled: lspEnabled,
    },
  });

  if (lspEnabled) {
    try {
      const lspService = new NativeLspService(
        config,
        config.getWorkspaceContext(),
        appEvents,
        fileService,
        ideContextStore,
        {
          requireTrustedWorkspace: folderTrust,
        },
      );

      await lspService.discoverAndPrepare();
      await lspService.start();
      lspClient = new NativeLspClient(lspService);
      config.setLspClient(lspClient);
    } catch (err) {
      debugLogger.warn('Failed to initialize native LSP service:', err);
    }
  }

  return config;
}

function mergeExcludeTools(
  settings: Settings,
  extraExcludes?: string[] | undefined,
  cliExcludeTools?: string[] | undefined,
): string[] {
  const allExcludeTools = new Set([
    ...(cliExcludeTools || []),
    ...(settings.tools?.exclude || []),
    ...(extraExcludes || []),
  ]);
  return [...allExcludeTools];
}
