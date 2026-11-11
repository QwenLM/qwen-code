/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultSessionTranscriptStore } from '../domain/impl/writer/default-session-transcript-store.js';

/**
 * Creates the process-scoped {@link SessionTranscriptStore} singleton.
 *
 * The store is intentionally created through a factory so tests can substitute
 * in-memory file systems and state readers.
 */
export function createSessionTranscriptStore(): DefaultSessionTranscriptStore {
  return new DefaultSessionTranscriptStore();
}
