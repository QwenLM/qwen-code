/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

export type SessionSourceLocator =
  | { type: 'workspace_file'; workspacePath: string }
  | { type: 'attachment'; attachmentId: string }
  | { type: 'url'; url: string };

export interface SessionSourceInput {
  title: string;
  locator: SessionSourceLocator;
  description?: string;
}

export interface SessionSource extends SessionSourceInput {
  id: string;
  kind: 'file' | 'link';
  workspaceCwd?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSourcesSnapshot {
  version: 1;
  revision: number;
  sources: SessionSource[];
}

export interface SessionSourcesResult {
  revision: number;
  sources: SessionSource[];
}

export interface SessionSourceUpsertResult {
  revision: number;
  source: SessionSource;
  change: 'created' | 'updated' | 'unchanged';
}

export interface SessionSourceRemoveResult {
  revision: number;
  removed: boolean;
}

export class SessionSourceError extends Error {
  constructor(
    readonly code:
      | 'invalid_source'
      | 'source_limit_reached'
      | 'source_persistence_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'SessionSourceError';
  }
}

const invalid = (message: string): never => {
  throw new SessionSourceError('invalid_source', message);
};

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('Source must be an object');
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid('Unknown source field');
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  limit: number,
  empty = false,
  trim = true,
): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return invalid(`Invalid ${field}`);
  }
  const normalized = trim ? value.trim() : value;
  if ((!empty && !normalized) || normalized.length > limit) {
    return invalid(`Invalid ${field} length (maximum ${limit})`);
  }
  return normalized;
}

export function validateSessionSourceInput(value: unknown): SessionSourceInput {
  const input = object(value, ['title', 'description', 'locator']);
  const title = text(input['title'], 'title', 200);
  const description =
    input['description'] === undefined
      ? undefined
      : text(input['description'], 'description', 1000, true);
  const raw = object(input['locator'], [
    'type',
    'workspacePath',
    'attachmentId',
    'url',
  ]);
  let locator: SessionSourceLocator;
  switch (raw['type']) {
    case 'workspace_file': {
      object(raw, ['type', 'workspacePath']);
      const sourcePath = text(
        raw['workspacePath'],
        'workspacePath',
        500,
        false,
        false,
      ).replaceAll('\\', '/');
      if (sourcePath.startsWith('/') || /^[a-z]:/iu.test(sourcePath)) {
        return invalid('Workspace path must be relative');
      }
      const segments: string[] = [];
      for (const segment of sourcePath.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
          if (!segments.length)
            return invalid('Workspace path escapes its root');
          segments.pop();
        } else {
          segments.push(segment);
        }
      }
      if (!segments.length)
        return invalid('Workspace path must identify a file');
      locator = { type: 'workspace_file', workspacePath: segments.join('/') };
      break;
    }
    case 'attachment':
      object(raw, ['type', 'attachmentId']);
      locator = {
        type: 'attachment',
        attachmentId: text(
          raw['attachmentId'],
          'attachmentId',
          200,
          false,
          false,
        ),
      };
      break;
    case 'url': {
      object(raw, ['type', 'url']);
      const maxUrlLength = 2048;
      const url = text(raw['url'], 'url', maxUrlLength);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return invalid('Invalid source URL');
      }
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      ) {
        return invalid('Source URL must be HTTP(S) without credentials');
      }
      if (parsed.href.length > maxUrlLength) {
        return invalid(
          `Source URL is too long (maximum ${maxUrlLength} characters after normalization)`,
        );
      }
      locator = { type: 'url', url: parsed.href };
      break;
    }
    default:
      return invalid('Unknown source locator type');
  }
  return {
    title,
    locator,
    ...(description !== undefined ? { description } : {}),
  };
}

export function sessionSourceId(
  sessionId: string,
  locator: SessionSourceLocator,
  workspaceCwd?: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, locator, workspaceCwd ?? null]))
    .digest('hex');
}

function ordered(sources: SessionSource[]): SessionSource[] {
  return sources.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

export function parseSessionSourcesSnapshot(
  value: unknown,
  sessionId: string,
): SessionSourcesSnapshot {
  const raw = object(value, ['version', 'revision', 'sources']);
  if (
    raw['version'] !== 1 ||
    !Number.isSafeInteger(raw['revision']) ||
    (raw['revision'] as number) < 0 ||
    !Array.isArray(raw['sources']) ||
    raw['sources'].length > 200
  ) {
    return invalid('Unsupported or malformed sources snapshot');
  }
  const ids = new Set<string>();
  const sources = raw['sources'].map((value: unknown) => {
    const source = object(value, [
      'id',
      'kind',
      'workspaceCwd',
      'createdAt',
      'updatedAt',
      'title',
      'description',
      'locator',
    ]);
    const input = validateSessionSourceInput({
      title: source['title'],
      locator: source['locator'],
      ...(source['description'] !== undefined
        ? { description: source['description'] }
        : {}),
    });
    const workspaceCwd = source['workspaceCwd'];
    if (
      input.locator.type === 'workspace_file'
        ? typeof workspaceCwd !== 'string' ||
          !path.isAbsolute(workspaceCwd) ||
          path.normalize(workspaceCwd) !== workspaceCwd
        : workspaceCwd !== undefined
    ) {
      return invalid('Invalid source workspace binding');
    }
    const id = sessionSourceId(
      sessionId,
      input.locator,
      workspaceCwd as string | undefined,
    );
    const kind = input.locator.type === 'url' ? 'link' : 'file';
    const createdAt = source['createdAt'];
    const updatedAt = source['updatedAt'];
    const isTimestamp = (value: unknown): value is string =>
      typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value;
    if (
      source['id'] !== id ||
      ids.has(id) ||
      source['kind'] !== kind ||
      !isTimestamp(createdAt) ||
      !isTimestamp(updatedAt) ||
      updatedAt < createdAt ||
      source['title'] !== input.title ||
      source['description'] !== input.description
    ) {
      return invalid('Invalid stored source');
    }
    ids.add(id);
    return {
      ...input,
      id,
      kind,
      ...(typeof workspaceCwd === 'string' ? { workspaceCwd } : {}),
      createdAt,
      updatedAt,
    } satisfies SessionSource;
  });
  return {
    version: 1,
    revision: raw['revision'] as number,
    sources: ordered(sources),
  };
}

export interface SessionSourcesRestoreState {
  sourcesSnapshot?: SessionSourcesSnapshot;
  sourcesUnavailable?: true;
}

export function restoreSessionSources(
  records: ReadonlyArray<{
    type?: unknown;
    subtype?: unknown;
    systemPayload?: unknown;
  }>,
  sessionId: string,
): SessionSourcesRestoreState {
  const latest = records.findLast(
    (record) =>
      record.type === 'system' && record.subtype === 'session_sources_snapshot',
  );
  if (!latest) return {};
  try {
    return {
      sourcesSnapshot: parseSessionSourcesSnapshot(
        latest.systemPayload,
        sessionId,
      ),
    };
  } catch {
    return { sourcesUnavailable: true };
  }
}

export class SessionSourceService {
  private snapshot: SessionSourcesSnapshot = {
    version: 1,
    revision: 0,
    sources: [],
  };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      sessionId: string;
      workspaceCwd: () => string;
      load: () => Promise<SessionSourcesRestoreState>;
      persist: (snapshot: SessionSourcesSnapshot) => Promise<void>;
      notify?: (revision: number) => Promise<void>;
    },
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (!this.loaded) {
        let restored: SessionSourcesRestoreState;
        try {
          restored = await this.options.load();
        } catch {
          throw new SessionSourceError(
            'source_persistence_unavailable',
            'Stored sources could not be loaded',
          );
        }
        if (restored.sourcesUnavailable)
          throw new SessionSourceError(
            'source_persistence_unavailable',
            'Stored sources are unavailable',
          );
        this.snapshot = restored.sourcesSnapshot ?? {
          version: 1,
          revision: 0,
          sources: [],
        };
        this.loaded = true;
      }
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async commit(sources: SessionSource[]): Promise<void> {
    const next = parseSessionSourcesSnapshot(
      { version: 1, revision: this.snapshot.revision + 1, sources },
      this.options.sessionId,
    );
    try {
      await this.options.persist(next);
    } catch {
      this.loaded = false;
      throw new SessionSourceError(
        'source_persistence_unavailable',
        'Source metadata could not be persisted',
      );
    }
    this.snapshot = next;
    void Promise.resolve()
      .then(() => this.options.notify?.(next.revision))
      .catch(() => undefined);
  }

  list(): Promise<SessionSourcesResult> {
    return this.serial(async () =>
      structuredClone({
        revision: this.snapshot.revision,
        sources: this.snapshot.sources,
      }),
    );
  }

  upsert(value: unknown): Promise<SessionSourceUpsertResult> {
    return this.serial(async () => {
      const input = validateSessionSourceInput(value);
      const workspaceCwd =
        input.locator.type === 'workspace_file'
          ? path.resolve(this.options.workspaceCwd())
          : undefined;
      const id = sessionSourceId(
        this.options.sessionId,
        input.locator,
        workspaceCwd,
      );
      const previous = this.snapshot.sources.find((source) => source.id === id);
      const description = input.description ?? previous?.description;
      if (
        previous &&
        previous.title === input.title &&
        previous.description === description
      ) {
        return {
          revision: this.snapshot.revision,
          source: structuredClone(previous),
          change: 'unchanged',
        };
      }
      if (!previous && this.snapshot.sources.length >= 200)
        throw new SessionSourceError(
          'source_limit_reached',
          'A session can contain at most 200 sources',
        );
      const now = new Date().toISOString();
      const source: SessionSource = {
        ...input,
        ...(description !== undefined ? { description } : {}),
        id,
        kind: input.locator.type === 'url' ? 'link' : 'file',
        ...(workspaceCwd ? { workspaceCwd } : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      await this.commit([
        ...this.snapshot.sources.filter((item) => item.id !== id),
        source,
      ]);
      return {
        revision: this.snapshot.revision,
        source: structuredClone(source),
        change: previous ? 'updated' : 'created',
      };
    });
  }

  remove(sourceId: string): Promise<SessionSourceRemoveResult> {
    return this.serial(async () => {
      const sources = this.snapshot.sources.filter(
        (source) => source.id !== sourceId,
      );
      const removed = sources.length !== this.snapshot.sources.length;
      if (removed) await this.commit(sources);
      return { revision: this.snapshot.revision, removed };
    });
  }

  copyFrom(
    sources: SessionSource[],
    attachmentIds: string[],
  ): Promise<{ warnings: string[] }> {
    return this.serial(async () => {
      const warnings: string[] = [];
      const cwd = path.resolve(this.options.workspaceCwd());
      const copied = sources.flatMap((source) => {
        if (
          (source.locator.type === 'attachment' &&
            !attachmentIds.includes(source.locator.attachmentId)) ||
          (source.locator.type === 'workspace_file' &&
            source.workspaceCwd !== cwd)
        ) {
          warnings.push(
            `Source ${source.id} was not copied because its resource could not be mapped`,
          );
          return [];
        }
        return [
          {
            ...source,
            id: sessionSourceId(
              this.options.sessionId,
              source.locator,
              source.workspaceCwd,
            ),
          },
        ];
      });
      if (copied.length) await this.commit(copied);
      return { warnings };
    });
  }
}
