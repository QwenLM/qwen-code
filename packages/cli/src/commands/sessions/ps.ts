/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen sessions ps` — list the Qwen Code sessions on this machine.
 *
 * The sibling `qwen sessions list` walks saved transcripts; this walks the
 * live-process registry, so the two answer different questions: "what have
 * I worked on" versus "what is going on at this moment".
 *
 * Two sources are read. The live-process registry is written by a session's
 * own process and knows only that the process is alive. The Agent View
 * supervisor's store also knows a managed session's title and task state —
 * and still knows the session after its worker exits, which is why a
 * listing can include rows with nothing running. One row per session,
 * managed ones first; see `managed-rows.ts` for the merge.
 *
 * KIND says what registered each one — an interactive terminal, a
 * daemon-managed session, a program that is not Qwen Code at all. It is a
 * self-report, like NAME and DIRECTORY: everything here was written by
 * the process it describes. A managed row's KIND says what the row is
 * instead of borrowing a registrant's word.
 *
 * STATE is claimed only where a source knows it: a managed row reports its
 * task state, and a registry row says `interactive` only when its own
 * record says a terminal registered it. A one-shot `qwen -p` run registers
 * nothing and is never shown.
 */

import type { CommandModule, Argv } from 'yargs';
import {
  describeSessionKind,
  listLiveSessions,
} from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import {
  sanitizeTerminalText,
  truncateToWidth,
} from '../../ui/utils/textUtils.js';
import {
  ignoreBrokenPipe,
  writeStderrLine,
  writeStdoutLine,
} from '../../utils/stdioHelpers.js';
import { listAgentViewSessionSnapshots } from '../../agent-view/supervisor-store.js';
import {
  managedSessionRows,
  mergeSessionRows,
  reconcileRowLiveness,
  type SessionRow,
} from './managed-rows.js';
import type { AgentViewTaskState } from '../../agent-view/presentation.js';

/** Fixed column widths for the human-readable table (exported for tests). */
export const NAME_COL = 22;
/** Wide enough for the longest kind this build writes (`headless`). */
export const KIND_COL = 10;
export const PID_COL = 9;
export const AGE_COL = 10;
export const STATE_COL = 13;

interface PsArgs {
  json?: boolean;
}

/**
 * Sanitize a record field for terminal output.
 *
 * `cwd` and `name` are written by another process, so they are
 * attacker-influenced: an ANSI sequence could repaint the table, a bare
 * control byte could misalign it, and a bidi override (Trojan Source,
 * CVE-2021-42572) could make a directory render as a path that does not
 * exist. `sanitizeTerminalText` is the single source of truth for all
 * three classes; it deliberately preserves TAB and LF for multi-line
 * render sites, so a one-line table cell drops those two on top of it.
 */
function sanitize(value: string): string {
  return sanitizeTerminalText(value).replace(/[\t\n]/g, '');
}

function padDisplay(str: string, width: number): string {
  const currentWidth = stringWidth(str);
  if (currentWidth >= width) return str;
  return str + ' '.repeat(width - currentWidth);
}

/**
 * Render an age as a short, human-scannable string.
 *
 * A negative delta means the record's clock ran ahead of ours (a paused
 * VM, a corrected clock). Showing "-3m" reads as a bug, so clamp to 0.
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * What the `STATE` column prints for a managed row.
 *
 * The mapping lives here rather than on the row because the row reaches
 * `--json`: a machine contract pinned to display wording breaks every
 * script the day someone rewords a column, with no type error to warn
 * them. `taskState` is the stable token; this is the only place it turns
 * into English.
 *
 * Labelled by task state rather than by the roster's display group,
 * which folds `ready`, `stopped` and `failed` into one `completed`
 * bucket. The roster UI can afford that because it also paints an icon
 * tone; a one-line table has no second channel, and printing
 * "completed" beside a session that failed is a lie the user has no way
 * to see through.
 */
const TASK_STATE_LABEL: Record<AgentViewTaskState, string> = {
  running: 'working',
  waiting: 'needs input',
  ready: 'ready',
  stopped: 'stopped',
  failed: 'failed',
};

/**
 * What the `STATE` column prints for a registry row.
 *
 * A record knows that a process is alive and how that process described
 * itself, so `interactive` is claimed only for a terminal's own
 * self-report. A `serve`, `headless` or `external` record gets no state
 * here rather than one the registry never knew — its KIND cell already
 * carries the word it did write.
 */
function stateLabel(row: SessionRow): string {
  if (row.taskState !== undefined) return TASK_STATE_LABEL[row.taskState];
  return describeSessionKind(row.record?.kind) === 'tui' ? 'interactive' : '-';
}

/**
 * What the `KIND` column prints.
 *
 * A registry row prints the kind its own process recorded, which
 * `describeSessionKind` reads as `tui` when the writer predates the field.
 * A managed row prints what it is even when its worker also registered:
 * the supervisor's store claims nothing about what registered, and
 * printing `tui` for a session nobody is sitting at would spend the one
 * word this table reserves for "someone is at a terminal" on it.
 */
function kindLabel(row: SessionRow): string {
  return row.managed ? 'managed' : describeSessionKind(row.record?.kind);
}

function outputHuman(rows: SessionRow[], now: number): void {
  writeStdoutLine(
    padDisplay('NAME', NAME_COL) +
      padDisplay('KIND', KIND_COL) +
      padDisplay('PID', PID_COL) +
      padDisplay('AGE', AGE_COL) +
      padDisplay('STATE', STATE_COL) +
      'DIRECTORY',
  );
  for (const row of rows) {
    writeStdoutLine(
      padDisplay(truncateToWidth(sanitize(row.name), NAME_COL - 2), NAME_COL) +
        // Truncated for the same reason NAME is: a newer build may write
        // a longer kind than any this one knows, and one over-wide cell
        // would misalign every column after it. Not sanitized — unlike
        // NAME and DIRECTORY, the read guard already bounds `kind` to
        // lowercase ASCII, digits and dashes.
        padDisplay(truncateToWidth(kindLabel(row), KIND_COL - 2), KIND_COL) +
        padDisplay(row.pid === undefined ? '-' : String(row.pid), PID_COL) +
        padDisplay(
          row.startedAt === undefined ? '-' : formatAge(now - row.startedAt),
          AGE_COL,
        ) +
        padDisplay(stateLabel(row), STATE_COL) +
        sanitize(row.cwd),
    );
  }
}

/**
 * Managed sessions, or an empty list plus a note on stderr.
 *
 * A supervisor store that cannot be read must not take the command down —
 * the registry half still answers the question. But it must not vanish
 * either: a listing that silently omits a session waiting for input is
 * the failure this command exists to prevent. stderr keeps `--json`
 * stdout parseable.
 */
async function readManagedRows(now: number): Promise<SessionRow[]> {
  try {
    return managedSessionRows(await listAgentViewSessionSnapshots(), now);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeStderrLine(
      `Managed sessions could not be listed: ${sanitize(reason)}`,
    );
    return [];
  }
}

async function handlePs(argv: PsArgs): Promise<void> {
  ignoreBrokenPipe();
  const now = Date.now();
  // listLiveSessions reports "cannot look" as "no peers" rather than
  // throwing, so there is no failure path to surface here.
  const [records, managed] = await Promise.all([
    listLiveSessions(),
    readManagedRows(now),
  ]);
  const rows = reconcileRowLiveness(mergeSessionRows(records, managed));

  if (argv.json) {
    for (const row of rows) {
      // Deliberately raw: field values are emitted exactly as recorded,
      // with none of the table path's terminal sanitization. That keeps
      // the output honest data for tooling (and matches the sibling
      // `sessions list --json`); consumers that RENDER these values in a
      // terminal own the sanitization.
      //
      // A record is emitted whenever one exists, so consumers keep every
      // field they always saw, minus the inbox token — a credential, not
      // data: tooling that really needs it can read the record file, but
      // it must not spill into logs and pipelines by default. A managed
      // session whose worker also registered adds the task state only the
      // supervisor knows, and its display title as `title` — the record's
      // own `name` stays, because that is the name peer messaging
      // addresses the session by. A managed session with no record behind
      // it is emitted as the row itself, where `name` is that title.
      writeStdoutLine(
        JSON.stringify(
          row.record
            ? {
                ...row.record,
                ipcToken: undefined,
                managed: row.managed,
                ...(row.managed
                  ? { title: row.name, taskState: row.taskState }
                  : {}),
              }
            : row,
        ),
      );
    }
    return;
  }

  // An empty listing is a claim about both sources at once: no live
  // registry record, and no managed session the store still records.
  if (rows.length === 0) {
    writeStdoutLine('No other Qwen Code sessions are running.');
    return;
  }

  outputHuman(rows, now);
}

export const psCommand: CommandModule<unknown, PsArgs> = {
  command: 'ps',
  describe: 'List Qwen Code sessions running or recorded on this machine',
  builder: (yargs: Argv) =>
    yargs.option('json', {
      type: 'boolean',
      describe: 'Output as JSON Lines',
      default: false,
    }),
  handler: async (argv) => {
    await handlePs(argv);
  },
};
