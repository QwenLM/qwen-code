/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Session } from '../session/session.js';
import type { SessionTranscriptWriter } from './session-transcript-writer.js';
import type { SessionWriterOptions } from './session-writer-options.js';

/**
 * Process-scoped composition root for transcript writers.
 *
 * A store manages the lifecycle of all active {@link SessionTranscriptWriter}
 * instances for the current process. It is intentionally separate from
 * {@link SessionManager}: the manager owns catalog queries and deletes, while
 * the store owns writer acquisition, flushing, and shutdown.
 */
export interface SessionTranscriptStore {
  /**
   * Acquires a writer for the given session. Multiple acquisitions for the
   * same session may return the same underlying writer or independent leases,
   * depending on the implementation; callers must still balance every
   * acquisition with a matching `writer.close()`.
   */
  acquireWriter(
    session: Session,
    options?: SessionWriterOptions,
  ): Promise<SessionTranscriptWriter>;

  /** Flushes every active writer to disk. */
  flushAll(): Promise<void>;

  /** Closes every active writer and releases all process-level resources. */
  close(): Promise<void>;
}
