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
  text: string;
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

export const peekCommand: CommandModule<unknown, SessionIdArgs> = {
  command: 'peek <session>',
  describe: 'Show what a background session is doing or waiting for',
  builder: (yargs: Argv) => sessionPositional(yargs) as Argv<SessionIdArgs>,
  handler: async (argv) => {
    report(await peekManagedSession(argv.session, connectSupervisor));
  },
};

export const answerCommand: CommandModule<unknown, AnswerArgs> = {
  command: 'answer <session> <text>',
  describe: 'Answer a background session that is waiting for input',
  builder: (yargs: Argv) =>
    sessionPositional(yargs).positional('text', {
      type: 'string',
      describe: 'What to tell it',
      demandOption: true,
    }) as Argv<AnswerArgs>,
  handler: async (argv) => {
    report(
      await answerManagedSession(argv.session, argv.text, connectSupervisor),
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
