/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen sessions ps` — list the Qwen Code sessions running right now.
 *
 * The sibling `qwen sessions list` walks saved transcripts; this walks the
 * live-process registry, so the two answer different questions: "what have
 * I worked on" versus "what is running on this machine at this moment".
 *
 * KIND says what registered each one — an interactive terminal, a
 * daemon-managed session, a program that is not Qwen Code at all. It is a
 * self-report, like NAME and DIRECTORY: everything here was written by
 * the process it describes. What does not appear at all is a one-shot
 * `qwen -p` run, which never registers.
 */

import type { CommandModule, Argv } from 'yargs';
import {
  describeSessionKind,
  listLiveSessions,
  type SessionRegistryRecord,
} from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import {
  sanitizeTerminalText,
  truncateToWidth,
} from '../../ui/utils/textUtils.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

/** Fixed column widths for the human-readable table (exported for tests). */
export const NAME_COL = 22;
/** Wide enough for the longest kind this build writes (`headless`). */
export const KIND_COL = 10;
export const PID_COL = 9;
export const AGE_COL = 10;

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

function outputHuman(records: SessionRegistryRecord[], now: number): void {
  writeStdoutLine(
    padDisplay('NAME', NAME_COL) +
      padDisplay('KIND', KIND_COL) +
      padDisplay('PID', PID_COL) +
      padDisplay('AGE', AGE_COL) +
      'DIRECTORY',
  );
  for (const record of records) {
    writeStdoutLine(
      padDisplay(
        truncateToWidth(sanitize(record.name), NAME_COL - 2),
        NAME_COL,
      ) +
        // Truncated for the same reason NAME is: a newer build may write
        // a longer kind than any this one knows, and one over-wide cell
        // would misalign every column after it. Not sanitized — unlike
        // NAME and DIRECTORY, the read guard already bounds `kind` to
        // lowercase ASCII, digits and dashes.
        padDisplay(
          truncateToWidth(describeSessionKind(record.kind), KIND_COL - 2),
          KIND_COL,
        ) +
        padDisplay(String(record.pid), PID_COL) +
        padDisplay(formatAge(now - record.startedAt), AGE_COL) +
        sanitize(record.cwd),
    );
  }
}

async function handlePs(argv: PsArgs): Promise<void> {
  // listLiveSessions reports "cannot look" as "no peers" rather than
  // throwing, so there is no failure path to surface here.
  const records = await listLiveSessions();
  const now = Date.now();

  if (argv.json) {
    for (const record of records) {
      // Deliberately raw: field values are emitted exactly as recorded,
      // with none of the table path's terminal sanitization. That keeps
      // the output honest data for tooling (and matches the sibling
      // `sessions list --json`); consumers that RENDER these values in a
      // terminal own the sanitization. The inbox token is the one
      // exception — a credential, not data: tooling that really needs it
      // can read the record file, but it must not spill into logs and
      // pipelines by default.
      writeStdoutLine(JSON.stringify({ ...record, ipcToken: undefined }));
    }
    return;
  }

  if (records.length === 0) {
    writeStdoutLine('No Qwen Code sessions are registered right now.');
    return;
  }

  outputHuman(records, now);
}

export const psCommand: CommandModule<unknown, PsArgs> = {
  command: 'ps',
  describe: 'List Qwen Code sessions running right now',
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
