/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Options used when acquiring a transcript writer for a session. */
export interface SessionWriterOptions {
  /** Explicit transcript bucket directory; falls back to the default bucket. */
  readonly bucketDir?: string;
  /** Effective working directory stamped on every persisted entry. */
  readonly cwd?: string;
  /** Where the session was started from. */
  readonly entrypoint?: string;
  /** CLI/SDK version that writes the session. */
  readonly version?: string;
  /** User type stamp, e.g. 'external' for interactive sessions. */
  readonly userType?: string;
  /** Most recently recorded git branch in the active chain. */
  readonly gitBranch?: string;
}
