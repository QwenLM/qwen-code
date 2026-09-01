import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const RETRY_DELAYS_MS = [10, 20, 30, 40, 50] as const;
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
        stale: 10_000,
        update: 2_000,
      });
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ELOCKED' ||
        attempt >= RETRY_DELAYS_MS.length
      ) {
        throw error;
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
