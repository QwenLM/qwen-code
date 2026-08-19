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

export async function collectRecordableWorkspaceFiles(
  absoluteDir: string,
  relativeDir: string,
  realWorkspace: string,
  isRecordable?: (relativePath: string) => boolean,
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
  isRecordable?: (relativePath: string) => boolean,
): Promise<{ truncated: boolean; depthLimited: boolean; unreadable: boolean }> {
  if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
    return { truncated: true, depthLimited: false, unreadable: false };
  }
  if (depth > MAX_DIRECTORY_ARTIFACT_DEPTH) {
    try {
      const peek = await fs.readdir(absoluteDir);
      return {
        truncated: false,
        depthLimited: peek.length > 0,
        unreadable: false,
      };
    } catch {
      return { truncated: false, depthLimited: false, unreadable: true };
    }
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) {
      throw error;
    }
    return { truncated: false, depthLimited: false, unreadable: true };
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  let truncated = false;
  let depthLimited = false;
  let unreadable = false;
  for (const entry of entries) {
    if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
      return { truncated: true, depthLimited, unreadable };
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
      if (truncated && files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
        return { truncated: true, depthLimited, unreadable };
      }
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) {
        continue;
      }
      if (isRecordable && !isRecordable(relativePath)) {
        continue;
      }
      files.push(relativePath);
    }
  }
  return { truncated, depthLimited, unreadable };
}

function isOutsidePath(relative: string): boolean {
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
