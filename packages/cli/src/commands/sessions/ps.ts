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
 */

import type { CommandModule, Argv } from 'yargs';
import {
  listLiveSessions,
  type SessionRegistryRecord,
} from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import { escapeAnsiCtrlCodes } from '../../ui/utils/textUtils.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

/**
 * Fixed column widths for the human-readable table (exported for tests).
 *
 * These are content widths, and cells are joined by an explicit space
 * rather than relying on padding to leave one — the same shape as sibling
 * `sessions list`. Folding the gutter into the width instead (truncating
 * to `NAME_COL - 2`) costs two columns on *every* row to protect the rare
 * full-width one, and `deriveSessionName` caps its basename at 32, so a
 * name long enough to truncate is the common case rather than the edge:
 * every one of them would lose two more characters, and a 21–22 column
 * name would be ellipsized while its cell sat two columns empty. The
 * suffix those two columns eat is the hash that tells two sessions in the
 * same directory apart, which is the one part of the name that cannot be
 * inferred from the DIRECTORY column beside it.
 */
export const NAME_COL = 22;
export const PID_COL = 9;
export const AGE_COL = 10;

interface PsArgs {
  json?: boolean;
}

/**
 * Sanitize a value for terminal output.
 *
 * `cwd` and `name` originate from another process's on-disk record, so
 * they are attacker-influenced in exactly the way a log line is: a record
 * containing an ANSI sequence or a stray `\r` could otherwise repaint or
 * misalign this table. Mirrors `sessions list`.
 */
function sanitize(value: string): string {
  const stripped = value.replace(/[\r\n\t]/g, '');
  const escaped = escapeAnsiCtrlCodes(stripped);
  // eslint-disable-next-line no-control-regex
  return escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

function padDisplay(str: string, width: number): string {
  const currentWidth = stringWidth(str);
  if (currentWidth >= width) return str;
  return str + ' '.repeat(width - currentWidth);
}

function truncate(str: string, maxLen: number): string {
  if (stringWidth(str) <= maxLen) return str;
  const suffix = maxLen > 3 ? '...' : '';
  const target = maxLen - stringWidth(suffix);
  let result = '';
  let w = 0;
  for (const char of str) {
    const cw = stringWidth(char);
    if (w + cw > target) break;
    result += char;
    w += cw;
  }
  return result + suffix;
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
    `${padDisplay('NAME', NAME_COL)} ${padDisplay('PID', PID_COL)} ${padDisplay(
      'AGE',
      AGE_COL,
    )} DIRECTORY`,
  );
  for (const record of records) {
    writeStdoutLine(
      `${padDisplay(
        truncate(sanitize(record.name), NAME_COL),
        NAME_COL,
      )} ${padDisplay(String(record.pid), PID_COL)} ${padDisplay(
        formatAge(now - record.startedAt),
        AGE_COL,
      )} ${sanitize(record.cwd)}`,
    );
  }
}

async function handlePs(argv: PsArgs): Promise<void> {
  let records: SessionRegistryRecord[];
  try {
    // No `includeSelf`: this process is not a session and never registers
    // one. `qwen sessions ps` is resolved and run during yargs' argument
    // parsing, which finishes and exits long before `startInteractiveUI`
    // — the only caller of `registerSession` — would run. So there is no
    // record at this PID to include, and a flag offering to include it
    // would be a switch with nothing on the other end.
    records = await listLiveSessions();
  } catch (err) {
    writeStderrLine(
      `Error: failed to read the session registry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  const now = Date.now();

  if (argv.json) {
    for (const record of records) {
      writeStdoutLine(JSON.stringify(record));
    }
    return;
  }

  if (records.length === 0) {
    writeStdoutLine('No other Qwen Code sessions are running.');
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
