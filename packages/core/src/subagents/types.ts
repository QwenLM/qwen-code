/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Subagent configuration types.
 *
 * Agent runtime types (PromptConfig, ModelConfig, RunConfig, ToolConfig,
 * AgentTerminateMode) are canonically defined in agents/runtime/agent-types.ts.
 */

import type {
  ModelConfig,
  RunConfig,
  PromptConfig,
  ToolConfig,
} from '../agents/runtime/agent-types.js';

/**
 * Represents the storage level for a subagent configuration.
 * - 'session': Session-level agents provided at runtime, read-only (highest priority)
 * - 'project': Stored in `.qwen/agents/` within the project directory
 * - 'user': Stored in `~/.qwen/agents/` in the user's home directory
 * - 'extension': Provided by an installed extension
 * - 'builtin': Built-in agents embedded in the codebase, always available (lowest priority)
 */
export type SubagentLevel =
  | 'session'
  | 'project'
  | 'user'
  | 'extension'
  | 'builtin';

/**
 * Core configuration for a subagent as stored in Markdown files.
 * This interface represents the file-based configuration that gets
 * converted to runtime configuration for AgentHeadless.
 */
export interface SubagentConfig {
  /** Unique name identifier for the subagent */
  name: string;

  /** Human-readable description of when and how to use this subagent */
  description: string;

  /**
   * Optional list of tool names that this subagent is allowed to use.
   * If omitted, the subagent inherits all available tools.
   */
  tools?: string[];

  /**
   * Optional list of tool names that this subagent is NOT allowed to use.
   * Applied after the allowlist (`tools`) and MCP bypass. Supports
   * MCP server-level patterns (e.g., "mcp__server" blocks all tools
   * from that server).
   */
  disallowedTools?: string[];

  /**
   * Optional permission mode for this subagent.
   * Controls how tool calls are approved during execution.
   * Valid values: 'default', 'plan', 'auto-edit', 'yolo'.
   * If omitted, the resolved mode depends on the parent's mode
   * (permissive parent modes win; otherwise defaults to 'auto-edit').
   */
  approvalMode?: string;

  /**
   * System prompt content that defines the subagent's behavior.
   * Supports ${variable} templating via ContextState.
   */
  systemPrompt: string;

  /** Storage level - determines where the configuration file is stored */
  level: SubagentLevel;

  /** Absolute path to the configuration file. Optional for session subagents. */
  filePath?: string;

  /**
   * Optional model selector.
   * - Omitted or 'inherit': use the main conversation model
   * - 'fast': use the configured fast model when available; supports
   *   authType-qualified fastModel settings and silently inherits otherwise
   * - 'model-id': use the given model with the main conversation authType
   * - 'authType:model-id': use the given authType and model ID
   */
  model?: string;

  /**
   * Optional runtime configuration. If not provided, uses defaults.
   * Can specify max_time_minutes and max_turns.
   */
  runConfig?: Partial<RunConfig>;

  /**
   * Optional color for runtime display.
   * If 'auto' or omitted, uses automatic color assignment.
   */
  color?: string;

  /**
   * When true, this agent always runs as a background task when spawned.
   * OR'd with the `run_in_background` tool parameter — if either is true,
   * the agent runs in the background.
   */
  background?: boolean;

  /**
   * Optional Claude-Code-compatible permission mode (`acceptEdits`, `auto`,
   * `bypassPermissions`, `default`, `dontAsk`, `plan`). Carried through from
   * frontmatter for parity with `.claude/agents/*.md` files. At parse time it
   * is normalised to {@link approvalMode} via
   * `claudePermissionModeToApprovalMode()`; if both `permissionMode` and
   * `approvalMode` are present in frontmatter, `approvalMode` wins.
   */
  permissionMode?: string;

  /**
   * Optional thinking-effort hint. Either one of `low | medium | high | xhigh
   * | max` (with `med` aliased to `medium`) or a positive integer. Maps to
   * Claude Code's DL7 `effort` field.
   */
  effort?: string | number;

  /**
   * Optional maximum number of turns before the agent halts. Positive integer.
   * Top-level promotion of the legacy `runConfig.max_turns` field; when both
   * are set, top-level `maxTurns` wins.
   */
  maxTurns?: number;

  /**
   * Optional list of skill names to expose to this agent. Matches CC `skills`
   * frontmatter field.
   */
  skills?: string[];

  /**
   * Optional initial prompt automatically submitted when the agent becomes
   * the main-session agent (via `--agent` or settings). Has no effect when
   * the agent runs as a subagent.
   */
  initialPrompt?: string;

  /**
   * Optional memory binding. One of `user | project | local`. Carried verbatim
   * for CC parity; runtime semantics are deferred to a follow-up PR.
   */
  memory?: string;

  /**
   * Optional isolation mode. Currently the only valid value is `worktree`.
   * Used as the per-agent default; per-call workflow `opts.isolation` (when
   * present) overrides this. Carried verbatim for CC parity; runtime
   * semantics are owned by the workflow port (#4721 / PR #4732).
   */
  isolation?: string;

  /**
   * Optional MCP-server overrides. Carried verbatim for CC parity; runtime
   * semantics are deferred to a follow-up PR.
   *
   * **Known limitation:** qwen-code's lightweight `yaml-parser.ts` only handles
   * one level of YAML nesting. Flat forms — array of server names, e.g.
   * `mcpServers: [filesystem-server, redis-server]` — round-trip cleanly.
   * Nested CC forms (`mcpServers: - name: { type: stdio, command: node }`)
   * are read with deeper keys collapsed or leaked. Full nested support lands
   * when this codebase wires in `js-yaml`.
   */
  mcpServers?: unknown;

  /**
   * Optional hooks. Carried verbatim for CC parity; runtime semantics are
   * deferred to a follow-up PR.
   *
   * **Known limitation:** hooks fundamentally require nested YAML, which
   * qwen-code's `yaml-parser.ts` cannot represent (see `mcpServers` above).
   * In practice the field is shaped correctly only for trivial inputs; full
   * support lands with `js-yaml`.
   */
  hooks?: unknown;

  /**
   * Indicates whether this is a built-in agent.
   * Built-in agents cannot be modified or deleted.
   */
  readonly isBuiltin?: boolean;

  /**
   * For extension-level subagents: the name of the providing extension
   */
  extensionName?: string;
}

/**
 * Runtime configuration that converts file-based config to AgentHeadless.
 * This interface maps SubagentConfig to the existing runtime interfaces.
 */
export interface SubagentRuntimeConfig {
  /** Prompt configuration for AgentHeadless */
  promptConfig: PromptConfig;

  /** Model configuration for AgentHeadless */
  modelConfig: ModelConfig;

  /** Runtime execution configuration for AgentHeadless */
  runConfig: RunConfig;

  /** Optional tool configuration for AgentHeadless */
  toolConfig?: ToolConfig;
}

/**
 * Result of a validation operation on a subagent configuration.
 */
export interface ValidationResult {
  /** Whether the configuration is valid */
  isValid: boolean;

  /** Array of error messages if validation failed */
  errors: string[];

  /** Array of warning messages (non-blocking issues) */
  warnings: string[];
}

/**
 * Options for listing subagents.
 */
export interface ListSubagentsOptions {
  /** Filter by storage level */
  level?: SubagentLevel;

  /** Filter by tool availability */
  hasTool?: string;

  /** Sort order for results */
  sortBy?: 'name' | 'lastModified' | 'level';

  /** Sort direction */
  sortOrder?: 'asc' | 'desc';

  /** Force refresh from disk, bypassing cache. Defaults to false. */
  force?: boolean;
}

/**
 * Options for creating a new subagent.
 */
export interface CreateSubagentOptions {
  /** Storage level for the new subagent */
  level: SubagentLevel;

  /** Whether to overwrite existing subagent with same name */
  overwrite?: boolean;

  /** Custom directory path (overrides default level-based path) */
  customPath?: string;
}

/**
 * Error thrown when a subagent operation fails.
 */
export class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly subagentName?: string,
  ) {
    super(message);
    this.name = 'SubagentError';
  }
}

/**
 * Error codes for subagent operations.
 */
export const SubagentErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_NAME: 'INVALID_NAME',
  FILE_ERROR: 'FILE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
} as const;

export type SubagentErrorCode =
  (typeof SubagentErrorCode)[keyof typeof SubagentErrorCode];
