/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { isMainThread } from 'node:worker_threads';

// Allow slow Windows scans while bounding an unresponsive where.exe process.
const PROBE_TIMEOUT_MS = 30_000;

// SDK close ends Worker stdin. `end` alone waits for buffered initialize
// frames to be consumed, which may not happen during startup. Observe EOF at
// the input producer without consuming or replacing the protocol stream.
let workerInput: AbortController | undefined;
let workerInputEnded = false;
function getWorkerInputSignal(): AbortSignal | undefined {
  // EOF cancels probes already running at disconnect, not later lookups
  // started by work that is still draining after input has ended.
  if (isMainThread || workerInputEnded || process.stdin.readableEnded) {
    return undefined;
  }
  if (!workerInput) {
    workerInput = new AbortController();
    const controller = workerInput;
    const input = process.stdin;
    const originalPush = input.push;
    const onEnd = () => {
      workerInputEnded = true;
      if (input.push === observePush) input.push = originalPush;
      input.removeListener('end', onEnd);
    };
    const observePush: typeof input.push = function (
      this: typeof input,
      chunk,
      encoding,
    ) {
      const result = originalPush.call(this, chunk, encoding);
      if (chunk === null) {
        onEnd();
        controller.abort();
      }
      return result;
    };
    input.push = observePush;
    // Consumer-side end may be delayed behind data buffered before this
    // observer was installed; only a newly received producer EOF cancels.
    input.once('end', onEnd);
    // Request input/EOF without removing buffered initialize frames.
    input.read(0);
  }
  return workerInput.signal;
}

/** Bounded PATH search; cancellation and timeout both wait for child close. */
export async function runWindowsExecutableProbe(
  name: '7z' | 'git' | 'bash',
  signal?: AbortSignal,
): Promise<string> {
  const deadline = new AbortController();
  const signals = [deadline.signal, signal, getWorkerInputSignal()].filter(
    (item): item is AbortSignal => item !== undefined,
  );
  const cancellation = AbortSignal.any(signals);
  cancellation.throwIfAborted();

  return new Promise<string>((resolve, reject) => {
    let output = '';
    const child = execFile(
      'where.exe',
      [name],
      {
        encoding: 'utf8',
        windowsHide: true,
        killSignal: 'SIGKILL',
        signal: cancellation,
      },
      (error, stdout) => {
        // Not found / failed probes retain the existing empty-result fallback.
        if (!error) output = stdout.trim();
      },
    );
    const timer = setTimeout(() => {
      deadline.abort(
        new DOMException(
          `where.exe ${name} timed out after ${PROBE_TIMEOUT_MS}ms. ` +
            'Tool availability is unknown; retry the lookup.',
          'TimeoutError',
        ),
      );
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    // execFile reports AbortError before the child has necessarily exited.
    // Keep observing close so cancellation does not leave a probe running.
    child.once('close', () => {
      clearTimeout(timer);
      if (cancellation.aborted) {
        reject(cancellation.reason);
      } else {
        resolve(output);
      }
    });
  });
}
