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
import {
  BACKGROUND_FLAG,
  BACKGROUND_FLAG_ATTACHED_PREFIX,
  BACKGROUND_FLAG_OFF_WORD,
  BACKGROUND_FLAG_ON_WORD,
} from './entry-flags.js';

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
 * `--bg` is a boolean and takes its prompt where the default command takes
 * it — as the trailing positional query — so `qwen --bg "audit the
 * release"` reads like the interactive form. Tokens after `--` are the
 * user's own data: they are never scanned for flags, but they are
 * collected as prompt words, matching yargs' positional-after-`--`
 * semantics. That collection is how a prompt that starts with `-` is
 * spelled (`qwen --bg -- -repro`).
 *
 * Any other flag before `--` declines, named: `--bg` forwards nothing to
 * the session (the worker argv carries only the session id and the
 * prompt), so silently dropping the flag would run the session without the
 * behavior it asks for — and a hand-rolled scan of which flags take values
 * misreads the value slots of the ones it cannot model as prompt words. A
 * flag added later cannot silently start leaking into prompts.
 *
 * Only the bare token launches. An attached `--bg=<value>` is left to the
 * parser, because `bg` is declared `type: 'boolean'` and yargs reads every
 * attached spelling as a boolean rather than as a prompt: `--bg=false`,
 * `--bg=` and `--bg=false\r` are all OFF, and so is `--bg=audit` — which
 * the parser then runs as an ordinary positional launch. Reading attached
 * values here instead is what made the two spellings of one wrapper
 * variable disagree, and what let a padded or empty OFF value dispatch a
 * real agent and certify it with exit 0.
 */
export function readBackgroundPrompt(
  rawArgv: readonly string[],
): BackgroundPromptRead | undefined {
  const separator = rawArgv.indexOf('--');
  const argv = separator === -1 ? rawArgv : rawArgv.slice(0, separator);
  if (
    !argv.includes(BACKGROUND_FLAG) ||
    argv.some((token) => token.startsWith(BACKGROUND_FLAG_ATTACHED_PREFIX))
  ) {
    return undefined;
  }

  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === BACKGROUND_FLAG) {
      // yargs-parser consumes exactly `false`/`true` as a boolean flag's
      // space-separated value, and the intercept runs before the parser,
      // so it has to consume them the same way. `false` switches the
      // launch off and the whole argv belongs to the parser; `true` means
      // the bare flag and contributes no prompt word. Any other word —
      // `FALSE`, `0`, `off` included, exactly as yargs treats them — stays
      // prompt data.
      const value = argv[i + 1];
      if (value === BACKGROUND_FLAG_OFF_WORD) {
        return undefined;
      }
      if (value === BACKGROUND_FLAG_ON_WORD) {
        i++;
      }
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
 * stale socket, a read-only home — and the user needs the reason. A
 * dispatch that may already have a session running returns a distinct
 * exit code (2) with an in-flight sentence instead of a failure, so a
 * wrapper keyed on the exit code does not retry it: a client-side
 * timeout, and any rejection the store shows arrived after the session
 * was recorded.
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

  let reachedDispatch = false;
  let sessionId: string;
  try {
    // Route through the supervisor's dispatch RPC: it is the one path that
    // records the session AND spawns its worker — it writes the store with
    // the supervisor's sideband endpoint, launches the pty host, and
    // answers with the session id. Writing the store directly
    // (dispatchAgentViewSession) would record a session nothing ever
    // starts. The returned session id is the output contract.
    const supervisor = await ensureAgentViewSupervisor();
    reachedDispatch = true;
    ({ sessionId } = (await supervisor.dispatch(prompt, cwd)) as {
      sessionId: string;
    });
  } catch (error) {
    const reason = getErrorMessage(error);
    // A client-side timeout is the one rejection that is itself evidence
    // the launch may still be in flight: the dispatch RPC runs under a
    // client cap (LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS) while the
    // supervisor's handler keeps recording and launching, so a store I/O
    // stall can push the client past a cap the server is still inside.
    // Calling that a failure has a wrapping script — the consumer this
    // entry is built for — retry and start a second agent on the same
    // prompt, so it returns the exit code a wrapper reads as "do not
    // retry". reachedDispatch scopes it to the RPC: a supervisor that never
    // came up recorded nothing, and pre-record rejections inside the
    // handler (an oversize or empty prompt) leave the store empty too, so
    // both stay exit 1.
    //
    // Every other rejection reports failure, including a supervisor killed
    // mid-dispatch (`code: 'closed'`). This used to widen to that case by
    // scanning the store for a managed row recorded since the dispatch
    // began, but the store cannot say which launch a row belongs to: the
    // failure envelope carries only a code and a message, so the client
    // holds no session id to match, and ownership + projectCwd + createdAt
    // are equally satisfied by a concurrent launch in the same directory.
    // Two rounds of adding conjuncts narrowed that without closing it, and
    // the false positive is the worse error — it certified a definitively
    // failed launch as "may still be starting", the wrapper honored
    // do-not-retry, and the task was silently never run, where a retry that
    // starts a second agent is at least visible in `qwen sessions ps`.
    // Carrying the session id on the failure envelope would restore the
    // certification as evidence rather than a guess; that is a wire change,
    // not a closeout fix.
    if (
      reachedDispatch &&
      (error as { code?: string } | undefined)?.code === 'timeout'
    ) {
      writeStderrLine(
        `The background session may still be starting: ${reason}. Check: qwen sessions ps`,
      );
      return 2;
    }
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
