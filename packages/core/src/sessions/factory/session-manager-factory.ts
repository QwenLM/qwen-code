/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionManager } from '../domain/interface/manager/session-manager.js';
import type { SessionTranscriptStore } from '../domain/interface/writer/session-transcript-store.js';
import { StandardSessionManager } from '../domain/impl/manager/standard-session-manager.js';
import { FileSystemSessionReader } from '../infra/reader/file-system-reader.js';

export interface CreateSessionManagerOptions {
  readonly store?: SessionTranscriptStore;
}

/**
 * Creates the default {@link SessionManager} implementation.
 */
export function createSessionManager(
  options: CreateSessionManagerOptions = {},
): SessionManager {
  return new StandardSessionManager({
    repository: new FileSystemSessionReader(),
    store: options.store,
  });
}
