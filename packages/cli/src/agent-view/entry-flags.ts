/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The argv tokens the CLI entry has to recognize before it parses
 * anything.
 *
 * Their own module because the entry decides on every launch, and every
 * decision must cost nothing when the answer is no: importing the
 * supervisor runtime, the pty-host runtime, or the dispatch path to read
 * one string would put them on the startup path of every `qwen`
 * invocation.
 */

import { TOP_LEVEL_HELP_OPTIONS } from '../config/top-level-options.js';

export const INTERNAL_AGENT_VIEW_SUPERVISOR_ARG =
  '--internal-agent-view-supervisor';

/**
 * The flag that names a process the supervisor spawned to BE a session's
 * PTY host. Internal exactly like the supervisor flag: the strict parser
 * rejects it, so the entry must intercept it before parsing.
 */
export const INTERNAL_AGENT_VIEW_PTY_HOST_ARG =
  '--internal-agent-view-pty-host';

/** The flag that asks for a background session. */
export const BACKGROUND_FLAG = '--bg';

/** The prefix of an attached `--bg=<value>` token. */
export const BACKGROUND_FLAG_ATTACHED_PREFIX = `${BACKGROUND_FLAG}=`;

/**
 * The two words yargs-parser consumes as a space-separated boolean flag's
 * value.
 *
 * Measured against this repo's installed yargs-parser (21.1.1, `bg`
 * declared boolean): `--bg false` parses as `bg: false` with NO positional
 * and `--bg true` as `bg: true` with none, while `--bg FALSE`, `--bg 0`,
 * `--bg off` and `--bg no` all leave `bg: true` and put the word in `_`.
 * Exactly these two lowercase literals are the flag's value.
 *
 * The reader has to agree with that because `--bg` is intercepted before
 * the parser runs. Reading every non-dash word as prompt data meant the
 * unquoted-variable wrapper form `qwen --bg $ENABLED "$TASK"` with
 * ENABLED=false dispatched a real agent on the prompt `false …` and
 * certified it with exit 0 — burning quota on a task the operator had
 * switched off, where the parser itself would have started no session.
 */
export const BACKGROUND_FLAG_OFF_WORD = 'false';
export const BACKGROUND_FLAG_ON_WORD = 'true';

/**
 * The flags the pre-parse scans treat as consuming the next token as their
 * value. Lives here because every pre-parse consumer — cli.ts's version and
 * bootstrap scans, the `sessions answer` chain recognizer below — must agree
 * on the set, and this module is the leaf each of them already imports.
 *
 * Deliberately the base's hardcoded set rather than the derived VALUE_FLAGS:
 * the version scan counts a token sitting in the value slot of a flag the
 * derived set adds (`qwen --proxy -v …` printed the version on base), so the
 * pre-parse grammar stays with exactly these spellings.
 */
export const BASE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--model',
  '-m',
  '--fallback-model',
  '--prompt',
  '-p',
  '--prompt-interactive',
  '-i',
  '--output-format',
  '-o',
  '--resume',
  '-r',
]);

function flagName(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

/**
 * The full value-taking top-level flag surface, derived from the shared
 * option table plus the hidden options config.ts registers inline. The
 * `sessions answer` chain recognizer skips THESE value slots: a value left
 * standing would read as a positional and either hide the chain
 * (`sessions --proxy <url> answer …`) or be mistaken for it. The version
 * scan deliberately does NOT use this set (see BASE_VALUE_FLAGS above).
 */
export const ROOT_VALUE_FLAGS: ReadonlySet<string> = (() => {
  const flags = new Set<string>();
  for (const [option, config] of TOP_LEVEL_HELP_OPTIONS) {
    if (
      config.type === 'string' ||
      config.type === 'number' ||
      config.type === 'array'
    ) {
      flags.add(flagName(option));
      const alias = config.alias;
      if (typeof alias === 'string') {
        flags.add(flagName(alias));
      } else if (alias) {
        for (const a of alias) flags.add(flagName(a));
      }
    }
  }
  flags.add('--sandbox-session-id');
  return flags;
})();

/**
 * Where a `sessions answer` chain sits in a raw argv.
 *
 * Indices rather than substrings because the consumers splice (`--`
 * insertion) or compare positions (the version intercept) against the same
 * argv.
 */
export interface SessionsAnswerChain {
  /** Index of the `sessions` token. */
  readonly sessionsAt: number;
  /** Index of the `answer` token. */
  readonly answerAt: number;
  /**
   * Index of the session-id token — the first positional after `answer` —
   * or -1 when it is absent (`sessions answer --help` falls through to
   * yargs, which shows the command's help).
   */
  readonly sessionAt: number;
}

/**
 * Recognize the `sessions answer` command chain by where it sits in the
 * parse, not by an adjacent token pair: `sessions` must be the first
 * positional (leading root globals and their value slots skipped), `answer`
 * the next positional, and the session id the positional after that, with
 * flag tokens between the chain words skipped the same way.
 *
 * The anchoring is what keeps the three pre-parse consumers honest: a prompt
 * or another command never has `sessions` as its first positional
 * (`qwen why does sessions answer refuse …`, `qwen mcp remove sessions
 * answer -v help`), so they are not rewritten, and tokens between the chain
 * words (`sessions --proxy <url> answer <id> …`, `sessions answer --debug
 * <id> …`) no longer shift the session id or the answer text off their
 * slots. Everything after `--` is verbatim data and ends the scan.
 */
export function findSessionsAnswerChain(
  argv: readonly string[],
  valueFlags: ReadonlySet<string> = ROOT_VALUE_FLAGS,
): SessionsAnswerChain | undefined {
  let sessionsAt = -1;
  let answerAt = -1;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      break;
    }
    if (token.startsWith('-')) {
      // Between `answer` and the session id a help/version token is the
      // user asking for help (or a version print), not a root global to
      // skip: bail so yargs shows it instead of the answer path
      // swallowing it into a delivery.
      if (
        answerAt !== -1 &&
        (token === '--help' ||
          token === '-h' ||
          token === '--version' ||
          token === '-v')
      ) {
        return undefined;
      }
      if (valueFlags.has(token)) {
        i++; // skip the value slot; the loop increment consumes the flag
      }
      continue;
    }
    if (sessionsAt === -1) {
      if (token !== 'sessions') return undefined;
      sessionsAt = i;
      continue;
    }
    if (answerAt === -1) {
      if (token !== 'answer') return undefined;
      answerAt = i;
      continue;
    }
    return { sessionsAt, answerAt, sessionAt: i };
  }
  if (sessionsAt === -1 || answerAt === -1) {
    return undefined;
  }
  return { sessionsAt, answerAt, sessionAt: -1 };
}
