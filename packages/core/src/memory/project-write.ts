/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
  assertSandboxFileVersion,
  type SandboxFileVersion,
} from '../sandbox/file-version.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { isSubpath, realpathNearestExisting } from '../utils/paths.js';
import { rebuildProjectMemoryIndexLocked } from './indexer.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getMemoryRootTrustedAnchor,
} from './paths.js';
import {
  assertProjectMemoryCommit,
  markProjectMemoryIndexPendingLocked,
  withProjectMemoryCommit,
} from './project-commit.js';
import { resolveTrustedMemoryRoot } from './trusted-memory-filesystem.js';

const debugLogger = createDebugLogger('PROJECT_MEMORY_WRITE');

const INDEX_WRITE_ERROR =
  'The project MEMORY.md index is generated automatically. Write a topic file.';

export function getProjectMemoryWriteRoot(
  root: string,
  filePath: string,
  followAliases = true,
): string | undefined {
  if (
    isSubpath(root, filePath) ||
    (followAliases &&
      isSubpath(
        realpathNearestExisting(root),
        realpathNearestExisting(filePath),
      ))
  ) {
    return root;
  }
  return undefined;
}

export function projectMemoryIndexWriteError(
  memoryRoot: string,
  filePath: string,
  followAliases = true,
): string | undefined {
  const root = getProjectMemoryWriteRoot(memoryRoot, filePath, followAliases);
  return root &&
    isIndex(
      path.join(root, AUTO_MEMORY_INDEX_FILENAME),
      filePath,
      followAliases,
    )
    ? INDEX_WRITE_ERROR
    : undefined;
}

function isIndex(
  indexPath: string,
  candidate: string,
  followAliases = true,
): boolean {
  return (
    path.relative(indexPath.toLowerCase(), candidate.toLowerCase()) === '' ||
    (followAliases &&
      path.relative(
        realpathNearestExisting(indexPath),
        realpathNearestExisting(candidate),
      ) === '')
  );
}

function prepareTopicCommit(
  root: string,
  resolvedRoot: string,
  filePath: string,
  expected: SandboxFileVersion | null,
): () => void {
  const resolvedFile = realpathNearestExisting(filePath);
  if (resolvedFile === resolvedRoot || !isSubpath(resolvedRoot, resolvedFile)) {
    throw new Error(
      'Project memory topic must resolve inside its memory directory.',
    );
  }
  if (isIndex(path.join(root, AUTO_MEMORY_INDEX_FILENAME), filePath)) {
    throw new Error(INDEX_WRITE_ERROR);
  }
  return () => {
    assertProjectMemoryCommit();
    if (
      lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink() ||
      realpathNearestExisting(filePath) !== resolvedFile
    ) {
      throw new Error(
        'Project memory topic path changed or is a symbolic link.',
      );
    }
    assertSandboxFileVersion(filePath, expected);
  };
}

async function resolveWriteRoot(root: string): Promise<string> {
  return (
    (await resolveTrustedMemoryRoot(root, getMemoryRootTrustedAnchor(root))) ??
    realpathNearestExisting(root)
  );
}

export async function commitProjectMemoryWrite<T>(
  root: string | undefined,
  filePath: string,
  expected: SandboxFileVersion | null | undefined,
  write: (assertCanCommit?: () => void) => Promise<T>,
): Promise<T> {
  if (!root) return write();
  if (expected === undefined)
    throw new Error('Missing project memory topic version.');
  return withProjectMemoryCommit(root, async () => {
    const assertCanCommit = prepareTopicCommit(
      root,
      await resolveWriteRoot(root),
      filePath,
      expected,
    );
    assertCanCommit();
    const isTopic = path.extname(filePath) === '.md';
    if (isTopic) await markProjectMemoryIndexPendingLocked(root);
    const result = await write(assertCanCommit);
    if (!isTopic) return result;
    try {
      await rebuildProjectMemoryIndexLocked(root);
    } catch (error) {
      debugLogger.warn(
        'Project memory topic saved, but index rebuild failed:',
        error,
      );
    }
    return result;
  });
}

export async function commitProjectMemoryWrites(
  root: string,
  changes: ReadonlyArray<{
    path: string;
    expected: SandboxFileVersion | null;
    content: string;
  }>,
  options: { assertTarget?: () => void; signal?: AbortSignal } = {},
): Promise<void> {
  if (changes.length === 0) return;
  const assertTarget = () => {
    options.signal?.throwIfAborted();
    options.assertTarget?.();
  };
  assertTarget();
  await withProjectMemoryCommit(root, async () => {
    assertTarget();
    const resolvedRoot = await resolveWriteRoot(root);
    const seen = new Set<string>();
    const prepared = changes.map((change) => {
      const resolved = realpathNearestExisting(change.path);
      const key = resolved.toLowerCase();
      if (
        path.extname(change.path) !== '.md' ||
        !path.isAbsolute(change.path) ||
        resolved !==
          path.join(resolvedRoot, path.relative(root, change.path)) ||
        seen.has(key)
      ) {
        throw new Error(`Invalid project memory topic path: ${change.path}`);
      }
      seen.add(key);
      const assertVersion = prepareTopicCommit(
        root,
        resolvedRoot,
        change.path,
        change.expected,
      );
      assertVersion();
      return { ...change, assertVersion };
    });
    assertTarget();
    await markProjectMemoryIndexPendingLocked(root);
    for (const change of prepared) {
      await fs.mkdir(path.dirname(change.path), { recursive: true });
      await atomicWriteFile(change.path, change.content, {
        encoding: 'utf-8',
        noFollow: true,
        requireAtomic: true,
        assertCanCommit: () => {
          assertTarget();
          change.assertVersion();
        },
      });
    }
    await rebuildProjectMemoryIndexLocked(root);
  });
}
