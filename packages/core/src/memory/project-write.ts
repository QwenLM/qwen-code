/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { lstatSync } from 'node:fs';
import {
  assertSandboxFileVersion,
  type SandboxFileVersion,
} from '../sandbox/file-version.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isSubpath,
  QWEN_DIR,
  realpathNearestExisting,
} from '../utils/paths.js';
import { rebuildProjectMemoryIndexLocked } from './indexer.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_DIRNAME,
  getAutoMemoryRoot,
  getAutoMemoryTrustedAnchor,
  getMemoryProjectOwner,
  getMemoryRootTrustedAnchor,
} from './paths.js';
import {
  assertProjectMemoryCommit,
  withProjectMemoryCommit,
} from './project-commit.js';
import { resolveTrustedMemoryRoot } from './trusted-memory-filesystem.js';

const debugLogger = createDebugLogger('PROJECT_MEMORY_WRITE');

const INDEX_WRITE_ERROR =
  'The project MEMORY.md index is generated automatically. Write a topic file instead.';

export function getProjectMemoryWriteRoot(
  projectRoot: string,
  filePath: string,
  followAliases = true,
): string | undefined {
  if (!followAliases) {
    const anchor = getAutoMemoryTrustedAnchor(projectRoot);
    const owner = getMemoryProjectOwner(projectRoot);
    if (
      !isSubpath(path.join(anchor, 'projects'), filePath) &&
      !isSubpath(path.join(anchor, 'project-memory'), filePath) &&
      !isSubpath(path.join(owner, QWEN_DIR, AUTO_MEMORY_DIRNAME), filePath)
    ) {
      return undefined;
    }
  }
  const root = getAutoMemoryRoot(projectRoot);
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
  projectRoot: string,
  filePath: string,
  followAliases = true,
): string | undefined {
  const root = getProjectMemoryWriteRoot(projectRoot, filePath, followAliases);
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

export async function commitProjectMemoryWrite<T>(
  root: string | undefined,
  filePath: string,
  expected: SandboxFileVersion | null | undefined,
  write: (assertCanCommit?: () => void) => Promise<T>,
): Promise<T> {
  if (!root) return write();
  return withProjectMemoryCommit(root, async () => {
    const resolvedRoot = await resolveTrustedMemoryRoot(
      root,
      getMemoryRootTrustedAnchor(root),
    );
    const resolvedFile = realpathNearestExisting(filePath);
    if (
      !isSubpath(resolvedRoot ?? realpathNearestExisting(root), resolvedFile)
    ) {
      throw new Error(
        'Project memory topic must resolve inside its memory directory.',
      );
    }
    if (isIndex(path.join(root, AUTO_MEMORY_INDEX_FILENAME), filePath)) {
      throw new Error(INDEX_WRITE_ERROR);
    }
    if (expected === undefined)
      throw new Error('Missing project memory topic version.');
    const assertCanCommit = () => {
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
    assertCanCommit();
    const result = await write(assertCanCommit);
    if (path.extname(filePath) !== '.md') return result;
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
