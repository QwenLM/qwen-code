/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import picomatch from 'picomatch';
import { parse } from 'shell-quote';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  normalizeMcpToolName,
  sanitizeToolNameForProvider,
} from '../utils/tool-name-utils.js';
import { isNodeError } from '../utils/errors.js';

const debugLogger = createDebugLogger('PERMISSIONS');

/**
 * Normalize a filesystem path to use POSIX-style forward slashes.
 *
 * On Windows, `path.join()` produces backslash-separated paths, but the
 * permission rule system and picomatch both work with forward slashes.
 * This helper ensures consistent path separators across all platforms.
 *
 * Examples:
 *   toPosixPath('C:\\Users\\foo\\bar') → 'C:/Users/foo/bar'
 *   toPosixPath('/home/user/project') → '/home/user/project' (no-op on POSIX)
 */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
import type {
  PermissionCheckContext,
  PermissionRule,
  SpecifierKind,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool name aliases & categories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of known tool name aliases to their canonical names.
 * Covers all built-in tools plus common aliases (including Claude Code's "Bash").
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  // Exec tool
  exec: 'exec',
  Exec: 'exec',
  ExecTool: 'exec',

  // Shell tool
  run_shell_command: 'run_shell_command',
  Shell: 'run_shell_command',
  ShellTool: 'run_shell_command',
  Bash: 'run_shell_command', // Claude Code compatibility

  // Edit tool — "Edit" is also a meta-category covering edit + write_file
  edit: 'edit',
  Edit: 'edit',
  EditTool: 'edit',

  // Notebook Edit tool — also matched by "Edit" meta-category rules
  notebook_edit: 'notebook_edit',
  NotebookEdit: 'notebook_edit',
  NotebookEditTool: 'notebook_edit',

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

  // Zoom Image tool — also matched by "Read" meta-category rules
  zoom_image: 'zoom_image',
  ZoomImage: 'zoom_image',
  ZoomImageTool: 'zoom_image',

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

  // TodoList tool (wire name todo_write; class TodoWriteTool)
  todo_write: 'todo_write',
  TodoList: 'todo_write',
  // Legacy display name (renamed from "TodoWrite")
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

  // ReadMcpResource tool
  read_mcp_resource: 'read_mcp_resource',
  ReadMcpResource: 'read_mcp_resource',
  ReadMcpResourceTool: 'read_mcp_resource',

  // Agent (subagent) tool
  agent: 'agent',
  Agent: 'agent',
  AgentTool: 'agent',

  // Legacy aliases for the agent tool (renamed from "task")
  task: 'agent',
  Task: 'agent',
  TaskTool: 'agent',

  // Skill tool
  skill: 'skill',
  Skill: 'skill',
  SkillTool: 'skill',

  // ExitPlanMode tool
  exit_plan_mode: 'exit_plan_mode',
  ExitPlanMode: 'exit_plan_mode',
  ExitPlanModeTool: 'exit_plan_mode',

  // EnterPlanMode tool
  enter_plan_mode: 'enter_plan_mode',
  EnterPlanMode: 'enter_plan_mode',
  EnterPlanModeTool: 'enter_plan_mode',

  // LSP tool
  lsp: 'lsp',
  Lsp: 'lsp',
  LspTool: 'lsp',

  // Monitor tool
  monitor: 'monitor',
  Monitor: 'monitor',
  MonitorTool: 'monitor',

  // Send Message tool (teams)
  send_message: 'send_message',
  SendMessage: 'send_message',
  SendMessageTool: 'send_message',

  // Goal tools — the display name of get_goal is "Goal" (see ToolDisplayNames)
  get_goal: 'get_goal',
  Goal: 'get_goal',
  GetGoal: 'get_goal',
  update_goal: 'update_goal',
  UpdateGoal: 'update_goal',
  UpdateGoalTool: 'update_goal',
  propose_goal: 'propose_goal',
  ProposeGoal: 'propose_goal',
  ProposeGoalTool: 'propose_goal',

  // Save Memory tool
  save_memory: 'save_memory',
  SaveMemory: 'save_memory',
  SaveMemoryTool: 'save_memory',

  // Ask User Question tool
  ask_user_question: 'ask_user_question',
  AskUserQuestion: 'ask_user_question',
  AskUserQuestionTool: 'ask_user_question',

  // Cron tools
  cron_create: 'cron_create',
  CronCreate: 'cron_create',
  cron_list: 'cron_list',
  CronList: 'cron_list',
  cron_delete: 'cron_delete',
  CronDelete: 'cron_delete',

  // Loop wakeup tool
  loop_wakeup: 'loop_wakeup',
  LoopWakeup: 'loop_wakeup',
  LoopWakeupTool: 'loop_wakeup',

  // Create Sub Session tool
  create_sub_session: 'create_sub_session',
  CreateSubSession: 'create_sub_session',
  CreateSubSessionTool: 'create_sub_session',

  // List Agents tool
  list_agents: 'list_agents',
  ListAgents: 'list_agents',
  ListAgentsTool: 'list_agents',

  // Task lifecycle tools (teams)
  task_stop: 'task_stop',
  TaskStop: 'task_stop',
  task_create: 'task_create',
  TaskCreate: 'task_create',
  task_update: 'task_update',
  TaskUpdate: 'task_update',
  task_list: 'task_list',
  TaskList: 'task_list',

  // Team tools
  team_create: 'team_create',
  TeamCreate: 'team_create',
  team_delete: 'team_delete',
  TeamDelete: 'team_delete',
  team_plan_approval: 'team_plan_approval',
  TeamPlanApproval: 'team_plan_approval',

  // Image generation tool
  image_gen: 'image_gen',
  ImageGen: 'image_gen',
  ImageGenTool: 'image_gen',

  // Omni media tools
  omni_downsample_image: 'omni_downsample_image',
  DownsampleImage: 'omni_downsample_image',
  omni_downscale_video: 'omni_downscale_video',
  DownscaleVideo: 'omni_downscale_video',
  omni_downsample_audio: 'omni_downsample_audio',
  DownsampleAudio: 'omni_downsample_audio',
  omni_extract_keyframes: 'omni_extract_keyframes',
  ExtractKeyframes: 'omni_extract_keyframes',
  omni_extract_audio: 'omni_extract_audio',
  ExtractAudio: 'omni_extract_audio',
  omni_clip_video: 'omni_clip_video',
  ClipVideo: 'omni_clip_video',
  omni_convert_image: 'omni_convert_image',
  ConvertImage: 'omni_convert_image',
  omni_transcribe_audio: 'omni_transcribe_audio',
  TranscribeAudio: 'omni_transcribe_audio',
  omni_clip_image: 'omni_clip_image',
  ClipImage: 'omni_clip_image',
  omni_clip_audio: 'omni_clip_audio',
  ClipAudio: 'omni_clip_audio',
  omni_caption_image: 'omni_caption_image',
  CaptionImage: 'omni_caption_image',
  omni_caption_audio: 'omni_caption_audio',
  CaptionAudio: 'omni_caption_audio',
  omni_ocr_image: 'omni_ocr_image',
  OcrImage: 'omni_ocr_image',
  omni_understand_video_segments: 'omni_understand_video_segments',
  UnderstandVideoSegments: 'omni_understand_video_segments',
  omni_recall_media_memory: 'omni_recall_media_memory',
  RecallMediaMemory: 'omni_recall_media_memory',

  // Tool search tool
  tool_search: 'tool_search',
  ToolSearch: 'tool_search',
  ToolSearchTool: 'tool_search',

  // Structured output (synthetic --json-schema contract)
  structured_output: 'structured_output',
  StructuredOutput: 'structured_output',

  // Worktree tools
  enter_worktree: 'enter_worktree',
  EnterWorktree: 'enter_worktree',
  exit_worktree: 'exit_worktree',
  ExitWorktree: 'exit_worktree',

  // Workflow / artifact tools
  workflow: 'workflow',
  Workflow: 'workflow',
  artifact: 'artifact',
  Artifact: 'artifact',
  record_artifact: 'record_artifact',
  record_source: 'record_source',
  RecordSource: 'record_source',
  RecordArtifact: 'record_artifact',

  // Report Findings tool
  report_findings: 'report_findings',
  ReportFindings: 'report_findings',

  request_shutdown: 'request_shutdown',
  RequestShutdown: 'request_shutdown',

  // Display image tool
  display_image: 'display_image',
  DisplayImage: 'display_image',

  // Legacy edit tool name
  replace: 'edit',
};

/**
 * Shell tool canonical names. These use command-style rule specifiers.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'run_shell_command',
  'monitor',
]);

/**
 * File-reading tools — "Read" rules apply to all of these (best-effort).
 *
 * Per Claude Code docs: "Claude makes a best-effort attempt to apply Read rules
 * to all built-in tools that read files like Grep and Glob."
 */
const READ_TOOLS = new Set([
  'read_file',
  'zoom_image',
  'grep_search',
  'glob',
  'list_directory',
]);

/**
 * File-editing tools — "Edit" rules apply to all of these.
 *
 * Per Claude Code docs: "Edit rules apply to all built-in tools that edit files."
 */
const EDIT_TOOLS = new Set(['edit', 'write_file', 'notebook_edit']);

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
  return Object.hasOwn(TOOL_NAME_ALIASES, rawName)
    ? TOOL_NAME_ALIASES[rawName]!
    : rawName;
}

const TOOL_NAME_ALIASES_BY_CANONICAL: ReadonlyMap<string, readonly string[]> =
  (() => {
    const byCanonical = new Map<string, string[]>();
    for (const [alias, canonical] of Object.entries(TOOL_NAME_ALIASES)) {
      const aliases = byCanonical.get(canonical);
      if (aliases) {
        aliases.push(alias);
      } else {
        byCanonical.set(canonical, [alias]);
      }
    }
    return byCanonical;
  })();

/**
 * Every name that {@link resolveToolName} resolves to the given canonical tool
 * name, including Claude Code's names (`Bash`, `Read`, `Write`). Exact names
 * only: the meta-categories applied by {@link toolMatchesRuleToolName} (a
 * `Read` rule also covering `grep_search`, a `Bash` rule also covering
 * `monitor`) are not expanded here. Empty for a name the table does not know,
 * such as an MCP tool.
 */
export function getToolNameAliases(canonicalName: string): readonly string[] {
  return TOOL_NAME_ALIASES_BY_CANONICAL.get(canonicalName) ?? [];
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
 * "Read" → resolves to "read_file", but also covers zoom_image, grep_search,
 * glob, and list_directory
 * "Edit" → resolves to "edit", but also covers write_file
 * "Bash" → resolves to "run_shell_command", but also covers monitor
 * "Monitor" → resolves to "monitor" only; it does not cover shell
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
  // "Bash" (run_shell_command) → also covers monitor so that existing
  // `Bash(...)` allow rules are not silently bypassed by switching to
  // the monitor tool.  Monitor-only rules do NOT cover shell.
  if (ruleToolName === 'run_shell_command' && contextToolName === 'monitor') {
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
 *   "Agent(Explore)"            → subagent type literal match (alias for Task)
 *   "mcp__server__tool"         → MCP tool (no specifier needed)
 */
export function parseRule(raw: string): PermissionRule {
  const trimmed = raw.trim();

  const openParen = trimmed.indexOf('(');

  if (openParen === -1) {
    // Simple tool name rule (no specifier)
    const canonicalName = resolveToolName(trimmed);
    return {
      raw: trimmed,
      toolName: canonicalName,
    };
  }

  const toolPart = trimmed.substring(0, openParen).trim();

  if (!trimmed.endsWith(')')) {
    // Malformed: unbalanced parentheses — mark as invalid so it never matches.
    return { raw: trimmed, toolName: resolveToolName(toolPart), invalid: true };
  }

  let rawSpecifier = trimmed.substring(openParen + 1, trimmed.length - 1);
  const canonicalName = resolveToolName(toolPart);

  // Handle legacy `:*` suffix for command specifiers (deprecated, equivalent to ` *`)
  // e.g. "Bash(git:*)" → specifier becomes "git *"
  // Only applies to command-type specifiers to avoid interfering with key:value syntax
  const specifierKind = rawSpecifier
    ? getSpecifierKind(canonicalName)
    : undefined;
  if (specifierKind === 'command') {
    rawSpecifier = rawSpecifier.replace(/:(\*)/g, ' $1');
  }

  // For literal specifier kind, extract `key:value` param matchers.
  // Comma-separated: `Agent(coder,model:opus,type:*)` →
  //   specifier = "coder", toolParamMatchers = [{model,opus},{type,*}]
  let specifier: string | undefined = rawSpecifier;
  let toolParamMatchers:
    | Array<{ key: string; valuePattern: string }>
    | undefined;

  if (
    specifierKind === 'literal' &&
    !canonicalName.startsWith('mcp__') &&
    rawSpecifier.includes(':')
  ) {
    const parts = rawSpecifier.split(',').map((p) => p.trim());
    const plainParts: string[] = [];
    const matchers: Array<{ key: string; valuePattern: string }> = [];

    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx > 0) {
        const key = part.substring(0, colonIdx).trim();
        const valuePattern = part.substring(colonIdx + 1).trim();
        if (key && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          if (valuePattern === '') {
            debugLogger.warn(
              `Empty valuePattern in rule "${trimmed}": key="${key}" will only match empty strings. Use "*" to match any value.`,
            );
          }
          matchers.push({ key, valuePattern });
          continue;
        } else if (key && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          debugLogger.warn(
            `Invalid key "${key}" in rule "${trimmed}": keys must match /^[a-zA-Z_][a-zA-Z0-9_]*$/. Hyphens and dots are not supported.`,
          );
        }
      }
      plainParts.push(part);
    }

    if (matchers.length > 0) {
      toolParamMatchers = matchers;
      specifier = plainParts.join(',').trim() || undefined;
    }
  } else if (
    specifierKind !== 'literal' &&
    rawSpecifier.includes(':') &&
    !rawSpecifier.startsWith('domain:')
  ) {
    debugLogger.warn(
      `key:value syntax is only supported for literal-specifier tools (got ${specifierKind} for "${canonicalName}")`,
    );
  }

  return {
    raw: trimmed,
    toolName: canonicalName,
    specifier,
    specifierKind,
    toolParamMatchers,
  };
}

/**
 * Parse an array of raw rule strings into PermissionRule objects,
 * silently skipping any empty entries.
 */
export function parseRules(raws: string[]): PermissionRule[] {
  return raws
    .filter((r) => r && r.trim())
    .map(parseRule)
    .map((r) => {
      if (r.invalid) {
        debugLogger.warn(
          `Ignoring malformed rule (unbalanced parentheses): ${r.raw}`,
        );
      }
      return r;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimum-scope rule generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map from canonical tool names to the preferred display names used in
 * permission rule strings.
 *
 * Read tools all map to "Read" (meta-category) so a single rule covers the
 * entire family (read_file, zoom_image, grep_search, glob, list_directory).
 * Edit tools map to "Edit" (meta-category) covering edit + write_file.
 * Other tools use their individual display alias.
 */
const CANONICAL_TO_RULE_DISPLAY: Readonly<Record<string, string>> = {
  // Read meta-category
  read_file: 'Read',
  zoom_image: 'Read',
  grep_search: 'Read',
  glob: 'Read',
  list_directory: 'Read',
  // Edit meta-category
  edit: 'Edit',
  write_file: 'Edit',
  notebook_edit: 'Edit',
  // Shell
  run_shell_command: 'Bash',
  // Monitor
  monitor: 'Monitor',
  // Web
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  read_mcp_resource: 'ReadMcpResource',
  // Agent / Skill
  agent: 'Agent',
  skill: 'Skill',
  // Others
  save_memory: 'SaveMemory',
  todo_write: 'TodoList',
  lsp: 'Lsp',
  exit_plan_mode: 'ExitPlanMode',
  enter_plan_mode: 'EnterPlanMode',
};

/**
 * Get the human-friendly display name to use in a permission rule string
 * for a given canonical tool name.
 *
 * Falls back to the canonical name itself for unknown tools (e.g. MCP tools).
 */
export function getRuleDisplayName(canonicalToolName: string): string {
  return CANONICAL_TO_RULE_DISPLAY[canonicalToolName] ?? canonicalToolName;
}

/**
 * Tools whose parameter path points to a **file** (as opposed to a directory).
 *
 * For these tools the minimum-scope rule uses `path.dirname()` so the rule
 * covers the containing directory rather than a single file — e.g.
 *   zoom_image("/Users/alice/chart.png") → `Read(//Users/alice)`
 *
 * Directory-targeted tools (list_directory, grep_search, glob) already receive
 * a directory path, so they use it as-is.
 */
const FILE_TARGETED_TOOLS = new Set([
  'read_file',
  'zoom_image',
  'edit',
  'write_file',
  'notebook_edit',
]);

/**
 * Build minimum-scope permission rule strings from a permission check context.
 *
 * This is the **single, centralised** function for generating rules to be
 * persisted when a user selects "Always Allow".  Rules follow the format
 * `DisplayName(specifier)` where the specifier narrows the rule to the
 * minimum scope required by the current invocation.
 *
 * Specifier selection by tool category:
 *   - **path** tools (Read/Edit):
 *       File-targeted tools (read_file, zoom_image, edit, write_file) use the
 *       **parent directory** so the rule covers the whole directory, not a
 *       single file.
 *       Directory-targeted tools (grep, glob, ls) use the directory as-is.
 *       The `//` prefix denotes an absolute filesystem path in the rule grammar.
 *   - **domain** tools (WebFetch): `WebFetch(example.com)`
 *   - **command** tools (Bash): `Bash(command)` — note: Shell already generates
 *     its own fine-grained rules via `extractCommandRules`; this is a fallback.
 *   - **literal** tools (Skill/Task): `Skill(name)` / `Task(type)`
 *
 * If no specifier is available the rule falls back to the bare display name
 * (e.g. `Read`), which matches **all** invocations of that tool category.
 *
 * @param ctx - The permission check context (built in coreToolScheduler L4).
 * @returns Array of rule strings (usually a single element).
 */
export function buildPermissionRules(ctx: PermissionCheckContext): string[] {
  const canonicalName = resolveToolName(ctx.toolName);
  const displayName = getRuleDisplayName(canonicalName);
  const kind = getSpecifierKind(canonicalName);

  switch (kind) {
    case 'command':
      // Shell commands — fallback only; shell.ts provides its own rules via
      // extractCommandRules which are more granular (per-simple-command).
      if (ctx.command) {
        return [`${displayName}(${ctx.command})`];
      }
      return [displayName];

    case 'path':
      if (ctx.filePath) {
        // For file-targeted tools, scope to the containing directory;
        // for directory-targeted tools the path is already a directory.
        const dirPath = FILE_TARGETED_TOOLS.has(canonicalName)
          ? path.dirname(ctx.filePath)
          : ctx.filePath;
        // Use the `//` prefix for absolute filesystem paths in rule grammar.
        // Append `/**` so the gitignore-style glob matches all files in the
        // directory recursively (picomatch uses `**` for recursive descent).
        // resolvePathPattern("//foo/**") → "/foo/**" — round-trips correctly.
        const specifier = dirPath.startsWith('/')
          ? `/${dirPath}/**`
          : `${dirPath}/**`;
        return [`${displayName}(${specifier})`];
      }
      return [displayName];

    case 'domain':
      if (ctx.domain) {
        return [`${displayName}(${ctx.domain})`];
      }
      return [displayName];

    case 'literal':
    default: {
      // MCP tool names already encode server + tool identity.
      // Don't add specifiers or params — matchesRule rejects MCP rules
      // with specifiers, and existing MCP rules in user configs should
      // remain backward compatible.
      if (canonicalName.startsWith('mcp__')) {
        return [displayName];
      }

      const parts: string[] = [];
      if (ctx.specifier) parts.push(ctx.specifier);
      // Only serialize stable, identity-bearing params — not volatile content
      // like `prompt` or `query`, which would make rules invocation-specific
      // and could leak sensitive data into settings.json.
      const stableParamKeys = new Set(['model', 'subagent_type', 'skill']);
      if (ctx.toolParams) {
        for (const key of stableParamKeys) {
          const v = ctx.toolParams[key];
          if (typeof v === 'string' || typeof v === 'number') {
            // Skip values already represented by ctx.specifier
            if (ctx.specifier && String(v) === ctx.specifier) continue;
            parts.push(`${key}:${v}`);
          }
        }
      }
      if (parts.length > 0) return [`${displayName}(${parts.join(',')})`];
      return [displayName];
    }
  }
}

/**
 * Human-readable display names for permission rule categories.
 * Maps display name → verb phrase for use in "Always allow [verb phrase] in this project".
 */
const DISPLAY_NAME_TO_VERB: Readonly<Record<string, string>> = {
  Read: 'read files',
  Edit: 'edit files',
  Bash: 'run commands',
  Monitor: 'monitor commands',
  WebFetch: 'fetch from',
  WebSearch: 'search the web',
  Agent: 'use agent',
  Skill: 'use skill',
  SaveMemory: 'save memory',
  TodoList: 'write todos',
  Lsp: 'use LSP',
  ExitPlanMode: 'exit plan mode',
  EnterPlanMode: 'enter plan mode',
};

/**
 * Strip the glob suffix (e.g. `/**`) and the leading `//` from an absolute
 * path specifier so it reads cleanly in a UI label.
 *
 * `//Users/mochi/.qwen/**` → `/Users/mochi/.qwen/`
 * `/src/**`                → `src/`
 */
function cleanPathSpecifier(specifier: string): string {
  let cleaned = specifier;
  // Remove trailing glob patterns like /** or /*
  cleaned = cleaned.replace(/\/\*\*$/, '/').replace(/\/\*$/, '/');
  // Convert rule grammar `//absolute` → `/absolute`
  if (cleaned.startsWith('//')) {
    cleaned = cleaned.substring(1);
  }
  // Ensure trailing slash for directories
  if (!cleaned.endsWith('/')) {
    cleaned += '/';
  }
  return cleaned;
}

/**
 * Build a human-readable label describing what a set of permission rules allow.
 *
 * Used in "Always Allow" UI options to give users a clear, natural-language
 * description instead of raw rule syntax.
 *
 * Examples:
 *   `["Read(//Users/mochi/.qwen/**)"]`  → `"read files in /Users/mochi/.qwen/"`
 *   `["Bash(git *)"]`                    → `"run 'git *' commands"`
 *   `["WebFetch(github.com)"]`            → `"fetch from github.com"`
 *   `["Read"]`                            → `"read files"`
 *
 * @param rules - Array of rule strings from buildPermissionRules()
 * @returns A human-readable description string
 */
export function buildHumanReadableRuleLabel(rules: string[]): string {
  if (!rules.length) return '';

  const parts: string[] = [];
  for (const rule of rules) {
    // Parse "DisplayName(specifier)" or bare "DisplayName"
    const parenIdx = rule.indexOf('(');
    if (parenIdx === -1) {
      // Bare rule like "Read" or "Bash"
      const verb = DISPLAY_NAME_TO_VERB[rule] ?? rule.toLowerCase();
      parts.push(verb);
      continue;
    }

    const displayName = rule.substring(0, parenIdx);
    const specifier = rule.substring(parenIdx + 1, rule.length - 1); // strip parens
    const verb = DISPLAY_NAME_TO_VERB[displayName] ?? displayName.toLowerCase();

    const canonicalName = Object.entries(CANONICAL_TO_RULE_DISPLAY).find(
      ([, v]) => v === displayName,
    )?.[0];
    const kind = canonicalName ? getSpecifierKind(canonicalName) : 'literal';

    switch (kind) {
      case 'path': {
        const cleanPath = cleanPathSpecifier(specifier);
        parts.push(`${verb} in ${cleanPath}`);
        break;
      }
      case 'command': {
        const cmdVerb = DISPLAY_NAME_TO_VERB[displayName] ?? 'run';
        // Extract just the verb word (e.g. "run commands" → "run", "monitor commands" → "monitor")
        const verbWord = cmdVerb.split(' ')[0]!;
        parts.push(`${verbWord} '${specifier}' commands`);
        break;
      }
      case 'domain':
        parts.push(`${verb} ${specifier}`);
        break;
      case 'literal':
      default:
        parts.push(`${verb} "${specifier}"`);
        break;
    }
  }

  return parts.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell command matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shell operator tokens that act as command boundaries.
 * Ordered by length (longest first) for correct multi-char operator detection.
 */
const SHELL_OPERATORS = ['&&', '||', ';;', '|&', '|', ';', '&', '\n'];

/**
 * Count the consecutive backslashes immediately before `index`.
 *
 * An odd count means the character at `index` is itself escaped, so it is a
 * literal rather than a shell metacharacter.
 */
function precedingBackslashCount(command: string, index: number): number {
  let count = 0;
  for (let k = index - 1; k >= 0 && command[k] === '\\'; k--) {
    count++;
  }
  return count;
}

/**
 * Whether the `&` at `index` is the async (background) operator rather than
 * part of a redirection.
 *
 * `&&` and `|&` never reach here — they are longer, so they match first — which
 * leaves three forms to exclude: `&>` and `&>>` redirect both streams, and
 * `>&` / `<&` duplicate a descriptor (`2>&1`, `>&2`). Confirmed against bash:
 * `echo hi &> out` writes the file and backgrounds nothing, while
 * `echo one & echo two` really does run two commands.
 *
 * The backward scan is escape-aware, and has to be: `\>` is a literal `>`
 * argument, not a redirection, so `echo a \> & rm -rf /` really does background
 * the `echo` and then run the `rm`. Reading that `\>` as a redirection would
 * keep both halves in one segment and let the `echo`'s allow rule cover the
 * `rm`.
 */
function isAsyncOperator(command: string, index: number): boolean {
  if (command[index + 1] === '>') {
    return false;
  }
  for (let j = index - 1; j >= 0; j--) {
    const ch = command[j]!;
    if (/\s/.test(ch)) {
      continue;
    }
    if (ch === '>' || ch === '<') {
      // Escaped, so a literal argument and the `&` still backgrounds.
      return precedingBackslashCount(command, j) % 2 === 1;
    }
    return true;
  }
  return true;
}

/**
 * Characters that end a bash word, so a `#` after one of them starts a word and
 * so a comment: the three default `IFS` whitespace characters plus the operators
 * that separate commands. The start of the input is handled by
 * {@link isCommentStart} itself.
 *
 * The whitespace half is an explicit list rather than `\s`. JavaScript's `\s`
 * also matches `\r`, `\v`, `\f` and `\u00a0`, and bash treats none of those as
 * word separators: `bash -xc "$(printf 'echo a\r#c ; echo DANGER')"` traces two
 * commands, because the `#` is mid-word and literal while the `;` after it is a
 * real boundary. Reading that `#` as a comment folded the line into one segment,
 * so the command bash ran second never got its own rule check.
 *
 * Confirmed against bash for the operators: `echo a;#c` and `echo a&#c` each run
 * one command, and `echo a|#c` is a syntax error because the `#` comments out
 * the right-hand side of the pipe. Redirection operators and `(` are
 * deliberately absent: bash starts a word there too, but leaving them literal
 * only over-splits, which stays fail-closed, and no reported shape needs them.
 *
 * This state is this splitter's alone and it encodes bash's rules. The sibling
 * `splitCommands` in `../utils/shell-utils.ts` — reached through
 * `checkCommandPermissions`, so by the shell-confirmation path — has no `#`
 * state at all and so disagrees on inputs like `echo hi # ; rm -rf /tmp/x`,
 * and the rule is applied on every platform although cmd.exe has no `#` comment
 * character. Converging the two splitters, and deciding how a shell-agnostic
 * splitter learns the reported shell, is tracked in #11882. Three older
 * `#`-comment rules already live in this package
 * (`detectCommandSubstitution` in `../utils/shell-utils.ts`,
 * `findUnquotedCommentStart` and `splitTrailingShellComment` in
 * `../tools/shell.ts`), so grep the name before trusting one of them.
 */
const COMMENT_WORD_BOUNDARIES = [' ', '\t', '\n', ';', '&', '|'];

/**
 * Whether the `#` at `index` opens a comment rather than being a literal.
 *
 * bash only starts a comment at the start of a word, so `echo a#b` prints
 * `a#b` while `echo a #b` prints `a`. The same word rule keeps the arithmetic
 * base prefix in `echo $(( 8#17 ))` literal.
 *
 * The boundary check is escape-aware: a backslash-escaped space or operator
 * does not end a word, so the `#` after `a\ ` or `a\;` is mid-word and
 * literal — treating it as a comment would swallow the rest of the line and
 * merge a real `;` boundary away, dropping the rule check the following
 * command would have got.
 *
 * A `\<newline>` continuation is the one escape that does not keep the `#`
 * literal: bash deletes the backslash and the newline together, so the
 * character left adjacent to the `#` is the one before the backslash. Testing
 * the newline itself read the next line's `#` as mid-word, kept the `;` after
 * it a boundary, and fired a hard deny on a command bash never runs —
 * `bash --noprofile --norc -xc $'echo hi \\\n# c ; echo TAIL'` traces only
 * `+ echo hi`. Unlike `ask`, a deny cannot be approved past.
 */
function isCommentStart(command: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  // Step back over every `\<newline>` pair bash deletes, so the word test and
  // its escape parity are both evaluated against the character bash leaves
  // adjacent to the `#`.
  let previousIndex = index - 1;
  while (command[previousIndex] === '\n') {
    const continuation = precedingBackslashCount(command, previousIndex);
    if (continuation % 2 === 0) {
      break;
    }
    previousIndex -= continuation + 1;
  }
  if (previousIndex < 0) {
    // The command opens with continuations, so bash sees the `#` at the start
    // of a word.
    return true;
  }
  const previous = command[previousIndex]!;
  return (
    COMMENT_WORD_BOUNDARIES.includes(previous) &&
    precedingBackslashCount(command, previousIndex) % 2 === 0
  );
}

/**
 * One segment of a compound command, together with the operator that ended it.
 */
export interface CompoundCommandSegment {
  /** The trimmed simple command. */
  command: string;
  /**
   * The operator that terminated this segment, or `''` when the segment ran to
   * the end of the input. Lets callers tell a foreground segment from one the
   * shell runs in a subshell (`&`).
   */
  terminator: string;
}

/**
 * Split a compound shell command into its individual simple commands, keeping
 * the operator that terminated each one.
 *
 * See {@link splitCompoundCommand} for the string-only form and for examples;
 * this is the same split, and that function is a projection of this one.
 */
export function splitCompoundCommandSegments(
  command: string,
): CompoundCommandSegment[] {
  const segments: CompoundCommandSegment[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let lastSplit = 0;
  // Nesting depth of `$(( … ))` / `(( … ))`. Inside arithmetic a bare `&` is
  // bitwise AND, not the async operator, so `$(( FLAGS & MASK ))` is one word.
  let arithmeticDepth = 0;
  // Nesting depth of `${ … }` parameter expansions. bash tokenizes no comment
  // inside one, so a space-preceded `#` there is literal and the closing `}`
  // still closes the expansion: `bash -xc 'x=""; echo ${x:- a #b} ; touch m ;
  // echo SECOND'` traces `+ echo a '#b'`, `+ touch m` and `+ echo SECOND`.
  // Reading that `#` as a comment swallowed the `;` and folded both commands
  // into one allow-covered segment.
  let paramDepth = 0;
  // Nesting depth of `$( … )` command substitutions only — backtick bodies are
  // tracked separately by `backtickDepth` below. A substitution body is
  // scanned without honouring a `}`: bash parses the body before it looks for
  // the `}` that closes an enclosing `${ … }`, so a brace inside one must not
  // close the expansion — `bash -xc 'x=""; echo ${x:-$(echo }) #c} ; touch m ;
  // echo SECOND'` traces `+ touch m` and runs the tail, while counting that
  // `}` as the closer dropped the depth early and the literal `#` after it
  // then swallowed the real `;`. Both counters suppress the `}` closer, which
  // is why the `}` guard below consults both.
  let commandSubDepth = 0;
  // 0 or 1: whether the scanner is inside a backtick body. It is the only place
  // a `#`-comment ends at a backtick rather than at the physical newline, so the
  // skip below consults it.
  let backtickDepth = 0;
  // Quote state saved by each open `$( … )` / backtick body, restored at its
  // closer. bash parses a substitution body independently of the quotes around
  // it, so the body's own quotes must not close an enclosing string: one flat
  // `inDouble` desynced on `echo "$(printf "a # b")"`, the `#` inside the
  // nested string then read as word-initial, and the skip folded the real `;`
  // after the closing quote away, costing the tail command its own rule check.
  const quoteFrames: Array<[boolean, boolean]> = [];

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
    // Substitution openers are matched before the quote state is consulted: a
    // `$( … )` or backtick body inside a double-quoted string is still a
    // substitution, and its body is scanned with its own quote state. Inside a
    // single-quoted string both are literal text, so that case falls through to
    // the quote skip below. `$((` is arithmetic, not a substitution, and stays
    // with the arithmetic tracking further down.
    if (
      !inSingle &&
      ((ch === '$' && command[i + 1] === '(' && command[i + 2] !== '(') ||
        (ch === '`' && backtickDepth === 0))
    ) {
      quoteFrames.push([inSingle, inDouble]);
      inSingle = false;
      inDouble = false;
      if (ch === '`') {
        backtickDepth = 1;
      } else {
        commandSubDepth++;
      }
      continue;
    }
    if (!inSingle && ch === '`') {
      backtickDepth = 0;
      const frame = quoteFrames.pop();
      if (frame) {
        [inSingle, inDouble] = frame;
      }
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

    // Track `${ … }` nesting. Only the `#` branch below consults it, so an
    // operator inside the expansion is unaffected.
    if (ch === '$' && command[i + 1] === '{') {
      paramDepth++;
      i++; // -1 +1: step onto the `{`
      continue;
    }
    // Arithmetic's own closers are consumed below as the `))` pair, so a `)`
    // reached while `arithmeticDepth` is above zero is never the `)` that
    // closes a `$( … )`. Charging it here zeroed the depth on the first half of
    // `$((1))` and left the enclosing substitution counted as already closed:
    // in `echo ${x:-$(echo $((1)) }) #c} ; rm -rf /tmp/x` the literal `}` then
    // met the `commandSubDepth === 0` conjunct below, closed `${ … }` while
    // bash is still inside it, and the word-initial `#` passed the
    // `paramDepth === 0` gate and swallowed the real `;`, folding the tail into
    // one allow-covered segment (#11815).
    if (ch === ')' && arithmeticDepth === 0 && commandSubDepth > 0) {
      commandSubDepth--;
      // The body ended, so the quotes around it are live again: the `"` that
      // follows the closer of `"$(…)"` closes the outer string, and an operator
      // after that is a real boundary.
      const frame = quoteFrames.pop();
      if (frame) {
        [inSingle, inDouble] = frame;
      }
    }
    if (
      ch === '}' &&
      paramDepth > 0 &&
      commandSubDepth === 0 &&
      backtickDepth === 0
    ) {
      paramDepth--;
    }

    // A word-initial `#` opens a comment that runs to the end of the physical
    // line, so an operator inside it is not a boundary: bash runs
    // `echo 'a' # comment ; echo B` as a single `echo` (#11815).
    //
    // bash tokenizes no comment inside arithmetic and none inside a `${ … }`
    // expansion, so the `#` there stays literal and the delimiter closing the
    // construct still closes it. Both depth guards keep a following `;`, `&` or
    // newline a real boundary; without them the skip ran past the closing `))`
    // — which also stranded `arithmeticDepth` above zero and muted every later
    // bare `&` — or past the closing `}`.
    //
    // This scan deliberately ignores `escaped`. A backslash does not continue a
    // line inside a comment — bash really does run the `rm` in `echo hi # foo \`
    // followed by a newline and `rm -rf /` — so honouring the escape would fold
    // that second command into the comment's segment and cost it its own rule
    // check. For the same reason the newline is left for the operator scan
    // below, and stays a boundary. An unescaped backtick ends the skip only
    // when the `#` sits inside a backtick body: bash finds such a body's closing
    // delimiter with a raw scan that does not honour the `#`
    // (`bash -xc 'echo `date # c` ; echo SECOND'` traces `++ date`, `+ echo …`
    // and `+ echo SECOND`), so stopping there keeps the operator after it a
    // boundary. Outside a body the backtick is comment text bash has already
    // discarded, and stopping there handed the tail of the comment back to the
    // state machine below, which rebuilt quote, escape and arithmetic state out
    // of it — reopening a quote that never closes, re-arming the escape that
    // eats the newline, or stranding the arithmetic depth — and folded a real
    // boundary into an allow-covered segment.
    if (
      ch === '#' &&
      arithmeticDepth === 0 &&
      paramDepth === 0 &&
      isCommentStart(command, i)
    ) {
      const stopAtBacktick = backtickDepth > 0;
      const commentStart = i;
      while (
        i < command.length &&
        command[i] !== '\n' &&
        !(
          stopAtBacktick &&
          command[i] === '`' &&
          precedingBackslashCount(command, i) % 2 === 0
        )
      ) {
        i++;
      }
      // A comment that is the whole pending text (a full-line comment, the
      // common case in a multi-line command) produces no segment of its own:
      // emitting one would match no Bash(...) rule and drag the most
      // restrictive aggregation to ask although bash runs only the real
      // commands around it. When the skip stopped at a newline the operator
      // scan then emits an empty segment, which is not pushed; when it ran to
      // the end of input the final segment is empty and is not pushed either.
      if (command.slice(lastSplit, commentStart).trim() === '') {
        lastSplit = i;
      }
      i--; // -1 because the loop will i++, landing back on the delimiter
      continue;
    }

    if (ch === '(' && command[i + 1] === '(') {
      arithmeticDepth++;
      i++;
      continue;
    }
    if (arithmeticDepth > 0 && ch === ')' && command[i + 1] === ')') {
      arithmeticDepth--;
      i++;
      continue;
    }

    // Check for shell operators (longest match first)
    for (const op of SHELL_OPERATORS) {
      if (command.substring(i, i + op.length) !== op) {
        continue;
      }
      // A bare `&` bounds a command only when it is the async operator; its
      // other spellings belong to a redirection or to arithmetic, and stay in
      // the segment.
      if (op === '&' && (arithmeticDepth > 0 || !isAsyncOperator(command, i))) {
        continue;
      }
      const segment = command.substring(lastSplit, i).trim();
      if (segment) {
        segments.push({ command: segment, terminator: op });
      }
      lastSplit = i + op.length;
      i = lastSplit - 1; // -1 because the loop will i++
      break;
    }
  }

  // Add the last segment
  const lastSegment = command.substring(lastSplit).trim();
  if (lastSegment) {
    segments.push({ command: lastSegment, terminator: '' });
  }

  return segments;
}

/**
 * Split a compound shell command into its individual simple commands
 * by splitting on unquoted shell operators (&&, ||, ;, |, etc.).
 *
 * Returns an array of trimmed simple command strings.
 * For simple commands (no operators), returns a single-element array.
 *
 * Examples:
 *   "git status && rm -rf /"  → ["git status", "rm -rf /"]
 *   "ls -la | grep foo"      → ["ls -la", "grep foo"]
 *   "echo 'a && b'"          → ["echo 'a && b'"]  (inside quotes)
 *   "echo 'a' # c ; echo B"  → ["echo 'a' # c ; echo B"]  (inside a comment)
 *   "a && b || c"            → ["a", "b", "c"]
 *   "git status & rm -rf /"  → ["git status", "rm -rf /"]  (async operator)
 *   "build &> log.txt"       → ["build &> log.txt"]  (redirection, not async)
 *   "x=$(( a & b ))"         → ["x=$(( a & b ))"]  (arithmetic, not async)
 */
export function splitCompoundCommand(command: string): string[] {
  const commands = splitCompoundCommandSegments(command).map(
    (segment) => segment.command,
  );
  return commands.length > 0 ? commands : [command];
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
  // This function matches a single pattern against a single simple command.
  // Compound command splitting is handled by the caller (PermissionManager).
  const normalizedCommand = stripLeadingVariableAssignments(command);

  // Special case: lone `*` matches any single command
  if (pattern === '*') {
    return true;
  }

  if (!pattern.includes('*')) {
    // No wildcards: prefix matching (backward compat).
    // "git commit" matches "git commit" and "git commit -m test"
    // but NOT "gitcommit".
    return (
      normalizedCommand === pattern ||
      normalizedCommand.startsWith(pattern + ' ')
    );
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
    return new RegExp(regex, 's').test(normalizedCommand);
  } catch {
    return normalizedCommand === pattern;
  }
}

/**
 * Match a glob pattern against a value using linear-time greedy matching.
 * `*` matches any substring (including empty). Case-insensitive to match
 * the convention used by matchesDomainPattern. No regex involved — avoids
 * ReDoS risk from catastrophic backtracking on multi-wildcard patterns.
 */
function matchesParamValuePattern(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedValue = value.toLowerCase();

  if (normalizedPattern === '*') {
    return true;
  }
  if (!normalizedPattern.includes('*')) {
    return normalizedValue === normalizedPattern;
  }

  const segments = normalizedPattern.split('*');
  let pos = 0;

  // First segment must match at the start
  if (segments[0]!.length > 0) {
    if (!normalizedValue.startsWith(segments[0]!)) {
      return false;
    }
    pos = segments[0]!.length;
  }

  // Middle segments: find next occurrence greedily
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (seg.length === 0) continue;
    const idx = normalizedValue.indexOf(seg, pos);
    if (idx === -1) {
      return false;
    }
    pos = idx + seg.length;
  }

  // Last segment must match at the end
  const last = segments[segments.length - 1]!;
  if (last.length > 0) {
    if (normalizedValue.length - pos < last.length) {
      return false;
    }
    return normalizedValue.endsWith(last);
  }

  return true;
}

/**
 * Evaluate all param matchers against the given toolParams.
 * Returns true if all matchers pass, false otherwise.
 * Shared between MCP and standard matching branches.
 */
function evaluateParamMatchers(
  matchers: Array<{ key: string; valuePattern: string }>,
  toolParams: Record<string, unknown> | undefined,
  ruleRaw: string,
): boolean {
  if (!toolParams) {
    debugLogger.debug(`Param matcher rule "${ruleRaw}" skipped: no toolParams`);
    return false;
  }
  for (const matcher of matchers) {
    if (!Object.hasOwn(toolParams, matcher.key)) {
      debugLogger.debug(
        `Param matcher failed: rule="${ruleRaw}" key=${matcher.key} expected="${matcher.valuePattern}" actual=missing`,
      );
      return false;
    }
    const actualValue = toolParams[matcher.key];
    if (actualValue === undefined || actualValue === null) {
      debugLogger.debug(
        `Param matcher failed: rule="${ruleRaw}" key=${matcher.key} expected="${matcher.valuePattern}" actual=null/undefined`,
      );
      return false;
    }
    if (typeof actualValue !== 'string' && typeof actualValue !== 'number') {
      debugLogger.debug(
        `Param matcher skipped: rule="${ruleRaw}" key=${matcher.key} value is ${typeof actualValue}`,
      );
      return false;
    }
    const actualStr = String(actualValue);
    if (!matchesParamValuePattern(matcher.valuePattern, actualStr)) {
      debugLogger.debug(
        `Param matcher failed: rule="${ruleRaw}" key=${matcher.key} expected="${matcher.valuePattern}" actual="${actualStr}"`,
      );
      return false;
    }
  }
  return true;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripLeadingVariableAssignments(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const tokens: string[] = [];

    for (const token of parse(trimmed)) {
      if (typeof token === 'string') {
        tokens.push(token);
      } else if (
        token &&
        typeof token === 'object' &&
        'op' in token &&
        typeof token.op === 'string'
      ) {
        tokens.push(token.op);
      }
    }

    let firstCommandToken = 0;
    while (
      firstCommandToken < tokens.length &&
      ENV_ASSIGNMENT_REGEX.test(tokens[firstCommandToken]!)
    ) {
      firstCommandToken++;
    }

    return tokens.slice(firstCommandToken).join(' ');
  } catch {
    return trimmed;
  }
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
    // Normalize homedir to forward slashes for cross-platform picomatch compatibility
    return toPosixPath(path.join(os.homedir(), specifier.substring(2)));
  }

  if (specifier.startsWith('/')) {
    // Relative to project root (NOT absolute!)
    return toPosixPath(path.join(projectRoot, specifier.substring(1)));
  }

  if (specifier.startsWith('./')) {
    // Relative to current working directory
    return toPosixPath(path.join(cwd, specifier.substring(2)));
  }

  // No prefix: relative to current working directory
  return toPosixPath(path.join(cwd, specifier));
}

/**
 * Match a file path against a gitignore-style path pattern.
 *
 * Uses picomatch for the actual glob matching, following gitignore semantics:
 *   - `*` matches files in a single directory (does not cross `/`)
 *   - `**` matches recursively across directories
 * When `matchMode` is `'canonical'`, both the lexical absolute path and its
 * canonical filesystem destination are considered. For new files, the closest
 * existing ancestor is canonicalized.
 *
 * @param specifier - The raw specifier from the rule (e.g. "./secrets/**")
 * @param filePath - The absolute path of the file being accessed
 * @param projectRoot - The project root directory (absolute)
 * @param cwd - The current working directory (absolute)
 * @param matchMode - Whether to also match the canonical filesystem destination
 * @returns True if the file path matches the pattern
 */
export function matchesPathPattern(
  specifier: string,
  filePath: string,
  projectRoot: string,
  cwd: string,
  matchMode: 'lexical' | 'canonical' = 'lexical',
): boolean {
  const resolvedPattern = resolvePathPattern(specifier, projectRoot, cwd);
  const patterns =
    matchMode === 'canonical'
      ? getCanonicalPatternCandidates(resolvedPattern)
      : [resolvedPattern];
  const matchers = patterns.map((pattern) =>
    picomatch(pattern, {
      dot: true,
      nocase: false,
    }),
  );
  const paths =
    matchMode === 'canonical'
      ? getCanonicalPathMatchCandidates(filePath, cwd)
      : [toPosixPath(filePath)];

  return paths.some((candidate) =>
    matchers.some((isMatch) => isMatch(candidate)),
  );
}

function getCanonicalPatternCandidates(resolvedPattern: string): string[] {
  const candidates = new Set([resolvedPattern]);
  const { base } = picomatch.scan(resolvedPattern);
  const canonicalBase = realpathNearestExisting(base);
  if (canonicalBase !== undefined) {
    candidates.add(
      `${toPosixPath(canonicalBase)}${resolvedPattern.slice(base.length)}`,
    );
  }
  return [...candidates];
}

function getCanonicalPathMatchCandidates(
  filePath: string,
  cwd: string,
): string[] {
  const candidates = new Set([toPosixPath(filePath)]);
  const absolutePath = resolveWithoutNormalizing(cwd, filePath);
  const canonicalPath = realpathNearestExisting(absolutePath);
  if (canonicalPath !== undefined) {
    candidates.add(toPosixPath(canonicalPath));
  }
  return [...candidates];
}

function resolveWithoutNormalizing(base: string, filePath: string): string {
  // Preserve `..` until realpathNearestExisting resolves symlinks on disk.
  return path.isAbsolute(filePath)
    ? filePath
    : `${base}${/[\\/]$/.test(base) ? '' : path.sep}${filePath}`;
}

function realpathNearestExisting(filePath: string): string | undefined {
  let current = filePath;
  const missingSegments: string[] = [];
  let symlinkHops = 0;
  const maxSymlinkHops = 40;

  while (true) {
    try {
      // Joining deliberately normalizes traversal in the unresolved suffix.
      return path.join(fs.realpathSync.native(current), ...missingSegments);
    } catch (error: unknown) {
      if (
        !isNodeError(error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      ) {
        return undefined;
      }
    }

    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        if (symlinkHops++ >= maxSymlinkHops) {
          return undefined;
        }
        const target = fs.readlinkSync(current);
        const parent = fs.realpathSync.native(path.dirname(current));
        current = resolveWithoutNormalizing(parent, target);
        continue;
      }
    } catch (error: unknown) {
      if (
        !isNodeError(error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      ) {
        return undefined;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
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
export function matchesMcpPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) {
    return true;
  }

  // Exact rules persisted before provider-safe MCP names were introduced
  // should continue matching their deterministic normalized registration.
  if (
    !pattern.endsWith('*') &&
    pattern.split('__').length >= 3 &&
    normalizeMcpToolName(pattern) === normalizeMcpToolName(toolName)
  ) {
    return true;
  }

  // Wildcard: patterns ending with "*" match by prefix.
  // e.g. "mcp__server__*" matches all tools from that server,
  //      "mcp__chrome__use_*" matches all "use_*" tools from chrome.
  if (pattern.endsWith('*')) {
    const prefix = sanitizeToolNameForProvider(pattern.slice(0, -1));
    return sanitizeToolNameForProvider(toolName).startsWith(prefix);
  }

  // Server-level match: "mcp__puppeteer" matches "mcp__puppeteer__anything"
  // Only when the pattern has exactly 2 parts (mcp + server) and the tool has 3+
  const patternParts = pattern.split('__');
  const toolParts = toolName.split('__');
  if (
    patternParts.length === 2 &&
    toolParts.length >= 3 &&
    patternParts[0] === toolParts[0] &&
    sanitizeToolNameForProvider(patternParts[1]) ===
      sanitizeToolNameForProvider(toolParts[1])
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
 * @param pathMatchMode - Whether path rules also match canonical destinations
 */
export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  command?: string,
  filePath?: string,
  domain?: string,
  pathContext?: PathMatchContext,
  specifier?: string,
  toolParams?: Record<string, unknown>,
  toolAliases?: readonly string[],
  pathMatchMode: 'lexical' | 'canonical' = 'lexical',
): boolean {
  const canonicalCtxToolName = resolveToolName(toolName);

  // ── Invalid (malformed) rules never match anything ──────────────────
  if (rule.invalid) {
    return false;
  }

  // ── MCP tool matching ────────────────────────────────────────────────
  if (
    rule.toolName.startsWith('mcp__') ||
    canonicalCtxToolName.startsWith('mcp__')
  ) {
    const matchesLegacyExactName =
      !rule.toolName.endsWith('*') &&
      rule.toolName.split('__').length >= 3 &&
      (toolAliases ?? []).some(
        (alias) => rule.toolName === resolveToolName(alias),
      );
    const matchesMcpName =
      matchesMcpPattern(rule.toolName, canonicalCtxToolName) ||
      matchesLegacyExactName;
    if (!matchesMcpName) {
      return false;
    }

    // MCP rules should not carry an unexpected specifier — the tool name
    // already encodes server + tool identity. If a specifier was somehow
    // parsed (e.g. user wrote `mcp__srv__tool(XXX)`), reject the match
    // rather than silently ignoring the constraint.
    if (rule.specifier) {
      debugLogger.debug(
        `MCP rule "${rule.raw}" has specifier "${rule.specifier}" — MCP tool names already encode server identity; specifier not supported`,
      );
      return false;
    }

    // MCP tools matched by name; now check param matchers if present
    if (rule.toolParamMatchers?.length) {
      if (
        !evaluateParamMatchers(rule.toolParamMatchers, toolParams, rule.raw)
      ) {
        return false;
      }
    }
    return true;
  }

  // ── Standard tool name matching (with meta-category support) ─────────
  if (!toolMatchesRuleToolName(rule.toolName, canonicalCtxToolName)) {
    return false;
  }

  // ── No specifier and no param matchers → match any invocation ────────
  if (!rule.specifier && !rule.toolParamMatchers?.length) {
    return true;
  }

  // ── Specifier matching (kind-dependent) ──────────────────────────────
  const kind = rule.specifierKind ?? getSpecifierKind(rule.toolName);

  let specifierMatched = true;

  if (rule.specifier) {
    switch (kind) {
      case 'command': {
        if (command === undefined) {
          return false;
        }
        specifierMatched = matchesCommandPattern(rule.specifier, command);
        break;
      }

      case 'path': {
        if (filePath === undefined) {
          return false;
        }
        const ctx = pathContext ?? {
          projectRoot: process.cwd(),
          cwd: process.cwd(),
        };
        specifierMatched = matchesPathPattern(
          rule.specifier,
          filePath,
          ctx.projectRoot,
          ctx.cwd,
          pathMatchMode,
        );
        break;
      }

      case 'domain': {
        if (domain === undefined) {
          return false;
        }
        specifierMatched = matchesDomainPattern(rule.specifier, domain);
        break;
      }

      case 'literal':
      default: {
        const value = command ?? specifier;
        specifierMatched = value !== undefined && value === rule.specifier;
        break;
      }
    }
  }

  if (!specifierMatched) {
    return false;
  }

  // ── Tool param matching (key:value syntax) ───────────────────────────
  if (rule.toolParamMatchers?.length) {
    if (!evaluateParamMatchers(rule.toolParamMatchers, toolParams, rule.raw)) {
      return false;
    }
  }

  return true;
}
