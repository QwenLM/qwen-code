/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents an error that occurred while loading a configuration item
 * (agent, skill, or hook). Stored by registries for later retrieval by UI.
 */
export interface ConfigLoadError {
  /** Display name of the config item, if parseable */
  name?: string;
  /** Absolute file path that failed to load, or source description (e.g. "project config") */
  filePath: string;
  /** Human-readable error message */
  message: string;
  /** Which config type produced this error */
  configType: 'agent' | 'skill' | 'hook';
  /** Source origin (personal, project, extension, inline, etc.) */
  source?: string;
  /**
   * Severity of the error. Defaults to 'error' if not specified.
   * - 'error': Fatal — config item failed to load entirely. Shown as error list item.
   * - 'warning': Tolerated — item loaded with issues (e.g. YAML fallback). Shown as indicator on normal item.
   */
  severity?: 'error' | 'warning';
}

// ─── Feed-stream summary helper ─────────────────────────────────────────────

/** Maximum length of a single error message in the feed stream */
const MAX_MSG_LENGTH = 200;

/**
 * Truncate a string with ellipsis if it exceeds maxLen.
 */
export function truncateMessage(
  msg: string,
  maxLen: number = MAX_MSG_LENGTH,
): string {
  // Collapse multi-line error messages (e.g. YAML snippets) to single line
  const singleLine = msg.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen) + '...';
}

/**
 * Emit a single summarized feed-stream warning for accumulated load errors.
 *
 * Emits one line per config type, e.g.:
 * - "3 errors loading agent configs. Use /agents to see details."
 * - "1 error, 2 warnings loading skill configs. Use /skills to see details."
 *
 * @param errors The accumulated errors to report
 * @param configLabel Human-readable label like "agent", "skill", or "hook"
 * @param emitFn The function to call for each message
 */
export function emitLoadErrorSummary(
  errors: readonly ConfigLoadError[],
  configLabel: string,
  emitFn: (severity: 'warning', message: string) => void,
): void {
  if (errors.length === 0) return;

  const errorCount = errors.filter(
    (e) => (e.severity ?? 'error') === 'error',
  ).length;
  const warningCount = errors.filter((e) => e.severity === 'warning').length;

  if (errorCount === 0 && warningCount === 0) return;

  const parts: string[] = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`);
  }

  emitFn(
    'warning',
    `${parts.join(', ')} loading ${configLabel} configs. Use /${configLabel}s to see details.`,
  );
}
