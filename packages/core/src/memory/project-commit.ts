/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import { isSubpath, realpathNearestExisting } from '../utils/paths.js';
import {
  AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  AUTO_MEMORY_METADATA_FILENAME,
  getAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
  type ProjectMemoryOwner,
} from './paths.js';
import { resolveTrustedMemoryRoot } from './trusted-memory-filesystem.js';
import type { AutoMemoryExtractCursor, AutoMemoryMetadata } from './types.js';

const pending = new Map<string, Promise<unknown>>();
const debugLogger = createDebugLogger('PROJECT_MEMORY_COMMIT');
const EMPTY_CURSOR_TIMESTAMP = new Date(0).toISOString();

async function trustedStateDirectory(
  root: string,
  create: boolean,
  owner?: ProjectMemoryOwner,
): Promise<string> {
  const anchor = getMemoryRootTrustedAnchor(root, owner);
  const directory = path.dirname(root);
  const trusted = await resolveTrustedMemoryRoot(directory, anchor, {
    followRootSymlink: path.relative(anchor, directory) === '',
  });
  if (trusted || !create) return trusted ?? directory;

  const resolved = realpathNearestExisting(directory);
  if (!isSubpath(realpathNearestExisting(anchor), resolved)) {
    throw new Error('Project memory state is outside its runtime directory.');
  }
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

async function readStateFile(file: string): Promise<Buffer> {
  const handle = await openNoFollow(file, { nonBlocking: true });
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Project memory state requires a regular file: ${file}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readState<T>(
  root: string,
  filename: string,
  owner?: ProjectMemoryOwner,
): Promise<T> {
  const directory = await trustedStateDirectory(root, false, owner);
  const contents = await readStateFile(path.join(directory, filename));
  return JSON.parse(contents.toString('utf-8')) as T;
}

export async function withProjectMemoryCommit<T>(
  memoryRoot: string,
  operation: () => Promise<T>,
  owner?: ProjectMemoryOwner,
): Promise<T> {
  const queueKey = getProjectMemoryQueueKey(memoryRoot);
  const previous = pending.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const target = path.join(
        await trustedStateDirectory(memoryRoot, true, owner),
        `.${path.basename(memoryRoot)}-commit`,
      );
      const release = await lockfile.lock(target, {
        realpath: false,
        retries: { retries: 120, minTimeout: 10, maxTimeout: 100 },
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  pending.set(queueKey, next);
  try {
    return await next;
  } finally {
    if (pending.get(queueKey) === next) pending.delete(queueKey);
  }
}

export function getProjectMemoryQueueKey(memoryRoot: string): string {
  return realpathNearestExisting(memoryRoot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeProjectMemoryCursor(value: unknown): {
  cursor: AutoMemoryExtractCursor;
  needsRepair: boolean;
} {
  const raw = isRecord(value) ? value : {};
  const {
    sessionId,
    processedOffset,
    projectIndexRebuildPending,
    sessions,
    updatedAt: rawUpdatedAt,
    ...extra
  } = raw;
  const updatedAt =
    typeof rawUpdatedAt === 'string' ? rawUpdatedAt : EMPTY_CURSOR_TIMESTAMP;
  let needsRepair =
    typeof rawUpdatedAt !== 'string' ||
    (sessionId !== undefined && typeof sessionId !== 'string') ||
    (projectIndexRebuildPending !== undefined &&
      projectIndexRebuildPending !== true);
  const checkedOffset = (offset: unknown): number | undefined => {
    if (offset === undefined) return undefined;
    if (
      typeof offset === 'number' &&
      Number.isSafeInteger(offset) &&
      offset >= 0
    ) {
      return offset;
    }
    needsRepair = true;
    return 0;
  };
  const offset = checkedOffset(processedOffset);
  const cursor: AutoMemoryExtractCursor = {
    ...extra,
    ...(typeof sessionId === 'string' && { sessionId }),
    ...(offset !== undefined && { processedOffset: offset }),
    ...(projectIndexRebuildPending === true && { projectIndexRebuildPending }),
    updatedAt,
  };
  if (isRecord(sessions)) {
    cursor.sessions = Object.fromEntries(
      Object.entries(sessions).map(([id, session]) => {
        if (!isRecord(session)) {
          needsRepair = true;
          return [id, { processedOffset: 0, updatedAt }];
        }
        return [
          id,
          {
            processedOffset: checkedOffset(session['processedOffset']),
            updatedAt:
              typeof session['updatedAt'] === 'string'
                ? session['updatedAt']
                : updatedAt,
          },
        ];
      }),
    );
  } else if (sessions !== undefined) {
    needsRepair = true;
  }
  return { cursor, needsRepair };
}

async function loadProjectMemoryCursor(
  memoryRoot: string,
  owner: ProjectMemoryOwner | undefined,
  repair: boolean,
): Promise<AutoMemoryExtractCursor | undefined> {
  const directory = await trustedStateDirectory(memoryRoot, false, owner);
  const file = path.join(directory, AUTO_MEMORY_EXTRACT_CURSOR_FILENAME);
  let contents: Buffer | undefined;
  try {
    contents = await readStateFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code !== 'EACCES') throw error;
    const stats = await fs.lstat(file);
    if (
      !stats.isFile() ||
      stats.uid !== process.geteuid?.() ||
      (stats.mode & 0o400) !== 0
    ) {
      throw error;
    }
  }
  let raw: unknown;
  try {
    if (contents) raw = JSON.parse(contents.toString('utf-8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const { cursor, needsRepair } = decodeProjectMemoryCursor(raw);
  if (!needsRepair) return cursor;

  cursor.projectIndexRebuildPending = true;
  if (repair) {
    const backup = `${file}.${randomUUID()}.corrupted`;
    // Leave the original in place until the replacement has the pending bit.
    if (contents) {
      await fs.writeFile(backup, contents, { flag: 'wx', mode: 0o600 });
    } else {
      await fs.link(file, backup);
    }
    await writeCursorFile(file, cursor, contents === undefined);
    debugLogger.warn('Preserved an invalid project memory cursor at', backup);
  }
  return cursor;
}

export function readProjectMemoryCursor(
  memoryRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<AutoMemoryExtractCursor | undefined> {
  return loadProjectMemoryCursor(memoryRoot, owner, false);
}

/** Read and repair a cursor while holding the project commit lock. */
export function readProjectMemoryCursorLocked(
  memoryRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<AutoMemoryExtractCursor | undefined> {
  return loadProjectMemoryCursor(memoryRoot, owner, true);
}

function writeCursorFile(
  file: string,
  cursor: AutoMemoryExtractCursor,
  restoreReadPermission = false,
): Promise<void> {
  return atomicWriteFile(file, `${JSON.stringify(cursor, null, 2)}\n`, {
    encoding: 'utf-8',
    noFollow: true,
    ...(restoreReadPermission && { mode: 0o600, forceMode: true }),
  });
}

export function writeProjectMemoryCursorLocked(
  memoryRoot: string,
  cursor: AutoMemoryExtractCursor,
): Promise<void> {
  return writeCursorFile(
    path.join(path.dirname(memoryRoot), AUTO_MEMORY_EXTRACT_CURSOR_FILENAME),
    cursor,
  );
}

export async function markProjectMemoryIndexPendingLocked(
  memoryRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<void> {
  const cursor = (await readProjectMemoryCursorLocked(memoryRoot, owner)) ?? {
    updatedAt: EMPTY_CURSOR_TIMESTAMP,
  };
  if (!cursor.projectIndexRebuildPending) {
    await writeProjectMemoryCursorLocked(memoryRoot, {
      ...cursor,
      projectIndexRebuildPending: true,
    });
  }
}

export async function updateProjectMemoryMetadata(
  projectRoot: string,
  now: Date,
  update: (metadata: AutoMemoryMetadata) => void,
  owner?: ProjectMemoryOwner,
): Promise<void> {
  const root = getAutoMemoryRoot(projectRoot, owner);
  await withProjectMemoryCommit(
    root,
    async () => {
      const filePath = path.join(
        path.dirname(root),
        AUTO_MEMORY_METADATA_FILENAME,
      );
      const metadata = await readState<AutoMemoryMetadata>(
        root,
        AUTO_MEMORY_METADATA_FILENAME,
        owner,
      );
      update(metadata);
      const updatedAt = now.toISOString();
      if (updatedAt > metadata.updatedAt) metadata.updatedAt = updatedAt;
      await atomicWriteFile(
        filePath,
        `${JSON.stringify(metadata, null, 2)}\n`,
        {
          encoding: 'utf-8',
          noFollow: true,
        },
      );
    },
    owner,
  );
}

export function readProjectMemoryMetadata(
  projectRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<AutoMemoryMetadata> {
  return readState<AutoMemoryMetadata>(
    getAutoMemoryRoot(projectRoot, owner),
    AUTO_MEMORY_METADATA_FILENAME,
    owner,
  );
}
