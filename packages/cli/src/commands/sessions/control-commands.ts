/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen sessions peek|answer|stop` — the three things a background
 * session needs before `qwen sessions ps` reporting "needs input" means
 * anything.
 *
 * The argv shape is most of what is here; the decisions live in
 * `managed-control.ts`. The one thing this file decides on its own is
 * which stream a result goes to.
 */

import type { Argv, CommandModule } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  answerManagedSession,
  peekManagedSession,
  stopManagedSession,
  type ConnectSupervisor,
  type ManagedControlResult,
} from './managed-control.js';

interface SessionIdArgs {
  session: string;
}

interface AnswerArgs extends SessionIdArgs {
  text?: string[];
}

/**
 * Connect to a running supervisor, or report that there is none.
 *
 * Deliberately `connectExisting` rather than `ensure`: these commands ask
 * about sessions, and starting a supervisor to answer would spawn a
 * process only to be told nothing is running.
 */
const connectSupervisor: ConnectSupervisor = async () => {
  const { connectExistingAgentViewSupervisor } = await import(
    '../../agent-view/supervisor-runner.js'
  );
  return connectExistingAgentViewSupervisor();
};

/**
 * Print a result, and set the exit code if it failed.
 *
 * Failure lines go to stderr, the way `list`, `ps` and `--bg` report
 * errors; success lines stay on stdout, so redirecting the command's
 * output never captures an error message alongside the result.
 */
function report(result: ManagedControlResult): void {
  const write = result.exitCode !== 0 ? writeStderrLine : writeStdoutLine;
  for (const line of result.lines) write(line);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

function sessionPositional(yargs: Argv): Argv {
  return yargs.positional('session', {
    type: 'string',
    describe: 'Session id, or a unique prefix of one',
    demandOption: true,
  });
}

/** The yargs option table fields that decide whether a token is known. */
interface ParsableOptionsTable {
  key: Record<string, unknown>;
  [group: string]: unknown;
}

/**
 * Forget the options registered higher up the chain (the root `--debug`,
 * `--proxy`, `--telemetry*`, `--version`, ... globals in config.ts) so
 * they cannot be parsed out of an answer.
 *
 * They stay known inside this command's parse, and `unknown-options-as-args`
 * only protects unknown options, so a quoted flag (`answer <id> rerun with
 * --debug`) would set the flag and vanish from the text while the CLI
 * reports success. An answer is free text: drop every inherited option from
 * the parse table so quoted tokens become unknown again and stay in the
 * text. Only `--help` stays known, the way the docs promise.
 */
function forgetInheritedOptions(built: Argv): Argv {
  // getOptions() exists at runtime but is missing from @types/yargs;
  // sessions.test.ts reaches it the same way.
  const table = (
    built as unknown as { getOptions(): ParsableOptionsTable }
  ).getOptions();
  const keep = new Set(['help', 'h']);
  // Derive the inherited set from every group, not just `table.key`:
  // `.version(false)` up the chain deletes `version` from the key/type
  // groups but leaves the alias entry `v: ['version']` behind, which is
  // enough for yargs-parser to keep `-v`/`--version` known.
  const candidates = new Set<string>();
  for (const group of Object.values(table)) {
    if (Array.isArray(group)) {
      for (const key of group as unknown[]) {
        if (typeof key === 'string') candidates.add(key);
      }
    } else if (group !== null && typeof group === 'object') {
      for (const key of Object.keys(group)) candidates.add(key);
    }
  }
  const inherited = [...candidates].filter((key) => !keep.has(key));
  for (const group of Object.values(table)) {
    if (Array.isArray(group)) {
      const keys = group as string[];
      for (const key of inherited) {
        let index = keys.indexOf(key);
        while (index !== -1) {
          keys.splice(index, 1);
          index = keys.indexOf(key);
        }
      }
    } else if (group !== null && typeof group === 'object') {
      const map = group as Record<string, unknown>;
      for (const key of inherited) delete map[key];
    }
  }
  return built;
}

/**
 * Cut `<session> <text...>` back out of the args this process was invoked
 * with, anchored on the command tokens yargs matched (`argv._`).
 *
 * yargs cannot hand the answer over intact, and both ways it loses one are
 * silent — the command still prints `Answer delivered.`:
 *
 * - `--help` has to stay a known boolean for a bare `--help` to work, and
 *   yargs-parser counts every `--no-<known flag>` as a negated boolean
 *   rather than an unknown option, so `answer <id> please --no-help me`
 *   delivers "please me". Turning `boolean-negation` off only trades that
 *   silent edit for a strict-mode `Unknown arguments: no-help, noHelp`.
 * - The variadic positional is re-parsed as argv by yargs'
 *   `postProcessPositionals`, where a quoted `--session=zzz` re-binds the
 *   session id (into an array) and a quoted `--text` swallows its own
 *   token.
 *
 * Reading the session id here instead of taking `argv.session` also keeps
 * it the string the supervisor's `requireSessionId` asks for: yargs coerces
 * an all-digit positional to a number.
 *
 * Returns `undefined` when the raw args do not line up with this parse — a
 * handler called programmatically, say — so the caller falls back to what
 * yargs produced.
 */
function rawAnswerTail(argv: {
  _?: unknown[];
}): { session: string; text: string } | undefined {
  const commands = (argv._ ?? []).map(String);
  // `argv._` is the matched command chain, so an empty one means this argv
  // did not come out of a parse and there is nothing to anchor on.
  if (commands.length === 0) return undefined;
  // `config.ts` builds its yargs tree from `hideBin(process.argv)`, so this
  // is the argv the parse came from — including the entry-point token
  // config.ts sometimes strips off the front, which anchoring on a run of
  // command tokens instead of a fixed offset makes harmless.
  const raw = hideBin(process.argv);
  const at = findRun(raw, commands);
  if (at === -1) return undefined;
  const session = raw[at + commands.length];
  if (typeof session !== 'string') return undefined;
  const tail = raw.slice(at + commands.length + 1);
  // `--` marks the verbatim tail the positional's describe promises; the
  // separator itself is not part of the answer.
  const separator = tail.indexOf('--');
  if (separator !== -1) tail.splice(separator, 1);
  return { session, text: tail.join(' ') };
}

/** Index of the first adjacent run of `needle` in `haystack`, or -1. */
function findRun(haystack: string[], needle: string[]): number {
  for (let at = 0; at + needle.length <= haystack.length; at++) {
    if (needle.every((token, offset) => haystack[at + offset] === token)) {
      return at;
    }
  }
  return -1;
}

export const peekCommand: CommandModule<unknown, SessionIdArgs> = {
  command: 'peek <session>',
  describe: 'Show what a background session is doing or waiting for',
  builder: (yargs: Argv) => sessionPositional(yargs) as Argv<SessionIdArgs>,
  handler: async (argv) => {
    report(await peekManagedSession(argv.session, connectSupervisor));
  },
};

export const answerCommand: CommandModule<unknown, AnswerArgs> = {
  // A variadic tail, not a single positional: with one, yargs parses a
  // dash-leading answer (`answer 0f8e1c42 --force`) as options and
  // refuses the command, and even `--` does not separate it.
  command: 'answer <session> [text..]',
  describe: 'Answer a background session that is waiting for input',
  builder: (yargs: Argv) =>
    forgetInheritedOptions(sessionPositional(yargs))
      .parserConfiguration({
        // An answer is free text: it may quote a flag or paste a command
        // snippet. Parse unknown options as the text and take what
        // follows `--` verbatim, the way `mcp add` takes server args;
        // forgetInheritedOptions keeps the root globals from being
        // parsed out of the text instead.
        'unknown-options-as-args': true,
        'populate--': true,
      })
      .positional('text', {
        type: 'string',
        describe:
          'What to tell it; tokens after `--` are taken as-is, but a bare --help still shows this help',
      })
      .middleware((argv) => {
        // Fold the verbatim tail (`answer <id> -- --force`) into the
        // answer text, the way `mcp add` folds `--` into server args.
        const args = argv as unknown as {
          text?: string | string[];
          '--'?: string[];
        };
        const verbatim = args['--'];
        if (verbatim && verbatim.length > 0) {
          const existing = Array.isArray(args.text)
            ? args.text
            : args.text
              ? [args.text]
              : [];
          args.text = [...existing, ...verbatim.map(String)];
        }
      }) as Argv<AnswerArgs>,
  handler: async (argv) => {
    // The raw tail wins over what yargs parsed: see rawAnswerTail for the
    // two ways yargs silently edits an answer.
    const raw = rawAnswerTail(argv);
    report(
      await answerManagedSession(
        raw?.session ?? argv.session,
        raw?.text ?? (argv.text ?? []).join(' '),
        connectSupervisor,
      ),
    );
  },
};

export const stopCommand: CommandModule<unknown, SessionIdArgs> = {
  command: 'stop <session>',
  describe: 'Stop a background session',
  builder: (yargs: Argv) => sessionPositional(yargs) as Argv<SessionIdArgs>,
  handler: async (argv) => {
    report(await stopManagedSession(argv.session, connectSupervisor));
  },
};
