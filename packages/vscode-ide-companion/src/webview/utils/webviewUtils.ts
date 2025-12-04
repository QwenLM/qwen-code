/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extract filename from full path
 * @param fsPath Full path of the file
 * @returns Filename (without path)
 */
export function getFileName(fsPath: string): string {
  // Use path.basename logic: find the part after the last path separator
  const lastSlash = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
  return lastSlash >= 0 ? fsPath.substring(lastSlash + 1) : fsPath;
}

/**
 * HTML escape function to prevent XSS attacks
 * Convert special characters to HTML entities
 * @param text Text to escape
 * @returns Escaped text
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
