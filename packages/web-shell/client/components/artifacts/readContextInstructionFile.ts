/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonCapabilities, DaemonClient } from '@qwen-code/sdk/daemon';
import { resolveArtifactWorkspaceOwner } from './useArtifactWorkspaceTarget.js';

export interface ContextInstructionFileContent {
  content: string;
  /** True when the served text is only the beginning of the file. */
  truncated: boolean;
}

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
): Promise<ContextInstructionFileContent> {
  const owner = resolveArtifactWorkspaceOwner(capabilities, workspaceCwd);
  if (!owner) {
    throw new Error('The workspace for this file is not available.');
  }
  // Agree with the producer's isSubpath containment, including a
  // filesystem-root workspace ('/' or 'C:\'): a naive `${cwd}/` prefix would
  // double the separator there and miss every file.
  const prefix = /[\\/]$/.test(owner.cwd) ? owner.cwd : `${owner.cwd}/`;
  const insideWorkspace =
    absolutePath === owner.cwd ||
    absolutePath.startsWith(prefix) ||
    absolutePath.startsWith(prefix.replace(/\/$/, '\\'));
  if (insideWorkspace) {
    const scoped = owner.primary ? client : client.workspaceByCwd(owner.cwd);
    const { content, truncated } = await scoped.readWorkspaceFile(
      absolutePath,
      {
        maxBytes: 256 * 1024,
      },
    );
    return { content, truncated: truncated === true };
  }
  const status = await client.workspaceMemory({ includeContent: true });
  const match = status.files.find((item) => item.path === absolutePath);
  if (!match) {
    throw new Error(`No readable memory file at ${absolutePath}`);
  }
  if (typeof match.content !== 'string') {
    // The route keeps the entry but withholds content for bytes that are not
    // BOM-free UTF-8 (or a torn read). The file exists; it just cannot be
    // shown as text — distinct from a path the route does not list at all.
    throw new Error(
      `Memory file ${absolutePath} could not be read as UTF-8 text.`,
    );
  }
  return { content: match.content, truncated: match.truncated === true };
}
