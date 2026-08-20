/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The result of a permission evaluation for a tool or command.
 * - 'allow': Auto-approved, no confirmation needed.
 * - 'ask': Requires user confirmation before proceeding.
 * - 'deny': Blocked; will not run.
 * - 'default': No explicit rule matched; falls back to the global approval mode.
 */
export type PermissionDecision = 'allow' | 'ask' | 'deny' | 'default';

/** The type of a permission rule. */
export type RuleType = 'allow' | 'ask' | 'deny';

/** The scope/source of a permission rule. */
export type RuleScope = 'system' | 'user' | 'workspace' | 'session';

/**
 * The kind of specifier a rule uses, determines which matching algorithm
 * to apply.
 *
 * - 'command': Shell command glob matching (for Bash / run_shell_command)
 * - 'path': File path gitignore-style matching (for Read / Edit / Write tools)
 * - 'domain': Domain matching with `domain:` prefix (for WebFetch)
 * - 'literal': Simple literal equality (fallback for unknown tool types)
 */
export type SpecifierKind = 'command' | 'path' | 'domain' | 'literal';

/**
 * A parsed permission rule.
 * Rules have the form "ToolName" or "ToolName(specifier)".
 *
 * Examples:
 *   "Bash"                     → all shell commands
 *   "Bash(git *)"              → shell commands matching glob
 *   "Read(./secrets/**)"       → file reads matching path pattern
 *   "Edit(/src/**\/*.ts)"       → file edits matching path pattern
 *   "WebFetch(domain:x.com)"   → web fetch matching domain
 *   "Agent(model:opus)"        → subagent with model param matching
 *   "mcp__server__tool"        → specific MCP tool
 */
export interface PermissionRule {
  /** The original raw rule string as written in config. */
  raw: string;
  /** The canonical tool name or category (e.g. "run_shell_command", "Read", "Edit"). */
  toolName: string;
  /**
   * Optional specifier for fine-grained matching.
   * For shell tools: a command pattern (e.g. "git *").
   * For file tools: a path pattern (e.g. "./secrets/**").
   * For WebFetch: a domain pattern (e.g. "domain:example.com").
   * For tool param matching: the plain (non-key:value) part of the specifier.
   */
  specifier?: string;
  /**
   * The kind of specifier, determines matching algorithm.
   * Set automatically during parsing based on the tool name/category.
   */
  specifierKind?: SpecifierKind;
  /**
   * Parsed `key:value` parameter matchers extracted from the specifier.
   * When set, `matchesRule` also requires every listed key to be present
   * in the tool's actual input params with a value matching the pattern
   * (supports `*` glob wildcards).
   *
   * Example: rule `Agent(model:opus)` → `[{ key: 'model', valuePattern: 'opus' }]`
   */
  toolParamMatchers?: Array<{ key: string; valuePattern: string }>;
  /** True if the raw rule was malformed (e.g. unbalanced parens) and should never match. */
  invalid?: boolean;
}

/** A complete set of permission rules organized by type. */
export interface PermissionRuleSet {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
}

/**
 * Context for a permission evaluation.
 *
 * Different fields are relevant depending on the tool type:
 * - Shell tools: provide `command`
 * - File tools: provide `filePath`
 * - WebFetch: provide `domain`
 * - Other tools: only `toolName` is needed
 */
export interface PermissionCheckContext {
  /** The canonical tool name being checked. */
  toolName: string;
  /** Historical names that may still appear in persisted rules. */
  toolAliases?: readonly string[];
  /**
   * The shell command being executed (only for Bash / run_shell_command).
   */
  command?: string;
  /**
   * Effective working directory for shell-like tools when resolving
   * relative virtual file operations extracted from the command.
   */
  cwd?: string;
  /**
   * The file path being accessed (only for Read / Edit / Write tools).
   * Should be an absolute path for matching against path patterns.
   */
  filePath?: string;
  /**
   * The domain being fetched (only for WebFetch).
   */
  domain?: string;
  /**
   * A generic specifier for literal matching (e.g. skill name for Skill,
   * subagent type for Task/Agent). Used when the rule has a literal
   * specifier that doesn't fall into command/path/domain categories.
   */
  specifier?: string;
  /**
   * Raw tool input parameters, used for `Tool(param:value)` rule matching.
   * Populated by `buildPermissionCheckContext` from the tool invocation args.
   */
  toolParams?: Record<string, unknown>;
}

/** A rule with its type and source scope, used for listing rules. */
export interface RuleWithSource {
  rule: PermissionRule;
  type: RuleType;
  scope: RuleScope;
}
