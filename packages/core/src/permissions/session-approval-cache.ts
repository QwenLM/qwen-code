/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-level approval cache that reduces excessive confirmation dialogs.
 *
 * Problem: Qwen Code asks for confirmation 7-10 times per dialogue even for
 * repetitive, low-risk operations on the same resources.
 *
 * Solution: After the user explicitly approves a tool call, subsequent calls
 * to the same tool with the same key parameters (file path, domain, command)
 * are auto-approved for the remainder of the session.
 *
 * This is intentionally narrow:
 * - Only applies to tools that already returned 'ask' from getDefaultPermission
 * - Only applies after explicit user approval (not for auto-deny scenarios)
 * - Does NOT apply to shell commands with side effects (rm, curl POST, etc.)
 * - Cleared when the session ends
 */

import type { PermissionCheckContext } from '../permissions/types.js';

/** Key types for different tools */
type CacheKey = string;

/** Maximum number of entries in the session cache to prevent memory leaks. */
const MAX_CACHE_SIZE = 500;

/**
 * Patterns that indicate a shell command may have side effects.
 * Commands matching these are NOT cached to prevent auto-approving
 * dangerous operations.
 */
const DANGEROUS_SHELL_PATTERNS = [
  /^rm\s/,
  /^rmdir\s/,
  /^del\s/,
  /^erase\s/,
  /^curl\s+(-X\s+(POST|DELETE|PUT|PATCH)|--data|--request)/i,
  /^wget\s+--post/i,
  /^(echo|printf|cat)\s+.*\s*[>]+/, // redirects
  /\|\s*(rm|xargs\s+rm)\s/,
];

/**
 * Builds a cache key from the permission check context.
 * Returns null if the context is not cacheable.
 */
function buildCacheKey(ctx: PermissionCheckContext): CacheKey | null {
  const { toolName, command, filePath, domain, specifier } = ctx;

  // Shell commands: only cache read-only commands
  if (toolName === 'run_shell_command') {
    if (!command) return null;
    // Don't cache potentially dangerous commands
    const lowerCmd = command.toLowerCase();
    if (DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(lowerCmd))) {
      return null;
    }
    return `shell:${command}`;
  }

  // File write/edit: cache by file path
  if (filePath) {
    return `file:${toolName}:${filePath}`;
  }

  // WebFetch: cache by domain
  if (domain) {
    return `web:${domain}`;
  }

  // WebSearch: cache by query
  if (toolName === 'web_search' && specifier) {
    return `search:${specifier}`;
  }

  // Memory tool: cache by scope
  if (toolName === 'save_memory' && specifier) {
    return `memory:${specifier}`;
  }

  // Fallback: tool-level cache (coarse-grained)
  return `tool:${toolName}`;
}

/**
 * Tracks which tool+parameter combinations have been explicitly approved
 * by the user during the current session.
 */
export class SessionApprovalCache {
  private approved = new Set<CacheKey>();

  /** Check if a context has been previously approved */
  isApproved(ctx: PermissionCheckContext): boolean {
    const key = buildCacheKey(ctx);
    if (!key) return false;
    return this.approved.has(key);
  }

  /** Mark a context as approved */
  approve(ctx: PermissionCheckContext): void {
    const key = buildCacheKey(ctx);
    if (!key) return;
    // Prevent unbounded growth in long sessions
    if (this.approved.size >= MAX_CACHE_SIZE) {
      // Evict oldest entries (first 10%)
      const toRemove = Math.floor(MAX_CACHE_SIZE * 0.1);
      const keys = [...this.approved];
      for (let i = 0; i < toRemove; i++) {
        this.approved.delete(keys[i]);
      }
    }
    this.approved.add(key);
  }

  /** Clear all cached approvals (e.g., on session end) */
  clear(): void {
    this.approved.clear();
  }

  /** Get the number of cached approvals (for debugging) */
  get size(): number {
    return this.approved.size;
  }
}
