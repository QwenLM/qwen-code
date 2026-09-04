/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two entry points that make an Agent View session actually start.
 *
 * Everything below the entry already ships: `ensureAgentViewSupervisor`
 * starts or finds the supervisor, and the supervisor's `dispatch` RPC is
 * the one path that records a session AND spawns its worker — every spawn
 * site lives inside the supervisor's RPC handlers, so writing the store
 * directly would record a session nothing ever starts. What was missing
 * is the pair of wires at the CLI entry:
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

import { getErrorMessage } from '../utils/errors.js';
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
 * user's own data: they are never scanned for flags — a `--bg` passed as
 * a prompt word declines — but they are collected as prompt words,
 * matching yargs' positional-after-`--` semantics. That collection is the
 * only way to express a prompt that starts with `-`.
 *
 * Any other flag before `--` declines too, named: `--bg` forwards nothing
 * to the session (the worker argv carries only the session id and the
 * prompt), so silently dropping the flag would run the session without
 * the behavior it asks for — and a hand-rolled scan of which flags take
 * values misreads the value slots of the ones it cannot model as prompt
 * words. A flag added later cannot silently start leaking into prompts.
 *
 * The attached `--bg=<prompt>` spelling reads like the CLI's other prompt
 * flags (`--prompt=<value>`); its value travels inside the token and is
 * prompt data even when it starts with a dash.
 */
export function readBackgroundPrompt(
  rawArgv: readonly string[],
): BackgroundPromptRead | undefined {
  const separator = rawArgv.indexOf('--');
  const argv = separator === -1 ? rawArgv : rawArgv.slice(0, separator);
  if (
    !argv.some(
      (token) =>
        token === BACKGROUND_FLAG || token.startsWith(`${BACKGROUND_FLAG}=`),
    )
  ) {
    return undefined;
  }

  const words: string[] = [];
  for (const token of argv) {
    if (token === BACKGROUND_FLAG) continue;
    if (token.startsWith(`${BACKGROUND_FLAG}=`)) {
      words.push(token.slice(BACKGROUND_FLAG.length + 1));
      continue;
    }
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      return { unsupportedFlag: eq === -1 ? token : token.slice(0, eq) };
    }
    words.push(token);
  }
  // Data after `--`: collected verbatim, dash-led tokens included, so a
  // prompt like `-repro` has a spelling.
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

  // The dispatch RPC can block for seconds while the worker starts; a
  // reader that leaves during that window (`qwen --bg "..." | true`, a
  // CI step closing the pipe) sends EPIPE back once the success writes
  // below arrive — after the session is already running. The async
  // 'error' event would crash the process and the sync throw would land
  // in the launch-failure catch; both would flip a successful launch
  // into exit 1 and have a wrapping script start a second agent on the
  // same prompt.
  ignoreBrokenPipe();

  const { ensureAgentViewSupervisor } = await import('./supervisor-runner.js');

  let sessionId: string;
  try {
    // Route through the supervisor's dispatch RPC: it is the one path that
    // records the session AND spawns its worker — it writes the store with
    // the supervisor's sideband endpoint, launches the pty host, waits for
    // the worker to come up, and answers with the session id. Writing the
    // store directly (dispatchAgentViewSession) would record a session
    // nothing ever starts. The ready-wait means this can block while the
    // worker starts; the returned session id is the output contract.
    const supervisor = await ensureAgentViewSupervisor();
    ({ sessionId } = (await supervisor.dispatch(prompt, cwd)) as {
      sessionId: string;
    });
  } catch (error) {
    const reason = getErrorMessage(error);
    writeStderrLine(`Could not start a background session: ${reason}`);
    return 1;
  }

  // Success writes live OUTSIDE the launch try, and cannot throw: once
  // the session is recorded and spawned, a gone reader is not a launch
  // failure, and reporting one would certify the opposite of what
  // happened.
  writeStdoutLineSafe(`Started background session ${sessionId}`);
  writeStdoutLineSafe('See it with: qwen sessions ps');
  return 0;
}
