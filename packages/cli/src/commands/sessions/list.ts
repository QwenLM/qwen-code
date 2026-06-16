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
import { initSessionService } from './common.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return str.slice(0, maxLen - 3) + '...';
}

function outputHuman(items: SessionListItem[]): void {
  if (items.length === 0) {
    writeStdoutLine('No sessions found.');
    return;
  }

  const SESSION_COL = 38;
  const TIME_COL = 16;
  const TITLE_COL = 24;
  const BRANCH_COL = 12;

  const header =
    'SESSION ID'.padEnd(SESSION_COL) +
    ' ' +
    'STARTED'.padEnd(TIME_COL) +
    ' ' +
    'TITLE'.padEnd(TITLE_COL) +
    ' ' +
    'BRANCH'.padEnd(BRANCH_COL) +
    ' ' +
    'PROMPT';

  writeStdoutLine(header);

  for (const item of items) {
    const sessionId = truncate(String(item.sessionId ?? ''), SESSION_COL);
    const time = formatTime(item.startTime);
    const title = truncate(item.customTitle ?? item.prompt, TITLE_COL);
    const branch = truncate(item.gitBranch ?? '-', BRANCH_COL);
    const prompt = truncate(item.prompt, 40);

    writeStdoutLine(
      `${sessionId.padEnd(SESSION_COL)} ${time.padEnd(TIME_COL)} ${title.padEnd(TITLE_COL)} ${branch.padEnd(BRANCH_COL)} ${prompt}`,
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
    if (result.hasMore) {
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
        coerce: (v) => (Number.isFinite(v) && v > 0 ? v : 20),
      }),
  handler: async (argv) => {
    await handleList(argv);
  },
};
