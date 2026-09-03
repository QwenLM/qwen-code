/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen sessions ps` — list the interactive Qwen Code sessions running
 * right now.
 *
 * The sibling `qwen sessions list` walks saved transcripts; this walks the
 * live-process registry, so the two answer different questions: "what have
 * I worked on" versus "what is running on this machine at this moment".
 *
 * Two things can be running: an interactive session, which writes the
 * live-process registry, and a managed Agent View session, which is owned
 * by a supervisor and writes no registry record. Both are listed, managed
 * ones first — see `managed-rows.ts` for the merge.
 *
 * "Interactive" is a registration fact, not a filter: only the
 * interactive UI registers sessions, so headless runs (`qwen -p`) never
 * appear here. A managed session appears whether or not it registers.
 */

import type { CommandModule, Argv } from 'yargs';
import { listLiveSessions } from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import {
  sanitizeTerminalText,
  truncateToWidth,
} from '../../ui/utils/textUtils.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { listAgentViewSessionSnapshots } from '../../agent-view/supervisor-store.js';
import {
  managedSessionRows,
  mergeSessionRows,
  type SessionRow,
} from './managed-rows.js';

/** Fixed column widths for the human-readable table (exported for tests). */
export const NAME_COL = 22;
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

function outputHuman(rows: SessionRow[], now: number): void {
  writeStdoutLine(
    padDisplay('NAME', NAME_COL) +
      padDisplay('PID', PID_COL) +
      padDisplay('AGE', AGE_COL) +
      padDisplay('STATE', STATE_COL) +
      'DIRECTORY',
  );
  for (const row of rows) {
    writeStdoutLine(
      padDisplay(truncateToWidth(sanitize(row.name), NAME_COL - 2), NAME_COL) +
        padDisplay(row.pid === undefined ? '-' : String(row.pid), PID_COL) +
        padDisplay(
          row.startedAt === undefined ? '-' : formatAge(now - row.startedAt),
          AGE_COL,
        ) +
        padDisplay(row.state, STATE_COL) +
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
  const now = Date.now();
  // listLiveSessions reports "cannot look" as "no peers" rather than
  // throwing, so there is no failure path to surface here.
  const [records, managed] = await Promise.all([
    listLiveSessions(),
    readManagedRows(now),
  ]);
  const rows = mergeSessionRows(records, managed);

  if (argv.json) {
    for (const row of rows) {
      // Deliberately raw: field values are emitted exactly as recorded,
      // with none of the table path's terminal sanitization. That keeps
      // the output honest data for tooling (and matches the sibling
      // `sessions list --json`); consumers that RENDER these values in a
      // terminal own the sanitization.
      //
      // Registry rows keep the whole record so existing consumers see
      // every field they always saw, minus the inbox token — a
      // credential, not data: tooling that really needs it can read the
      // record file, but it must not spill into logs and pipelines by
      // default. Managed rows have no record behind them and are emitted
      // as the row itself.
      writeStdoutLine(
        row.record
          ? JSON.stringify({
              ...row.record,
              ipcToken: undefined,
              managed: false,
            })
          : JSON.stringify(row),
      );
    }
    return;
  }

  if (rows.length === 0) {
    writeStdoutLine('No other Qwen Code sessions are running.');
    return;
  }

  outputHuman(rows, now);
}

export const psCommand: CommandModule<unknown, PsArgs> = {
  command: 'ps',
  describe: 'List the Qwen Code sessions running right now',
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
