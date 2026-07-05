/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import {
  canonicalizeWorkspaces,
  createWorkspaceFileSystemFactory,
  type WorkspaceFileSystemFactory,
} from '../fs/index.js';
import type { PathMutexRegistry } from '../fs/workspace-file-system.js';

const IDE_WORKSPACE_PATH_ENV_VAR = 'QWEN_CODE_IDE_WORKSPACE_PATH';

/**
 * Build a no-op fs-audit emitter that logs a warning every
 * `WARN_EVERY` dropped events. The default factory uses this so a
 * regression that silently strips audit events shows up in operator
 * logs instead of disappearing. `runQwenServe` replaces this with a
 * real per-session emit, so legitimate production traffic never hits
 * the warning.
 */
export function createDefaultFsAuditEmit(): (event: BridgeEvent) => void {
  const WARN_EVERY = 100;
  let droppedCount = 0;
  return (event: BridgeEvent) => {
    droppedCount += 1;
    if (droppedCount === 1 || droppedCount % WARN_EVERY === 0) {
      const data = event.data as
        | { errorKind?: string; pathHash?: string; intent?: string }
        | undefined;
      const ctx: string[] = [];
      if (data?.errorKind) ctx.push(`errorKind=${data.errorKind}`);
      if (data?.intent) ctx.push(`intent=${data.intent}`);
      if (data?.pathHash) ctx.push(`pathHash=${data.pathHash}`);
      const ctxStr = ctx.length > 0 ? ` (${ctx.join(' ')})` : '';
      writeStderrLine(
        `qwen serve: fs audit emit is the default no-op — ${droppedCount} event(s) dropped so far. ` +
          `Latest type=${event.type}${ctxStr}. ` +
          `Inject deps.fsFactory in createServeApp to wire audit into the EventBus.`,
      );
    }
  };
}

/**
 * Shared `WorkspaceFileSystemFactory` construction used by both
 * `runQwenServe` and `createServeApp`'s default bridge wiring.
 * Centralizes the "use the injected factory if provided, otherwise
 * build one with the given trust + audit-emit posture" logic.
 *
 * Trust is intentionally a **required** parameter — the two call
 * sites have different correct defaults:
 *   - `runQwenServe` defaults to `trusted: true`
 *   - `createServeApp` defaults to `trusted: false` (test-safe)
 */
export function resolveBridgeFsFactory(input: {
  boundWorkspaces: readonly string[];
  injected?: WorkspaceFileSystemFactory;
  trusted: boolean;
  emit?: (event: BridgeEvent) => void;
  customIgnoreFiles?: string[];
  pathLocks?: PathMutexRegistry;
}): WorkspaceFileSystemFactory {
  if (input.injected) return input.injected;
  return createWorkspaceFileSystemFactory({
    boundWorkspaces: input.boundWorkspaces,
    trusted: input.trusted,
    emit: input.emit ?? createDefaultFsAuditEmit(),
    pathLocks: input.pathLocks,
    ...(input.customIgnoreFiles !== undefined
      ? { customIgnoreFiles: input.customIgnoreFiles }
      : {}),
  });
}

export function resolveBoundWorkspacesFromIdeEnv(
  primaryWorkspace: string,
  ideWorkspacePath = process.env[IDE_WORKSPACE_PATH_ENV_VAR],
  includeWorkspace?: (workspace: string, index: number) => boolean,
): string[] {
  let primary = primaryWorkspace;
  let envCanonicals: string[];
  try {
    const primaryCanonical = canonicalizeWorkspaces([primaryWorkspace])[0];
    if (primaryCanonical === undefined) return [];
    primary = primaryCanonical;
    const envWorkspaces = parseIdeWorkspacePathEnv(ideWorkspacePath);
    envCanonicals = canonicalizeWorkspaces(envWorkspaces);
  } catch (err) {
    writeStderrLine(
      `qwen serve: failed to canonicalize IDE workspace paths, using primary only: ${err}`,
    );
    return [primary];
  }
  if (
    envCanonicals.length > 0 &&
    !envCanonicals.some(
      (workspace) =>
        isWithinRoot(primary, workspace) || isWithinRoot(workspace, primary),
    )
  ) {
    writeStderrLine(
      'qwen serve: ignoring stale IDE workspace paths that do not overlap ' +
        'the selected workspace',
    );
    return [primary];
  }
  const workspaces = [primary, ...envCanonicals.filter((w) => w !== primary)];
  const filteredWorkspaces =
    includeWorkspace === undefined
      ? workspaces
      : workspaces.filter(includeWorkspace);
  return dropNestedWorkspacesPreservingPrimary(filteredWorkspaces);
}

function parseIdeWorkspacePathEnv(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  if (value.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === 'string')
      ) {
        return parsed.filter(
          (workspace) => workspace.length > 0 && path.isAbsolute(workspace),
        );
      }
      throw new Error('IDE workspace path JSON must be a string array');
    } catch {
      // Fall through to the legacy delimiter parser below.
    }
  }
  return value
    .split(path.delimiter)
    .filter((workspace) => workspace.length > 0);
}

function dropNestedWorkspacesPreservingPrimary(
  workspaces: readonly string[],
): string[] {
  const primary = workspaces[0];
  if (primary === undefined) return [];
  const withoutPrimaryOverlaps = workspaces.filter(
    (workspace, i) =>
      i === 0 ||
      (workspace !== primary &&
        !isWithinRoot(workspace, primary) &&
        !isWithinRoot(primary, workspace)),
  );
  const filtered = withoutPrimaryOverlaps.filter(
    (workspace, i) =>
      i === 0 ||
      !withoutPrimaryOverlaps.some(
        (other, j) =>
          i !== j &&
          j !== 0 &&
          workspace !== other &&
          isWithinRoot(workspace, other),
      ),
  );
  if (filtered.length < workspaces.length) {
    writeStderrLine(
      'qwen serve: dropping nested IDE workspace roots ' +
        '(parent folders already cover children)',
    );
  }
  return filtered;
}
