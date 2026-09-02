/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { isAnyAutoMemPath } from '../memory/paths.js';
import type { PermissionDecision } from '../permissions/types.js';
import { isSubpaths } from '../utils/paths.js';

export function getFileReadDefaultPermission(
  config: Config,
  requestedPath: string,
): PermissionDecision {
  const filePath = path.resolve(requestedPath);
  const workspaceContext = config.getWorkspaceContext();

  // SYNC: Keep these base roots and the auto-memory check below aligned with
  // AcpAgent.buildAcpLocalReadRoots' mirrored ReadFileTool group. ACP may
  // append fallback-only roots after that group.
  const allowedRoots = [
    config.storage.getProjectTempDir(),
    // Background subagent transcripts live under <projectDir>/subagents/ and
    // are advertised to the model as polling targets via read_file.
    path.join(config.storage.getProjectDir(), 'subagents'),
    Storage.getGlobalTempDir(),
    ...config.storage.getUserSkillsDirs(),
    Storage.getUserExtensionsDir(),
    // Approved plans are persisted here (default ~/.qwen/plans, outside
    // the workspace) and after approval nothing re-injects the plan text,
    // so the saved file is the model's only recovery route — reading it
    // back must not stall on a confirmation prompt. The dir holds only
    // session plan files, never credentials or settings.
    config.getPlansDir(),
  ];

  if (
    workspaceContext.isPathWithinWorkspace(filePath) ||
    isSubpaths(allowedRoots, filePath) ||
    // isAnyAutoMemPath narrows to the managed auto-memory roots
    // (per-project + user-level under ~/.qwen/memories/) — never the
    // broad getMemoryBaseDir() — to avoid exposing sensitive ~/.qwen
    // files such as settings.json or OAuth credentials.
    isAnyAutoMemPath(filePath, config.getTargetDir())
  ) {
    return 'allow';
  }
  return 'ask';
}
