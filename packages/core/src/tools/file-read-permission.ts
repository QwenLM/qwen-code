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
import { isSubpaths, realpathNearestExisting } from '../utils/paths.js';

export function getFileReadDefaultPermission(
  config: Config,
  requestedPath: string,
): PermissionDecision {
  // Every allowed root below is agent-writable, so a lexical check classifies
  // a planted `link -> ~/.aws/credentials` by where it sits and grants 'allow'
  // with no prompt. Keep the leading path.resolve: it collapses `..` before any
  // link is followed, matching how the read tools resolve before opening, so
  // the decision and the open agree on which bytes are meant.
  const filePath = realpathNearestExisting(path.resolve(requestedPath));
  const workspaceContext = config.getWorkspaceContext();

  // SYNC: Keep these base roots and the auto-memory check below aligned with
  // AcpAgent.buildAcpLocalReadRoots' mirrored ReadFileTool group. ACP may
  // append fallback-only roots after that group.
  //
  // Roots are canonicalized too: resolving only the candidate would cost an
  // extra prompt whenever a root sits behind a symlink (macOS /var). Safe here
  // because these roots are anchored in the user's home / runtime dir, never
  // derived from repo-tracked contents.
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
  ].map(realpathNearestExisting);

  if (
    workspaceContext.isPathWithinWorkspace(filePath) ||
    isSubpaths(allowedRoots, filePath) ||
    // isAnyAutoMemPath narrows to the managed auto-memory roots
    // (per-project + user-level under ~/.qwen/memories/) — never the
    // broad getMemoryBaseDir() — to avoid exposing sensitive ~/.qwen
    // files such as settings.json or OAuth credentials.
    //
    // Asymmetric with allowedRoots on purpose: the candidate is canonicalized
    // but the memory roots stay lexical. In local-memory mode that root sits
    // under a repo-tracked `.qwen/`, so canonicalizing it would let a checked-in
    // `.qwen -> /outside` relocate the allowed root — see
    // getAutoMemoryTrustedAnchor. Candidate-only is fail-closed and still
    // refuses a link planted inside the root.
    isAnyAutoMemPath(filePath, config.getTargetDir())
  ) {
    return 'allow';
  }
  return 'ask';
}
