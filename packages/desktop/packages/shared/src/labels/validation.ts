/**
 * Label Validation
 *
 * Session-level validation for label references.
 * Checks that session label IDs exist in the workspace's label tree.
 * Invalid IDs are silently filtered out (handles deleted labels gracefully).
 */

import { isValidLabelId } from './storage.ts';
import { extractLabelId } from './values.ts';

/**
 * Validate a session's labels array.
 * Filters out any label IDs that no longer exist in the workspace config.
 * Handles valued entries (e.g., "priority::3") by extracting the ID before checking.
 * Returns the cleaned array (invalid IDs silently removed, values preserved).
 *
 * @param workspaceRootPath - Workspace root path
 * @param labels - Array of label entries to validate (may contain :: values)
 * @returns Array of valid label entries only
 */
export function validateSessionLabels(
  workspaceRootPath: string,
  labels: string[] | undefined
): string[] {
  if (!labels || labels.length === 0) {
    return [];
  }

  // Extract label ID from entries (handles "priority::3" → "priority")
  // then validate the ID exists in config. Preserves the full entry string.
  return labels.filter(entry => isValidLabelId(workspaceRootPath, extractLabelId(entry)));
}
