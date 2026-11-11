/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Result object for a single grep match
 */
export interface GrepMatch {
  filePath: string;
  absolutePath: string;
  lineNumber: number;
  line: string;
  isContext?: boolean;
}
