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
}): WorkspaceFileSystemFactory {
  if (input.injected) return input.injected;
  return createWorkspaceFileSystemFactory({
    boundWorkspaces: input.boundWorkspaces,
    trusted: input.trusted,
    emit: input.emit ?? createDefaultFsAuditEmit(),
    ...(input.customIgnoreFiles !== undefined
      ? { customIgnoreFiles: input.customIgnoreFiles }
      : {}),
  });
}

export function resolveBoundWorkspacesFromIdeEnv(
  primaryWorkspace: string,
  ideWorkspacePath = process.env[IDE_WORKSPACE_PATH_ENV_VAR],
): string[] {
  const envWorkspaces =
    ideWorkspacePath
      ?.split(path.delimiter)
      .filter((workspace) => workspace.length > 0) ?? [];
  let envCanonical: string[];
  try {
    envCanonical = canonicalizeWorkspaces(envWorkspaces);
  } catch (err) {
    writeStderrLine(
      `qwen serve: failed to canonicalize IDE workspace paths, using primary only: ${err}`,
    );
    return canonicalizeWorkspaces([primaryWorkspace]);
  }
  const workspaces = canonicalizeWorkspaces([
    primaryWorkspace,
    ...envCanonical,
  ]);
  const primary = workspaces[0];
  if (primary === undefined) return [];
  if (
    envCanonical.length > 0 &&
    !envCanonical.some((workspace) => isWithinRoot(primary, workspace))
  ) {
    return [primary];
  }
  return workspaces;
}
