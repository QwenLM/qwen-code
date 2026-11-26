/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared input check flows for the file tools.
 *
 * Read, Glob and Grep are the same read-shaped check; Write, Edit and
 * NotebookEdit are the same write-shaped check. Each tool keeps its own
 * checker entry under `checkers/`; the flow they share lives here.
 *
 * Both are thin: they find the path in their tool's input shape and hand it to
 * the path pipeline in `filesystem-permissions/filesystem.ts`, which owns rule
 * matching, the workspace boundary, symlink resolution and the dangerous-path
 * safety net.
 *
 * The tool-level rules are applied first, so a bare `Read` or `Edit` rule settles
 * the call without any path being examined.
 */

import type { ToolCheckContext } from '../../permissions/manager/decision/index.js';
import {
  checkReadPermissionForPath,
  checkWritePermissionForPath,
  getPathsForPermissionCheck,
} from '../filesystem-permissions/filesystem.js';
import { runLogger } from '../../utils/runLogger.js';
import type { ToolPermissionReason } from './checker-reasons.js';
import { isManagedAsk, type ToolPermissionResult } from './rule-precedence.js';
import { stringField } from './content-checkers.js';

/**
 * Evidence line for the six file tools: the raw path fields the model sent,
 * the cwd they are judged against, and the symlink-resolved path set the
 * pipeline actually checks. Pairs with the `[permission-check]` verdict line
 * emitted by withCheckLog; read together they expose path-resolution drift.
 */
export function logCheckedPaths(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolCheckContext<ToolPermissionReason>,
  rawFields: readonly string[],
  resolveField?: string,
  resolvedPath?: string,
): void {
  const raw: Record<string, unknown> = {};
  for (const field of rawFields) {
    const value = stringField(input, field);
    if (value !== undefined) {
      raw[field] = value;
    }
  }
  const pathToResolve =
    resolvedPath ??
    (resolveField ? stringField(input, resolveField) : undefined);
  const resolved = pathToResolve
    ? getPathsForPermissionCheck(pathToResolve, ctx.cwd)
    : [];
  runLogger.log(
    `[permission-path] ${toolName} raw=${JSON.stringify(raw)}` +
      ` cwd=${JSON.stringify(ctx.cwd)} resolved=${JSON.stringify(resolved)}`,
  );
}

/** Input shape of the read-only file tools: read_file, glob, ripGrep. */
export interface ReadToolPermissionInput extends Record<string, unknown> {
  file_path?: string;
  path?: string;
  pattern?: string;
}

/** Input shape of the write tools: write_file, edit, notebook_edit. */
export interface WriteToolPermissionInput extends Record<string, unknown> {
  file_path?: string;
  notebook_path?: string;
}

export function checkReadToolInput(
  input: Record<string, unknown>,
  ctx: ToolCheckContext<ToolPermissionReason>,
): ToolPermissionResult {
  const filePath =
    stringField(input, 'file_path') ?? stringField(input, 'path');
  if (!filePath) {
    // A no-path search covers the working directory plus every trusted
    // directory — the execution layer fans out over exactly those roots —
    // so each root goes through the normal read pipeline: any deny refuses
    // the whole search. Ordinary root asks stay silent; a managed ask must
    // still reach the person.
    let managedAsk: ToolPermissionResult | undefined;
    for (const root of [ctx.cwd, ...ctx.additionalDirectories]) {
      const decision = checkReadPermissionForPath(root, ctx, ctx.cwd);
      if (decision.kind === 'deny') {
        return decision;
      }
      if (isManagedAsk(decision)) managedAsk ??= decision;
    }
    if (managedAsk) return managedAsk;
    return {
      kind: 'allow',
      extra: { decisionPoint: 'fs_read.no_path.allow' },
    };
  }

  return checkReadPermissionForPath(filePath, ctx, ctx.cwd);
}

export function checkWriteToolInput(
  input: Record<string, unknown>,
  ctx: ToolCheckContext<ToolPermissionReason>,
): ToolPermissionResult {
  const filePath =
    stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
  if (!filePath) {
    // Fail closed: a write with no path to validate cannot be judged, and the
    // old pipeline's fallthrough no longer exists to catch it.
    return {
      kind: 'deny',
      extra: {
        decisionPoint: 'fs_write.no_path.deny',
        denialReason: {
          message: 'No file path was provided, so the write cannot be checked.',
          attribution: { type: 'other', reason: 'write without a path' },
          denialKind: 'permission-rule',
          decisionPoint: 'fs_write.no_path.deny',
        },
      },
    };
  }

  return checkWritePermissionForPath(filePath, ctx, ctx.cwd);
}
