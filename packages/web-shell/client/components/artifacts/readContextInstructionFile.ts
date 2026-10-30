/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonCapabilities, DaemonClient } from '@qwen-code/sdk/daemon';
import { resolveArtifactWorkspaceOwner } from './useArtifactWorkspaceTarget.js';

/**
 * Read a context instruction file for the read-only preview.
 *
 * The read goes through the session's owning workspace, never the primary:
 * a secondary workspace's file is outside the primary sandbox and the
 * primary file route rejects it. The backend only exposes an `absolutePath`
 * for files this preview can open, so a path inside the workspace is read
 * through that workspace's file route, and a path outside it must be a
 * global memory file, served by the (workspace-independent) memory route.
 */
export async function readContextInstructionFile(
  client: DaemonClient,
  capabilities: DaemonCapabilities | undefined,
  workspaceCwd: string,
  absolutePath: string,
): Promise<string> {
  const owner = resolveArtifactWorkspaceOwner(capabilities, workspaceCwd);
  if (!owner) {
    throw new Error('The workspace for this file is not available.');
  }
  const insideWorkspace =
    absolutePath === owner.cwd ||
    absolutePath.startsWith(`${owner.cwd}/`) ||
    absolutePath.startsWith(`${owner.cwd}\\`);
  if (insideWorkspace) {
    const scoped = owner.primary ? client : client.workspaceByCwd(owner.cwd);
    const { content } = await scoped.readWorkspaceFile(absolutePath, {
      maxBytes: 256 * 1024,
    });
    return content;
  }
  const status = await client.workspaceMemory({ includeContent: true });
  const match = status.files.find((item) => item.path === absolutePath);
  if (typeof match?.content !== 'string') {
    throw new Error(`No readable memory file at ${absolutePath}`);
  }
  return match.content;
}
