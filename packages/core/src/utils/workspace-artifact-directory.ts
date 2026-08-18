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

const OFFICE_DOCUMENT_EXTENSIONS = new Set([
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
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const truncated = await walkRecordableWorkspaceFiles(
    absoluteDir,
    relativeDir,
    realWorkspace,
    files,
    0,
  );
  return { files, truncated };
}

async function walkRecordableWorkspaceFiles(
  absoluteDir: string,
  relativeDir: string,
  realWorkspace: string,
  files: string[],
  depth: number,
): Promise<boolean> {
  if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
    return true;
  }
  if (depth > MAX_DIRECTORY_ARTIFACT_DEPTH) {
    return false;
  }
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
      return true;
    }
    if (shouldSkipDirectoryArtifactName(entry.name) || entry.isSymbolicLink()) {
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
      const truncated = await walkRecordableWorkspaceFiles(
        absolutePath,
        relativePath,
        realWorkspace,
        files,
        depth + 1,
      );
      if (truncated) {
        return true;
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
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
