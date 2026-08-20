/**
 * Shared PreToolUse utilities and centralized PreToolUse pipeline.
 *
 * Individual utility functions (path expansion, skill qualification, etc.)
 * are used by the centralized `runPreToolUseChecks()` pipeline. Agent
 * backends call it with normalized input and translate the result to their
 * runtime-specific format.
 *
 * Pipeline steps:
 * 1. Permission mode check: Block tools disallowed by current mode
 * 2. Source blocking: Block tools from inactive MCP sources
 * 3. Prerequisite check: Block source tools until guide.md is read
 * 4. call_llm detection: Intercept mcp__session__call_llm
 * 5. Input transforms: Path expansion, config validation, skill qualification, metadata stripping
 * 6. Ask-mode prompt decision: Determine if user approval is needed
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { expandPath } from '../../utils/paths.ts';
import {
  detectConfigFileType,
  detectAppConfigFileType,
  validateConfigFileContent,
  formatValidationResult,
  type ConfigFileDetection,
} from '../../config/validators.ts';
import {
  CLI_DOMAIN_POLICIES,
  CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES,
  CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES,
  type CliDomainNamespace,
} from '../../config/cli-domains.ts';
import { FEATURE_FLAGS } from '../../feature-flags.ts';
import { AGENTS_PLUGIN_NAME } from '../../skills/types.ts';
import { GLOBAL_AGENT_SKILLS_DIR, PROJECT_AGENT_SKILLS_DIR } from '../../skills/storage.ts';
import {
  shouldAllowToolInMode,
  isApiEndpointAllowed,
  isReadOnlyBashCommandWithConfig,
  getPermissionModeDiagnostics,
  PERMISSION_MODE_CONFIG,
  type PermissionMode,
} from '../mode-manager.ts';
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';
import type { PrerequisiteCheckResult } from './prerequisite-manager.ts';

// ============================================================
// TYPES
// ============================================================

export interface PreToolUseContext {
  /** Current working directory or workspace root */
  workspaceRootPath: string;
  /** Workspace ID for skill qualification */
  workspaceId: string;
  /** Debug callback */
  onDebug?: (message: string) => void;
}

export interface PathExpansionResult {
  /** Whether any paths were modified */
  modified: boolean;
  /** The updated input (or original if not modified) */
  input: Record<string, unknown>;
}

export interface SkillQualificationResult {
  /** Whether the skill name was qualified */
  modified: boolean;
  /** The updated input */
  input: Record<string, unknown>;
}

export interface MetadataStrippingResult {
  /** Whether metadata was stripped */
  modified: boolean;
  /** The cleaned input */
  input: Record<string, unknown>;
}

export interface ConfigValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

// ============================================================
// BUILT-IN TOOLS
// ============================================================

/** SDK built-in tools that should NOT have metadata stripped */
export const BUILT_IN_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'SubmitPlan',
  'Skill',
  'SlashCommand',
  'TaskStop',
]);

/** Tools that operate on file paths */
export const FILE_PATH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
]);

/** Tools that can write config files */
export const CONFIG_WRITE_TOOLS = new Set(['Write', 'Edit']);

/** File tools blocked for labels domain. */
export const LABELS_BLOCKED_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);


// ============================================================
// PATH EXPANSION
// ============================================================

/**
 * Expand ~ paths in file tool inputs.
 *
 * Handles multiple path parameters:
 * - file_path: Used by Read, Write, Edit, MultiEdit
 * - notebook_path: Used by NotebookEdit
 * - path: Used by Glob, Grep
 *
 * @param toolName - The SDK tool name
 * @param input - The tool input object
 * @param onDebug - Optional debug callback
 * @returns PathExpansionResult with modified flag and updated input
 */
export function expandToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  onDebug?: (message: string) => void
): PathExpansionResult {
  if (!FILE_PATH_TOOLS.has(toolName)) {
    return { modified: false, input };
  }

  let updatedInput: Record<string, unknown> | null = null;

  // Expand file_path if present and starts with ~
  if (typeof input.file_path === 'string' && input.file_path.startsWith('~')) {
    const expandedPath = expandPath(input.file_path);
    onDebug?.(`Expanding path: ${input.file_path} → ${expandedPath}`);
    updatedInput = { ...input, file_path: expandedPath };
  }

  // Expand notebook_path if present and starts with ~
  if (typeof input.notebook_path === 'string' && input.notebook_path.startsWith('~')) {
    const expandedPath = expandPath(input.notebook_path);
    onDebug?.(`Expanding notebook path: ${input.notebook_path} → ${expandedPath}`);
    updatedInput = { ...(updatedInput || input), notebook_path: expandedPath };
  }

  // Expand path if present and starts with ~ (for Glob, Grep)
  if (typeof input.path === 'string' && input.path.startsWith('~')) {
    const expandedPath = expandPath(input.path);
    onDebug?.(`Expanding search path: ${input.path} → ${expandedPath}`);
    updatedInput = { ...(updatedInput || input), path: expandedPath };
  }

  return {
    modified: updatedInput !== null,
    input: updatedInput || input,
  };
}

// ============================================================
// SKILL QUALIFICATION
// ============================================================

/**
 * Ensure skill names are fully-qualified with the correct plugin prefix.
 *
 * The runtime resolves skills as `pluginName:skillSlug` where the plugin name is
 * read from the workspace plugin manifest `name` field. Skills can live in 3 tiers:
 *   1. Workspace: {workspaceRoot}/skills/{slug}/ → plugin name from plugin.json
 *   2. Project:   {workingDir}/.agents/skills/{slug}/ → plugin name = ".agents"
 *   3. Global:    ~/.agents/skills/{slug}/ → plugin name = ".agents"
 *
 * This function resolves the bare slug to the correct plugin prefix by checking
 * which directory actually contains the skill. It also handles re-qualifying
 * skills that were incorrectly qualified by the UI (which always uses the
 * workspace slug, even for global/project skills).
 *
 * @param input - The Skill tool input ({ skill: string, args?: string })
 * @param workspaceSlug - The workspace plugin slug
 * @param workspaceRootPath - Absolute path to the workspace root
 * @param workingDirectory - Absolute path to the current working directory (optional)
 * @param onDebug - Optional debug callback
 * @returns SkillQualificationResult with modified flag and updated input
 */
export function qualifySkillName(
  input: Record<string, unknown>,
  workspaceSlug: string,
  workspaceRootPath?: string,
  workingDirectory?: string,
  onDebug?: (message: string) => void
): SkillQualificationResult {
  const skill = input.skill as string | undefined;
  if (!skill) return { modified: false, input };

  // Extract the bare slug — strip any existing qualifier (e.g. "CraftAgentWS:commit" → "commit")
  const bareSlug = skill.includes(':') ? skill.split(':').pop()! : skill;
  if (!bareSlug) return { modified: false, input };

  // If we don't have the workspace root path, fall back to simple workspace-only qualification
  if (!workspaceRootPath) {
    if (skill.includes(':')) return { modified: false, input };
    const qualifiedSkill = `${workspaceSlug}:${skill}`;
    onDebug?.(`Skill tool: qualified "${skill}" → "${qualifiedSkill}" (legacy fallback)`);
    return { modified: true, input: { ...input, skill: qualifiedSkill } };
  }

  // Resolve which plugin tier contains this skill by checking SKILL.md existence
  const resolvedSkill = resolveSkillPlugin(bareSlug, workspaceSlug, workspaceRootPath, workingDirectory);

  if (resolvedSkill === skill) {
    // Already correctly qualified
    return { modified: false, input };
  }

  onDebug?.(`Skill tool: qualified "${skill}" → "${resolvedSkill}"`);
  return {
    modified: true,
    input: { ...input, skill: resolvedSkill },
  };
}

/**
 * Resolve a skill slug to its fully-qualified plugin:slug name by checking
 * which plugin directory actually contains the skill.
 */
function resolveSkillPlugin(
  bareSlug: string,
  workspaceSlug: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string {
  // Priority order matches loadAllSkills: project (highest) > workspace > global (lowest)

  // 1. Project: {workingDir}/.agents/skills/{slug}/SKILL.md
  if (workingDirectory && existsSync(join(workingDirectory, PROJECT_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))) {
    return `${AGENTS_PLUGIN_NAME}:${bareSlug}`;
  }

  // 2. Workspace: {workspaceRoot}/skills/{slug}/SKILL.md
  if (existsSync(join(workspaceRootPath, 'skills', bareSlug, 'SKILL.md'))) {
    return `${workspaceSlug}:${bareSlug}`;
  }

  // 3. Global: ~/.agents/skills/{slug}/SKILL.md
  if (existsSync(join(GLOBAL_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))) {
    return `${AGENTS_PLUGIN_NAME}:${bareSlug}`;
  }

  // Fallback: assume workspace plugin (original behavior)
  return `${workspaceSlug}:${bareSlug}`;
}

// ============================================================
// MCP METADATA STRIPPING
// ============================================================

/**
 * Strip _intent and _displayName metadata from tool inputs.
 *
 * These fields are injected into tool schemas so the backend can provide
 * semantic intent for UI display. They must be stripped before execution to
 * avoid runtime validation errors and MCP server rejections.
 *
 * The extraction for UI happens in tool-matching.ts BEFORE this stripping.
 *
 * @param toolName - The tool name
 * @param input - The tool input object
 * @param onDebug - Optional debug callback
 * @returns MetadataStrippingResult with modified flag and cleaned input
 */
export function stripToolMetadata(
  toolName: string,
  input: Record<string, unknown>,
  onDebug?: (message: string) => void
): MetadataStrippingResult {
  const hasMetadata = '_intent' in input || '_displayName' in input;

  if (!hasMetadata) {
    return { modified: false, input };
  }

  // Strip the metadata fields
  const { _intent, _displayName, ...cleanInput } = input;
  onDebug?.(`Stripped tool metadata from ${toolName}: _intent=${!!_intent}, _displayName=${!!_displayName}`);

  return {
    modified: true,
    input: cleanInput,
  };
}

/**
 * @deprecated Use stripToolMetadata instead. This alias is kept for backwards compatibility.
 */
export const stripMcpMetadata = stripToolMetadata;

// ============================================================
// CONFIG FILE VALIDATION
// ============================================================

/**
 * Validate config file writes before they happen.
 *
 * For Write/Edit operations on workspace config files, validates the
 * resulting content before allowing the write to proceed. This prevents
 * invalid configs from ever reaching disk.
 *
 * Validates:
 * - sources/{slug}/config.json
 * - skills/{slug}/SKILL.md
 * - statuses/config.json
 * - permissions.json
 * - theme.json
 * - tool-icons/tool-icons.json
 *
 * @param toolName - 'Write' or 'Edit'
 * @param input - The tool input (with expanded paths)
 * @param workspaceRootPath - The workspace root path for detection
 * @param onDebug - Optional debug callback
 * @returns ConfigValidationResult with valid flag and optional error
 */
export function validateConfigWrite(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  onDebug?: (message: string) => void
): ConfigValidationResult {
  if (!CONFIG_WRITE_TOOLS.has(toolName)) {
    return { valid: true };
  }

  const filePath = input.file_path as string | undefined;
  if (!filePath) {
    return { valid: true };
  }

  // Check workspace-scoped configs first, then app-level configs
  const detection: ConfigFileDetection | null =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);

  if (!detection) {
    // Not a config file - allow
    return { valid: true };
  }

  let contentToValidate: string | null = null;

  if (toolName === 'Write') {
    // For Write, the full file content is in input.content
    contentToValidate = input.content as string;
  } else if (toolName === 'Edit') {
    // For Edit, simulate the replacement on the current file content
    try {
      const currentContent = readFileSync(filePath, 'utf-8');
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = input.replace_all as boolean | undefined;
      contentToValidate = replaceAll
        ? currentContent.replaceAll(oldString, newString)
        : currentContent.replace(oldString, newString);
    } catch {
      // File doesn't exist yet or can't be read — skip validation
      // (Write tool will create it; Edit will fail on its own)
      return { valid: true };
    }
  }

  if (!contentToValidate) {
    return { valid: true };
  }

  const validationResult = validateConfigFileContent(detection, contentToValidate);

  if (validationResult && !validationResult.valid) {
    onDebug?.(
      `Config validation blocked ${toolName} to ${detection.displayFile}: ${validationResult.errors.length} errors`
    );
    return {
      valid: false,
      error: `Cannot write invalid config to ${detection.displayFile}.\n\n${formatValidationResult(validationResult)}\n\nFix the errors above and try again.`,
    };
  }

  return { valid: true };
}

function buildCliDomainBlockMessage(namespace: CliDomainNamespace, context: string): string {
  const policy = CLI_DOMAIN_POLICIES[namespace]
  const noun = namespace === 'automation' ? 'automation' : namespace
  const quickExamplesHeading = namespace === 'label' ? 'Quick examples:' : 'Examples:'

  return [
    `${context}`,
    `Use \`craft-agent ${namespace} ...\` instead.`,
    `Run \`${policy.helpCommand}\` for the full ${noun} command reference.`,
    '',
    quickExamplesHeading,
    ...policy.quickExamples.map(example => `  ${example}`),
  ].join('\n')
}

function getWorkspaceRelativePath(
  filePath: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string | null {
  const normalizedWorkspaceRoot = resolve(workspaceRootPath).replace(/\\/g, '/').replace(/\/?$/, '/');
  const resolvedPath = filePath.startsWith('/')
    ? resolve(filePath)
    : resolve(workingDirectory ?? workspaceRootPath, filePath);
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedWorkspaceRoot)) return null;

  return normalizedPath.slice(normalizedWorkspaceRoot.length);
}

function matchesPathScope(relativePath: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3)
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }

  if (scope.includes('*')) {
    const escaped = scope
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]+')
    return new RegExp(`^${escaped}$`).test(relativePath)
  }

  return relativePath === scope
}

function detectCliNamespaceFromConfigDetection(detection: ConfigFileDetection): CliDomainNamespace | null {
  if (detection.type === 'labels') return 'label'
  if (detection.type === 'automations') return 'automation'
  if (detection.type === 'source') return 'source'
  if (detection.type === 'skill') return 'skill'
  return null
}

/**
 * For selected config domains, enforce CLI usage instead of direct file operations.
 * - labels/**: strict block on Read/Write/Edit
 * - sources/{slug}/config.json: redirect on Write/Edit
 * - skills/{slug}/SKILL.md: redirect on Write/Edit
 * - automations.json: redirect on Write/Edit
 */
export function getConfigCliRedirect(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const filePath = input.file_path as string | undefined;

  if (filePath && LABELS_BLOCKED_FILE_TOOLS.has(toolName)) {
    const relativePath = getWorkspaceRelativePath(filePath, workspaceRootPath, workingDirectory)
    if (relativePath) {
      const labelsScopeMatch = CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES.find(
        entry => entry.namespace === 'label' && matchesPathScope(relativePath, entry.scope)
      )
      if (labelsScopeMatch) {
        return {
          message: buildCliDomainBlockMessage(
            'label',
            `Direct ${toolName} operations in labels/ are blocked.`
          ),
        }
      }
    }
  }

  if (!CONFIG_WRITE_TOOLS.has(toolName)) return null;
  if (!filePath) return null;

  const detection =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);
  if (!detection) return null;

  const namespace = detectCliNamespaceFromConfigDetection(detection)
  if (!namespace) return null

  return {
    message: buildCliDomainBlockMessage(
      namespace,
      `Direct ${toolName} operations in ${detection.displayFile} are blocked.`
    ),
  }
}

/**
 * Block bash commands that operate on guarded config paths unless they use craft-agent commands.
 * Current guarded domains in Bash are declared in shared CLI domain policy.
 */
export function getConfigDomainBashRedirect(
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return null;

  if (/^craft-agent\s+(label|automation|source|skill)\b/.test(command)) {
    return null;
  }

  const baseDir = resolve(workingDirectory ?? workspaceRootPath);
  const tokenRegex = /'([^']+)'|"([^"]+)"|([^\s'";|&()<>]+)/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!candidate) continue;
    if (!candidate.includes('/') && !candidate.includes('\\') && !candidate.endsWith('.json') && !candidate.endsWith('.jsonl')) {
      continue;
    }
    candidates.push(candidate);
  }

  const bashGuardEntries: Array<{ namespace: CliDomainNamespace; scope: string }> = CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES

  for (const candidate of candidates) {
    const relativePath = getWorkspaceRelativePath(candidate, workspaceRootPath, baseDir);
    if (!relativePath) continue;

    for (const entry of bashGuardEntries) {
      if (!matchesPathScope(relativePath, entry.scope)) continue

      const context = entry.namespace === 'label'
        ? 'Direct Bash operations targeting the workspace labels/ folder are blocked.'
        : `Direct Bash operations targeting \`${relativePath}\` are blocked.`

      return {
        message: buildCliDomainBlockMessage(entry.namespace, context),
      }
    }
  }

  return null;
}

// ============================================================
// CENTRALIZED PRETOOLUSE PIPELINE
// ============================================================

/**
 * Discriminated union result from `runPreToolUseChecks()`.
 * Each agent translates these into its SDK-specific format via a simple switch.
 */
export type PreToolUseCheckResult =
  | { type: 'allow' }
  | { type: 'modify'; input: Record<string, unknown> }
  | { type: 'block'; reason: string; source?: 'prerequisite' }
  | {
      type: 'prompt';
      promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
      description: string;
      command?: string;
      modifiedInput?: Record<string, unknown>;
      appName?: string;
      reason?: string;
      impact?: string;
      requiresSystemPrompt?: boolean;
      rememberForMinutes?: number;
      commandHash?: string;
      approvalTtlSeconds?: number;
    }
  | { type: 'source_activation_needed'; sourceSlug: string; sourceExists: boolean }
  | { type: 'call_llm_intercept'; input: Record<string, unknown> }
  | { type: 'spawn_session_intercept'; input: Record<string, unknown> };

/**
 * Input for `runPreToolUseChecks()`. Each agent builds this from its SDK-specific
 * hook input. All fields needed for the pipeline are normalized here.
 */
export interface PreToolUseInput {
  /** SDK-normalized tool name (PascalCase for built-in, mcp__server__tool for MCP) */
  toolName: string;
  /** Tool input object */
  input: Record<string, unknown>;
  /** Current session ID */
  sessionId: string;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Absolute path to workspace root */
  workspaceRootPath: string;
  /** Workspace ID or slug for skill qualification */
  workspaceId: string;
  /** Plans folder path for the session (writes allowed in explore mode) */
  plansFolderPath?: string;
  /** Data folder path (writes allowed in explore mode for transform_data output) */
  dataFolderPath?: string;
  /** Working directory override (for skill resolution) */
  workingDirectory?: string;
  /** Currently active source slugs */
  activeSourceSlugs: string[];
  /** All available sources (for source-exists check) */
  allSourceSlugs: string[];
  /** Whether the agent supports source activation (has onSourceActivationRequest callback) */
  hasSourceActivation: boolean;
  /** PermissionManager for session-scoped whitelists */
  permissionManager: PermissionManagerLike;
  /** PrerequisiteManager for guide.md checking */
  prerequisiteManager?: PrerequisiteManagerLike;
  /** Backend metadata provided alongside a tool call */
  backendMetadata?: { intent?: string; displayName?: string };
  /** Debug callback */
  onDebug?: (message: string) => void;
}

/**
 * Minimal interface for PermissionManager that runPreToolUseChecks() depends on.
 * This keeps the pipeline testable without importing the full PermissionManager.
 */
export interface PermissionManagerLike {
  isCommandWhitelisted(command: string): boolean;
  isDangerousCommand(command: string): boolean;
  getBaseCommand(command: string): string;
  extractDomainFromNetworkCommand(command: string): string | null;
  isDomainWhitelisted(domain: string): boolean;
}

/**
 * Minimal interface for PrerequisiteManager.
 */
export interface PrerequisiteManagerLike {
  checkPrerequisites(toolName: string): PrerequisiteCheckResult;
  trackBashSkillRead(input: Record<string, unknown>): boolean;
}

/** Built-in MCP servers that are always available (not user sources) */
const BUILT_IN_MCP_SERVERS = new Set(['session', 'craft-agents-docs']);

/** File write tools that require permission in ask mode */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Centralized PreToolUse pipeline.
 *
 * Synchronous except for the final result — all async work (source activation,
 * user prompting) is handled by the calling agent based on the result type.
 *
 * Pipeline:
 * 1. Permission mode check (shouldAllowToolInMode)
 * 2. Source blocking (inactive MCP sources)
 * 3. Prerequisite check (guide.md before source tools)
 * 4. call_llm interception
 * 5. Input transforms (paths, config validation, skills, metadata)
 * 6. Ask-mode prompt decision
 *
 * @returns A discriminated union that the agent translates to its SDK format
 */
function withPermissionModeContext(reason: string, sessionId: string, effectiveMode: PermissionMode): string {
  if (reason.includes('Effective mode:')) return reason;

  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const modeDisplayName = PERMISSION_MODE_CONFIG[effectiveMode]?.displayName ?? effectiveMode;
  return [
    reason,
    '',
    `Effective mode: ${modeDisplayName}`,
    `Last mode change: ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (modeVersion=${diagnostics.modeVersion})`,
  ].join('\n');
}

export function runPreToolUseChecks(ctx: PreToolUseInput): PreToolUseCheckResult {
  const {
    toolName,
    input,
    sessionId,
    permissionMode,
    workspaceRootPath,
    workspaceId,
    plansFolderPath,
    dataFolderPath,
    workingDirectory,
    activeSourceSlugs,
    allSourceSlugs,
    hasSourceActivation,
    permissionManager,
    prerequisiteManager,
    backendMetadata,
    onDebug,
  } = ctx;

  // Build permissions context for custom permissions.json rules
  const permissionsContext: PermissionsContext = {
    workspaceRootPath,
    activeSourceSlugs,
  };

  // Canonical mode source of truth for this session.
  // Keep incoming permissionMode only for mismatch diagnostics.
  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const effectivePermissionMode = diagnostics.permissionMode;

  if (permissionMode !== effectivePermissionMode) {
    onDebug?.(
      `[ModeSync] sessionId=${sessionId} incomingMode=${permissionMode} effectiveMode=${effectivePermissionMode} ` +
      `modeVersion=${diagnostics.modeVersion} changedBy=${diagnostics.lastChangedBy} changedAt=${diagnostics.lastChangedAt}`
    );
  }

  // ============================================================
  // 1. PERMISSION MODE CHECK
  // ============================================================
  const modeResult = shouldAllowToolInMode(
    toolName,
    input,
    effectivePermissionMode,
    { plansFolderPath, dataFolderPath, permissionsContext }
  );

  if (!modeResult.allowed) {
    const reasonWithContext = withPermissionModeContext(modeResult.reason, sessionId, effectivePermissionMode);
    onDebug?.(`Permission mode ${effectivePermissionMode}: blocking ${toolName} — ${reasonWithContext}`);
    return { type: 'block', reason: reasonWithContext };
  }

  // ============================================================
  // 2. SOURCE BLOCKING (inactive MCP sources)
  // ============================================================
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1];
    if (parts.length >= 3 && serverName && !BUILT_IN_MCP_SERVERS.has(serverName)) {
      const isActive = activeSourceSlugs.includes(serverName);
      if (!isActive) {
        const sourceExists = allSourceSlugs.includes(serverName);
        onDebug?.(`Source "${serverName}" not active (exists=${sourceExists}, hasActivation=${hasSourceActivation})`);
        return {
          type: 'source_activation_needed',
          sourceSlug: serverName,
          sourceExists,
        };
      }
    }
  }

  // ============================================================
  // 3. PREREQUISITE CHECK (guide.md before source tools)
  // ============================================================
  if (prerequisiteManager) {
    // Allow Bash through if it's reading a pending skill file (clears the prerequisite)
    if (toolName === 'Bash' && prerequisiteManager.trackBashSkillRead(input)) {
      // Prerequisite cleared — fall through to remaining pipeline steps
    } else {
      const prereqResult = prerequisiteManager.checkPrerequisites(toolName);
      if (!prereqResult.allowed) {
        return { type: 'block', reason: prereqResult.blockReason!, source: 'prerequisite' };
      }
    }
  }

  // ============================================================
  // 4. CALL_LLM / SPAWN_SESSION INTERCEPTION
  // ============================================================
  if (toolName === 'mcp__session__call_llm') {
    return { type: 'call_llm_intercept', input };
  }
  if (toolName === 'mcp__session__spawn_session') {
    return { type: 'spawn_session_intercept', input };
  }

  // ============================================================
  // 5. INPUT TRANSFORMS
  // ============================================================
  let currentInput = input;
  let wasModified = false;

  // 5a. Path expansion
  const pathResult = expandToolPaths(toolName, currentInput, onDebug);
  if (pathResult.modified) {
    currentInput = pathResult.input;
    wasModified = true;
  }

  // 5b. Config-domain Bash guard (block direct labels/automations path operations unless using craft-agent)
  if (FEATURE_FLAGS.craftAgentsCli && toolName === 'Bash') {
    const configDomainBashRedirect = getConfigDomainBashRedirect(currentInput, workspaceRootPath, workingDirectory);
    if (configDomainBashRedirect) {
      return { type: 'block', reason: configDomainBashRedirect.message };
    }
  }

  // 5c. Config file validation
  const configResult = validateConfigWrite(toolName, currentInput, workspaceRootPath, onDebug);
  if (!configResult.valid) {
    return { type: 'block', reason: configResult.error! };
  }

  // 5d. Config file CLI redirect (labels + automations)
  if (FEATURE_FLAGS.craftAgentsCli) {
    const cliRedirect = getConfigCliRedirect(toolName, currentInput, workspaceRootPath, workingDirectory);
    if (cliRedirect) {
      return { type: 'block', reason: cliRedirect.message };
    }
  }

  // 5e. Skill qualification
  if (toolName === 'Skill') {
    const skillResult = qualifySkillName(
      currentInput,
      workspaceId,
      workspaceRootPath,
      workingDirectory,
      onDebug
    );
    if (skillResult.modified) {
      currentInput = skillResult.input;
      wasModified = true;
    }
  }

  // 5f. Metadata stripping
  const metadataResult = stripToolMetadata(toolName, currentInput, onDebug);
  if (metadataResult.modified) {
    currentInput = metadataResult.input;
    wasModified = true;
  }

  // ============================================================
  // 6. PROMPT DECISION
  // ============================================================
  if (effectivePermissionMode === 'ask' || effectivePermissionMode === 'auto-edit') {
    const promptInfo = shouldPromptInAskMode(
      toolName,
      input, // Use original input for permission decisions (before stripping)
      permissionManager,
      permissionsContext,
      plansFolderPath,
      onDebug,
    );
    const shouldPrompt = effectivePermissionMode === 'auto-edit' && promptInfo?.promptType === 'file_write'
      ? null
      : promptInfo;
    if (shouldPrompt) {
      const adminWrappedInput =
        shouldPrompt.promptType === 'admin_approval' &&
        shouldPrompt.command &&
        typeof currentInput.command === 'string' &&
        process.platform === 'darwin'
          ? { ...currentInput, command: wrapCommandForMacAdminPrompt(shouldPrompt.command) }
          : undefined;

      return {
        type: 'prompt',
        promptType: shouldPrompt.promptType,
        description: shouldPrompt.description,
        command: shouldPrompt.command,
        modifiedInput: adminWrappedInput ?? (wasModified ? currentInput : undefined),
        appName: shouldPrompt.appName,
        reason: shouldPrompt.reason,
        impact: shouldPrompt.impact,
        requiresSystemPrompt: shouldPrompt.requiresSystemPrompt,
        rememberForMinutes: shouldPrompt.rememberForMinutes,
        commandHash: shouldPrompt.commandHash,
        approvalTtlSeconds: shouldPrompt.approvalTtlSeconds,
      };
    }
  }

  // ============================================================
  // RESULT
  // ============================================================
  if (wasModified) {
    return { type: 'modify', input: currentInput };
  }
  return { type: 'allow' };
}

// ============================================================
// ASK-MODE PROMPT DECISION
// ============================================================

interface PromptInfo {
  promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
  description: string;
  command?: string;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

function toDisplayName(token: string): string {
  return token.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function classifyAdminApproval(command: string): PromptInfo | null {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();

  const brewInstallCask = normalized.match(/^brew\s+install\s+--cask\s+([^\s]+).*$/);
  if (brewInstallCask) {
    const appToken = brewInstallCask[1] ?? 'application';
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask install: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to complete post-install steps.',
      impact: 'May install files in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  const brewUpgradeCask = normalized.match(/^brew\s+upgrade\s+--cask\s+([^\s]+).*$/);
  if (brewUpgradeCask) {
    const appToken = brewUpgradeCask[1] ?? 'application';
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask upgrade: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to replace app files in protected locations.',
      impact: 'May replace app binaries in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  if (/^installer\s+-pkg\s+.+\s+-target\s+\//.test(normalized)) {
    return {
      promptType: 'admin_approval',
      description: 'Admin approval required for macOS installer package',
      command: trimmed,
      appName: 'Installer Package',
      reason: 'The installer writes files to protected system locations.',
      impact: 'May install system services, app files, or startup items.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 5,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  return null;
}

function wrapCommandForMacAdminPrompt(command: string): string {
  // Escape for AppleScript shell string: \ -> \\, " -> \", $ -> \$
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');

  return `osascript -e 'do shell script "${escaped}" with administrator privileges'`;
}

/**
 * Determine if user approval is needed in 'ask' mode.
 *
 * Returns prompt info if user should be asked, null if auto-allowed.
 * This is the single source of truth for ask-mode decisions across agent
 * backends.
 */
export function shouldPromptInAskMode(
  toolName: string,
  input: Record<string, unknown>,
  permissionManager: PermissionManagerLike,
  permissionsContext: PermissionsContext,
  plansFolderPath?: string,
  onDebug?: (message: string) => void,
): PromptInfo | null {

  // --- File writes ---
  if (FILE_WRITE_TOOLS.has(toolName)) {
    if (permissionManager.isCommandWhitelisted(toolName)) {
      onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
      return null;
    }
    const filePath = (input.file_path as string) || (input.notebook_path as string) || 'unknown';
    return {
      promptType: 'file_write',
      description: `${toolName}: ${filePath}`,
      command: filePath,
    };
  }

  // --- Bash commands ---
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const baseCommand = permissionManager.getBaseCommand(command);

    const adminPrompt = classifyAdminApproval(command);
    if (adminPrompt) {
      return adminPrompt;
    }

    // Auto-allow read-only commands using full AST-based validation
    // (same pipeline as Plan mode — catches redirects, substitutions, pipes to write commands)
    const mergedConfig = permissionsConfigCache.getMergedConfig(permissionsContext);
    if (isReadOnlyBashCommandWithConfig(command, mergedConfig)) {
      onDebug?.(`Auto-allowing read-only command: ${baseCommand}`);
      return null;
    }

    // Check session whitelist (not dangerous)
    if (permissionManager.isCommandWhitelisted(baseCommand) &&
        !permissionManager.isDangerousCommand(baseCommand)) {
      onDebug?.(`Auto-allowing "${baseCommand}" (previously approved)`);
      return null;
    }

    // Check domain whitelist for curl/wget
    if (['curl', 'wget'].includes(baseCommand)) {
      const domain = permissionManager.extractDomainFromNetworkCommand(command);
      if (domain && permissionManager.isDomainWhitelisted(domain)) {
        onDebug?.(`Auto-allowing ${baseCommand} to "${domain}" (domain whitelisted)`);
        return null;
      }
    }

    return {
      promptType: 'bash',
      description: `Execute: ${command}`,
      command,
    };
  }

  // --- MCP mutations ---
  if (toolName.startsWith('mcp__')) {
    // Check if it would be blocked in safe mode (= it's a mutation)
    const safeModeResult = shouldAllowToolInMode(
      toolName, input, 'safe', { plansFolderPath }
    );
    if (!safeModeResult.allowed) {
      // It's a mutation — check whitelist
      if (permissionManager.isCommandWhitelisted(toolName)) {
        onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
        return null;
      }
      const serverAndTool = toolName.replace('mcp__', '').replace(/__/g, '/');
      return {
        promptType: 'mcp_mutation',
        description: `MCP: ${serverAndTool}`,
        command: toolName,
      };
    }
    // Read-only MCP tool — no prompt needed
    return null;
  }

  // --- API mutations ---
  if (toolName.startsWith('api_')) {
    const method = ((input?.method as string) || 'GET').toUpperCase();
    const path = input?.path as string | undefined;

    if (method !== 'GET') {
      const apiDescription = `${method} ${path || ''}`;

      // Check permissions.json whitelist
      if (isApiEndpointAllowed(method, path, permissionsContext)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (whitelisted in permissions.json)`);
        return null;
      }

      // Check session whitelist
      if (permissionManager.isCommandWhitelisted(apiDescription)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (previously approved)`);
        return null;
      }

      return {
        promptType: 'api_mutation',
        description: `API: ${apiDescription}`,
        command: apiDescription,
      };
    }
  }

  return null;
}
