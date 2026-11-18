/**
 * Async a1 CLI transport for the Aone channel. Re-implements the transport
 * shape of packages/cli/src/serve/server/aone-mrs.ts locally: channel
 * packages cannot import from packages/cli, and the review subsystem's
 * aone-client.ts is execFileSync with blocking retries — unacceptable on
 * a polling channel's event loop.
 *
 * Error contract (probed 2026-11-16): a1 answers some errors with an
 * `a1.error/v1` object at exit 0 and others at exit 1 with the same object
 * on stdout — the parsed shape, not the exit code, is the error signal.
 * Reads ride the poll loop's own backoff; writes are never retried here
 * (a retried write could double-post a comment).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const A1_TIMEOUT_MS = 20_000;
export const A1_MAX_BUFFER = 16 * 1024 * 1024;
const A1_ERROR_MESSAGE_MAX = 512;

/**
 * Test seam for the exec layer: the a1 spawn, resolved to stdout. Errors
 * keep the exec shape (code/stdout/stderr/killed) the contract keys on.
 */
export type A1Exec = (
  args: readonly string[],
  options: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string }>;

const defaultA1Exec: A1Exec = async (args, options) => {
  const { stdout } = await execFileAsync('a1', [...args], {
    ...options,
    encoding: 'utf8',
    windowsHide: true,
    // No env override: a1 authenticates through its own `a1 auth login`
    // config; there is no A1_* token convention.
  });
  return { stdout };
};

let a1Exec: A1Exec = defaultA1Exec;

/** Test seam: swaps the a1 spawn (pass nothing to restore the default). */
export function setA1ExecForTest(exec?: A1Exec): void {
  a1Exec = exec ?? defaultA1Exec;
}

export class AoneCliUnavailableError extends Error {}
export class AoneCommandError extends Error {}

function isA1ErrorObject(
  value: unknown,
): value is { schemaVersion: string; message?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['schemaVersion'] === 'a1.error/v1'
  );
}

function a1ErrorMessage(error: unknown): string {
  if ((error as { killed?: unknown } | null)?.killed === true) {
    return `a1 timed out after ${A1_TIMEOUT_MS / 1000}s`;
  }
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, A1_ERROR_MESSAGE_MAX);
}

/** Run `a1 … --format json` and return the parsed body. */
export async function runA1Json<T>(args: readonly string[]): Promise<T> {
  let stdout: string;
  try {
    // --no-update-check: a days-long poller must not pick up an update
    // banner mid-run (a1's documented automation switch); it also skips
    // the update-check network I/O on every call.
    ({ stdout } = await a1Exec(
      [...args, '--no-update-check', '--format', 'json'],
      {
        timeout: A1_TIMEOUT_MS,
        maxBuffer: A1_MAX_BUFFER,
      },
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AoneCliUnavailableError(
        'a1 CLI not installed or not on PATH; install it and run `a1 auth login` on the channel host.',
      );
    }
    // Exit-1 errors carry the structured cause on stdout.
    const errorStdout = (error as { stdout?: unknown } | null)?.stdout;
    if (typeof errorStdout === 'string' && errorStdout.trim()) {
      try {
        const parsed: unknown = JSON.parse(errorStdout);
        if (isA1ErrorObject(parsed)) {
          throw new AoneCommandError(parsed.message || 'a1 command failed');
        }
      } catch (parseError) {
        if (parseError instanceof AoneCommandError) throw parseError;
      }
    }
    throw new AoneCommandError(a1ErrorMessage(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AoneCommandError('a1 returned non-JSON output');
  }
  if (isA1ErrorObject(parsed)) {
    throw new AoneCommandError(parsed.message || 'a1 command failed');
  }
  return parsed as T;
}

/**
 * The authenticated a1 account — the bot identity. A missing or unreadable
 * account THROWS: an empty identity would disable the self-comment filter
 * and let the bot answer its own replies in a loop.
 */
export async function aoneWhoamiAccount(): Promise<string> {
  const out = await runA1Json<{ account?: unknown } | null>(['auth', 'whoami']);
  if (
    out === null ||
    typeof out.account !== 'string' ||
    out.account.trim() === ''
  ) {
    throw new AoneCommandError('a1 auth whoami returned no account');
  }
  return out.account.trim();
}
