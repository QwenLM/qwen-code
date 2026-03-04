/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import os from 'node:os';
import picomatch from 'picomatch';
import type { PermissionRule, SpecifierKind } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool name aliases & categories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of known tool name aliases to their canonical names.
 * Covers all built-in tools plus common aliases (including Claude Code's "Bash").
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  // Shell tool
  run_shell_command: 'run_shell_command',
  Shell: 'run_shell_command',
  ShellTool: 'run_shell_command',
  Bash: 'run_shell_command', // Claude Code compatibility

  // Edit tool — "Edit" is also a meta-category covering edit + write_file
  edit: 'edit',
  Edit: 'edit',
  EditTool: 'edit',

  // Write File tool — also matched by "Edit" meta-category rules
  write_file: 'write_file',
  WriteFile: 'write_file',
  WriteFileTool: 'write_file',
  Write: 'write_file',

  // Read File tool — "Read" is also a meta-category covering read_file + grep + glob + list_directory
  read_file: 'read_file',
  ReadFile: 'read_file',
  ReadFileTool: 'read_file',
  Read: 'read_file',

  // Grep tool — also matched by "Read" meta-category rules
  grep_search: 'grep_search',
  Grep: 'grep_search',
  GrepTool: 'grep_search',
  search_file_content: 'grep_search', // legacy
  SearchFiles: 'grep_search', // legacy display name

  // Glob tool — also matched by "Read" meta-category rules
  glob: 'glob',
  Glob: 'glob',
  GlobTool: 'glob',
  FindFiles: 'glob', // legacy display name

  // List Directory tool — also matched by "Read" meta-category rules
  list_directory: 'list_directory',
  ListFiles: 'list_directory',
  ListFilesTool: 'list_directory',
  ReadFolder: 'list_directory', // legacy display name

  // Memory tool
  save_memory: 'save_memory',
  SaveMemory: 'save_memory',
  SaveMemoryTool: 'save_memory',

  // TodoWrite tool
  todo_write: 'todo_write',
  TodoWrite: 'todo_write',
  TodoWriteTool: 'todo_write',

  // WebFetch tool
  web_fetch: 'web_fetch',
  WebFetch: 'web_fetch',
  WebFetchTool: 'web_fetch',

  // WebSearch tool
  web_search: 'web_search',
  WebSearch: 'web_search',
  WebSearchTool: 'web_search',

  // Task tool
  task: 'task',
  Task: 'task',
  TaskTool: 'task',

  // Skill tool
  skill: 'skill',
  Skill: 'skill',
  SkillTool: 'skill',

  // ExitPlanMode tool
  exit_plan_mode: 'exit_plan_mode',
  ExitPlanMode: 'exit_plan_mode',
  ExitPlanModeTool: 'exit_plan_mode',

  // LSP tool
  lsp: 'lsp',
  Lsp: 'lsp',
  LspTool: 'lsp',

  // Legacy edit tool name
  replace: 'edit',

  // Agent (subagent) rules — "Agent" is a category prefix.
  // "Agent(Explore)" is parsed with toolName = "Agent" and specifier = "Explore"
  Agent: 'Agent',
};

/**
 * Shell tool canonical names.
 */
const SHELL_TOOL_NAMES = new Set(['run_shell_command']);

/**
 * File-reading tools — "Read" rules apply to all of these (best-effort).
 *
 * Per Claude Code docs: "Claude makes a best-effort attempt to apply Read rules
 * to all built-in tools that read files like Grep and Glob."
 */
const READ_TOOLS = new Set([
  'read_file',
  'grep_search',
  'glob',
  'list_directory',
]);

/**
 * File-editing tools — "Edit" rules apply to all of these.
 *
 * Per Claude Code docs: "Edit rules apply to all built-in tools that edit files."
 */
const EDIT_TOOLS = new Set(['edit', 'write_file']);

/**
 * WebFetch tools.
 */
const WEBFETCH_TOOLS = new Set(['web_fetch']);

// ─────────────────────────────────────────────────────────────────────────────
// Tool name resolution & categorization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a raw tool name or alias to its canonical name.
 * Returns the input unchanged if it is not in the alias map
 * (e.g. MCP tool names are kept as-is).
 */
export function resolveToolName(rawName: string): string {
  return TOOL_NAME_ALIASES[rawName] ?? rawName;
}

/**
 * Determine the specifier kind for a given canonical tool name.
 * This tells the matching engine which algorithm to use for the specifier.
 */
export function getSpecifierKind(canonicalToolName: string): SpecifierKind {
  if (SHELL_TOOL_NAMES.has(canonicalToolName)) {
    return 'command';
  }
  if (READ_TOOLS.has(canonicalToolName) || EDIT_TOOLS.has(canonicalToolName)) {
    return 'path';
  }
  if (WEBFETCH_TOOLS.has(canonicalToolName)) {
    return 'domain';
  }
  return 'literal';
}

/**
 * Check whether a given tool (by canonical name) is covered by a rule's tool name,
 * taking meta-categories into account.
 *
 * "Read" → resolves to "read_file", but also covers grep_search, glob, list_directory
 * "Edit" → resolves to "edit", but also covers write_file
 */
export function toolMatchesRuleToolName(
  ruleToolName: string,
  contextToolName: string,
): boolean {
  if (ruleToolName === contextToolName) {
    return true;
  }
  // "Read" → covers all READ_TOOLS
  if (ruleToolName === 'read_file' && READ_TOOLS.has(contextToolName)) {
    return true;
  }
  // "Edit" → covers all EDIT_TOOLS
  if (ruleToolName === 'edit' && EDIT_TOOLS.has(contextToolName)) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw permission rule string into a PermissionRule object.
 *
 * Supported formats:
 *   "ToolName"            → matches all invocations of the tool
 *   "ToolName(specifier)" → fine-grained matching via specifier
 *
 * Tool-specific specifier semantics:
 *   "Bash(git *)"               → shell command glob
 *   "Read(./secrets/**)"        → gitignore-style path match
 *   "Edit(/src/**\/*.ts)"        → gitignore-style path match
 *   "WebFetch(domain:x.com)"    → domain match
 *   "Agent(Explore)"            → subagent name literal match
 *   "mcp__server__tool"         → MCP tool (no specifier needed)
 */
export function parseRule(raw: string): PermissionRule {
  const trimmed = raw.trim();

  // Handle legacy `:*` suffix (deprecated, equivalent to ` *`)
  // e.g. "Bash(git:*)" → "Bash(git *)"
  const normalized = trimmed.replace(/:(\*)/, ' $1');

  const openParen = normalized.indexOf('(');

  if (openParen === -1) {
    // Simple tool name rule (no specifier)
    const canonicalName = resolveToolName(normalized);
    return {
      raw: trimmed,
      toolName: canonicalName,
    };
  }

  const toolPart = normalized.substring(0, openParen).trim();
  const specifier = normalized.endsWith(')')
    ? normalized.substring(openParen + 1, normalized.length - 1)
    : undefined;

  const canonicalName = resolveToolName(toolPart);
  const specifierKind = specifier ? getSpecifierKind(canonicalName) : undefined;

  return {
    raw: trimmed,
    toolName: canonicalName,
    specifier,
    specifierKind,
  };
}

/**
 * Parse an array of raw rule strings into PermissionRule objects,
 * silently skipping any empty entries.
 */
export function parseRules(raws: string[]): PermissionRule[] {
  return raws.filter((r) => r && r.trim()).map(parseRule);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell command matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shell operator tokens that act as command boundaries.
 * Ordered by length (longest first) for correct multi-char operator detection.
 */
const SHELL_OPERATORS = ['&&', '||', ';;', '|&', '|', ';'];

/**
 * Extract the first simple command from a compound shell command string.
 * Stops at the first shell operator boundary (&&, ||, ;, |) that is not
 * inside quotes.
 *
 * Examples:
 *   "git status && rm -rf /"  → "git status"
 *   "ls -la | grep foo"      → "ls -la"
 *   "echo 'a && b'"          → "echo 'a && b'"  (inside quotes)
 */
function extractFirstCommand(command: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }

    // Check for shell operators (longest match first)
    for (const op of SHELL_OPERATORS) {
      if (command.substring(i, i + op.length) === op) {
        return command.substring(0, i).trimEnd();
      }
    }
  }

  return command;
}

/**
 * Match a shell command against a glob pattern.
 *
 * Key semantics (from Claude Code docs):
 *
 * 1. `*` wildcard can appear at any position (head, middle, tail).
 *
 * 2. **Word boundary rule**: A space before `*` enforces a word boundary.
 *    - `Bash(ls *)` matches `ls -la` but NOT `lsof`
 *    - `Bash(ls*)` matches both `ls -la` and `lsof`
 *
 * 3. **Shell operator awareness**: Patterns don't match across operator
 *    boundaries. We extract only the first simple command before matching.
 *
 * 4. Without `*`, uses prefix matching for backward compatibility.
 *    `Bash(git commit)` matches `git commit -m "test"`.
 *
 * 5. `Bash(*)` is equivalent to `Bash` and matches any command.
 */
export function matchesCommandPattern(
  pattern: string,
  command: string,
): boolean {
  // Extract only the first simple command (operator awareness)
  const firstCmd = extractFirstCommand(command);

  // Special case: lone `*` matches any single command
  if (pattern === '*') {
    return true;
  }

  if (!pattern.includes('*')) {
    // No wildcards: prefix matching (backward compat).
    // "git commit" matches "git commit" and "git commit -m test"
    // but NOT "gitcommit".
    return firstCmd === pattern || firstCmd.startsWith(pattern + ' ');
  }

  // Build regex from glob pattern with word-boundary semantics.
  //
  // We walk through the pattern character by character, building a regex.
  // When we encounter `*`:
  //   - If preceded by a space: the space acts as a word boundary before `.*`
  //   - If preceded by non-space (or at start): `.*` with no boundary constraint

  let regex = '^';
  let pos = 0;

  while (pos < pattern.length) {
    const starIdx = pattern.indexOf('*', pos);
    if (starIdx === -1) {
      // No more wildcards; rest is literal, then allow trailing args
      regex += escapeRegex(pattern.substring(pos));
      break;
    }

    // Add literal part before the `*`
    const literalBefore = pattern.substring(pos, starIdx);

    if (starIdx > 0 && pattern[starIdx - 1] === ' ') {
      // Word-boundary wildcard: "ls *"
      // The literal includes the trailing space. The `*` matches
      // anything after that space (including empty = just "ls").
      // But the key insight: "ls " was already committed, so
      // `ls` alone without a trailing space should also match.
      //
      // Rewrite: literal without trailing space + (space + anything | end)
      const literalWithoutTrailingSpace = literalBefore.slice(0, -1);
      regex += escapeRegex(literalWithoutTrailingSpace);
      regex += '( .*)?';
    } else {
      // No word boundary: "ls*" → `ls` followed by anything
      regex += escapeRegex(literalBefore);
      regex += '.*';
    }

    pos = starIdx + 1;
  }

  // If the pattern does NOT end with `*`, the regex already matches exactly.
  // If it does end with `*`, the trailing `.*` handles it.
  regex += '$';

  try {
    return new RegExp(regex).test(firstCmd);
  } catch {
    return firstCmd === pattern;
  }
}

/**
 * Escape special regex characters.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// File path matching (gitignore-style)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a path pattern from a permission rule specifier to an absolute
 * glob pattern for matching.
 *
 * Path pattern prefixes (from Claude Code docs):
 *
 * | Prefix    | Meaning                           | Example                      |
 * |-----------|-----------------------------------|------------------------------|
 * | `//path`  | Absolute from filesystem root      | `//Users/alice/secrets/**`   |
 * | `~/path`  | Relative to home directory         | `~/Documents/*.pdf`          |
 * | `/path`   | Relative to project root           | `/src/**\/*.ts`               |
 * | `./path`  | Relative to current working dir    | `./secrets/**`               |
 * | `path`    | Relative to current working dir    | `*.env`                      |
 *
 * WARNING: `/Users/alice/file` is NOT an absolute path — it's relative to
 * the project root. Use `//Users/alice/file` for absolute paths.
 */
export function resolvePathPattern(
  specifier: string,
  projectRoot: string,
  cwd: string,
): string {
  if (specifier.startsWith('//')) {
    // Absolute path from filesystem root: `//path` → `/path`
    return specifier.substring(1);
  }

  if (specifier.startsWith('~/')) {
    // Relative to home directory
    return path.join(os.homedir(), specifier.substring(2));
  }

  if (specifier.startsWith('/')) {
    // Relative to project root (NOT absolute!)
    return path.join(projectRoot, specifier.substring(1));
  }

  if (specifier.startsWith('./')) {
    // Relative to current working directory
    return path.join(cwd, specifier.substring(2));
  }

  // No prefix: relative to current working directory
  return path.join(cwd, specifier);
}

/**
 * Match a file path against a gitignore-style path pattern.
 *
 * Uses picomatch for the actual glob matching, following gitignore semantics:
 *   - `*` matches files in a single directory (does not cross `/`)
 *   - `**` matches recursively across directories
 *
 * @param specifier - The raw specifier from the rule (e.g. "./secrets/**")
 * @param filePath - The absolute path of the file being accessed
 * @param projectRoot - The project root directory (absolute)
 * @param cwd - The current working directory (absolute)
 * @returns True if the file path matches the pattern
 */
export function matchesPathPattern(
  specifier: string,
  filePath: string,
  projectRoot: string,
  cwd: string,
): boolean {
  const resolvedPattern = resolvePathPattern(specifier, projectRoot, cwd);

  // Use picomatch for gitignore-style matching
  const isMatch = picomatch(resolvedPattern, {
    dot: true, // Match dotfiles (e.g. .env)
    nocase: false, // Case-sensitive (filesystem convention)
    // Note: do NOT set bash: true — it makes `*` match across directories.
    // Default picomatch behavior is gitignore-style: `*` = single dir, `**` = recursive.
  });

  return isMatch(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain matching (for WebFetch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a domain against a WebFetch domain specifier.
 *
 * Specifier format: `domain:example.com`
 * Matches the exact domain or any subdomain.
 *
 * Examples:
 *   matchesDomainPattern("domain:example.com", "example.com")      → true
 *   matchesDomainPattern("domain:example.com", "sub.example.com")  → true
 *   matchesDomainPattern("domain:example.com", "notexample.com")   → false
 */
export function matchesDomainPattern(
  specifier: string,
  domain: string,
): boolean {
  // Strip the "domain:" prefix if present
  const pattern = specifier.startsWith('domain:')
    ? specifier.substring(7).trim()
    : specifier.trim();

  if (!pattern || !domain) {
    return false;
  }

  const normalizedDomain = domain.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  // Exact match
  if (normalizedDomain === normalizedPattern) {
    return true;
  }

  // Subdomain match: "sub.example.com" matches "example.com"
  if (normalizedDomain.endsWith('.' + normalizedPattern)) {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP tool wildcard matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match an MCP tool name against a pattern that may contain wildcards.
 *
 * Per Claude Code docs:
 *   "mcp__puppeteer" matches any tool provided by the puppeteer server
 *   "mcp__puppeteer__*" wildcard syntax, also matches all tools from the server
 *   "mcp__puppeteer__puppeteer_navigate" matches only that exact tool
 */
function matchesMcpPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) {
    return true;
  }

  // Wildcard: "mcp__server__*" matches all tools from that server
  if (pattern.endsWith('__*')) {
    const prefix = pattern.slice(0, -1); // "mcp__server__"
    return toolName.startsWith(prefix);
  }

  // Server-level match: "mcp__puppeteer" matches "mcp__puppeteer__anything"
  // Only when the pattern has exactly 2 parts (mcp + server) and the tool has 3+
  const patternParts = pattern.split('__');
  const toolParts = toolName.split('__');
  if (
    patternParts.length === 2 &&
    toolParts.length >= 3 &&
    patternParts[0] === toolParts[0] &&
    patternParts[1] === toolParts[1]
  ) {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified rule matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for path-based matching, providing the directory context needed
 * to resolve relative path patterns.
 */
export interface PathMatchContext {
  /** The project root directory (absolute path). */
  projectRoot: string;
  /** The current working directory (absolute path). */
  cwd: string;
}

/**
 * Check whether a parsed PermissionRule matches a given context.
 *
 * Matching logic depends on the tool and specifier type:
 *
 * 1. **Tool name matching**:
 *    - "Read" rules also match grep_search, glob, list_directory (meta-category).
 *    - "Edit" rules also match write_file (meta-category).
 *    - MCP tools support wildcard patterns (e.g. "mcp__server__*").
 *
 * 2. **No specifier**: matches any invocation of the tool.
 *
 * 3. **With specifier** (depends on specifierKind):
 *    - `command`: Shell glob matching with word boundary & operator awareness
 *    - `path`: Gitignore-style file path matching (*, **)
 *    - `domain`: Domain matching for WebFetch
 *    - `literal`: Exact string match (for Agent subagent names, etc.)
 *
 * @param rule - The parsed permission rule
 * @param toolName - The canonical tool name being checked
 * @param command - Shell command (for Bash rules)
 * @param filePath - Absolute file path (for Read/Edit rules)
 * @param domain - Domain (for WebFetch rules)
 * @param pathContext - Project root and cwd for resolving relative path patterns
 */
export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  command?: string,
  filePath?: string,
  domain?: string,
  pathContext?: PathMatchContext,
): boolean {
  const canonicalCtxToolName = resolveToolName(toolName);

  // ── MCP tool matching ────────────────────────────────────────────────
  if (
    rule.toolName.startsWith('mcp__') ||
    canonicalCtxToolName.startsWith('mcp__')
  ) {
    return matchesMcpPattern(rule.toolName, canonicalCtxToolName);
  }

  // ── Standard tool name matching (with meta-category support) ─────────
  if (!toolMatchesRuleToolName(rule.toolName, canonicalCtxToolName)) {
    return false;
  }

  // ── No specifier → match any invocation of the tool ──────────────────
  if (!rule.specifier) {
    return true;
  }

  // ── Specifier matching (kind-dependent) ──────────────────────────────
  const kind = rule.specifierKind ?? getSpecifierKind(rule.toolName);

  switch (kind) {
    case 'command': {
      if (command === undefined) {
        return false;
      }
      return matchesCommandPattern(rule.specifier, command);
    }

    case 'path': {
      if (filePath === undefined) {
        return false;
      }
      const ctx = pathContext ?? {
        projectRoot: process.cwd(),
        cwd: process.cwd(),
      };
      return matchesPathPattern(
        rule.specifier,
        filePath,
        ctx.projectRoot,
        ctx.cwd,
      );
    }

    case 'domain': {
      if (domain === undefined) {
        return false;
      }
      return matchesDomainPattern(rule.specifier, domain);
    }

    case 'literal':
    default: {
      // Literal/exact matching (for Agent subagent names, etc.)
      if (command !== undefined) {
        return command === rule.specifier;
      }
      return false;
    }
  }
}
