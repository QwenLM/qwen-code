/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionService } from '@qwen-code/qwen-code-core';
import {
  SessionArchivedError,
  SessionArchivingError,
} from '../acp-session-bridge.js';

export class SessionArchiveCoordinator {
  private readonly inFlight = new Set<string>();

  assertNotTransitioning(sessionId: string): void {
    if (this.inFlight.has(sessionId)) {
      throw new SessionArchivingError(sessionId);
    }
  }

  async runExclusiveMany<T>(
    sessionIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    for (const sessionId of sessionIds) {
      this.assertNotTransitioning(sessionId);
    }
    for (const sessionId of sessionIds) {
      this.inFlight.add(sessionId);
    }
    try {
      return await fn();
    } finally {
      for (const sessionId of sessionIds) {
        this.inFlight.delete(sessionId);
      }
    }
  }
}

export async function assertSessionLoadable(
  sessionService: SessionService,
  sessionId: string,
): Promise<void> {
  const location = await sessionService.getSessionLocation(sessionId);
  if (location === 'archived' || location === 'conflict') {
    throw new SessionArchivedError(sessionId);
  }
}
