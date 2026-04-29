/**
 * Safe Mode Configuration
 *
 * Allows customization of Safe Mode rules per workspace and per source.
 * Users can create permissions.json files to extend the default rules.
 *
 * File locations:
 * - Workspace: ~/.craft-agent/workspaces/{slug}/permissions.json
 * - Per-source: ~/.craft-agent/workspaces/{slug}/sources/{sourceSlug}/permissions.json
 *
 * Rules are additive - custom configs extend the defaults (more permissive).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync, safeJsonParse } from '../utils/files.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { getSourcePath } from '../sources/storage.ts';
import { isValidPermissionsFile } from '../config/validators.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import {
  SAFE_MODE_CONFIG,
  PermissionsConfigSchema,
  type ApiEndpointRule,
  type PermissionsConfigFile,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type BlockedCommandHintRule,
  type PermissionPaths,
} from './mode-types.ts';

// ============================================================
// App-level Permissions Directory
// ============================================================

// Track if permissions have been initialized this session (prevents re-init on hot reload)
let permissionsInitialized = false;

/**
 * Get the app-level permissions directory.
 * Default permissions are stored at ~/.craft-agent/permissions/
 * Reads env var dynamically so tests can override via CRAFT_CONFIG_DIR.
 */
export function getAppPermissionsDir(): string {
  const configDir = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
  return join(configDir, 'permissions');
}

/**
 * Sync bundled default permissions to disk on launch.
 * Handles migrations when bundled version is newer:
 * - If file doesn't exist → copy from bundle
 * - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
 * - If file exists and bundled is newer → merge new patterns, update version
 * - If file exists and same/older version → no-op (preserve user changes)
 *
 * User customizations in workspace/source permissions.json files
 * are never touched by this function.
 */
export function ensureDefaultPermissions(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (permissionsInitialized) {
    return;
  }
  permissionsInitialized = true;

  const permissionsDir = getAppPermissionsDir();

  // Create permissions directory if it doesn't exist
  if (!existsSync(permissionsDir)) {
    mkdirSync(permissionsDir, { recursive: true });
  }

  // Resolve bundled permissions directory via shared asset resolver
  const bundledPermissionsDir = getBundledAssetsDir('permissions');
  if (!bundledPermissionsDir) {
    return;
  }

  const destPath = join(permissionsDir, 'default.json');
  const srcPath = join(bundledPermissionsDir, 'default.json');

  if (!existsSync(srcPath)) {
    return;
  }

  // New install or corrupt file - copy fresh from bundle
  if (!existsSync(destPath) || !isValidPermissionsFile(destPath)) {
    try {
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
      debug('[Permissions] Installed default.json');
    } catch (error) {
      debug('[Permissions] Error installing default.json:', error);
    }
    return;
  }

  // Check if migration needed (bundled version > installed version)
  try {
    const installedContent = readFileSync(destPath, 'utf-8');
    const bundledContent = readFileSync(srcPath, 'utf-8');

    const installed = safeJsonParse(installedContent) as PermissionsConfigFile;
    const bundled = safeJsonParse(bundledContent) as PermissionsConfigFile;

    const installedVersion = installed.version || '2000-01-01';
    const bundledVersion = bundled.version || '2000-01-01';

    if (bundledVersion > installedVersion) {
      const merged = migratePermissions(installed, bundled);
      writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf-8');
      debug('[Permissions] Migrated from', installedVersion, 'to', bundledVersion);
    } else {
      debug('[Permissions] Already up to date:', installedVersion);
    }
  } catch (error) {
    debug('[Permissions] Migration error:', error);
  }
}

/**
 * Merge new patterns from bundled config into existing installed config.
 * Preserves user customizations, adds new patterns, updates version.
 */
function migratePermissions(
  installed: PermissionsConfigFile,
  bundled: PermissionsConfigFile
): PermissionsConfigFile {
  // Get existing pattern strings for deduplication
  const getPatternString = (p: string | { pattern: string }): string =>
    typeof p === 'string' ? p : p.pattern;

  const existingBashPatterns = new Set(
    (installed.allowedBashPatterns || []).map(getPatternString)
  );
  const existingMcpPatterns = new Set(
    (installed.allowedMcpPatterns || []).map(getPatternString)
  );

  // Find new patterns not already in installed
  const newBashPatterns = (bundled.allowedBashPatterns || []).filter(
    p => !existingBashPatterns.has(getPatternString(p))
  );
  const newMcpPatterns = (bundled.allowedMcpPatterns || []).filter(
    p => !existingMcpPatterns.has(getPatternString(p))
  );

  // Merge blocked command hints (dedupe by command + whenNotMatching + reason)
  const installedHints = installed.blockedCommandHints || [];
  const installedHintKeys = new Set(
    installedHints.map(h => `${h.command}::${h.whenNotMatching || ''}::${h.reason}`)
  );
  const newBlockedCommandHints = (bundled.blockedCommandHints || []).filter(
    h => !installedHintKeys.has(`${h.command}::${h.whenNotMatching || ''}::${h.reason}`)
  );

  debug('[Permissions] Adding', newBashPatterns.length, 'new bash patterns');
  debug('[Permissions] Adding', newMcpPatterns.length, 'new MCP patterns');
  debug('[Permissions] Adding', newBlockedCommandHints.length, 'new blocked command hints');

  return {
    ...installed,
    version: bundled.version,
    allowedBashPatterns: [
      ...(installed.allowedBashPatterns || []),
      ...newBashPatterns,
    ],
    allowedMcpPatterns: [
      ...(installed.allowedMcpPatterns || []),
      ...newMcpPatterns,
    ],
    blockedCommandHints: [
      ...installedHints,
      ...newBlockedCommandHints,
    ],
  };
}

/**
 * Load default permissions from ~/.craft-agent/permissions/default.json
 * Returns null if file doesn't exist or is invalid.
 */
export function loadDefaultPermissions(): PermissionsCustomConfig | null {
  const defaultPath = join(getAppPermissionsDir(), 'default.json');
  if (!existsSync(defaultPath)) {
    debug('[Permissions] No default.json found at', defaultPath);
    return null;
  }

  try {
    const content = readFileSync(defaultPath, 'utf-8');
    const config = parsePermissionsJson(content);
    debug('[Permissions] Loaded default permissions from', defaultPath);
    return config;
  } catch (error) {
    debug('[Permissions] Error loading default permissions:', error);
    return null;
  }
}

// Re-export types from mode-types for external consumers
export {
  PermissionsConfigSchema,
  type ApiEndpointRule,
  type PermissionsConfigFile,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type PermissionPaths,
};

// ============================================================
// Types
// ============================================================

/**
 * Pattern entry with optional comment for error messages.
 * Preserves the comment from permissions.json so we can show helpful hints.
 */
export interface PatternWithComment {
  pattern: string;
  comment?: string;
}

/**
 * Parsed and normalized permissions configuration
 *
 * Note: blockedTools (Write, Edit, MultiEdit, NotebookEdit) are hardcoded in
 * SAFE_MODE_CONFIG and not configurable here - they're fundamental write
 * operations that must always be blocked in Plan mode.
 */
export interface PermissionsCustomConfig {
  /** Additional bash patterns to allow (with optional comments for error messages) */
  allowedBashPatterns: PatternWithComment[];
  /** Additional MCP patterns to allow (as regex strings) */
  allowedMcpPatterns: string[];
  /** API endpoint rules for fine-grained control */
  allowedApiEndpoints: ApiEndpointRule[];
  /** File paths to allow writes in Plan mode (glob pattern strings) */
  allowedWritePaths: string[];
  /** Command-specific hints for blocked Bash commands */
  blockedCommandHints: BlockedCommandHintRule[];
}

/**
 * Merged permissions config for runtime use
 */
export interface MergedPermissionsConfig {
  /** Blocked tools (Write, Edit, MultiEdit, NotebookEdit) - hardcoded, not configurable */
  blockedTools: Set<string>;
  /** Read-only bash patterns with metadata for helpful error messages */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** Command-specific hints for blocked Bash command explanations */
  blockedCommandHints: CompiledBlockedCommandHint[];
  readOnlyMcpPatterns: RegExp[];
  /** Fine-grained API endpoint rules */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** File paths allowed for writes in Plan mode (glob patterns) */
  allowedWritePaths: string[];
  /** Display name for error messages */
  displayName: string;
  /** Keyboard shortcut hint */
  shortcutHint: string;
  /** Paths to permission files for actionable error messages */
  permissionPaths?: PermissionPaths;
}

/**
 * Context for permissions checking (includes workspace/source/agent info)
 */
export interface PermissionsContext {
  workspaceRootPath: string;
  /** Active source slugs for source-specific rules */
  activeSourceSlugs?: string[];
}

// ============================================================
// JSON Parser
// ============================================================

/**
 * Parse and validate permissions.json file
 */
export function parsePermissionsJson(content: string): PermissionsCustomConfig {
  const emptyConfig: PermissionsCustomConfig = {
    allowedBashPatterns: [],
    allowedMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    blockedCommandHints: [],
  };

  try {
    const json = safeJsonParse(content);
    const result = PermissionsConfigSchema.safeParse(json);

    if (!result.success) {
      debug('[SafeMode] Validation errors:', result.error.issues);
      // Log specific errors for debugging
      for (const issue of result.error.issues) {
        debug(`[SafeMode]   - ${issue.path.join('.')}: ${issue.message}`);
      }
      return emptyConfig;
    }

    const data = result.data;

    // Normalize patterns (extract string from pattern objects, but NOT for bash - preserve comments)
    const normalizePatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): string[] => {
      if (!patterns) return [];
      return patterns.map(p => typeof p === 'string' ? p : p.pattern);
    };

    // For bash patterns, preserve comments for helpful error messages
    const normalizeBashPatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): PatternWithComment[] => {
      if (!patterns) return [];
      return patterns.map(p => {
        if (typeof p === 'string') {
          return { pattern: p };
        }
        return { pattern: p.pattern, comment: p.comment };
      });
    };

    return {
      allowedBashPatterns: normalizeBashPatterns(data.allowedBashPatterns),
      allowedMcpPatterns: normalizePatterns(data.allowedMcpPatterns),
      allowedApiEndpoints: data.allowedApiEndpoints ?? [],
      allowedWritePaths: normalizePatterns(data.allowedWritePaths),
      blockedCommandHints: data.blockedCommandHints ?? [],
    };
  } catch (error) {
    debug('[SafeMode] JSON parse error:', error);
    return emptyConfig;
  }
}

/**
 * Validate a regex pattern string, return null if invalid
 */
function validateRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function compileBlockedCommandHint(hint: BlockedCommandHintRule): CompiledBlockedCommandHint | null {
  const command = hint.command.trim().toLowerCase();
  if (!command) return null;

  let whenNotMatchingRegex: RegExp | undefined;
  if (hint.whenNotMatching) {
    const compiled = validateRegex(hint.whenNotMatching);
    if (!compiled) {
      debug(`[Permissions] Invalid blockedCommandHints.whenNotMatching regex, skipping: ${hint.whenNotMatching}`);
      return null;
    }
    whenNotMatchingRegex = compiled;
  }

  return {
    command,
    reason: hint.reason,
    context: hint.context,
    tryInstead: hint.tryInstead,
    example: hint.example,
    whenNotMatching: hint.whenNotMatching,
    whenNotMatchingRegex,
  };
}

function shouldCompileBashPattern(pattern: string): boolean {
  if (!FEATURE_FLAGS.craftAgentsCli && pattern.startsWith('^craft-agent\\s')) {
    return false;
  }
  return true;
}

/**
 * Validate permissions config and return errors
 */
export function validatePermissionsConfig(config: PermissionsConfigFile): string[] {
  const errors: string[] = [];

  // Validate regex patterns
  const checkPatterns = (patterns: Array<string | { pattern: string }> | undefined, name: string) => {
    if (!patterns) return;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (!p) continue;
      const patternStr = typeof p === 'string' ? p : p.pattern;
      if (!validateRegex(patternStr)) {
        errors.push(`${name}[${i}]: Invalid regex pattern: ${patternStr}`);
      }
    }
  };

  checkPatterns(config.allowedBashPatterns, 'allowedBashPatterns');
  checkPatterns(config.allowedMcpPatterns, 'allowedMcpPatterns');

  // Validate API endpoint patterns
  if (config.allowedApiEndpoints) {
    for (let i = 0; i < config.allowedApiEndpoints.length; i++) {
      const rule = config.allowedApiEndpoints[i];
      if (rule && !validateRegex(rule.path)) {
        errors.push(`allowedApiEndpoints[${i}].path: Invalid regex pattern: ${rule.path}`);
      }
    }
  }

  // Validate blocked command hint conditional regex patterns
  if (config.blockedCommandHints) {
    for (let i = 0; i < config.blockedCommandHints.length; i++) {
      const hint = config.blockedCommandHints[i];
      if (hint?.whenNotMatching && !validateRegex(hint.whenNotMatching)) {
        errors.push(`blockedCommandHints[${i}].whenNotMatching: Invalid regex pattern: ${hint.whenNotMatching}`);
      }
    }
  }

  return errors;
}

// ============================================================
// Storage Functions
// ============================================================

/**
 * Get path to workspace permissions.json
 */
export function getWorkspacePermissionsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'permissions.json');
}

/**
 * Get path to source permissions.json
 */
export function getSourcePermissionsPath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'permissions.json');
}

/**
 * Load workspace-level permissions config
 */
export function loadWorkspacePermissionsConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
  const path = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content);
    debug(`[Permissions] Loaded workspace config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading workspace config:`, error);
    return null;
  }
}

/**
 * Load source-level permissions config
 */
export function loadSourcePermissionsConfig(
  workspaceRootPath: string,
  sourceSlug: string
): PermissionsCustomConfig | null {
  const path = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content);
    debug(`[Permissions] Loaded source config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading source config:`, error);
    return null;
  }
}

// ============================================================
// Raw Load / Save (for CLI CRUD — preserves schema-level structure)
// ============================================================

/**
 * Load raw PermissionsConfigFile from a workspace permissions.json.
 * Returns the Zod-parsed schema object (not the normalized runtime config).
 * Returns null if the file doesn't exist.
 */
export function loadRawWorkspacePermissions(workspaceRootPath: string): PermissionsConfigFile | null {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Load raw PermissionsConfigFile from a source permissions.json.
 * Returns null if the file doesn't exist.
 */
export function loadRawSourcePermissions(workspaceRootPath: string, sourceSlug: string): PermissionsConfigFile | null {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Save a PermissionsConfigFile to the workspace permissions.json.
 */
export function saveWorkspacePermissions(workspaceRootPath: string, config: PermissionsConfigFile): void {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  mkdirSync(workspaceRootPath, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
}

/**
 * Save a PermissionsConfigFile to a source permissions.json.
 */
export function saveSourcePermissions(workspaceRootPath: string, sourceSlug: string, config: PermissionsConfigFile): void {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  const sourceDir = getSourcePath(workspaceRootPath, sourceSlug);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateSource(workspaceRootPath, sourceSlug);
}

// ============================================================
// API Endpoint Checking
// ============================================================

/**
 * Check if an API call is allowed by endpoint rules
 */
export function isApiEndpointAllowed(
  method: string,
  path: string,
  config: MergedPermissionsConfig
): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules
  for (const rule of config.allowedApiEndpoints) {
    if (rule.method === upperMethod && rule.pathPattern.test(path)) {
      return true;
    }
  }

  return false;
}

// ============================================================
// Config Cache
// ============================================================

/**
 * In-memory cache for parsed permissions configs
 * Invalidated on file changes via ConfigWatcher
 */
class PermissionsConfigCache {
  private workspaceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  private sourceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  private mergedConfigs: Map<string, MergedPermissionsConfig> = new Map();

  // App-level default permissions (loaded from ~/.craft-agent/permissions/default.json)
  private defaultConfig: PermissionsCustomConfig | null | undefined = undefined; // undefined = not loaded yet

  /**
   * Get or load app-level default permissions
   * These come from ~/.craft-agent/permissions/default.json
   */
  private getDefaultConfig(): PermissionsCustomConfig | null {
    if (this.defaultConfig === undefined) {
      this.defaultConfig = loadDefaultPermissions();
    }
    return this.defaultConfig;
  }

  /**
   * Get or load workspace config
   */
  getWorkspaceConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
    if (!this.workspaceConfigs.has(workspaceRootPath)) {
      this.workspaceConfigs.set(workspaceRootPath, loadWorkspacePermissionsConfig(workspaceRootPath));
    }
    return this.workspaceConfigs.get(workspaceRootPath) ?? null;
  }

  /**
   * Get or load source config
   */
  getSourceConfig(workspaceRootPath: string, sourceSlug: string): PermissionsCustomConfig | null {
    const key = `${workspaceRootPath}::${sourceSlug}`;
    if (!this.sourceConfigs.has(key)) {
      this.sourceConfigs.set(key, loadSourcePermissionsConfig(workspaceRootPath, sourceSlug));
    }
    return this.sourceConfigs.get(key) ?? null;
  }

  /**
   * Invalidate app-level default permissions (called by ConfigWatcher)
   * This clears all merged configs since defaults affect everything
   */
  invalidateDefaults(): void {
    debug('[Permissions] Invalidating app-level default permissions');
    this.defaultConfig = undefined;
    // Clear ALL merged configs since defaults affect everything
    this.mergedConfigs.clear();
  }

  /**
   * Invalidate workspace config (called by ConfigWatcher)
   */
  invalidateWorkspace(workspaceRootPath: string): void {
    debug(`[Permissions] Invalidating workspace config: ${workspaceRootPath}`);
    this.workspaceConfigs.delete(workspaceRootPath);
    // Clear all merged configs for this workspace
    for (const key of this.mergedConfigs.keys()) {
      if (key.startsWith(`${workspaceRootPath}::`)) {
        this.mergedConfigs.delete(key);
      }
    }
  }

  /**
   * Invalidate source config (called by ConfigWatcher)
   */
  invalidateSource(workspaceRootPath: string, sourceSlug: string): void {
    debug(`[Permissions] Invalidating source config: ${workspaceRootPath}/${sourceSlug}`);
    this.sourceConfigs.delete(`${workspaceRootPath}::${sourceSlug}`);
    // Clear merged configs that include this source
    // Cache key format: "{workspaceRootPath}::{source1},{source2},..."
    // Use precise matching to avoid false positives (e.g., "linear" matching "linear-triage")
    for (const key of this.mergedConfigs.keys()) {
      if (!key.startsWith(`${workspaceRootPath}::`)) continue;

      // Extract sources portion after the ::
      const sourcesStr = key.slice(workspaceRootPath.length + 2);
      if (!sourcesStr) continue;

      // Check for exact match: at start, end, or between commas
      const sources = sourcesStr.split(',');
      if (sources.includes(sourceSlug)) {
        this.mergedConfigs.delete(key);
      }
    }
  }


  /**
   * Get merged config for a context (workspace + active sources)
   * Uses additive merging: custom configs extend defaults
   */
  getMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    const cacheKey = this.buildCacheKey(context);

    if (!this.mergedConfigs.has(cacheKey)) {
      const merged = this.buildMergedConfig(context);
      this.mergedConfigs.set(cacheKey, merged);
    }

    return this.mergedConfigs.get(cacheKey)!;
  }

  private buildMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    const defaults = SAFE_MODE_CONFIG;

    // Start with hardcoded fallback defaults (blocked tools are fixed, display settings)
    // blockedTools (Write, Edit, MultiEdit, NotebookEdit) come from SAFE_MODE_CONFIG
    // and cannot be modified via permissions.json
    const merged: MergedPermissionsConfig = {
      blockedTools: new Set(defaults.blockedTools),
      readOnlyBashPatterns: [...defaults.readOnlyBashPatterns],
      blockedCommandHints: [...(defaults.blockedCommandHints ?? [])],
      readOnlyMcpPatterns: [...defaults.readOnlyMcpPatterns],
      allowedApiEndpoints: [],
      allowedWritePaths: [],
      displayName: defaults.displayName,
      shortcutHint: defaults.shortcutHint,
      // Add permission file paths for actionable error messages
      permissionPaths: {
        workspacePath: getWorkspacePermissionsPath(context.workspaceRootPath),
        appDefaultPath: join(getAppPermissionsDir(), 'default.json'),
        docsPath: join(CONFIG_DIR, 'docs', 'permissions.md'),
      },
    };

    // Load and apply app-level default permissions from JSON
    // This is where the actual bash/MCP patterns come from
    const defaultConfig = this.getDefaultConfig();
    if (defaultConfig) {
      this.applyDefaultConfig(merged, defaultConfig);
    }

    // Add workspace-level customizations
    const wsConfig = this.getWorkspaceConfig(context.workspaceRootPath);
    if (wsConfig) {
      this.applyCustomConfig(merged, wsConfig);
    }

    // Add source-level customizations (additive, with auto-scoped MCP patterns)
    if (context.activeSourceSlugs) {
      for (const sourceSlug of context.activeSourceSlugs) {
        const srcConfig = this.getSourceConfig(context.workspaceRootPath, sourceSlug);
        if (srcConfig) {
          // Use applySourceConfig which auto-scopes MCP patterns to this source
          this.applySourceConfig(merged, srcConfig, sourceSlug);
        }
      }
    }

    return merged;
  }

  /**
   * Apply app-level default config (from default.json)
   * This adds bash/MCP patterns from the JSON config. Blocked tools are hardcoded
   * in SAFE_MODE_CONFIG and not loaded from JSON.
   */
  private applyDefaultConfig(merged: MergedPermissionsConfig, config: PermissionsCustomConfig): void {
    // Add allowed bash patterns (as CompiledBashPattern with metadata for error messages)
    for (const patternEntry of config.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid default bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // Add allowed MCP patterns
    for (const pattern of config.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid default MCP pattern, skipping: ${pattern}`);
      }
    }

    // Add allowed API endpoints
    for (const rule of config.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      }
    }

    // Add allowed write paths
    for (const pattern of config.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Add blocked command hints (contextual guidance for blocked bash commands)
    for (const hint of config.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  private applyCustomConfig(merged: MergedPermissionsConfig, custom: PermissionsCustomConfig): void {
    // Add allowed bash patterns (making config more permissive)
    for (const patternEntry of custom.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // Add allowed MCP patterns
    for (const pattern of custom.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid MCP pattern, skipping: ${pattern}`);
      }
    }

    // Add allowed API endpoints (fine-grained)
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // Add allowed write paths (glob patterns, stored as strings)
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Add blocked command hints
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * Apply source-specific config with auto-scoped MCP patterns.
   * MCP patterns in a source's permissions.json are automatically prefixed with
   * mcp__<sourceSlug>__ so they only apply to that source's tools.
   * This prevents cross-source leakage when using simple patterns like "list".
   */
  private applySourceConfig(
    merged: MergedPermissionsConfig,
    custom: PermissionsCustomConfig,
    sourceSlug: string
  ): void {
    // Write paths - apply normally (global effect)
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // MCP patterns - AUTO-SCOPE to this source
    // User writes: "list" → becomes: "mcp__<sourceSlug>__.*list"
    // This ensures patterns only match tools from THIS source
    for (const pattern of custom.allowedMcpPatterns) {
      const scopedPattern = `mcp__${sourceSlug}__.*${pattern}`;
      const regex = validateRegex(scopedPattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
        debug(`[Permissions] Scoped MCP pattern for ${sourceSlug}: ${pattern} → ${scopedPattern}`);
      } else {
        debug(`[Permissions] Invalid MCP pattern after scoping, skipping: ${scopedPattern}`);
      }
    }

    // Bash patterns - apply normally (not source-specific)
    for (const patternEntry of custom.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // API endpoints - apply normally (API tools are already source-scoped as api_<slug>)
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // Blocked command hints - apply normally (bash is session-level)
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  private buildCacheKey(context: PermissionsContext): string {
    const sources = context.activeSourceSlugs?.sort().join(',') ?? '';
    return `${context.workspaceRootPath}::${sources}`;
  }

  /**
   * Clear all cached configs
   */
  clear(): void {
    this.defaultConfig = undefined;
    this.workspaceConfigs.clear();
    this.sourceConfigs.clear();
    this.mergedConfigs.clear();
  }
}

// Singleton instance
export const permissionsConfigCache = new PermissionsConfigCache();
