/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Options for renaming a session. */
export interface SessionRenameOptions {
  /** Explicit transcript bucket directory; falls back to the default bucket. */
  readonly bucketDir?: string;
}
