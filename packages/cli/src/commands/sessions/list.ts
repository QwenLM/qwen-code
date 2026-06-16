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

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Sanitize a user-controllable string for terminal output:
 * 1. Strip \r and \n to prevent carriage-return / log-injection attacks.
 * 2. Escape ANSI control sequences that could manipulate the terminal.
 */
function sanitize(value: string): string {
  return escapeAnsiCtrlCodes(value.replace(/[\r\n]/g, ''));
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

  if (maxLen <= 3) {
    let result = '';
    let w = 0;
    for (const char of str) {
      const cw = stringWidth(char);
      if (w + cw > maxLen) break;
      result += char;
      w += cw;
    }
    return result;
  }

  const suffix = '...';
  const suffixWidth = 3;
  const targetWidth = maxLen - suffixWidth;
  let result = '';
  let w = 0;
  for (const char of str) {
    const cw = stringWidth(char);
    if (w + cw > targetWidth) break;
    result += char;
    w += cw;
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
    padDisplay('STARTED (LOCAL)', TIME_COL) +
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
    const time = formatTime(item.startTime);
    const title = truncate(
      item.customTitle != null
        ? sanitize(item.customTitle)
        : sanitize(item.prompt ?? ''),
      TITLE_COL,
    );
    const branch = truncate(
      item.gitBranch != null ? sanitize(item.gitBranch) : '-',
      BRANCH_COL,
    );
    const prompt = truncate(sanitize(item.prompt ?? ''), PROMPT_COL);

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
