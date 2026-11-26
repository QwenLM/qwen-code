/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionWriterStateSnapshot } from '../../domain/impl/writer/session-writer-state.js';

export interface SessionWriterStateReader {
  load(filePath: string, sessionId: string): Promise<SessionWriterStateSnapshot>;
}
