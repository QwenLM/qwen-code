/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The entry points that make an Agent View session actually start.
 *
 * Everything below the entry already ships: `ensureAgentViewSupervisor`
 * starts or finds the supervisor, its `dispatch` operation records a
 * session and launches the PTY host that owns the worker, and the
 * supervisor owns the worker from there. What was missing is the set of
 * wires at the CLI entry:
 *
 * - the supervisor spawns itself as
 *   `qwen --internal-agent-view-supervisor`, and nothing parsed that
 *   flag. The CLI's parser runs `.strict()`, so the spawned "supervisor"
 *   exited on an unknown argument instead of serving, which made every
 *   dispatch path unreachable end to end.
 * - the supervisor spawns each session's PTY host as
 *   `qwen --internal-agent-view-pty-host <launch record> <socket>`, and
 *   nothing parsed that flag either, so the host a dispatch launched died
 *   in the same strict parser.
 * - `--bg` did not exist, so nothing ever asked for a session.
 *
 * All three are handled before the argv parser rather than through it.
 * The two internal flags must not reach a parser that rejects them.
 * `--bg` needs only a prompt and a directory, so routing it through the
 * interactive startup path — auth, theme, extensions — would buy nothing
 * and cost all of it.
 */

import {
  ignoreBrokenPipe,
  writeStderrLine,
  writeStdoutLineSafe,
} from '../utils/stdioHelpers.js';
import { BACKGROUND_FLAG } from './entry-flags.js';

/**
 * Serve as the Agent View supervisor for the rest of this process's life.
 *
 * The caller has already recognized the flag; this is only the part that
 * needs the supervisor runtime loaded.
 */
export async function runAsAgentViewSupervisor(): Promise<void> {
  const { runAgentViewSupervisor } = await import('./supervisor-runner.js');
  await runAgentViewSupervisor();
}

/**
 * Serve as one session's PTY host for the rest of this process's life.
 *
 * The caller has already recognized the flag and read its two operands;
 * the host's auth token and id travel in the environment the supervisor
 * spawned this process with, which the runner reads itself.
 */
export async function runAsAgentViewPtyHost(
  launchPath: string,
  socketPath: string,
): Promise<void> {
  const { runAgentViewPtyHostProcess } = await import('./pty-host-process.js');
  await runAgentViewPtyHostProcess({ launchPath, socketPath });
}

/**
 * What a raw argv says about a background launch.
 *
 * - `undefined` — no `--bg` before `--`: not a background launch; the
 *   entry falls through to the normal startup path.
 * - `{ prompt }` — the prompt to dispatch; possibly empty, which the
 *   dispatch reports rather than guessing.
 * - `{ unsupportedFlag }` — a background launch carrying some other flag.
 */
export type BackgroundPromptRead =
  | { prompt: string }
  | { unsupportedFlag: string };

/**
 * The background launch a raw argv asks for, or undefined when it is not
 * one.
 *
 * `--bg` is a boolean and takes its prompt where the default command
 * takes it — as the trailing positional query — so `qwen --bg "audit the
 * release"` reads like the interactive form. Tokens after `--` are the
 * user's own data: never scanned for flags, and collected as prompt, so
 * an operand survives (`--bg run vitest -- src/a.test.ts`) and a prompt
 * whose first word starts with a dash has a spelling (`--bg -- -O2 fix`).
 *
 * Any other flag declines too, named: `--bg` forwards nothing to the
 * session (the worker argv carries only the session id and the prompt),
 * so silently dropping the flag would run the session without the
 * behavior it asks for — and a hand-rolled scan of which flags take
 * values misreads the value slots of the ones it cannot model as prompt
 * words. A flag added later cannot silently start leaking into prompts.
 */
export function readBackgroundPrompt(
  rawArgv: readonly string[],
): BackgroundPromptRead | undefined {
  const separator = rawArgv.indexOf('--');
  const flags = separator === -1 ? rawArgv : rawArgv.slice(0, separator);
  if (!flags.includes(BACKGROUND_FLAG)) return undefined;

  const words: string[] = [];
  for (const token of flags) {
    if (token === BACKGROUND_FLAG) continue;
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      return { unsupportedFlag: eq === -1 ? token : token.slice(0, eq) };
    }
    words.push(token);
  }
  if (separator !== -1) {
    words.push(...rawArgv.slice(separator + 1));
  }
  return { prompt: words.join(' ').trim() };
}

/**
 * Start a background Agent View session and report its id.
 *
 * Returns a process exit code. A failure is reported as a sentence, not
 * a stack: the supervisor can be unstartable for ordinary reasons — a
 * stale socket, a read-only home — and the user needs the reason.
 */
export async function runBackgroundDispatch(
  prompt: string,
  cwd: string = process.cwd(),
): Promise<number> {
  if (!prompt) {
    writeStderrLine(
      'qwen --bg needs a prompt: qwen --bg "review the failing release"',
    );
    return 1;
  }

  // By the time anything is printed the session is durably recorded and
  // its worker launched, so a reader that has gone away (`qwen --bg … |
  // head -1`) must not turn a completed launch into a crash-class exit.
  ignoreBrokenPipe();

  const { ensureAgentViewSupervisor } = await import('./supervisor-runner.js');

  let sessionId: string;
  try {
    // The supervisor's own dispatch is the only path that both records
    // the session and launches the PTY host that runs it. Writing the
    // store directly would record a session nothing ever starts, while
    // reporting it as started.
    const supervisor = await ensureAgentViewSupervisor();
    sessionId = readDispatchedSessionId(await supervisor.dispatch(prompt, cwd));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeStderrLine(`Could not start a background session: ${reason}`);
    return 1;
  }

  writeStdoutLineSafe(`Started background session ${sessionId}`);
  writeStdoutLineSafe('See it with: qwen sessions ps');
  return 0;
}

/**
 * The session id a supervisor dispatch reported.
 *
 * The handle types every operation's result as `unknown`, so the shape is
 * checked here rather than asserted: a supervisor from another build
 * answering without an id is a failure to report, not an id to invent.
 */
function readDispatchedSessionId(result: unknown): string {
  const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('The supervisor did not report a session id.');
  }
  return sessionId;
}
