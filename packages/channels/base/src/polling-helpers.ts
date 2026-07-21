import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getGlobalQwenDir } from './paths.js';

export interface ParsedChatId {
  owner: string;
  repo: string;
}

export interface ParsedIssueThreadId {
  type: 'issue' | 'pr';
  number: number;
}

export function parseChatId(chatId: string): ParsedChatId | null {
  const match = chatId.match(/^([^/]+)\/(.+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

export function parseIssueThreadId(
  threadId: string,
): ParsedIssueThreadId | null {
  const match = threadId.match(/^(issue|pr):(\d+)$/);
  if (!match) return null;
  return { type: match[1] as 'issue' | 'pr', number: Number(match[2]) };
}

export function extractFromSubjectUrl(subjectUrl: string | null | undefined): {
  type: 'issue' | 'pr';
  owner: string;
  repo: string;
  number: number;
} | null {
  if (!subjectUrl) return null;
  const issueMatch = subjectUrl.match(/\/repos\/([^/]+)\/(.+)\/issues\/(\d+)/);
  if (issueMatch) {
    return {
      type: 'issue',
      owner: issueMatch[1]!,
      repo: issueMatch[2]!,
      number: Number(issueMatch[3]),
    };
  }
  const prMatch = subjectUrl.match(/\/repos\/([^/]+)\/(.+)\/pulls\/(\d+)/);
  if (prMatch) {
    return {
      type: 'pr',
      owner: prMatch[1]!,
      repo: prMatch[2]!,
      number: Number(prMatch[3]),
    };
  }
  return null;
}

export function extractCommentIdFromUrl(
  url: string | null | undefined,
): number | null {
  if (!url) return null;
  const match = url.match(/\/comments\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function cursorFileName(channelName: string): string {
  return `${encodeURIComponent(channelName)}-poll-cursor.txt`;
}

function defaultCursorDir(): string {
  return join(getGlobalQwenDir(), 'channels');
}

export interface PollCursor {
  timestamp: string;
  processedIds: Set<string>;
}

export function loadPollCursor(channelName: string, dir?: string): PollCursor {
  const p = join(dir ?? defaultCursorDir(), cursorFileName(channelName));
  if (!existsSync(p)) return { timestamp: '', processedIds: new Set() };
  try {
    const lines = readFileSync(p, 'utf-8').split('\n');
    const timestamp = (lines[0] ?? '').trim();
    const idsLine = (lines[1] ?? '').trim();
    const processedIds = idsLine
      ? new Set(idsLine.split(',').filter(Boolean))
      : new Set<string>();
    return { timestamp, processedIds };
  } catch {
    return { timestamp: '', processedIds: new Set() };
  }
}

export function savePollCursor(
  channelName: string,
  timestamp: string,
  processedIds?: Set<string>,
  dir?: string,
): void {
  const d = dir ?? defaultCursorDir();
  mkdirSync(d, { recursive: true });
  const idsLine =
    processedIds && processedIds.size > 0
      ? `\n${[...processedIds].join(',')}`
      : '';
  const target = join(d, cursorFileName(channelName));
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${timestamp}${idsLine}`, 'utf-8');
  renameSync(tmp, target);
}

export function stripMentions(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(
          /(?:(?<=\s|^|[([{"<])@[a-zA-Z0-9_\-/]+(?:\.[a-zA-Z0-9_-]+)+)|(?<=\s|^|[([{"<])@[a-zA-Z0-9_\-/]+\s*/g,
          (match) => {
            if (match.includes('.')) return match;
            return /\s$/.test(match) ? ' ' : '';
          },
        )
        .replace(/ {2,}/g, ' ')
        .trim(),
    )
    .join('\n');
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
