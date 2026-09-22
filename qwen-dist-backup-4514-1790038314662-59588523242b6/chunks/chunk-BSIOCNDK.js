// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";

// packages/cli/src/config/top-level-options.ts
init_esbuild_shims();
var APPROVAL_MODES = [
  "plan",
  "default",
  "auto-edit",
  "auto",
  "yolo"
];
var APPROVAL_MODE_DESCRIPTIONS = {
  plan: "Analyze only, do not modify files or execute commands",
  default: "Require approval for file edits or shell commands",
  "auto-edit": "Automatically approve file edits",
  auto: "LLM classifier auto-approves safe actions, blocks risky ones",
  yolo: "Automatically approve all tools"
};
var AUTH_TYPE_CHOICES = [
  "openai",
  "openai-responses",
  "anthropic",
  "qwen-oauth",
  "gemini",
  "vertex-ai"
];
var TOP_LEVEL_USAGE = "Usage: qwen [options] [command]\n\nQwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode";
var DEFAULT_COMMAND = "$0 [query..]";
var DEFAULT_COMMAND_DESC = "Launch Qwen Code CLI";
var QUERY_POSITIONAL = {
  description: "Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive."
};
var TOP_LEVEL_GLOBAL_OPTIONS = {
  telemetry: {
    type: "boolean",
    description: "Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own."
  },
  "telemetry-target": {
    type: "string",
    choices: ["local", "gcp"],
    description: "Set the telemetry target (local or gcp). Overrides settings files."
  },
  "telemetry-otlp-endpoint": {
    type: "string",
    description: "Set the OTLP endpoint for telemetry. Overrides environment variables and settings files."
  },
  "telemetry-otlp-protocol": {
    type: "string",
    choices: ["grpc", "http"],
    description: "Set the OTLP protocol for telemetry (grpc or http). Overrides settings files."
  },
  "telemetry-log-prompts": {
    type: "boolean",
    description: "Enable or disable logging of user prompts for telemetry. Overrides settings files."
  },
  "telemetry-outfile": {
    type: "string",
    description: "Redirect all telemetry output to the specified file."
  },
  debug: {
    alias: "d",
    type: "boolean",
    description: "Run in debug mode?",
    default: false
  },
  bare: {
    type: "boolean",
    description: "Minimal mode: skip implicit startup auto-discovery and only honor explicitly provided CLI inputs.",
    default: false
  },
  "safe-mode": {
    type: "boolean",
    description: "Disable all customizations (context files, hooks, extensions, skills, MCP servers) for troubleshooting."
  },
  proxy: {
    type: "string",
    description: "Proxy for Qwen Code, like schema://user:password@host:port"
  },
  insecure: {
    type: "boolean",
    description: "Skip TLS certificate verification for API connections (for self-signed certs in trusted/lab environments). Equivalent to setting QWEN_TLS_INSECURE=1. WARNING: removes protection against man-in-the-middle attacks.",
    default: false
  },
  "chat-recording": {
    type: "boolean",
    description: "Enable chat recording to disk. If false, chat history is not saved and --continue/--resume will not work."
  }
};
var TOP_LEVEL_DEPRECATED_OPTIONS = {
  telemetry: 'Use the "telemetry.enabled" setting in settings.json instead. This flag will be removed in a future version.',
  "telemetry-target": 'Use the "telemetry.target" setting in settings.json instead. This flag will be removed in a future version.',
  "telemetry-otlp-endpoint": 'Use the "telemetry.otlpEndpoint" setting in settings.json instead. This flag will be removed in a future version.',
  "telemetry-otlp-protocol": 'Use the "telemetry.otlpProtocol" setting in settings.json instead. This flag will be removed in a future version.',
  "telemetry-log-prompts": 'Use the "telemetry.logPrompts" setting in settings.json instead. This flag will be removed in a future version.',
  "telemetry-outfile": 'Use the "telemetry.outfile" setting in settings.json instead. This flag will be removed in a future version.',
  proxy: 'Use the "proxy" setting in settings.json instead. This flag will be removed in a future version.',
  "sandbox-image": 'Use the "tools.sandboxImage" setting in settings.json instead. This flag will be removed in a future version.',
  prompt: "Use the positional prompt instead. This flag will be removed in a future version."
};
var DEFAULT_COMMAND_OPTIONS = {
  model: {
    alias: "m",
    type: "string",
    description: "Model"
  },
  "fallback-model": {
    type: "array",
    description: "Fallback model(s) for capacity errors (429/503/529), repeatable or comma-separated (max 3)"
  },
  prompt: {
    alias: "p",
    type: "string",
    description: "Prompt. Appended to input on stdin (if any)."
  },
  "prompt-interactive": {
    alias: "i",
    type: "string",
    description: "Execute the provided prompt and continue in interactive mode"
  },
  "system-prompt": {
    type: "string",
    description: "Override the main session system prompt for this run. Can be combined with --append-system-prompt."
  },
  "append-system-prompt": {
    type: "string",
    description: "Append instructions to the main session system prompt for this run. Can be combined with --system-prompt."
  },
  "output-style": {
    type: "string",
    description: 'Output style for this run, for example "Concise" or "Explanatory". Overrides the general.outputStyle setting; "default" selects no style.'
  },
  sandbox: {
    alias: "s",
    type: "boolean",
    description: "Run in sandbox?"
  },
  "sandbox-image": {
    type: "string",
    description: "Sandbox image URI."
  },
  yolo: {
    alias: "y",
    type: "boolean",
    description: "Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?",
    default: false
  },
  "approval-mode": {
    type: "string",
    choices: APPROVAL_MODES,
    description: `Set the approval mode: ${APPROVAL_MODES.map(
      (mode) => `${mode} (${APPROVAL_MODE_DESCRIPTIONS[mode]})`
    ).join(", ")}`
  },
  acp: {
    type: "boolean",
    description: "Starts the agent in ACP mode"
  },
  "experimental-lsp": {
    type: "boolean",
    description: "Enable experimental LSP (Language Server Protocol) feature for code intelligence",
    default: false
  },
  "restore-ask-user-question": {
    type: "boolean",
    description: "On daemon session load/resume, re-hang a trailing unanswered ask_user_question instead of synthesizing a failed tool result",
    default: false
  },
  channel: {
    type: "string",
    choices: ["VSCode", "ACP", "SDK", "CI", "desktop", "daemon"],
    description: "Channel identifier (VSCode, ACP, SDK, CI, desktop, daemon)"
  },
  "allowed-mcp-server-names": {
    type: "array",
    description: "Allowed MCP server names"
  },
  "mcp-config": {
    type: "string",
    description: 'MCP server configuration as JSON string or file path. Can be a path to a JSON file or inline JSON with {"mcpServers": {...}} format.'
  },
  "allowed-tools": {
    type: "array",
    // Pre-PR the default-command builder registered this option twice and
    // yargs rendered the LAST registration's description; keep that wording
    // so the consolidated help output is unchanged.
    description: "Tools to allow, will bypass confirmation"
  },
  extensions: {
    alias: "e",
    type: "array",
    description: "A list of extensions to use. If not provided, all extensions are used."
  },
  "list-extensions": {
    alias: "l",
    type: "boolean",
    description: "List all available extensions and exit."
  },
  "include-directories": {
    alias: "add-dir",
    type: "array",
    description: "Additional directories to include in the workspace (comma-separated or multiple --include-directories)"
  },
  "openai-logging": {
    type: "boolean",
    description: "Enable logging of OpenAI API calls for debugging and analysis"
  },
  "openai-logging-dir": {
    type: "string",
    description: "Custom directory path for OpenAI API logs. Overrides settings files."
  },
  "openai-api-key": {
    type: "string",
    description: "OpenAI API key to use for authentication"
  },
  "openai-base-url": {
    type: "string",
    description: "OpenAI base URL (for custom endpoints)"
  },
  "screen-reader": {
    type: "boolean",
    description: "Enable screen reader mode for accessibility."
  },
  "input-format": {
    type: "string",
    choices: ["text", "stream-json"],
    description: "The format consumed from standard input.",
    default: "text"
  },
  "output-format": {
    alias: "o",
    type: "string",
    description: "The format of the CLI output.",
    choices: ["text", "json", "stream-json"]
  },
  "include-partial-messages": {
    type: "boolean",
    description: "Include partial assistant messages when using stream-json output.",
    default: false
  },
  "json-fd": {
    type: "number",
    description: "File descriptor for structured JSON event output (dual output mode). The TUI renders normally on stdout while JSON events are written to this fd. The caller must provide this fd via spawn stdio configuration."
  },
  "json-file": {
    type: "string",
    description: "File path for structured JSON event output (dual output mode). Can be a regular file, FIFO (named pipe), or /dev/fd/N."
  },
  "json-schema": {
    type: "string",
    description: 'JSON Schema that the model\'s final output must conform to (headless mode only). Accepts a JSON literal or "@path/to/schema.json". Registers a synthetic `structured_output` tool; the session ends on the first valid call.'
  },
  "input-file": {
    type: "string",
    description: "File path for receiving remote input commands (bidirectional sync). An external process writes JSONL commands; the TUI watches and processes them."
  },
  continue: {
    alias: "c",
    type: "boolean",
    description: "Resume the most recent session for the current project.",
    default: false
  },
  resume: {
    alias: "r",
    type: "string",
    description: "Resume a specific session by its ID. Use without an ID to show session picker."
  },
  "session-id": {
    type: "string",
    description: "Specify a session ID for this run."
  },
  "fork-session": {
    type: "boolean",
    description: "Create a new forked session from the resumed session. Must be used with --resume or --continue.",
    default: false
  },
  worktree: {
    type: "string",
    description: "Start the session inside a git worktree at <repoRoot>/.qwen/worktrees/<slug>/. Pass a slug (`--worktree my-feature`), a PR reference (`--worktree=#123` or a full GitHub pull-request URL), or use bare `--worktree` to auto-generate a slug. On exit, the WorktreeExitDialog prompts to keep or remove the worktree."
  },
  "max-session-turns": {
    type: "number",
    description: "Maximum number of session turns (must be an integer)"
  },
  "max-wall-time": {
    type: "string",
    description: "Run-level wall-clock budget for headless / unattended runs. Accepts seconds (e.g. `90`), or a duration string with unit (e.g. `30s`, `5m`, `1h`, `1.5h`). Minimum 1s \u2014 sub-second values (`500ms`, `0.5`) are rejected as typos; max ~24 days. Aborts the run with exit code 55 when exceeded."
  },
  "max-tool-calls": {
    type: "number",
    description: 'Maximum cumulative tool calls executed during the run (success or failure; `structured_output` under --json-schema is exempt). Aborts with exit code 55 when exceeded. -1 / unset means no limit; 0 means "no tool calls allowed" (first call aborts). Capped at 1,000,000 to catch typos.'
  },
  "max-subagent-depth": {
    type: "number",
    description: "Maximum sub-agent nesting depth (1-based levels). 1 keeps sub-agents available but disables nesting; capped at 100. Overrides model.maxSubagentDepth from settings. Defaults to 5."
  },
  "core-tools": {
    type: "array",
    description: "Core tool paths"
  },
  "exclude-tools": {
    type: "array",
    description: "Tools to exclude"
  },
  "disabled-slash-commands": {
    type: "array",
    description: "Slash command names to hide/disable (comma-separated or repeated). Merged with the `slashCommands.disabled` setting and QWEN_DISABLED_SLASH_COMMANDS. Matched case-insensitively against the final command name; a skill command matches under its registered name (rust:pdf) or its authored name (pdf)."
  },
  "auth-type": {
    type: "string",
    choices: AUTH_TYPE_CHOICES,
    description: "Authentication type"
  }
};
var TOP_LEVEL_HELP_OPTIONS = Object.freeze([
  ...Object.entries(TOP_LEVEL_GLOBAL_OPTIONS),
  ...Object.entries(DEFAULT_COMMAND_OPTIONS)
]);

export {
  TOP_LEVEL_USAGE,
  DEFAULT_COMMAND,
  DEFAULT_COMMAND_DESC,
  QUERY_POSITIONAL,
  TOP_LEVEL_GLOBAL_OPTIONS,
  TOP_LEVEL_DEPRECATED_OPTIONS,
  DEFAULT_COMMAND_OPTIONS,
  TOP_LEVEL_HELP_OPTIONS
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
