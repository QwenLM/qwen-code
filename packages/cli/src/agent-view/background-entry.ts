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

import {
  DEFAULT_COMMAND_OPTIONS,
  TOP_LEVEL_GLOBAL_OPTIONS,
} from '../config/top-level-options.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';
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
 * Flags that consume the token after them, derived from the CLI's own
 * option tables rather than listed here.
 *
 * A hand-written list is the wrong shape for this: the cost of missing
 * one is that a flag's value is read as part of the prompt, and the list
 * would go stale the first time someone adds an option. `type` in those
 * tables already says which flags take a value.
 */
function valueTakingFlags(): ReadonlySet<string> {
  const flags = new Set<string>();
  const entries = [
    ...Object.entries(TOP_LEVEL_GLOBAL_OPTIONS),
    ...Object.entries(DEFAULT_COMMAND_OPTIONS),
  ] as ReadonlyArray<
    readonly [string, { type?: string; alias?: string | readonly string[] }]
  >;
  for (const [name, option] of entries) {
    if (option.type === 'boolean' || option.type === 'count') continue;
    flags.add(name.length === 1 ? `-${name}` : `--${name}`);
    const aliases =
      option.alias === undefined
        ? []
        : Array.isArray(option.alias)
          ? option.alias
          : [option.alias as string];
    for (const alias of aliases) {
      flags.add(alias.length === 1 ? `-${alias}` : `--${alias}`);
    }
  }
  return flags;
}

/**
 * The prompt of a `--bg` launch, or undefined when this is not one.
 *
 * `--bg` is a boolean and takes its prompt where the default command
 * takes it — as the trailing positional query — so `qwen --bg "audit the
 * release"` reads like the interactive form. Everything after `--` is the
 * user's own data and is never scanned.
 *
 * Returns an empty string for `--bg` with nothing to run, which the
 * caller reports rather than dispatching.
 */
export function readBackgroundPrompt(
  rawArgv: readonly string[],
): string | undefined {
  const separator = rawArgv.indexOf('--');
  const argv = separator === -1 ? rawArgv : rawArgv.slice(0, separator);
  if (!argv.includes(BACKGROUND_FLAG)) return undefined;

  const takesValue = valueTakingFlags();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // An attached value (`--model=x`) is one token and consumes nothing
    // after it; a detached one (`--model x`) consumes the next token.
    if (token.startsWith('-')) {
      if (takesValue.has(token)) index += 1;
      continue;
    }
    words.push(token);
  }
  return words.join(' ').trim();
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
    process.stderr.write(
      'qwen --bg needs a prompt: qwen --bg "review the failing release"\n',
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
    process.stderr.write(`Could not start a background session: ${reason}\n`);
    return 1;
  }
}
