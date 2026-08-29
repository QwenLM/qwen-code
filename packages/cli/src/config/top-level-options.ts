/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Options, PositionalOptions } from 'yargs';
import type {
  ApprovalMode,
  AuthType as CoreAuthType,
} from '@qwen-code/qwen-code-core';

/**
 * Top-level (global) option definitions shared between the bootstrap
 * `qwen --help` fast-path and the real argument parser in config.ts.
 *
 * These options are valid at the top level, before any subcommand.
 */

// The bootstrap entry evaluates this module in-process on every fast path
// (`qwen --help`, `qwen mcp`, ...), so it must not import
// @qwen-code/qwen-code-core at runtime: the core barrel pulls the entire
// agent runtime into the entry's static import closure (measured +10 MB /
// ~6x slower fast paths). The literals below mirror core's ApprovalMode
// and AuthType enums; the `satisfies` checks reject any value core does
// not declare, and the Record witnesses below reject a member core adds
// that is missing here, so the copies cannot silently diverge.
const APPROVAL_MODES = [
  'plan',
  'default',
  'auto-edit',
  'auto',
  'yolo',
] as const satisfies ReadonlyArray<`${ApprovalMode}`>;

// Doubles as the ApprovalMode drift witness: the Record annotation is a
// compile error if core adds a member missing here or if a key here is
// not a member core declares.
const APPROVAL_MODE_DESCRIPTIONS: Record<`${ApprovalMode}`, string> = {
  plan: 'Analyze only, do not modify files or execute commands',
  default: 'Require approval for file edits or shell commands',
  'auto-edit': 'Automatically approve file edits',
  auto: 'LLM classifier auto-approves safe actions, blocks risky ones',
  yolo: 'Automatically approve all tools',
};

const AUTH_TYPE_CHOICES = [
  'openai',
  'anthropic',
  'qwen-oauth',
  'gemini',
  'vertex-ai',
] as const satisfies ReadonlyArray<`${CoreAuthType}`>;

// AuthType drift witness (the choices array's `satisfies` check only
// rejects values core does not declare, not missing ones): adding a member
// to core's enum without adding it here is a compile error. Never read at
// runtime; exported only so noUnusedLocals preserves the witness.
export const AUTH_TYPE_PARITY_WITNESS: Record<`${CoreAuthType}`, true> = {
  openai: true,
  anthropic: true,
  'qwen-oauth': true,
  gemini: true,
  'vertex-ai': true,
};

/** Usage banner shared by both help builders, kept here with the options. */
export const TOP_LEVEL_USAGE =
  'Usage: qwen [options] [command]\n\nQwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode';

/**
 * The default command's yargs signature, description, and positional.
 *
 * Both help builders register this so `qwen --help` documents the positional
 * prompt form. It is the form `--prompt`'s own deprecation notice points at
 * ("Use the positional prompt instead"), so omitting it from help output left
 * the documented migration target undiscoverable.
 */
export const DEFAULT_COMMAND = '$0 [query..]';

export const DEFAULT_COMMAND_DESC = 'Launch Qwen Code CLI';

export const QUERY_POSITIONAL = {
  description:
    'Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive.',
} as const satisfies PositionalOptions;

export const TOP_LEVEL_GLOBAL_OPTIONS = {
  telemetry: {
    type: 'boolean' as const,
    description:
      'Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.',
  },
  'telemetry-target': {
    type: 'string' as const,
    choices: ['local', 'gcp'] as const,
    description:
      'Set the telemetry target (local or gcp). Overrides settings files.',
  },
  'telemetry-otlp-endpoint': {
    type: 'string' as const,
    description:
      'Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.',
  },
  'telemetry-otlp-protocol': {
    type: 'string' as const,
    choices: ['grpc', 'http'] as const,
    description:
      'Set the OTLP protocol for telemetry (grpc or http). Overrides settings files.',
  },
  'telemetry-log-prompts': {
    type: 'boolean' as const,
    description:
      'Enable or disable logging of user prompts for telemetry. Overrides settings files.',
  },
  'telemetry-outfile': {
    type: 'string' as const,
    description: 'Redirect all telemetry output to the specified file.',
  },
  debug: {
    alias: 'd',
    type: 'boolean' as const,
    description: 'Run in debug mode?',
    default: false,
  },
  bare: {
    type: 'boolean' as const,
    description:
      'Minimal mode: skip implicit startup auto-discovery and only honor explicitly provided CLI inputs.',
    default: false,
  },
  'safe-mode': {
    type: 'boolean' as const,
    description:
      'Disable all customizations (context files, hooks, extensions, skills, MCP servers) for troubleshooting.',
  },
  proxy: {
    type: 'string' as const,
    description: 'Proxy for Qwen Code, like schema://user:password@host:port',
  },
  insecure: {
    type: 'boolean' as const,
    description:
      'Skip TLS certificate verification for API connections (for self-signed certs in trusted/lab environments). Equivalent to setting QWEN_TLS_INSECURE=1. WARNING: removes protection against man-in-the-middle attacks.',
    default: false,
  },
  'chat-recording': {
    type: 'boolean' as const,
    description:
      'Enable chat recording to disk. If false, chat history is not saved and --continue/--resume will not work.',
  },
} as const satisfies Record<string, Options>;

export const TOP_LEVEL_DEPRECATED_OPTIONS = {
  telemetry:
    'Use the "telemetry.enabled" setting in settings.json instead. This flag will be removed in a future version.',
  'telemetry-target':
    'Use the "telemetry.target" setting in settings.json instead. This flag will be removed in a future version.',
  'telemetry-otlp-endpoint':
    'Use the "telemetry.otlpEndpoint" setting in settings.json instead. This flag will be removed in a future version.',
  'telemetry-otlp-protocol':
    'Use the "telemetry.otlpProtocol" setting in settings.json instead. This flag will be removed in a future version.',
  'telemetry-log-prompts':
    'Use the "telemetry.logPrompts" setting in settings.json instead. This flag will be removed in a future version.',
  'telemetry-outfile':
    'Use the "telemetry.outfile" setting in settings.json instead. This flag will be removed in a future version.',
  proxy:
    'Use the "proxy" setting in settings.json instead. This flag will be removed in a future version.',
  'sandbox-image':
    'Use the "tools.sandboxImage" setting in settings.json instead. This flag will be removed in a future version.',
  prompt:
    'Use the positional prompt instead. This flag will be removed in a future version.',
} as const satisfies Record<string, string>;

/**
 * Options registered inside the `$0 [query..]` default command.
 *
 * In the bootstrap `--help` fast-path these are rendered as top-level options
 * for display purposes (since `qwen --help` shows all valid flags together).
 * The real parser nests them inside the positional-query subcommand.
 */
export const DEFAULT_COMMAND_OPTIONS = {
  model: {
    alias: 'm',
    type: 'string' as const,
    description: 'Model',
  },
  'fallback-model': {
    type: 'array' as const,
    description:
      'Fallback model(s) for capacity errors (429/503/529), repeatable or comma-separated (max 3)',
  },
  prompt: {
    alias: 'p',
    type: 'string' as const,
    description: 'Prompt. Appended to input on stdin (if any).',
  },
  'prompt-interactive': {
    alias: 'i',
    type: 'string' as const,
    description: 'Execute the provided prompt and continue in interactive mode',
  },
  'system-prompt': {
    type: 'string' as const,
    description:
      'Override the main session system prompt for this run. Can be combined with --append-system-prompt.',
  },
  'append-system-prompt': {
    type: 'string' as const,
    description:
      'Append instructions to the main session system prompt for this run. Can be combined with --system-prompt.',
  },
  sandbox: {
    alias: 's',
    type: 'boolean' as const,
    description: 'Run in sandbox?',
  },
  'sandbox-image': {
    type: 'string' as const,
    description: 'Sandbox image URI.',
  },
  yolo: {
    alias: 'y',
    type: 'boolean' as const,
    description:
      'Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?',
    default: false,
  },
  'approval-mode': {
    type: 'string' as const,
    choices: APPROVAL_MODES,
    description: `Set the approval mode: ${APPROVAL_MODES.map(
      (mode) => `${mode} (${APPROVAL_MODE_DESCRIPTIONS[mode]})`,
    ).join(', ')}`,
  },
  acp: {
    type: 'boolean' as const,
    description: 'Starts the agent in ACP mode',
  },
  'experimental-lsp': {
    type: 'boolean' as const,
    description:
      'Enable experimental LSP (Language Server Protocol) feature for code intelligence',
    default: false,
  },
  'restore-ask-user-question': {
    type: 'boolean' as const,
    description:
      'On daemon session load/resume, re-hang a trailing unanswered ask_user_question instead of synthesizing a failed tool result',
    default: false,
  },
  channel: {
    type: 'string' as const,
    choices: ['VSCode', 'ACP', 'SDK', 'CI', 'desktop', 'daemon'] as const,
    description: 'Channel identifier (VSCode, ACP, SDK, CI, desktop, daemon)',
  },
  'allowed-mcp-server-names': {
    type: 'array' as const,
    description: 'Allowed MCP server names',
  },
  'mcp-config': {
    type: 'string' as const,
    description:
      'MCP server configuration as JSON string or file path. Can be a path to a JSON file or inline JSON with {"mcpServers": {...}} format.',
  },
  'allowed-tools': {
    type: 'array' as const,
    // Pre-PR the default-command builder registered this option twice and
    // yargs rendered the LAST registration's description; keep that wording
    // so the consolidated help output is unchanged.
    description: 'Tools to allow, will bypass confirmation',
  },
  extensions: {
    alias: 'e',
    type: 'array' as const,
    description:
      'A list of extensions to use. If not provided, all extensions are used.',
  },
  'list-extensions': {
    alias: 'l',
    type: 'boolean' as const,
    description: 'List all available extensions and exit.',
  },
  'include-directories': {
    alias: 'add-dir',
    type: 'array' as const,
    description:
      'Additional directories to include in the workspace (comma-separated or multiple --include-directories)',
  },
  'openai-logging': {
    type: 'boolean' as const,
    description:
      'Enable logging of OpenAI API calls for debugging and analysis',
  },
  'openai-logging-dir': {
    type: 'string' as const,
    description:
      'Custom directory path for OpenAI API logs. Overrides settings files.',
  },
  'openai-api-key': {
    type: 'string' as const,
    description: 'OpenAI API key to use for authentication',
  },
  'openai-base-url': {
    type: 'string' as const,
    description: 'OpenAI base URL (for custom endpoints)',
  },
  'screen-reader': {
    type: 'boolean' as const,
    description: 'Enable screen reader mode for accessibility.',
  },
  'input-format': {
    type: 'string' as const,
    choices: ['text', 'stream-json'] as const,
    description: 'The format consumed from standard input.',
    default: 'text',
  },
  'output-format': {
    alias: 'o',
    type: 'string' as const,
    description: 'The format of the CLI output.',
    choices: ['text', 'json', 'stream-json'] as const,
  },
  'include-partial-messages': {
    type: 'boolean' as const,
    description:
      'Include partial assistant messages when using stream-json output.',
    default: false,
  },
  'json-fd': {
    type: 'number' as const,
    description:
      'File descriptor for structured JSON event output (dual output mode). ' +
      'The TUI renders normally on stdout while JSON events are written to this fd. ' +
      'The caller must provide this fd via spawn stdio configuration.',
  },
  'json-file': {
    type: 'string' as const,
    description:
      'File path for structured JSON event output (dual output mode). ' +
      'Can be a regular file, FIFO (named pipe), or /dev/fd/N.',
  },
  'json-schema': {
    type: 'string' as const,
    description:
      "JSON Schema that the model's final output must conform to " +
      '(headless mode only). Accepts a JSON literal or "@path/to/schema.json". ' +
      'Registers a synthetic `structured_output` tool; the session ends on ' +
      'the first valid call.',
  },
  'input-file': {
    type: 'string' as const,
    description:
      'File path for receiving remote input commands (bidirectional sync). ' +
      'An external process writes JSONL commands; the TUI watches and processes them.',
  },
  continue: {
    alias: 'c',
    type: 'boolean' as const,
    description: 'Resume the most recent session for the current project.',
    default: false,
  },
  resume: {
    alias: 'r',
    type: 'string' as const,
    description:
      'Resume a specific session by its ID. Use without an ID to show session picker.',
  },
  'session-id': {
    type: 'string' as const,
    description: 'Specify a session ID for this run.',
  },
  'fork-session': {
    type: 'boolean' as const,
    description:
      'Create a new forked session from the resumed session. Must be used with --resume or --continue.',
    default: false,
  },
  worktree: {
    type: 'string' as const,
    description:
      'Start the session inside a git worktree at <repoRoot>/.qwen/worktrees/<slug>/. ' +
      'Pass a slug (`--worktree my-feature`), a PR reference (`--worktree=#123` or a full ' +
      'GitHub pull-request URL), or use bare `--worktree` to auto-generate a slug. ' +
      'On exit, the WorktreeExitDialog prompts to keep or remove the worktree.',
  },
  'max-session-turns': {
    type: 'number' as const,
    description: 'Maximum number of session turns (must be an integer)',
  },
  'max-wall-time': {
    type: 'string' as const,
    description:
      'Run-level wall-clock budget for headless / unattended runs. Accepts seconds (e.g. `90`), or a duration string with unit (e.g. `30s`, `5m`, `1h`, `1.5h`). Minimum 1s — sub-second values (`500ms`, `0.5`) are rejected as typos; max ~24 days. Aborts the run with exit code 55 when exceeded.',
  },
  'max-tool-calls': {
    type: 'number' as const,
    description:
      'Maximum cumulative tool calls executed during the run (success or failure; `structured_output` under --json-schema is exempt). Aborts with exit code 55 when exceeded. -1 / unset means no limit; 0 means "no tool calls allowed" (first call aborts). Capped at 1,000,000 to catch typos.',
  },
  'max-subagent-depth': {
    type: 'number' as const,
    description:
      'Maximum sub-agent nesting depth (1-based levels). 1 keeps sub-agents available but disables nesting; capped at 100. Overrides model.maxSubagentDepth from settings. Defaults to 5.',
  },
  'core-tools': {
    type: 'array' as const,
    description: 'Core tool paths',
  },
  'exclude-tools': {
    type: 'array' as const,
    description: 'Tools to exclude',
  },
  'disabled-slash-commands': {
    type: 'array' as const,
    description:
      'Slash command names to hide/disable (comma-separated or ' +
      'repeated). Merged with the `slashCommands.disabled` setting ' +
      'and QWEN_DISABLED_SLASH_COMMANDS. Matched case-insensitively ' +
      'against the final command name; for extension skills, a ' +
      'pre-rename bare entry also matches its `<extension>:<name>` ' +
      'form (#9408).',
  },
  'auth-type': {
    type: 'string' as const,
    choices: AUTH_TYPE_CHOICES,
    description: 'Authentication type',
  },
} as const satisfies Record<string, Options>;

/**
 * All non-hidden CLI options for top-level help display.
 * Flattened for the `qwen --help` fast-path.
 */
export const TOP_LEVEL_HELP_OPTIONS: ReadonlyArray<readonly [string, Options]> =
  Object.freeze([
    ...Object.entries(TOP_LEVEL_GLOBAL_OPTIONS),
    ...Object.entries(DEFAULT_COMMAND_OPTIONS),
  ]) as ReadonlyArray<readonly [string, Options]>;
