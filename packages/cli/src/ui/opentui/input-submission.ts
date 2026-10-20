/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OpenTuiInputSubmission {
  text: string;
  imagePaths?: readonly string[];
  submittedPrompt?: string;
  deferUntilIdle?: boolean;
}
