/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates a filename with timestamp for export files.
 */
export function generateExportFilename(extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `export-${timestamp}.${extension}`;
}
