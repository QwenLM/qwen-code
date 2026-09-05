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
    report(
      await answerManagedSession(
        argv.session,
        (argv.text ?? []).join(' '),
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
