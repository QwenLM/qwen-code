/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Options for deleting a session. */
export interface SessionDeleteOptions {
  /** Explicit transcript bucket directory; falls back to the default bucket. */
  readonly bucketDir?: string;
}
