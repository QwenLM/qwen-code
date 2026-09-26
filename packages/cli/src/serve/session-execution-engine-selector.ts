/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeExecutionEngine,
  BridgeExecutionSelection,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import { SessionExecutionEngineError } from '@qwen-code/qwen-code-core/services/session-execution-engine.js';
import { readSessionTranscriptSnapshot } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import {
  SessionIdCaseConflictError,
  SessionService,
} from '@qwen-code/qwen-code-core/services/sessionService.js';

export interface SessionExecutionEngineSelectorOptions {
  /** Engine for sessions this host creates. Restores never use it. */
  readonly newSessionEngine: BridgeExecutionEngine;
  readonly runtimeBaseDir: string;
}

/**
 * Selection for a paired Bridge. A cold load or resume runs on the owner
 * proven by the whole persisted transcript; unreadable, conflicting or empty
 * history is rejected instead of falling back to the host's engine.
 */
export function createSessionExecutionEngineSelector(
  options: SessionExecutionEngineSelectorOptions,
): (selection: BridgeExecutionSelection) => Promise<BridgeExecutionEngine> {
  return async (selection) => {
    if (selection.operation === 'spawn') return options.newSessionEngine;
    const { sessionId, workspaceCwd } = selection.request;
    const service = new SessionService(workspaceCwd, {
      runtimeBaseDir: options.runtimeBaseDir,
    });
    const persistedSessionId = await resolvePersistedSessionId(
      service,
      sessionId,
    );
    const snapshot =
      persistedSessionId === undefined
        ? undefined
        : await readSessionTranscriptSnapshot(
            service.getSessionTranscriptPath(persistedSessionId),
            persistedSessionId,
            false,
          );
    if (!snapshot) throw new SessionNotFoundError(sessionId);
    const owner = snapshot.executionEngine;
    if (owner.status !== 'verified') {
      throw new SessionExecutionEngineError(sessionId, owner.reason);
    }
    return owner.engine;
  };
}

// Resolves the spelling the ACP child restores, so both read one transcript.
async function resolvePersistedSessionId(
  service: SessionService,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return await service.findSessionIdIgnoringCase(sessionId);
  } catch (error) {
    if (
      error instanceof SessionIdCaseConflictError &&
      error.reason === 'case_conflict' &&
      error.candidateSessionId === sessionId
    ) {
      return sessionId;
    }
    throw error;
  }
}
