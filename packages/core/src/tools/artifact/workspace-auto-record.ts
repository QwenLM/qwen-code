/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import type { ToolArtifact, ToolArtifactKind } from '../tools.js';
import {
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_WORKSPACE_PATH_MAX_LENGTH,
  hasControlCharacter,
  hasUnsafeDisplayPayload,
} from '../record-artifact.js';
import {
  OFFICE_DOCUMENT_EXTENSIONS,
  pathHasSkippedDirectoryComponent,
} from '../../utils/workspace-artifact-directory.js';
import { toCanonicalWorkspaceArtifactPath } from '../../utils/workspace-artifact-path.js';
import { getSpecificMimeType } from '../../utils/fileUtils.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKSPACE_AUTO_RECORD');

const ARTIFACT_KIND_BY_EXTENSION = new Map<string, ToolArtifactKind>([
  ['.csv', 'file'],
  ['.htm', 'html'],
  ['.html', 'html'],
  ['.ipynb', 'notebook'],
  ['.jpeg', 'image'],
  ['.jpg', 'image'],
  ['.json', 'file'],
  ['.md', 'file'],
  ['.pdf', 'pdf'],
  ['.png', 'image'],
  ['.py', 'file'],
  ['.sql', 'file'],
  ['.svg', 'image'],
  ['.webp', 'image'],
]);
for (const ext of OFFICE_DOCUMENT_EXTENSIONS) {
  ARTIFACT_KIND_BY_EXTENSION.set(ext, 'document');
}

export type WorkspaceToolArtifact = ToolArtifact & {
  storage: 'workspace';
  workspacePath: string;
};

/**
 * Builds the session-artifact candidate for a file a built-in tool just wrote.
 * Artifact-like extensions yield a normal candidate; any other workspace file,
 * or one written with `recordAsArtifact: false`, yields an `updateOnly`
 * candidate that only refreshes an artifact the session already has.
 */
export function buildWorkspaceArtifactCandidate(
  config: Config,
  filePath: string,
  options: { recordAsArtifact?: boolean; sizeBytes?: number } = {},
): WorkspaceToolArtifact | null {
  const recorded = resolveRecordedWorkspaceFile(config, filePath);
  if (!recorded) {
    return null;
  }
  const title = path.basename(recorded.filePath);
  // The daemon store rejects titles and paths that are too long, carry control
  // characters, or contain markup; skip the artifact rather than tell the model
  // it was recorded when it will be dropped.
  if (
    title.length > ARTIFACT_TITLE_MAX_LENGTH ||
    hasControlCharacter(title) ||
    hasUnsafeDisplayPayload(title) ||
    recorded.workspacePath.length > ARTIFACT_WORKSPACE_PATH_MAX_LENGTH ||
    hasControlCharacter(recorded.workspacePath) ||
    hasUnsafeDisplayPayload(recorded.workspacePath)
  ) {
    debugLogger.debug('workspace artifact skipped (safety checks)', {
      path: filePath,
    });
    return null;
  }
  const kind = ARTIFACT_KIND_BY_EXTENSION.get(
    path.extname(recorded.filePath).toLowerCase(),
  );
  return {
    title,
    kind: kind ?? 'file',
    storage: 'workspace',
    workspacePath: recorded.workspacePath,
    mimeType:
      getSpecificMimeType(recorded.filePath) ??
      (recorded.filePath.toLowerCase().endsWith('.ipynb')
        ? 'application/x-ipynb+json'
        : undefined),
    sizeBytes: options.sizeBytes,
    ...(kind === undefined || options.recordAsArtifact === false
      ? { updateOnly: true }
      : {}),
  };
}

/** The candidate for an artifact-like file, or null for any other file. */
export function buildWorkspaceArtifactMetadata(
  config: Config,
  filePath: string,
  sizeBytes?: number,
): WorkspaceToolArtifact | null {
  const artifact = buildWorkspaceArtifactCandidate(config, filePath, {
    sizeBytes,
  });
  return artifact && !artifact.updateOnly ? artifact : null;
}

/**
 * Kept for the cross-package contract test in `workspace-file-read.test.ts`:
 * the daemon's `GET /file` route resolves the `workspacePath` this produces.
 * Delegates to `buildWorkspaceArtifactMetadata` so the two agree by construction.
 */
export function buildRecordArtifactReminder(
  config: Config,
  filePath: string,
): string | null {
  const artifact = buildWorkspaceArtifactMetadata(config, filePath);
  return artifact ? formatRecordArtifactReminder(artifact.workspacePath) : null;
}

export function formatRecordArtifactReminder(workspacePath: string): string {
  return (
    `This file was automatically recorded as a workspace artifact with ` +
    `workspacePath "${workspacePath}". No extra artifact registration step ` +
    `is needed.`
  );
}

function resolveRecordedWorkspaceFile(
  config: Config,
  filePath: string,
): { filePath: string; workspacePath: string } | null {
  if (!config.isRecordArtifactEnabled()) {
    return null;
  }
  let resolvedFile = filePath;
  let resolvedRoot = config.getTargetDir();
  try {
    if (!config.getFileSystemService().textFileIo) {
      resolvedFile = fs.realpathSync(filePath);
      resolvedRoot = fs.realpathSync(resolvedRoot);
    }
  } catch {
    // Keep the lexical path when the file or root cannot be realpath'd yet.
  }
  const workspacePath = toCanonicalWorkspaceArtifactPath(
    resolvedFile,
    resolvedRoot,
  );
  if (!workspacePath) {
    return null;
  }
  if (pathHasSkippedDirectoryComponent(workspacePath)) {
    return null;
  }
  return { filePath: resolvedFile, workspacePath };
}
