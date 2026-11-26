/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview maybe() — error isolation wrapper for attachment generators.
 *
 * All attachment generators are wrapped with maybe() to ensure that a failure
 * in one generator does not crash the entire attachment pipeline. Errors are
 * silently logged (Silent Degradation pattern).
 */

import { runLogger } from '../utils/runLogger.js';
import { emitAttachmentGeneratorFinished } from '../utils/diagnosticInterceptors.js';

export interface AttachmentGeneratorDiagnostics {
  sessionId?: string;
  turnId?: string;
  loopId?: string;
  phase?: string;
}

/**
 * Run an attachment generator, returning [] on any error.
 *
 * @param label - Short label for logs (e.g. 'file-generators.getChangedFiles')
 * @param f - Generator function that returns a Promise<A[]>
 * @returns The generator result, or [] if the generator throws
 */
export async function maybe<A>(
  label: string,
  f: () => Promise<A[]>,
  diagnostics?: AttachmentGeneratorDiagnostics,
): Promise<A[]> {
  const start = Date.now();
  try {
    const result = await f();
    const durationMs = Date.now() - start;
    runLogger.log(
      `[attachment:${label}] ok count=${result.length} duration=${durationMs}ms`,
    );
    emitAttachmentGeneratorFinished({
      sessionId: diagnostics?.sessionId,
      turnId: diagnostics?.turnId,
      loopId: diagnostics?.loopId,
      phase: diagnostics?.phase,
      label,
      status: 'success',
      count: result.length,
      durationMs,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    runLogger.log(
      `[attachment:${label}] error duration=${durationMs}ms`,
      err,
    );
    emitAttachmentGeneratorFinished({
      sessionId: diagnostics?.sessionId,
      turnId: diagnostics?.turnId,
      loopId: diagnostics?.loopId,
      phase: diagnostics?.phase,
      label,
      status: 'error',
      durationMs,
      error: err,
    });
    return [];
  }
}

/**
 * Wrap a generator in a Promise with an absolute timeout.
 * Returns [] if the generator doesn't complete within timeoutMs.
 */
export async function withTimeout<A>(
  label: string,
  f: () => Promise<A[]>,
  timeoutMs: number,
  diagnostics?: AttachmentGeneratorDiagnostics,
): Promise<A[]> {
  const start = Date.now();
  return new Promise<A[]>((resolve) => {
    let settled = false;
    const finish = (result: A[]) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      runLogger.log(`[attachment:${label}] timeout after ${timeoutMs}ms`);
      emitAttachmentGeneratorFinished({
        sessionId: diagnostics?.sessionId,
        turnId: diagnostics?.turnId,
        loopId: diagnostics?.loopId,
        phase: diagnostics?.phase,
        label,
        status: 'timeout',
        durationMs: Date.now() - start,
      });
      finish([]);
    }, timeoutMs);

    f()
      .then((result) => {
        clearTimeout(timer);
        if (settled) return;
        emitAttachmentGeneratorFinished({
          sessionId: diagnostics?.sessionId,
          turnId: diagnostics?.turnId,
          loopId: diagnostics?.loopId,
          phase: diagnostics?.phase,
          label,
          status: 'success',
          count: result.length,
          durationMs: Date.now() - start,
        });
        finish(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (settled) return;
        runLogger.log(`[attachment:${label}] error:`, err);
        emitAttachmentGeneratorFinished({
          sessionId: diagnostics?.sessionId,
          turnId: diagnostics?.turnId,
          loopId: diagnostics?.loopId,
          phase: diagnostics?.phase,
          label,
          status: 'error',
          durationMs: Date.now() - start,
          error: err,
        });
        finish([]);
      });
  });
}
