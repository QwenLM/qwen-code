/**
 * Config Validators
 *
 * Zod schemas and validation utilities for config files.
 * Used by agents to validate config changes before they take effect.
 *
 * Validates:
 * - config.json: Main app configuration
 * - preferences.json: User preferences
 * - sources/{slug}/config.json: Workspace-scoped source configs
 * - permissions.json: Permission rules for Plan mode
 * - tool-icons/tool-icons.json: CLI tool icon mappings
 */

import { z } from 'zod';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { safeJsonParse, readJsonFileSync } from '../utils/files.ts';
import { EntityColorSchema } from '../colors/validate.ts';
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels.ts';
import { isValidProviderAuthCombination } from './llm-connections.ts';

// ============================================================
// Config Directory
// ============================================================

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// ============================================================
// Validation Result Types
// ============================================================

export interface ValidationIssue {
  file: string;
  path: string;  // JSON path like "workspaces[0].name"
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  fixed?: string[];
}

// ============================================================
// Zod Schemas
// ============================================================

// --- config.json ---

const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional(),
  createdAt: z.number().int().positive(),
  sessionId: z.string().optional(),
  iconUrl: z.string().optional(),
});

// --- LLM Connection schema for config validation ---

const LlmProviderTypeSchema = z.enum([
  'qwen',
]);

const LlmAuthTypeSchema = z.enum([
  'none',
]);

const CustomEndpointSchema = z.object({
  api: z.never(),
  supportsImages: z.boolean().optional(),
});

const LlmConnectionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  providerType: LlmProviderTypeSchema,
  authType: LlmAuthTypeSchema,
  baseUrl: z.string().optional(),
  models: z.array(z.union([z.string(), z.object({ id: z.string() }).passthrough()])).optional(),
  defaultModel: z.string().optional(),
  modelSelectionMode: z.enum(['automaticallySyncedFromProvider', 'userDefined3Tier']).optional(),
  customEndpoint: CustomEndpointSchema.optional(),
  createdAt: z.number(),
  // Allow additional fields (codexPath, awsRegion, gcpProjectId, etc.)
}).passthrough();

export const StoredConfigSchema = z.object({
  workspaces: z.array(WorkspaceSchema).min(0),
  activeWorkspaceId: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  llmConnections: z.array(LlmConnectionSchema).optional(),
  defaultLlmConnection: z.string().optional(),
  defaultThinkingLevel: z.enum([...THINKING_LEVEL_IDS, 'think'] as [string, ...string[]]).transform(v => v === 'think' ? 'medium' : v).optional(),
  // Note: tokenDisplay, showCost, cumulativeUsage, defaultPermissionMode removed
  // Permission mode and cyclable modes are now per-workspace in workspace config.json
});

// --- preferences.json ---

const LocationSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

export const UserPreferencesSchema = z.object({
  name: z.string().optional(),
  timezone: z.string().optional(),  // TODO: Could validate against IANA timezone list
  location: LocationSchema.optional(),
  language: z.string().optional(),
  notes: z.string().optional(),
  updatedAt: z.number().int().min(0).optional(),
});

// ============================================================
// Validation Functions
// ============================================================

/**
 * Convert Zod error to ValidationIssues
 */
function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Validate config.json
 */
export function validateConfig(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists
  if (!existsSync(CONFIG_FILE)) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: 'Config file does not exist',
        severity: 'error',
        suggestion: 'Run setup to create initial configuration',
      }],
      warnings: [],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = StoredConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'config.json'));
  } else {
    const config = result.data;

    // Semantic validations
    if (config.activeWorkspaceId && config.workspaces.length > 0) {
      const activeExists = config.workspaces.some(w => w.id === config.activeWorkspaceId);
      if (!activeExists) {
        errors.push({
          file: 'config.json',
          path: 'activeWorkspaceId',
          message: `Active workspace ID '${config.activeWorkspaceId}' does not exist in workspaces array`,
          severity: 'error',
          suggestion: 'Set activeWorkspaceId to an existing workspace ID or null',
        });
      }
    }

    // Validate LLM connections
    if (config.llmConnections) {
      const seenSlugs = new Set<string>();
      for (const [i, conn] of config.llmConnections.entries()) {
        // Check for duplicate slugs
        if (seenSlugs.has(conn.slug)) {
          errors.push({
            file: 'config.json',
            path: `llmConnections[${i}].slug`,
            message: `Duplicate connection slug '${conn.slug}'`,
            severity: 'error',
            suggestion: 'Each connection must have a unique slug',
          });
        }
        seenSlugs.add(conn.slug);

        // Validate provider/auth combination
        if (!isValidProviderAuthCombination(conn.providerType as any, conn.authType as any)) {
          warnings.push({
            file: 'config.json',
            path: `llmConnections[${i}]`,
            message: `Invalid provider/auth combination: providerType='${conn.providerType}' with authType='${conn.authType}'`,
            severity: 'warning',
            suggestion: 'Check supported auth types for this provider',
          });
        }
      }

      // Validate defaultLlmConnection references an existing connection
      if (config.defaultLlmConnection) {
        const exists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
        if (!exists) {
          warnings.push({
            file: 'config.json',
            path: 'defaultLlmConnection',
            message: `Default LLM connection '${config.defaultLlmConnection}' does not exist in llmConnections array`,
            severity: 'warning',
            suggestion: 'Set defaultLlmConnection to an existing connection slug',
          });
        }
      }
    }

  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate preferences.json
 */
export function validatePreferences(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists (preferences are optional)
  if (!existsSync(PREFERENCES_FILE)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'preferences.json',
        path: '',
        message: 'Preferences file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(PREFERENCES_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'preferences.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = UserPreferencesSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'preferences.json'));
  } else {
    const prefs = result.data;

    // Warn about missing recommended fields
    if (!prefs.name) {
      warnings.push({
        file: 'preferences.json',
        path: 'name',
        message: 'User name is not set',
        severity: 'warning',
        suggestion: 'Setting a name helps personalize agent responses',
      });
    }

    if (!prefs.timezone) {
      warnings.push({
        file: 'preferences.json',
        path: 'timezone',
        message: 'Timezone is not set',
        severity: 'warning',
        suggestion: 'Setting timezone helps with date/time formatting',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate all config files
 * @param workspaceId - Optional workspace ID for source validation
 * @param workspaceRoot - Optional workspace root path for skill and status validation
 */
export function validateAll(workspaceId?: string, workspaceRoot?: string): ValidationResult {
  const results: ValidationResult[] = [
    validateConfig(),
    validatePreferences(),
    validateToolIcons(),
  ];

  // Include workspace-scoped validations if workspaceId is provided
  if (workspaceId) {
    results.push(validateAllSources(workspaceId));
  }

  // Include skill, status, label, automations, and permissions validation if workspaceRoot is provided
  if (workspaceRoot) {
    results.push(validateAllSkills(workspaceRoot));
    results.push(validateStatuses(workspaceRoot));
    results.push(validateLabels(workspaceRoot));
    results.push(validateAutomations(workspaceRoot));
    results.push(validateAllPermissions(workspaceRoot));
  }

  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ============================================================
// Source & Agent Validators (Folder-Based Architecture)
// ============================================================

import { getWorkspaceSourcesPath } from '../workspaces/storage.ts';

// --- sources/{slug}/config.json ---

const SourceTypeSchema = z.enum(['mcp', 'api', 'local']);

// MCP source supports two transport types:
// - HTTP/SSE: requires url and authType
// - Stdio: requires command (and optional args, env)
const McpSourceConfigSchema = z.object({
  transport: z.enum(['http', 'sse', 'stdio']).optional(),
  // HTTP/SSE fields
  url: z.string().url().optional(),
  authType: z.enum(['oauth', 'bearer', 'none']).optional(),
  clientId: z.string().optional(),
  // Stdio fields
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Custom headers for HTTP/SSE transport (e.g., API keys, custom auth)
  headers: z.record(z.string(), z.string()).optional(),
  // Header names for credential-store auth (values stored in credential store as JSON)
  headerNames: z.array(z.string()).optional(),
}).refine(
  (data) => {
    if (data.transport === 'stdio') {
      // Stdio transport requires command
      return !!data.command;
    } else {
      // HTTP/SSE transport (default) requires url and authType
      return !!data.url && !!data.authType;
    }
  },
  {
    message: 'MCP config requires either (url + authType) for HTTP/SSE or (command) for stdio transport',
  }
);

const ApiOAuthConfigSchema = z.object({
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

const ApiSourceConfigSchema = z.object({
  baseUrl: z.string().url(),
  authType: z.enum(['bearer', 'header', 'query', 'basic', 'oauth', 'none']),
  headerName: z.string().optional(),
  headerNames: z.array(z.string()).optional(),
  queryParam: z.string().optional(),
  authScheme: z.string().optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  testEndpoint: z
    .object({
      method: z.enum(['GET', 'POST']),
      path: z.string(),
      body: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  googleService: z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', 'searchconsole']).optional(),
  googleScopes: z.array(z.string()).optional(),
  googleOAuthClientId: z.string().optional(),
  googleOAuthClientSecret: z.string().optional(),
  slackService: z.enum(['messaging', 'channels', 'users', 'files', 'full']).optional(),
  slackUserScopes: z.array(z.string()).optional(),
  microsoftService: z.enum(['outlook', 'microsoft-calendar', 'onedrive', 'teams', 'sharepoint']).optional(),
  microsoftScopes: z.array(z.string()).optional(),
  oauth: ApiOAuthConfigSchema.optional(),
});

const LocalSourceConfigSchema = z.object({
  path: z.string().min(1),
  format: z.string().optional(),
});

// Source brand schema
const SourceBrandSchema = z.object({
  color: EntityColorSchema.optional(),
});

export const FolderSourceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  enabled: z.boolean(),
  provider: z.string().min(1),
  type: SourceTypeSchema,
  mcp: McpSourceConfigSchema.optional(),
  api: ApiSourceConfigSchema.optional(),
  local: LocalSourceConfigSchema.optional(),
  brand: SourceBrandSchema.optional(),
  isAuthenticated: z.boolean().optional(),
  lastTestedAt: z.number().int().min(0).optional(),
  // Timestamps are optional - manually created configs may not have them
  // Storage functions add these automatically when saving
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).refine(
  (data) => {
    // Ensure correct config block exists for type
    switch (data.type) {
      case 'mcp': return !!data.mcp;
      case 'api': return !!data.api;
      case 'local': return !!data.local;
    }
  },
  { message: 'Config must include type-specific configuration (mcp, api, or local)' }
);

/**
 * Validate a source config object (in-memory, no disk reads)
 */
export function validateSourceConfig(config: unknown): ValidationResult {
  const result = FolderSourceConfigSchema.safeParse(config);

  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }

  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'config.json'),
    warnings: [],
  };
}

/**
 * Validate source config from a JSON string.
 * Used by PreToolUse hook to validate before writing to disk.
 */
export function validateSourceConfigContent(jsonString: string): ValidationResult {
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validateSourceConfig(content);
}

/**
 * Validate a source folder (workspace-scoped)
 */
export function validateSource(workspaceId: string, slug: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceId);
  const file = `sources/${slug}/config.json`;
  const configPath = join(sourcesDir, slug, 'config.json');

  if (!existsSync(join(sourcesDir, slug))) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Source folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  if (!existsSync(configPath)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'config.json not found',
        severity: 'error',
        suggestion: 'Create a config.json file in the source folder',
      }],
      warnings: [],
    };
  }

  let content: unknown;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const result = validateSourceConfig(content);

  // Add warnings for missing guide.md
  const guidePath = join(sourcesDir, slug, 'guide.md');
  if (!existsSync(guidePath)) {
    result.warnings.push({
      file: `sources/${slug}/guide.md`,
      path: '',
      message: 'guide.md not found (recommended for usage guidelines)',
      severity: 'warning',
    });
  }

  return result;
}

/**
 * Validate all sources in a workspace
 */
export function validateAllSources(workspaceId: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceId);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(sourcesDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'Sources directory does not exist (no sources configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(sourcesDir);
  const sourceFolders = entries.filter((entry) => {
    const entryPath = join(sourcesDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (sourceFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'No sources configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of sourceFolders) {
    const result = validateSource(workspaceId, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Skill Validators
// ============================================================

import matter from 'gray-matter';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { basename, extname } from 'path';

/**
 * Schema for skill metadata (SKILL.md frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Add a 'name' field with a human-readable title (e.g., 'Git Commit Helper')"),
  description: z.string().min(1, "Add a 'description' field explaining what this skill does and when to use it (1-2 sentences)"),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
});

/**
 * Find icon file in skill directory
 */
function findSkillIconForValidation(skillDir: string): string | null {
  const iconExtensions = ['.svg', '.png', '.jpg', '.jpeg'];

  for (const ext of iconExtensions) {
    const iconPath = join(skillDir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }

  return null;
}

/**
 * Validate a skill folder
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param slug - Skill directory name
 */
export function validateSkill(workspaceRoot: string, slug: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');
  const file = `skills/${slug}/SKILL.md`;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Check directory exists (slug format is validated by validateSkillContent below)
  if (!existsSync(skillDir)) {
    return {
      valid: false,
      errors: [{
        file: `skills/${slug}`,
        path: '',
        message: `Skill folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 3. Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'SKILL.md not found',
        severity: 'error',
        suggestion: 'Create a SKILL.md file with YAML frontmatter',
      }],
      warnings: [],
    };
  }

  // 4. Read and validate content using content-based validator
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Delegate content validation (frontmatter schema + body non-empty + slug format)
  const contentResult = validateSkillContent(content, slug);
  errors.push(...contentResult.errors);

  // 5. FS-only checks: icon existence (warnings)
  const iconPath = findSkillIconForValidation(skillDir);
  if (iconPath) {
    const ext = extname(iconPath).toLowerCase();
    if (!['.svg', '.png', '.jpg', '.jpeg'].includes(ext)) {
      warnings.push({
        file: `skills/${slug}/${basename(iconPath)}`,
        path: '',
        message: `Unexpected icon format: ${ext}`,
        severity: 'warning',
        suggestion: 'Use .svg, .png, or .jpg for icons',
      });
    }
  } else {
    const searchTerm = slug.replace(/-/g, ' ');
    warnings.push({
      file: `skills/${slug}/`,
      path: 'icon',
      message: 'No icon found',
      severity: 'warning',
      suggestion: `Search for '${searchTerm} icon' on heroicons.com, lucide.dev, or icons8.com. Save as icon.svg in the skill folder.`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate skill SKILL.md content from a string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks frontmatter schema and non-empty body. Skips icon/folder checks.
 *
 * @param markdownContent - The full SKILL.md file content
 * @param slug - The skill slug (folder name), used for slug format validation
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const file = `skills/${slug}/SKILL.md`;
  const errors: ValidationIssue[] = [];

  // 1. Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    const suggestedSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    errors.push({
      file: `skills/${slug}`,
      path: 'slug',
      message: 'Slug must be lowercase alphanumeric with hyphens',
      severity: 'error',
      suggestion: `Rename folder to '${suggestedSlug || 'valid-slug-name'}'`,
    });
  }

  // 2. Parse frontmatter
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = matter(markdownContent);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: 'frontmatter',
        message: `Invalid YAML frontmatter: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
        suggestion: 'See ~/.craft-agent/docs/skills.md for SKILL.md format reference',
      }],
      warnings: [],
    };
  }

  // 3. Validate frontmatter schema
  const metaResult = SkillMetadataSchema.safeParse(frontmatter);
  if (!metaResult.success) {
    errors.push(...zodErrorToIssues(metaResult.error, file));
  }

  // 4. Check content is not empty
  if (!body || body.trim().length === 0) {
    errors.push({
      file,
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      severity: 'error',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],  // Icon/folder warnings skipped in content-only validation
  };
}

/**
 * Validate all skills in a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateAllSkills(workspaceRoot: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(skillsDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'Skills directory does not exist (no skills configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(skillsDir);
  const skillFolders = entries.filter((entry) => {
    const entryPath = join(skillsDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (skillFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'No skills configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of skillFolders) {
    const result = validateSkill(workspaceRoot, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Status Validators
// ============================================================

const STATUS_CONFIG_FILE = 'statuses/config.json';

/** Required fixed statuses that must always exist */
const REQUIRED_FIXED_STATUS_IDS = ['todo', 'done', 'cancelled'] as const;

/**
 * Status icons are simple strings: emoji characters, URLs, or local filenames
 * such as "in-progress.svg" which resolve to statuses/icons/in-progress.svg.
 * When icon is omitted, local icon files (statuses/icons/{id}.svg) are still
 * auto-discovered at runtime.
 */
const StatusIconSchema = z.string();

/**
 * Zod schema for individual status configuration
 */
const StatusConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Status ID must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1, 'Status label is required'),
  color: EntityColorSchema.optional(),
  icon: StatusIconSchema.optional(),
  category: z.enum(['open', 'closed']),
  isFixed: z.boolean(),
  isDefault: z.boolean(),
  order: z.number().int().min(0),
});

/**
 * Zod schema for workspace status configuration
 */
const WorkspaceStatusConfigSchema = z.object({
  version: z.number().int().min(1),
  statuses: z.array(StatusConfigSchema),
  defaultStatusId: z.string().min(1),
});

/**
 * Validate statuses configuration for a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateStatuses(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, STATUS_CONFIG_FILE);
  const file = STATUS_CONFIG_FILE;

  // Check if config file exists (optional - defaults are used if missing)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Status config does not exist (using defaults)',
        severity: 'warning',
        suggestion: 'Statuses will use default configuration. Edit to customize.',
      }],
    };
  }

  // Read file and delegate to content-based validator
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Icons are auto-discovered from statuses/icons/{id}.{ext} at runtime,
  // not referenced in config, so no FS checks needed here.
  return validateStatusesContent(raw);
}

/**
 * Validate statuses config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs schema validation and semantic checks. Skips icon file existence checks.
 */
export function validateStatusesContent(jsonString: string): ValidationResult {
  const file = 'statuses/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = WorkspaceStatusConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validations (same as validateStatuses but without FS checks)

  // 1. Check required fixed statuses exist
  const statusIds = new Set(config.statuses.map(s => s.id));
  for (const requiredId of REQUIRED_FIXED_STATUS_IDS) {
    if (!statusIds.has(requiredId)) {
      errors.push({
        file,
        path: 'statuses',
        message: `Required fixed status '${requiredId}' is missing`,
        severity: 'error',
        suggestion: `Add the '${requiredId}' status - it's required for the system to function`,
      });
    }
  }

  // 2. Check for duplicate IDs
  const seenIds = new Set<string>();
  for (const status of config.statuses) {
    if (seenIds.has(status.id)) {
      errors.push({
        file,
        path: `statuses[id=${status.id}]`,
        message: `Duplicate status ID '${status.id}'`,
        severity: 'error',
        suggestion: 'Each status must have a unique ID',
      });
    }
    seenIds.add(status.id);
  }

  // 3. Check defaultStatusId references an existing status
  if (!statusIds.has(config.defaultStatusId)) {
    errors.push({
      file,
      path: 'defaultStatusId',
      message: `Default status '${config.defaultStatusId}' does not exist in statuses array`,
      severity: 'error',
      suggestion: 'Set defaultStatusId to an existing status ID (typically "todo")',
    });
  }

  // 4. Check fixed statuses have correct isFixed flag
  for (const status of config.statuses) {
    const shouldBeFixed = (REQUIRED_FIXED_STATUS_IDS as readonly string[]).includes(status.id);
    if (shouldBeFixed && !status.isFixed) {
      warnings.push({
        file,
        path: `statuses[id=${status.id}].isFixed`,
        message: `Status '${status.id}' should have isFixed: true`,
        severity: 'warning',
        suggestion: 'This is a required system status and should be marked as fixed',
      });
    }
  }

  // 5. Check that at least one status is in each category
  const hasOpen = config.statuses.some(s => s.category === 'open');
  const hasClosed = config.statuses.some(s => s.category === 'closed');
  if (!hasOpen) {
    errors.push({
      file,
      path: 'statuses',
      message: 'No status with category "open" - sessions will not appear in inbox',
      severity: 'error',
    });
  }
  if (!hasClosed) {
    warnings.push({
      file,
      path: 'statuses',
      message: 'No status with category "closed" - sessions cannot be archived',
      severity: 'warning',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Labels Validators
// ============================================================

import { validateAutoLabelRule } from '../labels/auto/validation.ts';

const LABEL_CONFIG_FILE = 'labels/config.json';

/** Maximum nesting depth for label tree (prevents excessively deep hierarchies) */
const MAX_LABEL_DEPTH = 5;

/**
 * Zod schema for individual label configuration.
 * Recursive: each label can have optional children forming a tree.
 * IDs are simple slugs (lowercase alphanumeric + hyphens).
 */
/**
 * Zod schema for auto-label rules (regex patterns for automatic label application).
 * Validates pattern is non-empty; regex validity is checked semantically below.
 */
const AutoLabelRuleSchema = z.object({
  pattern: z.string().min(1, 'Auto-label rule pattern is required'),
  flags: z.string().optional(),
  valueTemplate: z.string().optional(),
  description: z.string().optional(),
});

const BaseLabelConfigSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Label ID must be a simple slug (lowercase alphanumeric + hyphens, e.g., "bug", "frontend")'
  ),
  name: z.string().min(1, 'Label name is required'),
  color: EntityColorSchema.optional(),
  icon: z.string().optional(),
  /** Optional hint: what type of value this label carries (omit for boolean labels) */
  valueType: z.enum(['string', 'number', 'date']).optional(),
  /** Auto-label rules: regex patterns that scan messages and apply labels automatically */
  autoRules: z.array(AutoLabelRuleSchema).optional(),
});

// Recursive schema: LabelConfig can have children which are also LabelConfigs.
// Zod supports lazy() for recursive types.
type LabelConfigSchemaType = z.ZodType<{
  id: string;
  name: string;
  color?: unknown;
  icon?: string;
  valueType?: 'string' | 'number' | 'date';
  autoRules?: Array<{ pattern: string; flags?: string; valueTemplate?: string; description?: string }>;
  children?: LabelConfigSchemaType[];
}>;

const LabelConfigSchema: z.ZodType<any> = BaseLabelConfigSchema.extend({
  children: z.lazy(() => z.array(LabelConfigSchema)).optional(),
});

/**
 * Zod schema for workspace label configuration (recursive tree)
 */
const WorkspaceLabelConfigSchema = z.object({
  version: z.number().int().min(1),
  labels: z.array(LabelConfigSchema),
});

/**
 * Validate labels configuration for a workspace (reads from disk)
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateLabels(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, LABEL_CONFIG_FILE);
  const file = LABEL_CONFIG_FILE;

  // Labels config is optional — no config means no labels (valid state)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Labels config does not exist (no labels configured)',
        severity: 'warning',
      }],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validateLabelsContent(raw);
}

/**
 * Validate labels config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks schema validation and semantic rules (unique IDs, max depth).
 */
export function validateLabelsContent(jsonString: string): ValidationResult {
  const file = 'labels/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema (recursive, includes EntityColor validation via Zod)
  const result = WorkspaceLabelConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // 1. Check for globally unique IDs across the entire tree
  const seenIds = new Set<string>();
  function checkUniqueIds(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (seenIds.has(label.id)) {
        errors.push({
          file,
          path: `${path}[${i}].id`,
          message: `Duplicate label ID '${label.id}' — IDs must be globally unique across the tree`,
          severity: 'error',
          suggestion: 'Each label must have a unique ID regardless of nesting level',
        });
      }
      seenIds.add(label.id);
      if (label.children && label.children.length > 0) {
        checkUniqueIds(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkUniqueIds(config.labels, 'labels');

  // 2. Check max nesting depth (prevents excessively deep hierarchies)
  function checkDepth(labels: any[], depth: number, path: string): void {
    if (depth > MAX_LABEL_DEPTH) {
      errors.push({
        file,
        path,
        message: `Label tree exceeds maximum depth of ${MAX_LABEL_DEPTH} levels`,
        severity: 'error',
        suggestion: `Flatten the hierarchy — ${MAX_LABEL_DEPTH} levels should be sufficient for any organization scheme`,
      });
      return;
    }
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.children && label.children.length > 0) {
        checkDepth(label.children, depth + 1, `${path}[${i}].children`);
      }
    }
  }
  checkDepth(config.labels, 1, 'labels');

  // 3. Validate auto-label rules (regex patterns on regular labels)
  function checkAutoRules(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.autoRules && Array.isArray(label.autoRules)) {
        for (let j = 0; j < label.autoRules.length; j++) {
          const rule = label.autoRules[j];
          if (rule.pattern) {
            const ruleResult = validateAutoLabelRule(rule.pattern, rule.flags);
            for (const err of ruleResult.errors) {
              errors.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: err,
                severity: 'error',
                suggestion: 'Fix the regex pattern or remove the rule',
              });
            }
            for (const warn of ruleResult.warnings) {
              warnings.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: warn,
                severity: 'warning',
              });
            }
          } else {
            errors.push({
              file,
              path: `${path}[${i}].autoRules[${j}]`,
              message: 'Auto-label rule must have a "pattern" field',
              severity: 'error',
              suggestion: 'Add a regex pattern string to the rule',
            });
          }
        }
      }
      if (label.children && label.children.length > 0) {
        checkAutoRules(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkAutoRules(config.labels, 'labels');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Permissions Validators
// ============================================================

import { PermissionsConfigSchema } from '../agent/mode-types.ts';
import {
  validatePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  getAppPermissionsDir,
} from '../agent/permissions-config.ts';
import { validateAutomationsContent, validateAutomations, AUTOMATIONS_CONFIG_FILE } from '../automations/index.ts';

/**
 * Internal: Validate a single permissions.json file
 * Checks JSON syntax, Zod schema, and regex pattern validity.
 */
function validatePermissionsFile(filePath: string, displayFile: string): ValidationResult {
  // File is optional - missing is just a warning
  if (!existsSync(filePath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: displayFile,
        path: '',
        message: 'Permissions file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content-based validator
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validatePermissionsContent(raw, displayFile);
}

/**
 * Validate permissions config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs Zod schema validation and regex pattern compilation checks.
 *
 * @param jsonString - The raw JSON content of the permissions file
 * @param displayFile - File name for error messages (e.g., 'permissions.json' or 'sources/github/permissions.json')
 */
export function validatePermissionsContent(jsonString: string, displayFile: string = 'permissions.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PermissionsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  // Validate regex patterns (semantic validation)
  const regexErrors = validatePermissionsConfig(result.data);
  for (const regexError of regexErrors) {
    errors.push({
      file: displayFile,
      path: regexError.split(':')[0] || '',
      message: regexError,
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Validate workspace-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateWorkspacePermissions(workspaceRoot: string): ValidationResult {
  const permissionsPath = getWorkspacePermissionsPath(workspaceRoot);
  return validatePermissionsFile(permissionsPath, 'permissions.json');
}

/**
 * Validate source-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param sourceSlug - Source slug
 */
export function validateSourcePermissions(workspaceRoot: string, sourceSlug: string): ValidationResult {
  const permissionsPath = getSourcePermissionsPath(workspaceRoot, sourceSlug);
  return validatePermissionsFile(permissionsPath, `sources/${sourceSlug}/permissions.json`);
}

/**
 * Validate app-level default permissions
 */
export function validateDefaultPermissions(): ValidationResult {
  const permissionsPath = join(getAppPermissionsDir(), 'default.json');
  return validatePermissionsFile(permissionsPath, 'permissions/default.json');
}

/**
 * Validate all permissions files in a workspace
 * Includes: app-level default, workspace-level, and all source-level permissions
 */
export function validateAllPermissions(workspaceRoot: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Validate app-level default permissions
  const defaultResult = validateDefaultPermissions();
  errors.push(...defaultResult.errors);
  warnings.push(...defaultResult.warnings);

  // Validate workspace-level permissions
  const wsResult = validateWorkspacePermissions(workspaceRoot);
  errors.push(...wsResult.errors);
  warnings.push(...wsResult.warnings);

  // Validate all source-level permissions
  const sourcesDir = join(workspaceRoot, 'sources');
  if (existsSync(sourcesDir)) {
    const entries = readdirSync(sourcesDir);
    for (const entry of entries) {
      const entryPath = join(sourcesDir, entry);
      if (statSync(entryPath).isDirectory()) {
        const srcResult = validateSourcePermissions(workspaceRoot, entry);
        errors.push(...srcResult.errors);
        warnings.push(...srcResult.warnings);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if a permissions file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidPermissionsFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validatePermissionsContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Theme Validators
// ============================================================

const CSSColorSchema = z.string().min(1);

const ThemeDarkOverrideSchema = z.object({
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
}).strict();

/**
 * Zod schema for app-level theme override files (~/.craft-agent/theme.json).
 * Allows partial overrides but rejects unknown keys.
 */
export const ThemeOverrideSchema = z.object({
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: ThemeDarkOverrideSchema.optional(),
}).strict()
  .refine(
    (data) => {
      const keys = Object.keys(data);
      return keys.length > 0;
    },
    { message: 'Theme override must include at least one supported field' }
  )
  .refine(
    (data) => data.mode !== 'scenic' || Boolean(data.backgroundImage),
    { message: 'backgroundImage is required when mode is scenic', path: ['backgroundImage'] }
  );

/**
 * Zod schema for preset theme files.
 * Validates theme structure and requires at least one color property.
 */
export const PresetThemeSchema = z.object({
  name: z.string().min(1, 'Theme name is required'),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  source: z.string().optional(),
  supportedModes: z.array(z.enum(['light', 'dark'])).optional(),
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: z.object({}).passthrough().optional(),
  // Shiki theme for syntax highlighting
  shikiTheme: z.object({
    light: z.string().optional(),
    dark: z.string().optional(),
  }).optional(),
}).refine(
  (data) => {
    const colorProps = ['background', 'foreground', 'accent', 'info', 'success', 'destructive'];
    return colorProps.some(prop => prop in data);
  },
  { message: 'Theme must have at least one color property (background, foreground, accent, info, success, or destructive)' }
);

/**
 * Validate theme content from a JSON string (no disk reads).
 * Used to check if an existing theme file is valid before deciding to overwrite.
 */
export function validateThemeContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PresetThemeSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * Validate app-level theme override content from a JSON string (no disk reads).
 * Unlike preset validation, this accepts partial ThemeOverrides objects and rejects unknown keys.
 */
export function validateThemeOverrideContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = ThemeOverrideSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * Check if a theme file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidThemeFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validateThemeContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Tool Icons Validators
// ============================================================

import { getToolIconsDir } from './storage.ts';

/**
 * Zod schema for a single tool icon entry in tool-icons.json.
 * Each entry maps CLI commands to an icon file.
 */
const ToolIconEntrySchema = z.object({
  id: z.string().min(1, 'Tool ID is required').regex(
    /^[a-z0-9-]+$/,
    'ID must be lowercase alphanumeric with hyphens (e.g., "my-tool")'
  ),
  displayName: z.string().min(1, 'Display name is required'),
  icon: z.string().min(1, 'Icon filename is required'),
  commands: z.array(z.string().min(1)).min(1, 'At least one command is required'),
});

/**
 * Zod schema for the full tool-icons.json config.
 * Contains a version number and array of tool icon mappings.
 */
const ToolIconsConfigSchema = z.object({
  version: z.number().int().min(1, 'Version must be a positive integer'),
  tools: z.array(ToolIconEntrySchema),
});

/**
 * Validate tool-icons config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks JSON syntax, Zod schema, duplicate IDs, and duplicate commands.
 */
export function validateToolIconsContent(jsonString: string): ValidationResult {
  const file = 'tool-icons/tool-icons.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate against Zod schema
  const result = ToolIconsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validation: check for duplicate tool IDs
  const seenIds = new Set<string>();
  for (const tool of config.tools) {
    if (seenIds.has(tool.id)) {
      errors.push({
        file,
        path: `tools[id=${tool.id}]`,
        message: `Duplicate tool ID '${tool.id}'`,
        severity: 'error',
        suggestion: 'Each tool must have a unique ID',
      });
    }
    seenIds.add(tool.id);
  }

  // Semantic validation: warn on duplicate commands across tools
  const seenCommands = new Map<string, string>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      if (seenCommands.has(cmd)) {
        warnings.push({
          file,
          path: `tools[id=${tool.id}].commands`,
          message: `Command '${cmd}' is also mapped by tool '${seenCommands.get(cmd)}'`,
          severity: 'warning',
          suggestion: 'Commands should be unique across tools for unambiguous icon resolution',
        });
      } else {
        seenCommands.set(cmd, tool.id);
      }
    }
  }

  // Validate icon file extensions
  const validIconExtensions = new Set(['.png', '.ico', '.svg', '.jpg', '.jpeg']);
  for (const tool of config.tools) {
    const ext = tool.icon.includes('.') ? '.' + tool.icon.split('.').pop()!.toLowerCase() : '';
    if (!validIconExtensions.has(ext)) {
      warnings.push({
        file,
        path: `tools[id=${tool.id}].icon`,
        message: `Icon '${tool.icon}' has unrecognized extension '${ext}'`,
        severity: 'warning',
        suggestion: 'Supported formats: .png, .ico, .svg, .jpg',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate tool-icons/tool-icons.json from disk.
 * Reads the file, runs content validation, and also checks that referenced icon files exist.
 */
export function validateToolIcons(): ValidationResult {
  const toolIconsDir = getToolIconsDir();
  const configPath = join(toolIconsDir, 'tool-icons.json');
  const file = 'tool-icons/tool-icons.json';

  // File is optional — missing is just a warning
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Tool icons config does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content validator
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const result = validateToolIconsContent(raw);

  // Filesystem-specific check: verify referenced icon files exist
  try {
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    if (parsed.tools && Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.icon) {
          const iconPath = join(toolIconsDir, tool.icon);
          if (!existsSync(iconPath)) {
            result.warnings.push({
              file: `tool-icons/${tool.icon}`,
              path: `tools[id=${tool.id}].icon`,
              message: `Icon file '${tool.icon}' not found in tool-icons directory`,
              severity: 'warning',
              suggestion: `Place '${tool.icon}' in ~/.craft-agent/tool-icons/`,
            });
          }
        }
      }
    }
  } catch {
    // JSON parse errors already reported by content validator
  }

  return result;
}

// ============================================================
// Formatting
// ============================================================

/**
 * Format validation result as text for agent response
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push('All configuration files are valid.');
    return lines.join('\n');
  }

  if (result.valid) {
    lines.push('Configuration is valid with warnings:');
  } else {
    lines.push('Configuration has errors:');
  }

  lines.push('');

  // Errors first
  if (result.errors.length > 0) {
    lines.push('**Errors:**');
    for (const error of result.errors) {
      lines.push(`- \`${error.file}\` at \`${error.path}\`: ${error.message}`);
      if (error.suggestion) {
        lines.push(`  → ${error.suggestion}`);
      }
    }
    lines.push('');
  }

  // Then warnings
  if (result.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const warning of result.warnings) {
      lines.push(`- \`${warning.file}\` at \`${warning.path}\`: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`  → ${warning.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// PreToolUse Content Validation
// ============================================================
// These utilities are used by the PreToolUse hook to detect config files
// being written and validate their content before it reaches disk.

/**
 * Result of detecting what type of config file a path corresponds to.
 */
export interface ConfigFileDetection {
  type: 'source' | 'skill' | 'statuses' | 'labels' | 'permissions' | 'tool-icons' | 'automations';
  /** Slug of the source or skill (if applicable) */
  slug?: string;
  /** Display file path for error messages */
  displayFile: string;
}

/**
 * Detect if a file path corresponds to a known config file type within a workspace.
 * Returns null if the path is not a recognized config file.
 *
 * Matches patterns:
 * - .../sources/{slug}/config.json → source config
 * - .../skills/{slug}/SKILL.md → skill definition
 * - .../statuses/config.json → status workflow config
 * - .../labels/config.json → label config
 * - .../permissions.json (workspace or source-level) → permission rules
 */
export function detectConfigFileType(filePath: string, workspaceRootPath: string): ConfigFileDetection | null {
  // Normalize to consistent forward slashes and ensure root ends with /
  // so startsWith doesn't false-match on path prefixes (e.g., /workspace vs /workspacefoo)
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only validate files within the workspace root
  if (!normalizedPath.startsWith(normalizedRoot)) {
    return null;
  }

  // Get the relative path from workspace root (no leading slash since root ends with /)
  const relativePath = normalizedPath.slice(normalizedRoot.length);

  // Match: sources/{slug}/config.json
  const sourceMatch = relativePath.match(/^sources\/([^/]+)\/config\.json$/);
  if (sourceMatch) {
    return { type: 'source', slug: sourceMatch[1], displayFile: `sources/${sourceMatch[1]}/config.json` };
  }

  // Match: skills/{slug}/SKILL.md
  const skillMatch = relativePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    return { type: 'skill', slug: skillMatch[1], displayFile: `skills/${skillMatch[1]}/SKILL.md` };
  }

  // Match: statuses/config.json
  if (relativePath === 'statuses/config.json') {
    return { type: 'statuses', displayFile: 'statuses/config.json' };
  }

  // Match: labels/config.json
  if (relativePath === 'labels/config.json') {
    return { type: 'labels', displayFile: 'labels/config.json' };
  }

  // Match: automations config file
  if (relativePath === AUTOMATIONS_CONFIG_FILE) {
    return { type: 'automations', displayFile: relativePath };
  }

  // Match: permissions.json (workspace-level)
  if (relativePath === 'permissions.json') {
    return { type: 'permissions', displayFile: 'permissions.json' };
  }

  // Match: sources/{slug}/permissions.json (source-level)
  const sourcePermMatch = relativePath.match(/^sources\/([^/]+)\/permissions\.json$/);
  if (sourcePermMatch) {
    return { type: 'permissions', slug: sourcePermMatch[1], displayFile: `sources/${sourcePermMatch[1]}/permissions.json` };
  }

  return null;
}

/**
 * Detect if a file path corresponds to an app-level config file (outside workspace scope).
 * Checks paths relative to CONFIG_DIR (~/.craft-agent/).
 * Returns null if the path is not a recognized app-level config file.
 *
 * Matches patterns:
 * - ~/.craft-agent/tool-icons/tool-icons.json → tool icon mappings
 */
export function detectAppConfigFileType(filePath: string): ConfigFileDetection | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedConfigDir = CONFIG_DIR.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only check files within CONFIG_DIR
  if (!normalizedPath.startsWith(normalizedConfigDir)) {
    return null;
  }

  const relativePath = normalizedPath.slice(normalizedConfigDir.length);

  // Match: tool-icons/tool-icons.json
  if (relativePath === 'tool-icons/tool-icons.json') {
    return { type: 'tool-icons', displayFile: 'tool-icons/tool-icons.json' };
  }

  return null;
}

/**
 * Validate config file content based on its detected type.
 * Dispatches to the appropriate content-based validator.
 * Returns null if the detection type is unrecognized.
 */
export function validateConfigFileContent(
  detection: ConfigFileDetection,
  content: string
): ValidationResult | null {
  switch (detection.type) {
    case 'source':
      return validateSourceConfigContent(content);
    case 'skill':
      return validateSkillContent(content, detection.slug || 'unknown');
    case 'statuses':
      return validateStatusesContent(content);
    case 'labels':
      return validateLabelsContent(content);
    case 'automations':
      return validateAutomationsContent(content, detection.displayFile);
    case 'permissions':
      return validatePermissionsContent(content, detection.displayFile);
    case 'tool-icons':
      return validateToolIconsContent(content);
    default:
      return null;
  }
}
