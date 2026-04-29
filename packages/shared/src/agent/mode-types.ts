/**
 * Mode Types and Constants
 *
 * Pure types and UI configuration for permission modes.
 * This file has NO runtime dependencies - safe for browser bundling.
 *
 * For runtime mode management functions, use './mode-manager.ts'
 */

import { z } from 'zod';

// ============================================================
// Permission Mode Types
// ============================================================

/**
 * Available permission modes (internal storage keys).
 *
 * Qwen Code / ACP mode mapping:
 * - yolo              -> allow-all
 * - plan              -> safe
 * - default           -> ask
 * - auto-edit         -> auto-edit
 */
export type PermissionMode = 'allow-all' | 'safe' | 'ask' | 'auto-edit';

/**
 * Canonical mode names used in user-facing/session-state surfaces.
 */
export type PermissionModeCanonical = 'explore' | 'ask' | 'execute' | 'auto-edit';

/**
 * Order of modes for cycling with SHIFT+TAB
 */
export const PERMISSION_MODE_ORDER: PermissionMode[] = ['allow-all', 'safe', 'ask', 'auto-edit'];

/**
 * Internal -> canonical mapping.
 */
export const PERMISSION_MODE_TO_CANONICAL: Record<PermissionMode, PermissionModeCanonical> = {
  'allow-all': 'execute',
  safe: 'explore',
  ask: 'ask',
  'auto-edit': 'auto-edit',
};

/**
 * Canonical -> internal mapping.
 */
export const CANONICAL_TO_PERMISSION_MODE: Record<PermissionModeCanonical, PermissionMode> = {
  explore: 'safe',
  ask: 'ask',
  execute: 'allow-all',
  'auto-edit': 'auto-edit',
};

/**
 * Convert internal mode key to canonical user-facing mode name.
 */
export function toCanonicalPermissionMode(mode: PermissionMode): PermissionModeCanonical {
  return PERMISSION_MODE_TO_CANONICAL[mode];
}

/**
 * Parse user-facing mode names into internal mode keys.
 *
 * Accepts canonical values (explore/ask/execute) and legacy aliases
 * (safe/allow-all, ask-to-edit) for backward compatibility.
 */
export function parsePermissionMode(mode: string): PermissionMode | null {
  const normalized = mode.trim().toLowerCase();

  if (normalized === 'safe') return 'safe';
  if (normalized === 'ask') return 'ask';
  if (normalized === 'allow-all') return 'allow-all';
  if (normalized === 'auto-edit') return 'auto-edit';

  if (normalized === 'explore') return 'safe';
  if (normalized === 'plan' || normalized === 'plan-mode' || normalized === 'plan mode') return 'safe';
  if (normalized === 'execute') return 'allow-all';
  if (normalized === 'yolo') return 'allow-all';
  if (normalized === 'default') return 'ask';
  if (normalized === 'ask-to-edit' || normalized === 'ask_to_edit' || normalized === 'ask to edit') return 'ask';
  if (normalized === 'ask-before-edits' || normalized === 'ask_before_edits' || normalized === 'ask before edits') return 'ask';
  if (normalized === 'edit-automatically' || normalized === 'edit_automatically' || normalized === 'edit automatically') return 'auto-edit';

  return null;
}

const LEGACY_CYCLABLE_PERMISSION_MODE_SETS: PermissionMode[][] = [
  ['safe', 'allow-all'],
  ['safe', 'ask', 'allow-all'],
];

function isLegacyCyclablePermissionModeSet(modes: PermissionMode[]): boolean {
  return LEGACY_CYCLABLE_PERMISSION_MODE_SETS.some(legacy =>
    legacy.length === modes.length && legacy.every((mode, index) => modes[index] === mode)
  );
}

export function normalizeCyclablePermissionModes(
  modes: readonly unknown[] | undefined,
): PermissionMode[] {
  const normalized: PermissionMode[] = [];

  for (const mode of modes ?? []) {
    if (typeof mode !== 'string') continue;
    const parsed = parsePermissionMode(mode);
    if (!parsed || normalized.includes(parsed)) continue;
    normalized.push(parsed);
  }

  if (normalized.length < 2 || isLegacyCyclablePermissionModeSet(normalized)) {
    return [...PERMISSION_MODE_ORDER];
  }

  return normalized;
}

// ============================================================
// Permissions Config Types (Browser-safe Zod schemas)
// ============================================================

/**
 * API endpoint rule - method + path pattern
 */
const ApiEndpointRuleSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().describe('Regex pattern for API path'),
  comment: z.string().optional(),
});

export type ApiEndpointRule = z.infer<typeof ApiEndpointRuleSchema>;

/**
 * Pattern with optional comment
 */
const PatternSchema = z.union([
  z.string(),
  z.object({
    pattern: z.string(),
    comment: z.string().optional(),
  }),
]);

/**
 * Command-specific block hint for clearer Plan-mode rejection messages.
 */
const BlockedCommandHintSchema = z.object({
  /** Command name (normalized lowercase base command, e.g. "printf") */
  command: z.string(),
  /** Primary reason shown when command is blocked */
  reason: z.string(),
  /** Additional policy/risk context */
  context: z.string().optional(),
  /** Suggested alternatives or next actions */
  tryInstead: z.array(z.string()).optional(),
  /** Concrete example command */
  example: z.string().optional(),
  /** Apply this hint only when the command does NOT match this regex */
  whenNotMatching: z.string().optional(),
});

export type BlockedCommandHintRule = z.infer<typeof BlockedCommandHintSchema>;

/**
 * Permissions JSON configuration schema
 *
 * Note: Core write tools (Write, Edit, MultiEdit, NotebookEdit) are hardcoded in
 * SAFE_MODE_CONFIG and always blocked in Plan mode. The blockedTools field
 * allows users to block additional tools beyond these defaults.
 */
export const PermissionsConfigSchema = z.object({
  /** Version date for migration (ISO format: "2026-02-07") */
  version: z.string().optional(),
  /** Bash command patterns to allow (regex strings) */
  allowedBashPatterns: z.array(PatternSchema).optional(),
  /** MCP tool patterns to allow (regex strings) */
  allowedMcpPatterns: z.array(PatternSchema).optional(),
  /** API endpoint rules - method + path pattern */
  allowedApiEndpoints: z.array(ApiEndpointRuleSchema).optional(),
  /** File paths to allow writes in Plan mode (glob patterns) */
  allowedWritePaths: z.array(PatternSchema).optional(),
  /** Additional tools to block (extends the hardcoded defaults) */
  blockedTools: z.array(PatternSchema).optional(),
  /** Command-specific hint messages for blocked Bash commands */
  blockedCommandHints: z.array(BlockedCommandHintSchema).optional(),
});

export type PermissionsConfigFile = z.infer<typeof PermissionsConfigSchema>;

// ============================================================
// Mode Config Types
// ============================================================

/**
 * Compiled API endpoint rule for runtime checking
 */
export interface CompiledApiEndpointRule {
  method: string;
  pathPattern: RegExp;
}

/**
 * Compiled bash pattern with metadata for error messages.
 * Stores the original pattern string and comment alongside the compiled RegExp
 * so we can provide helpful error messages when commands don't match.
 */
export interface CompiledBashPattern {
  /** Compiled regex for matching */
  regex: RegExp;
  /** Original pattern string (for error messages) */
  source: string;
  /** Human-readable comment explaining what this pattern allows */
  comment?: string;
}

/**
 * Runtime command-specific hint for blocked Bash commands.
 */
export interface CompiledBlockedCommandHint {
  /** Base command token (lowercase), e.g. "printf" */
  command: string;
  reason: string;
  context?: string;
  tryInstead?: string[];
  example?: string;
  /** Optional condition: hint applies only when command does NOT match this regex */
  whenNotMatching?: string;
  whenNotMatchingRegex?: RegExp;
}

/**
 * Analysis of why a command didn't match a pattern.
 * Used by incr-regex-package to provide detailed diagnostics showing
 * exactly WHERE matching failed and what was expected.
 */
export interface MismatchAnalysis {
  /** How much of the command matched before failure */
  matchedPrefix: string;
  /** Character position where matching stopped */
  failedAtPosition: number;
  /** The token/word that caused the mismatch */
  failedToken: string;
  /** The pattern that got closest to matching */
  bestMatchPattern?: {
    source: string;
    comment?: string;
  };
  /** Actionable suggestion for the user/agent */
  suggestion?: string;
}

/**
 * Paths to permissions configuration files.
 * Used in error messages to guide the agent on how to customize permissions.
 */
export interface PermissionPaths {
  /** Path to workspace-level permissions.json */
  workspacePath: string;
  /** Path to app-level default.json */
  appDefaultPath: string;
  /** Path to permissions documentation */
  docsPath: string;
}

/**
 * Safe mode configuration - defines behavior for read-only mode
 */
export interface ModeConfig {
  /** Tools that are always blocked in safe mode (Write, Edit, etc.) - hardcoded, not configurable */
  blockedTools: Set<string>;
  /** Read-only Bash command patterns with metadata for helpful error messages */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** Command-specific hints shown when blocked Bash commands are rejected */
  blockedCommandHints?: CompiledBlockedCommandHint[];
  /** Read-only MCP patterns (tools matching these are allowed) */
  readOnlyMcpPatterns: RegExp[];
  /** Fine-grained API endpoint rules (method + path pattern) */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** File paths allowed for writes in Plan mode (glob patterns) */
  allowedWritePaths?: string[];
  /** User-friendly name */
  displayName: string;
  /** Keyboard shortcut hint */
  shortcutHint: string;
  /** Paths to permission files for actionable error messages */
  permissionPaths?: PermissionPaths;
}

// ============================================================
// Safe Mode Configuration (Browser-safe - pure data)
// ============================================================

/**
 * Minimal fallback configuration for safe mode.
 *
 * The actual patterns are loaded from ~/.craft-agent/permissions/default.json
 * at runtime by PermissionsConfigCache. This fallback ensures the app works
 * even if the JSON file is missing or invalid.
 *
 * To customize allowed commands, edit ~/.craft-agent/permissions/default.json
 */
export const SAFE_MODE_CONFIG: ModeConfig = {
  // Tools that are always blocked (no read-only variant) - these are hardcoded
  // as they represent fundamental write operations that should never be allowed
  // in Plan mode regardless of user configuration
  blockedTools: new Set([
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
  ]),
  // Empty fallbacks - actual patterns loaded from default.json
  // If default.json is missing, no bash commands will be auto-allowed in Plan mode
  readOnlyBashPatterns: [],
  blockedCommandHints: [],
  readOnlyMcpPatterns: [],
  allowedApiEndpoints: [],
  displayName: 'Plan mode',
  shortcutHint: 'SHIFT+TAB',
};

/**
 * Display configuration for each mode
 */
export const PERMISSION_MODE_CONFIG: Record<PermissionMode, {
  displayName: string;
  shortName: string;
  description: string;
  /** SVG path data for the icon (viewBox 0 0 24 24, stroke-based) */
  svgPath: string;
  /** Tailwind color classes for consistent theming */
  colorClass: {
    /** Text color class (e.g., 'text-info') */
    text: string;
    /** Background color class (e.g., 'bg-info') */
    bg: string;
    /** Border color class (e.g., 'border-info') */
    border: string;
  };
}> = {
  'allow-all': {
    displayName: 'YOLO',
    shortName: 'YOLO',
    description: 'Auto-approves every tool request.',
    // Repeat icon from Lucide (loop)
    svgPath: 'm17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
    colorClass: {
      text: 'text-accent',
      bg: 'bg-accent',
      border: 'border-accent',
    },
  },
  'safe': {
    displayName: 'Plan mode',
    shortName: 'Plan',
    description: 'Plan and inspect before making edits.',
    // Clipboard list icon from Lucide
    svgPath: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2h6v4H9z M9 12h6 M9 16h6',
    colorClass: {
      text: 'text-foreground/60',
      bg: 'bg-foreground/60',
      border: 'border-foreground/60',
    },
  },
  'ask': {
    displayName: 'Ask before edits',
    shortName: 'Ask',
    description: 'Prompts before applying edits.',
    // Info icon from Lucide
    svgPath: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01',
    colorClass: {
      text: 'text-info',
      bg: 'bg-info',
      border: 'border-info',
    },
  },
  'auto-edit': {
    displayName: 'Edit automatically',
    shortName: 'Auto edit',
    description: 'Applies edits automatically; asks for other risky tools.',
    // Square pen icon from Lucide
    svgPath: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.375 2.625a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z',
    colorClass: {
      text: 'text-success',
      bg: 'bg-success',
      border: 'border-success',
    },
  },
};
