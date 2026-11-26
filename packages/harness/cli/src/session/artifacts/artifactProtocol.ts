/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

export const PRESENT_FILES_TOOL_NAME = 'mcp__qw-builtin__present_files';

export type PresentFilesToolFile = SDKArtifactInfo & {
  file_path: string;
};

export interface PresentFilesToolUseResult {
  type: 'present_files';
  files: PresentFilesToolFile[];
  isHardFailure: boolean;
}

export function createPresentFilesToolUseResult(
  artifacts: readonly SDKArtifactInfo[],
  isHardFailure = false,
): PresentFilesToolUseResult {
  return {
    type: 'present_files',
    files: artifacts.map((artifact) => ({
      ...cloneArtifactEntry(artifact),
      file_path: artifact.path,
    })),
    isHardFailure,
  };
}

export function cloneArtifactEntry(entry: SDKArtifactInfo): SDKArtifactInfo {
  return {
    ...entry,
    ...(entry.group ? { group: { ...entry.group } } : {}),
  };
}
