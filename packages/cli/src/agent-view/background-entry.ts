/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two entry points that make an Agent View session actually start.
 *
 * Everything below the entry already ships: `ensureAgentViewSupervisor`
 * starts or finds the supervisor, `dispatchAgentViewSession` records a
 * session for it to spawn, and the supervisor owns the worker from there.
 * What was missing is the pair of wires at the CLI entry:
 *
 * - the supervisor spawns itself as
 *   `qwen --internal-agent-view-supervisor`, and nothing parsed that
 *   flag. The CLI's parser runs `.strict()`, so the spawned "supervisor"
 *   exited on an unknown argument instead of serving, which made every
 *   dispatch path unreachable end to end.
 * - `--bg` did not exist, so nothing ever asked for a session.
 *
 * Both are handled before the argv parser rather than through it. The
 * supervisor flag is internal and must not reach a parser that rejects
 * it. `--bg` needs only a prompt and a directory, so routing it through
 * the interactive startup path — auth, theme, extensions — would buy
 * nothing and cost all of it.
 */

import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
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
 * release"` reads like the interactive form. Everything after `--` is the
 * user's own data and is never scanned, so a `--bg` passed as a prompt
 * word declines.
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
  const argv = separator === -1 ? rawArgv : rawArgv.slice(0, separator);
  if (!argv.includes(BACKGROUND_FLAG)) return undefined;

  const words: string[] = [];
  for (const token of argv) {
    if (token === BACKGROUND_FLAG) continue;
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      return { unsupportedFlag: eq === -1 ? token : token.slice(0, eq) };
    }
    words.push(token);
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

  const [{ ensureAgentViewSupervisor }, { dispatchAgentViewSession }] =
    await Promise.all([
      import('./supervisor-runner.js'),
      import('./supervisor-dispatch.js'),
    ]);

  try {
    // The supervisor is what spawns and then owns the worker. Dispatching
    // without one would record a session nothing ever starts.
    await ensureAgentViewSupervisor();
    const { sessionId } = await dispatchAgentViewSession(prompt, cwd);
    writeStdoutLine(`Started background session ${sessionId}`);
    writeStdoutLine('See it with: qwen sessions ps');
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeStderrLine(`Could not start a background session: ${reason}`);
    return 1;
  }
}
