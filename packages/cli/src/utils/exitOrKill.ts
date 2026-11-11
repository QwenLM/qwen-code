/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';
import { unload as unloadExitHooks } from 'signal-exit';

type RedactText = (text: string) => string;

function errorDetails(
  error: unknown,
  redact: RedactText,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const unreadable: string[] = [];
  if (
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function')
  ) {
    return { errorName: typeof error };
  }
  for (const [field, target, limit] of [
    ['name', 'errorName', 200],
    ['code', 'errorCode', 200],
    ['stack', 'errorStack', 2000],
  ] as const) {
    try {
      // Read once: getters, proxies and lazy stack formatting may throw. A bad
      // optional field must not discard the base record or other useful fields.
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === 'string') {
        // Reserve the stack budget for callsites: a long exception message must
        // not push the throwing callback out of the diagnostic. Custom stacks
        // without Node-style frames still get a bounded, redacted preview.
        const text =
          field === 'stack'
            ? (value.match(/^[ \t]+at .+$/gm)?.join('\n') ?? value)
            : value;
        // Redact before truncation so a cut-off credential is never logged.
        details[target] = redact(text).slice(0, limit);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        details[target] = value;
      }
    } catch {
      unreadable.push(field);
    }
  }
  if (unreadable.length) details['unreadableErrorFields'] = unreadable;
  return details;
}

function recordExitFailure(
  code: number,
  error: unknown,
  attempt: number,
  action: string,
  getLogPath: () => string,
  redact: RedactText,
): void {
  try {
    // An earlier exit listener may already have closed sessionLogger. Append
    // synchronously with a fresh descriptor, without touching protocol streams.
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'process_exit_failed',
        pid: process.pid,
        threadId,
        isMainThread,
        exitCode: code,
        attempt,
        action,
        ...errorDetails(error, redact),
      }) + '\n',
      'utf8',
    );
  } catch {
    // Diagnostic failure must not prevent termination or escalate its scope.
  }
}

/**
 * Exit the current runtime without allowing a Worker to kill its host.
 * Main-thread Bun exits retain the SIGKILL fallback for a closed TTY (EIO).
 */
export function exitOrKill(
  code: number,
  getLogPath: () => string,
  redact: RedactText,
): never {
  try {
    process.exit(code);
  } catch (error) {
    // Tests replace process.exit with a throwing spy; preserve that signal.
    if (isMainThread && process.env['NODE_ENV'] === 'test') throw error;

    recordExitFailure(
      code,
      error,
      1,
      isMainThread ? 'kill_process' : 'retry_worker_exit',
      getLogPath,
      redact,
    );

    if (isMainThread) {
      process.kill(process.pid, 'SIGKILL');
    } else {
      try {
        // Node sets _exiting before emitting 'exit', so a retry skips ordinary
        // listeners. signal-exit also wraps reallyExit: its callbacks may still
        // run here if an ordinary listener prevented their first invocation.
        process.exit(code);
      } catch (retryError) {
        recordExitFailure(
          code,
          retryError,
          2,
          'unload_exit_hooks_and_retry_worker_exit',
          getLogPath,
          redact,
        );
        // Restore the runtime's reallyExit after the second callback failure.
        // This is signal-exit's public teardown API; never signal the shared PID
        // or reach into Node's private bindings to terminate a Worker.
        unloadExitHooks();
        process.exit(code);
      }
    }
  }
  return undefined as never;
}
