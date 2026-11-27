/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_DIRECTORY_ARTIFACT_FILES = 100;
export const MAX_DIRECTORY_ARTIFACT_DEPTH = 4;

const SKIP_DIRECTORY_ARTIFACT_NAMES = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'dist',
  '.qwen',
]);

export const OFFICE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.dotx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.ppt',
  '.pptx',
  '.pptm',
  '.odt',
  '.ods',
  '.odp',
]);

export type RecordableWorkspaceWalkResult = {
  files: string[];
  truncated: boolean;
  depthLimited: boolean;
  unreadable: boolean;
  skippedUnrecordable: number;
};

export function isOfficeDocumentExtension(ext: string): boolean {
  return OFFICE_DOCUMENT_EXTENSIONS.has(ext);
}

export function shouldSkipDirectoryArtifactName(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('~$') ||
    SKIP_DIRECTORY_ARTIFACT_NAMES.has(name)
  );
}

const WORKTREE_ARTIFACT_PREFIX_RE = /^\.qwen\/worktrees\/[^/]+\//;

/**
 * Bound-root-canonical paths from a worktree session always start with
 * `.qwen/worktrees/<slug>/`. That leading `.qwen` must not itself trip the
 * skip-directory gate for ordinary subdirectories inside the worktree.
 */
export function stripWorktreeArtifactPrefix(workspacePath: string): string {
  return workspacePath.replace(WORKTREE_ARTIFACT_PREFIX_RE, '');
}

export function pathHasSkippedDirectoryComponent(
  workspacePath: string,
): boolean {
  return stripWorktreeArtifactPrefix(workspacePath)
    .split('/')
    .filter(Boolean)
    .some((segment) => shouldSkipDirectoryArtifactName(segment));
}

/**
 * True when a proper ancestor directory of a workspace-root-relative file
 * path is named in the artifact skip list (node_modules, .git, __pycache__,
 * dist, .qwen). This is the issue #17453 direct-file contract: such paths
 * are never surfaced by the Artifacts panel, independent of ignore files.
 * The file's own name does not count: a regular file named "dist" at the
 * workspace root is a panel-visible file. Callers pass a path that is
 * already worktree-stripped (see stripWorktreeArtifactPrefix).
 */
export function pathHasSkippedArtifactDirectoryAncestor(
  workspaceFilePath: string,
): boolean {
  return workspaceFilePath
    .split('/')
    .filter(Boolean)
    .slice(0, -1)
    .some((segment) => SKIP_DIRECTORY_ARTIFACT_NAMES.has(segment));
}

/**
 * True when the Artifacts panel cannot surface the directory itself: the
 * directory or a proper ancestor above it is named in the artifact skip
 * list (node_modules, .git, __pycache__, dist, .qwen) — the same 5-name
 * contract the direct-file gate applies, so a directory expansion refuses
 * only directories the gate would refuse file by file. A dot-named
 * directory such as `.github` that the panel actually lists is not
 * flagged. Callers pass an already worktree-stripped path (see
 * stripWorktreeArtifactPrefix).
 */
export function pathIsOrSitsUnderSkippedArtifactDirectory(
  workspaceDirPath: string,
): boolean {
  const segments = workspaceDirPath.split('/').filter(Boolean);
  const ownName = segments.at(-1);
  return (
    (ownName !== undefined && SKIP_DIRECTORY_ARTIFACT_NAMES.has(ownName)) ||
    pathHasSkippedArtifactDirectoryAncestor(workspaceDirPath)
  );
}

export async function collectRecordableWorkspaceFiles(
  absoluteDir: string,
  relativeDir: string,
  realWorkspace: string,
  /**
   * Predicate over each child's workspace-root-relative path (relativeDir
   * plus the child's path below it), so callers can judge the path the
   * Artifacts panel would show.
   */
  isRecordable?: (workspaceRelativePath: string) => boolean,
): Promise<RecordableWorkspaceWalkResult> {
  const files: string[] = [];
  const walked = await walkRecordableWorkspaceFiles(
    absoluteDir,
    relativeDir,
    realWorkspace,
    files,
    0,
    isRecordable,
  );
  return { files, ...walked };
}

async function walkRecordableWorkspaceFiles(
  absoluteDir: string,
  relativeDir: string,
  realWorkspace: string,
  files: string[],
  depth: number,
  isRecordable?: (workspaceRelativePath: string) => boolean,
): Promise<{
  truncated: boolean;
  depthLimited: boolean;
  unreadable: boolean;
  skippedUnrecordable: number;
}> {
  if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
    return {
      truncated: true,
      depthLimited: false,
      unreadable: false,
      skippedUnrecordable: 0,
    };
  }
  if (depth > MAX_DIRECTORY_ARTIFACT_DEPTH) {
    return {
      truncated: false,
      depthLimited: await hasRecordableDescendant(
        absoluteDir,
        relativeDir,
        8,
        isRecordable,
      ),
      unreadable: false,
      skippedUnrecordable: 0,
    };
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) {
      throw error;
    }
    return {
      truncated: false,
      depthLimited: false,
      unreadable: true,
      skippedUnrecordable: 0,
    };
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  let truncated = false;
  let depthLimited = false;
  let unreadable = false;
  let skippedUnrecordable = 0;
  for (const entry of entries) {
    if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
      return { truncated: true, depthLimited, unreadable, skippedUnrecordable };
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativeToWorkspace = path.relative(realWorkspace, absolutePath);
    if (!relativeToWorkspace || isOutsidePath(relativeToWorkspace)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (shouldSkipDirectoryArtifactName(entry.name)) {
        continue;
      }
      const nested = await walkRecordableWorkspaceFiles(
        absolutePath,
        relativePath,
        realWorkspace,
        files,
        depth + 1,
        isRecordable,
      );
      truncated ||= nested.truncated;
      depthLimited ||= nested.depthLimited;
      unreadable ||= nested.unreadable;
      skippedUnrecordable += nested.skippedUnrecordable;
      if (truncated && files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
        return {
          truncated: true,
          depthLimited,
          unreadable,
          skippedUnrecordable,
        };
      }
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) {
        continue;
      }
      if (isRecordable && !isRecordable(relativePath)) {
        skippedUnrecordable++;
        continue;
      }
      files.push(relativePath);
    }
  }
  return { truncated, depthLimited, unreadable, skippedUnrecordable };
}

async function hasRecordableDescendant(
  absoluteDir: string,
  relativeDir: string,
  remainingDepth: number,
  isRecordable?: (workspaceRelativePath: string) => boolean,
): Promise<boolean> {
  if (remainingDepth < 0) {
    return true;
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    // Unreadable over-depth dirs are inconclusive — disclose via depthLimited.
    return true;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    if (
      entry.isFile() &&
      !entry.name.startsWith('.') &&
      !entry.name.startsWith('~$')
    ) {
      if (!isRecordable || isRecordable(relativePath)) {
        return true;
      }
      continue;
    }
    if (entry.isDirectory() && !shouldSkipDirectoryArtifactName(entry.name)) {
      try {
        if (
          await hasRecordableDescendant(
            path.join(absoluteDir, entry.name),
            relativePath,
            remainingDepth - 1,
            isRecordable,
          )
        ) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

function isOutsidePath(relative: string): boolean {
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
