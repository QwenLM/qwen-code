/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule, Argv } from 'yargs';
import type {
  SessionService,
  SessionListItem,
  ListSessionsResult,
} from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import { escapeAnsiCtrlCodes } from '../../ui/utils/textUtils.js';
import { initSessionService } from './common.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

/** Fixed column widths for the human-readable table (exported for tests). */
export const SESSION_COL = 38;
export const TIME_COL = 16;
export const TITLE_COL = 24;
export const BRANCH_COL = 12;

/**
 * Format an ISO 8601 timestamp to a UTC short form: YYYY-MM-DD HH:MM.
 * Uses UTC methods so the human output matches the raw data in JSON.
 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Sanitize a user-controllable string for terminal output:
 * 1. Strip \r, \n, and \t to prevent carriage-return / log-injection
 *    attacks and to keep table columns aligned.
 * 2. Escape ANSI escape sequences that could manipulate the terminal.
 * 3. Strip remaining C0 control characters (0x00-0x08, 0x0b, 0x0c,
 *    0x0e-0x1f) and C1 controls (0x7f-0x9f) that can cause disruptive
 *    terminal behaviour (bell, backspace, cursor movement, etc.).
 */
function sanitize(value: string): string {
  // Strip \r, \n, \t — these either inject fake newlines or misalign columns.
  const stripped = value.replace(/[\r\n\t]/g, '');
  // Neutralize ANSI escape sequences (e.g. colour codes).
  const escaped = escapeAnsiCtrlCodes(stripped);
  // Remove remaining C0/C1 controls that escapeAnsiCtrlCodes doesn't cover.
  // eslint-disable-next-line no-control-regex
  return escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/**
 * Pad a string to the given display width using spaces.
 * Uses string-width so CJK characters occupy the correct number of columns.
 */
function padDisplay(str: string, width: number): string {
  const currentWidth = stringWidth(str);
  if (currentWidth >= width) return str;
  return str + ' '.repeat(width - currentWidth);
}

/**
 * Truncate a string to at most `maxLen` *display columns*.
 * Appends "..." when truncation occurs and maxLen > 3.
 *
 * Unlike String.prototype.slice this iterates by code point and measures
 * each glyph with string-width, so CJK characters are handled correctly.
 */
function truncate(str: string, maxLen: number): string {
  const width = stringWidth(str);
  if (width <= maxLen) return str;

  const suffix = maxLen > 3 ? '...' : '';
  const target = maxLen - stringWidth(suffix);

  let result = '';
  let w = 0;
  for (const char of str) {
    w += stringWidth(char);
    if (w > target) break;
    result += char;
  }
  return result + suffix;
}

function outputHuman(items: SessionListItem[]): void {
  if (items.length === 0) {
    writeStdoutLine('No sessions found.');
    return;
  }

  const termWidth = process.stdout.columns ?? 80;
  // 4 = spaces between the 5 columns (SESSION TIME TITLE BRANCH PROMPT)
  const PROMPT_COL = Math.max(
    20,
    termWidth - SESSION_COL - TIME_COL - TITLE_COL - BRANCH_COL - 4,
  );

  const header =
    padDisplay('SESSION ID', SESSION_COL) +
    ' ' +
    padDisplay('STARTED', TIME_COL) +
    ' ' +
    padDisplay('TITLE', TITLE_COL) +
    ' ' +
    padDisplay('BRANCH', BRANCH_COL) +
    ' ' +
    'PROMPT';

  writeStdoutLine(header);

  for (const item of items) {
    const sessionId = truncate(
      sanitize(String(item.sessionId ?? '')),
      SESSION_COL,
    );
    const time = truncate(sanitize(formatTime(item.startTime)), TIME_COL);
    const sanitizedPrompt = sanitize(item.prompt ?? '');
    const title = truncate(
      item.customTitle != null ? sanitize(item.customTitle) : sanitizedPrompt,
      TITLE_COL,
    );
    const branch = truncate(
      item.gitBranch != null ? sanitize(item.gitBranch) : '-',
      BRANCH_COL,
    );
    const prompt = truncate(sanitizedPrompt, PROMPT_COL);

    writeStdoutLine(
      `${padDisplay(sessionId, SESSION_COL)} ${padDisplay(time, TIME_COL)} ${padDisplay(title, TITLE_COL)} ${padDisplay(branch, BRANCH_COL)} ${prompt}`,
    );
  }
}

function toJsonItem(item: SessionListItem): Record<string, unknown> {
  return {
    sessionId: item.sessionId,
    startTime: item.startTime,
    mtime: item.mtime,
    prompt: item.prompt,
    gitBranch: item.gitBranch ?? null,
    customTitle: item.customTitle ?? null,
    titleSource: item.titleSource ?? null,
    filePath: item.filePath,
    cwd: item.cwd,
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ListArgs {
  json?: boolean;
  limit?: number;
}

export async function handleList(argv: ListArgs): Promise<void> {
  let svc: SessionService;
  try {
    svc = initSessionService();
  } catch (err) {
    writeStderrLine(
      `Error: failed to initialize session service: ${formatError(err)}`,
    );
    process.exit(1);
    return;
  }

  let result: ListSessionsResult;
  try {
    result = await svc.listSessions({
      size: argv.limit ?? 20,
    });
  } catch (err) {
    writeStderrLine(`Error: failed to list sessions: ${formatError(err)}`);
    process.exit(1);
    return;
  }

  if (argv.json) {
    for (const item of result.items) {
      writeStdoutLine(JSON.stringify(toJsonItem(item)));
    }
    // Emit hasMore hint via stderr so it never contaminates the stdout JSON
    // stream, keeping pipelines like `qwen sessions list --json | jq …` safe.
    if (result.items.length > 0 && result.hasMore) {
      writeStderrLine(
        `Note: ${result.items.length} sessions shown, more available. Use --limit to show more.`,
      );
    }
  } else {
    outputHuman(result.items);
    if (result.items.length > 0 && result.hasMore) {
      writeStdoutLine(
        `Showing ${result.items.length} sessions. Use --limit to show more.`,
      );
    }
  }
}

export const listCommand: CommandModule<unknown, ListArgs> = {
  command: 'list',
  describe: 'List sessions',
  builder: (yargs: Argv) =>
    yargs
      .option('json', {
        type: 'boolean',
        describe: 'Output as JSON Lines',
        default: false,
      })
      .option('limit', {
        type: 'number',
        describe: 'Maximum number of sessions to show',
        default: 20,
        coerce: (v) => (Number.isInteger(v) && v > 0 ? v : 20),
      }),
  handler: async (argv) => {
    await handleList(argv);
  },
};
