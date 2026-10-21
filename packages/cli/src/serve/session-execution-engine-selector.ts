/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeExecutionEngine,
  BridgeExecutionSelection,
  BridgeOptions,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import type { ChannelFactory } from '@qwen-code/acp-bridge/channel';
import { SessionExecutionEngineError } from '@qwen-code/qwen-code-core/services/session-execution-engine.js';
import { readSessionTranscriptSnapshot } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import {
  SessionIdCaseConflictError,
  SessionService,
} from '@qwen-code/qwen-code-core/services/sessionService.js';

export type ManagedExecutionEngineCompatibility =
  | { readonly status: 'compatible' }
  | { readonly status: 'deferred' | 'unknown'; readonly reason: string };

/** A Managed engine a paired host may select, with its compatibility rule. */
export interface ManagedExecutionEngine {
  readonly factory: ChannelFactory;
  evaluate(
    selection: BridgeExecutionSelection,
  ):
    | ManagedExecutionEngineCompatibility
    | Promise<ManagedExecutionEngineCompatibility>;
}

export interface SessionExecutionEngineSelectorOptions {
  readonly runtimeBaseDir: string;
  /** Absent while no Managed engine exists for ordinary hosts. */
  readonly managed?: ManagedExecutionEngine;
}

/**
 * Selection for a paired Bridge. A new session runs on Managed only when its
 * purpose is eligible and the engine proves it compatible. A cold load or
 * resume runs on the owner proven by the whole persisted transcript;
 * unreadable, conflicting or empty history, and a Managed owner that cannot
 * run here, are rejected instead of falling back to Legacy.
 */
export function createSessionExecutionEngineSelector(
  options: SessionExecutionEngineSelectorOptions,
): (selection: BridgeExecutionSelection) => Promise<BridgeExecutionEngine> {
  return async (selection) => {
    const { managed } = options;
    if (selection.operation === 'spawn') {
      if (!managed || isDeferredCreation(selection)) return 'legacy';
      const compatibility = await checkCompatibility(managed, selection);
      return compatibility.status === 'compatible' ? 'managed' : 'legacy';
    }
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
    if (owner.engine === 'legacy') return 'legacy';
    const compatibility: ManagedExecutionEngineCompatibility = managed
      ? await checkCompatibility(managed, selection)
      : { status: 'unknown', reason: 'no Managed engine is available' };
    if (compatibility.status === 'compatible') return 'managed';
    throw new SessionExecutionEngineError(
      sessionId,
      `belongs to managed, which cannot run here: ${compatibility.reason}`,
    );
  };
}

/**
 * The Bridge's paired construction for one workspace runtime. Without a
 * Managed engine the Managed factory is never selected; it exists because the
 * Bridge requires both.
 */
export function createPairedExecutionEngines(
  options: SessionExecutionEngineSelectorOptions & {
    readonly legacy: ChannelFactory;
  },
): NonNullable<BridgeOptions['executionEngines']> {
  return {
    legacy: options.legacy,
    managed: options.managed?.factory ?? managedEngineUnavailable,
    select: createSessionExecutionEngineSelector(options),
  };
}

const managedEngineUnavailable: ChannelFactory = async () => {
  throw new Error('No Managed execution engine is available in this host.');
};

// First-phase purposes that stay on Legacy whatever the configuration.
// Creator-attributed sources can only make a session ineligible.
function isDeferredCreation(
  selection: Extract<BridgeExecutionSelection, { operation: 'spawn' }>,
): boolean {
  const { request } = selection;
  return (
    selection.daemonOwnedStandalone ||
    request.parentSessionId !== undefined ||
    request.worktree !== undefined ||
    request.branch !== undefined ||
    (request.sourceType !== undefined &&
      (request.sourceType !== 'default' || request.sourceId !== undefined))
  );
}

async function checkCompatibility(
  managed: ManagedExecutionEngine,
  selection: BridgeExecutionSelection,
): Promise<ManagedExecutionEngineCompatibility> {
  try {
    return await managed.evaluate(selection);
  } catch {
    return { status: 'unknown', reason: 'the compatibility check failed' };
  }
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
