import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { sessionMatchesGitQuery } from './sessionSearch';

export type ArchivedSessionSort =
  | 'updatedAt'
  | 'lastUserPromptAt'
  | 'createdAt'
  | 'alphabetical';

export type ArchivedConversationType =
  | 'all'
  | 'tasks'
  | 'channels'
  | 'local'
  | 'cloud';

export type ArchivedTimestampKind =
  | 'updatedAt'
  | 'lastUserPromptAt'
  | 'createdAt';

const ARCHIVED_SORT_STORAGE_PREFIX = 'web-shell:archived-session-sort:';

function isArchivedSessionSort(
  value: string | null,
): value is ArchivedSessionSort {
  return (
    value === 'updatedAt' ||
    value === 'lastUserPromptAt' ||
    value === 'createdAt' ||
    value === 'alphabetical'
  );
}

export function readArchivedSessionSort(host: string): ArchivedSessionSort {
  try {
    const raw = localStorage.getItem(`${ARCHIVED_SORT_STORAGE_PREFIX}${host}`);
    return isArchivedSessionSort(raw) ? raw : 'updatedAt';
  } catch {
    return 'updatedAt';
  }
}

export function writeArchivedSessionSort(
  host: string,
  sort: ArchivedSessionSort,
): void {
  try {
    localStorage.setItem(`${ARCHIVED_SORT_STORAGE_PREFIX}${host}`, sort);
  } catch {
    // Storage may be disabled by an embedding host.
  }
}

export function toServerArchivedSortBy(
  sort: ArchivedSessionSort,
  questionSortSupported: boolean,
): 'updatedAt' | 'lastUserPromptAt' | undefined {
  if (!questionSortSupported) return undefined;
  return sort === 'lastUserPromptAt' ? 'lastUserPromptAt' : 'updatedAt';
}

function parseTimestampMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveArchivedSessionTimestamp(
  session: DaemonSessionSummary,
  sort: ArchivedSessionSort,
): { iso: string; kind: ArchivedTimestampKind } | undefined {
  const candidates: Array<{
    iso: string | undefined;
    kind: ArchivedTimestampKind;
  }> =
    sort === 'lastUserPromptAt'
      ? [
          { iso: session.lastUserPromptAt, kind: 'lastUserPromptAt' },
          { iso: session.updatedAt, kind: 'updatedAt' },
          { iso: session.createdAt, kind: 'createdAt' },
        ]
      : sort === 'createdAt'
        ? [
            { iso: session.createdAt, kind: 'createdAt' },
            { iso: session.updatedAt, kind: 'updatedAt' },
          ]
        : [
            { iso: session.updatedAt, kind: 'updatedAt' },
            { iso: session.createdAt, kind: 'createdAt' },
          ];
  for (const candidate of candidates) {
    if (candidate.iso && parseTimestampMs(candidate.iso) !== undefined) {
      return { iso: candidate.iso, kind: candidate.kind };
    }
  }
  return undefined;
}

export function formatArchivedTimestamp(iso: string, language: string): string {
  const ms = parseTimestampMs(iso);
  if (ms === undefined) return '';
  const date = new Date(ms);
  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function compareDescOptional(
  aMs: number | undefined,
  bMs: number | undefined,
): number {
  if (aMs !== undefined && bMs !== undefined) return bMs - aMs;
  if (aMs !== undefined) return -1;
  if (bMs !== undefined) return 1;
  return 0;
}

export function compareArchivedSessions(
  a: DaemonSessionSummary,
  b: DaemonSessionSummary,
  sort: ArchivedSessionSort,
): number {
  if (sort === 'alphabetical') {
    const aTitle = a.displayName?.trim() ?? '';
    const bTitle = b.displayName?.trim() ?? '';
    if (aTitle && !bTitle) return -1;
    if (!aTitle && bTitle) return 1;
    if (aTitle && bTitle) {
      const byTitle = aTitle.localeCompare(bTitle, undefined, {
        sensitivity: 'base',
      });
      if (byTitle !== 0) return byTitle;
    }
    return a.sessionId.localeCompare(b.sessionId);
  }

  if (sort === 'createdAt') {
    const byCreated = compareDescOptional(
      parseTimestampMs(a.createdAt),
      parseTimestampMs(b.createdAt),
    );
    if (byCreated !== 0) return byCreated;
    return a.sessionId.localeCompare(b.sessionId);
  }

  if (sort === 'lastUserPromptAt') {
    const byQuestion = compareDescOptional(
      parseTimestampMs(a.lastUserPromptAt),
      parseTimestampMs(b.lastUserPromptAt),
    );
    if (byQuestion !== 0) return byQuestion;
  }

  const byUpdated = compareDescOptional(
    parseTimestampMs(a.updatedAt ?? a.createdAt),
    parseTimestampMs(b.updatedAt ?? b.createdAt),
  );
  if (byUpdated !== 0) return byUpdated;
  return a.sessionId.localeCompare(b.sessionId);
}

export function matchesArchivedSearch(
  session: DaemonSessionSummary,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  const label = session.displayName?.trim().toLowerCase() ?? '';
  return (
    label.includes(query) ||
    session.sessionId.toLowerCase().includes(query) ||
    sessionMatchesGitQuery(session, query)
  );
}
