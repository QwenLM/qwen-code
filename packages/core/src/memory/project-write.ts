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
  type ProjectMemoryOwner,
} from './paths.js';
import {
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

function assertTopicVersion(
  root: string,
  resolvedRoot: string,
  filePath: string,
  expected: SandboxFileVersion | null,
): void {
  const resolvedFile = realpathNearestExisting(filePath);
  if (resolvedFile === resolvedRoot || !isSubpath(resolvedRoot, resolvedFile)) {
    throw new Error(
      'Project memory topic must resolve inside its memory directory.',
    );
  }
  if (isIndex(path.join(root, AUTO_MEMORY_INDEX_FILENAME), filePath)) {
    throw new Error(INDEX_WRITE_ERROR);
  }
  if (lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('Project memory topic is a symbolic link.');
  }
  assertSandboxFileVersion(filePath, expected);
}

async function resolveWriteRoot(
  root: string,
  owner?: ProjectMemoryOwner,
): Promise<string> {
  return (
    (await resolveTrustedMemoryRoot(
      root,
      getMemoryRootTrustedAnchor(root, owner),
    )) ?? realpathNearestExisting(root)
  );
}

export async function commitProjectMemoryWrite(
  root: string,
  filePath: string,
  expected: SandboxFileVersion | null | undefined,
  content: string | Buffer,
  owner?: ProjectMemoryOwner,
): Promise<void> {
  if (expected === undefined)
    throw new Error('Missing project memory topic version.');
  await withProjectMemoryCommit(
    root,
    async () => {
      const resolvedRoot = await resolveWriteRoot(root, owner);
      assertTopicVersion(root, resolvedRoot, filePath, expected);
      const isTopic = path.extname(filePath) === '.md';
      if (isTopic) await markProjectMemoryIndexPendingLocked(root, owner);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      assertTopicVersion(root, resolvedRoot, filePath, expected);
      await atomicWriteFile(filePath, content, { noFollow: true });
      if (!isTopic) return;
      try {
        await rebuildProjectMemoryIndexLocked(root, owner);
      } catch (error) {
        debugLogger.warn(
          'Project memory topic saved, but index rebuild failed:',
          error,
        );
      }
    },
    owner,
  );
}

export async function commitProjectMemoryWrites(
  root: string,
  changes: ReadonlyArray<{
    path: string;
    expected: SandboxFileVersion | null;
    content: string;
  }>,
  options: {
    owner?: ProjectMemoryOwner;
    assertTarget?: () => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (changes.length === 0) return;
  const assertTarget = () => {
    options.signal?.throwIfAborted();
    options.assertTarget?.();
  };
  assertTarget();
  await withProjectMemoryCommit(
    root,
    async () => {
      assertTarget();
      const resolvedRoot = await resolveWriteRoot(root, options.owner);
      const validate = (change: (typeof changes)[number]) => {
        const resolved = realpathNearestExisting(change.path);
        if (
          path.extname(change.path) !== '.md' ||
          !path.isAbsolute(change.path) ||
          resolved !== path.join(resolvedRoot, path.relative(root, change.path))
        ) {
          throw new Error(`Invalid project memory topic path: ${change.path}`);
        }
        assertTopicVersion(root, resolvedRoot, change.path, change.expected);
        return resolved.toLowerCase();
      };
      const seen = new Set<string>();
      for (const change of changes) {
        const key = validate(change);
        if (seen.has(key)) {
          throw new Error(
            `Duplicate project memory topic path: ${change.path}`,
          );
        }
        seen.add(key);
      }
      assertTarget();
      await markProjectMemoryIndexPendingLocked(root, options.owner);
      for (const change of changes) {
        await fs.mkdir(path.dirname(change.path), { recursive: true });
        assertTarget();
        validate(change);
        await atomicWriteFile(change.path, change.content, { noFollow: true });
      }
      await rebuildProjectMemoryIndexLocked(root, options.owner);
    },
    options.owner,
  );
}
