/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseLineTolerantWithIntegrity } from '../utils/jsonl-utils.js';
import { validateTranscriptRecord } from '../utils/transcript-records.js';

export type SessionExecutionEngine = 'legacy' | 'managed';
export const SESSION_EXECUTION_ENGINE_META_KEY = 'qwen.session.executionEngine';

export interface SessionExecutionEnginePayload {
  version: 1;
  engine: SessionExecutionEngine;
}

export interface SessionExecutionSnapshot {
  filePath: string;
  dev: number;
  ino: number;
  size: number;
  lastUpdated: string;
}

export type SessionExecutionEngineState = {
  sessionId: string;
  snapshot: SessionExecutionSnapshot;
} & (
  | {
      status: 'verified';
      engine: SessionExecutionEngine;
      recorded: boolean;
    }
  | { status: 'unavailable'; reason: string }
);

export class SessionExecutionEngineError extends Error {
  readonly errorKind = 'session_execution_engine_unavailable';

  constructor(sessionId: string, reason: string) {
    super(`Session execution engine for ${sessionId}: ${reason}.`);
    this.name = 'SessionExecutionEngineError';
  }
}

export function assertSessionExecutionEngine(
  state: SessionExecutionEngineState | undefined,
  sessionId: string,
  expected: SessionExecutionEngine,
): asserts state is SessionExecutionEngineState & { status: 'verified' } {
  if (!state || state.sessionId !== sessionId) {
    throw new SessionExecutionEngineError(
      sessionId,
      'ownership was not verified',
    );
  }
  if (state.status !== 'verified') {
    throw new SessionExecutionEngineError(sessionId, state.reason);
  }
  if (state.engine !== expected) {
    throw new SessionExecutionEngineError(
      sessionId,
      `belongs to ${state.engine}, cannot execute with ${expected}`,
    );
  }
}

/** Tracks physical records before branch selection or UUID aggregation. */
export class SessionExecutionEngineAccumulator {
  private engine: SessionExecutionEngine | undefined;
  private reason: string | undefined;
  private hasRecords = false;
  private complete = true;

  constructor(private readonly sessionId: string) {}

  parseLine(line: string, filePath: string): unknown[] {
    if (!line.trim()) return [];
    const parsed = parseLineTolerantWithIntegrity<unknown>(line, filePath);
    if (!parsed.complete) this.reason ??= 'incomplete transcript';
    this.complete &&= parsed.complete;
    for (const value of parsed.records) {
      this.hasRecords = true;
      const { record, diagnostics } = validateTranscriptRecord(value);
      if (
        !record ||
        record.sessionId !== this.sessionId ||
        diagnostics.some((diagnostic) => diagnostic.affectsCompleteness)
      ) {
        this.reason ??= 'invalid transcript record';
      }
      const candidate = value as Record<string, unknown>;
      if (candidate['subtype'] !== 'session_execution_engine') continue;
      const payload = candidate['systemPayload'];
      if (
        candidate['type'] !== 'system' ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        !('version' in payload) ||
        payload.version !== 1 ||
        !('engine' in payload) ||
        (payload.engine !== 'legacy' && payload.engine !== 'managed')
      ) {
        this.reason ??= 'invalid owner record';
        continue;
      }
      if (this.engine !== undefined && this.engine !== payload.engine) {
        this.reason ??= 'conflicting owners';
      }
      this.engine = payload.engine;
    }
    return parsed.records;
  }

  /**
   * Whether every line handed to {@link parseLine} parsed whole.
   *
   * Exposed because a caller that reads lines through this accumulator has no
   * other way to see it: the parse happens here, and an index that assumed the
   * source was complete would present a truncated transcript as a whole one.
   */
  get sourceComplete(): boolean {
    return this.complete;
  }

  finish(snapshot: SessionExecutionSnapshot): SessionExecutionEngineState {
    const reason =
      this.reason ?? (!this.hasRecords ? 'empty transcript' : undefined);
    return reason
      ? { status: 'unavailable', sessionId: this.sessionId, snapshot, reason }
      : {
          status: 'verified',
          sessionId: this.sessionId,
          snapshot,
          engine: this.engine ?? 'legacy',
          recorded: this.engine !== undefined,
        };
  }
}
