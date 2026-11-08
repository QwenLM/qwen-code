import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const RETRY_DELAYS_MS = [10, 20, 30, 40, 50] as const;
// proper-lockfile stamps the lock mtime once at acquisition and never refreshes
// it during a synchronous hold, so an operation outlasting this window lets a
// second process take the lock over mid-operation. Every locked pidfile
// operation must stay a bounded handful of local syscalls.
const STALE_LOCK_MS = 10_000;
const sleepState = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepState, 0, 0, ms);
}

/**
 * Run a short synchronous pidfile operation under proper-lockfile's atomic,
 * stale-recoverable lock directory. The dependency's sync API rejects its own
 * retries option, so brief contention is retried explicitly here.
 */
export function withChannelPidfileLock<T>(
  filePath: string,
  operation: () => T,
): T {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let release: (() => void) | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      release = lockfile.lockSync(filePath, {
        realpath: false,
        stale: STALE_LOCK_MS,
      });
      break;
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== 'ELOCKED') {
        throw error;
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw Object.assign(
          new Error(
            `Channel pidfile lock ${filePath}.lock is held; an abandoned lock recovers automatically after ${STALE_LOCK_MS / 1000} seconds.`,
            { cause: error },
          ),
          { code: 'ELOCKED' },
        );
      }
      sleepSync(RETRY_DELAYS_MS[attempt]!);
    }
  }

  try {
    return operation();
  } finally {
    release();
  }
}
