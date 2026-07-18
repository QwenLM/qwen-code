/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import { ToolNames } from '../tools/tool-names.js';
import { isShellCommandReadOnlyAST } from '../utils/shellAstParser.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import {
  getAutoMemoryRoot,
  getAutoMemoryTrustedAnchor,
  getUserAutoMemoryRoot,
} from './paths.js';

type MemoryScopedPermissionManager = Pick<
  PermissionManager,
  | 'evaluate'
  | 'findMatchingDenyRule'
  | 'hasMatchingAskRule'
  | 'hasRelevantRules'
  | 'isToolEnabled'
>;

export interface MemoryScopedAgentConfigOptions {
  allowShell?: boolean;
  bypassBaseAskForScopedPaths?: boolean;
  includeUserMemory?: boolean;
  restrictReadsToMemoryPaths?: boolean;
}

function isScopedTool(
  toolName: string,
  opts: Required<MemoryScopedAgentConfigOptions>,
): boolean {
  return (
    (opts.restrictReadsToMemoryPaths &&
      (toolName === ToolNames.READ_FILE ||
        toolName === ToolNames.GREP ||
        toolName === ToolNames.LS)) ||
    toolName === ToolNames.EDIT ||
    toolName === ToolNames.WRITE_FILE ||
    toolName === ToolNames.SHELL
  );
}

function mergePermissionDecision(
  scopedDecision: PermissionDecision,
  baseDecision: PermissionDecision,
  opts: Required<MemoryScopedAgentConfigOptions>,
): PermissionDecision {
  if (
    opts.bypassBaseAskForScopedPaths &&
    scopedDecision === 'allow' &&
    baseDecision === 'ask'
  ) {
    return 'allow';
  }
  const priority: Record<PermissionDecision, number> = {
    deny: 4,
    ask: 3,
    allow: 2,
    default: 1,
  };
  return priority[baseDecision] > priority[scopedDecision]
    ? baseDecision
    : scopedDecision;
}

export function isAllowedMemoryPath(
  filePath: string | undefined,
  projectRoot: string,
  options: Pick<MemoryScopedAgentConfigOptions, 'includeUserMemory'> = {},
): boolean {
  if (!filePath) return false;
  const includeUserMemory = options.includeUserMemory ?? true;
  const projectMemoryRoot = resolveTrustedMemoryRoot(
    getAutoMemoryRoot(projectRoot),
    getAutoMemoryTrustedAnchor(projectRoot),
  );
  const userMemoryRoot = realpathOrResolved(getUserAutoMemoryRoot());
  const isAllowed = (candidate: string): boolean =>
    isWithinRoot(candidate, projectMemoryRoot) ||
    (includeUserMemory && isWithinRoot(candidate, userMemoryRoot));
  const resolved = realpathExistingOrNew(filePath);
  return !!resolved && isAllowed(resolved);
}

function realpathExistingOrNew(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) return undefined;
    } catch {
      // The leaf is truly absent; resolve the closest existing parent.
    }
    return realpathNewPath(filePath);
  }
}

function realpathNewPath(filePath: string): string | undefined {
  let current = path.dirname(path.resolve(filePath));
  let remainder = path.basename(filePath);
  while (true) {
    try {
      return path.join(fs.realpathSync(current), remainder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      remainder = path.join(path.basename(current), remainder);
      current = parent;
    }
  }
}

function realpathOrResolved(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // The root may not exist yet (e.g. before the first managed-memory write).
    // Resolve the nearest existing ancestor's real path — the same way the
    // candidate is resolved via realpathExistingOrNew — so a symlinked
    // component in the path (e.g. a linked worktree, or macOS `/var` ->
    // `/private/var`) stays symmetric on both sides. Otherwise a symlinked
    // root compared against a realpath'd candidate makes isWithinRoot false
    // and misclassifies allowed writes as outside managed memory.
    return realpathNewPath(filePath) ?? path.resolve(filePath);
  }
}

/**
 * Resolve a managed-memory root for the write-boundary comparison.
 *
 * The candidate path is always realpath-resolved, so the root must resolve the
 * same symlinks in its trusted prefix (macOS `/var` -> `/private/var`, a
 * symlinked project dir or linked worktree) to avoid false denials. But it must
 * NOT follow a symlink that lives inside the managed suffix — e.g. a repo-
 * tracked `.qwen -> /outside` under `QWEN_CODE_MEMORY_LOCAL` — which would
 * relocate the "allowed" root out of the project and let the first managed
 * write land outside it. So we canonicalize the trusted anchor only and append
 * the managed suffix literally.
 */
function resolveTrustedMemoryRoot(literalRoot: string, anchor: string): string {
  const suffix = path.relative(anchor, literalRoot);
  if (
    suffix === '' ||
    suffix === '..' ||
    suffix.startsWith(`..${path.sep}`) ||
    path.isAbsolute(suffix)
  ) {
    // The root is not under its expected anchor (unexpected layout); resolve
    // the whole path, matching the behavior before this anchor guard existed.
    return realpathOrResolved(literalRoot);
  }
  return path.join(realpathOrResolved(anchor), suffix);
}

function isWithinRoot(filePath: string, root: string): boolean {
  const rel = path.relative(root, filePath);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

async function evaluateScopedDecision(
  ctx: PermissionCheckContext,
  projectRoot: string,
  opts: Required<MemoryScopedAgentConfigOptions>,
): Promise<PermissionDecision> {
  switch (ctx.toolName) {
    case ToolNames.SHELL: {
      if (!opts.allowShell || !ctx.command) {
        return 'deny';
      }
      const isReadOnly = await isShellCommandReadOnlyAST(
        stripShellWrapper(ctx.command),
      );
      return isReadOnly ? 'allow' : 'deny';
    }
    case ToolNames.READ_FILE:
    case ToolNames.GREP:
    case ToolNames.LS:
      if (!opts.restrictReadsToMemoryPaths) return 'default';
      return isAllowedMemoryPath(ctx.filePath, projectRoot, {
        includeUserMemory: opts.includeUserMemory,
      })
        ? 'allow'
        : 'deny';
    case ToolNames.EDIT:
    case ToolNames.WRITE_FILE:
      return isAllowedMemoryPath(ctx.filePath, projectRoot, {
        includeUserMemory: opts.includeUserMemory,
      })
        ? 'allow'
        : 'deny';
    default:
      return 'default';
  }
}

function getScopedDenyRule(
  ctx: PermissionCheckContext,
  projectRoot: string,
  opts: Required<MemoryScopedAgentConfigOptions>,
): string | undefined {
  const allowedRoots = opts.includeUserMemory
    ? `${getUserAutoMemoryRoot()} or ${getAutoMemoryRoot(projectRoot)}`
    : getAutoMemoryRoot(projectRoot);
  switch (ctx.toolName) {
    case ToolNames.SHELL:
      return opts.allowShell
        ? 'ManagedAutoMemory(run_shell_command: read-only only)'
        : 'ManagedAutoMemory(run_shell_command: disabled)';
    case ToolNames.READ_FILE:
      if (!opts.restrictReadsToMemoryPaths) return undefined;
      return `ManagedAutoMemory(read_file: only within ` + `${allowedRoots})`;
    case ToolNames.GREP:
      if (!opts.restrictReadsToMemoryPaths) return undefined;
      return `ManagedAutoMemory(grep_search: only within ` + `${allowedRoots})`;
    case ToolNames.LS:
      if (!opts.restrictReadsToMemoryPaths) return undefined;
      return (
        `ManagedAutoMemory(list_directory: only within ` + `${allowedRoots})`
      );
    case ToolNames.EDIT:
      return `ManagedAutoMemory(edit: only within ${allowedRoots})`;
    case ToolNames.WRITE_FILE:
      return `ManagedAutoMemory(write_file: only within ${allowedRoots})`;
    default:
      return undefined;
  }
}

export function createMemoryScopedAgentConfig(
  config: Config,
  projectRoot: string,
  options: MemoryScopedAgentConfigOptions = {},
): Config {
  const opts: Required<MemoryScopedAgentConfigOptions> = {
    allowShell: options.allowShell ?? false,
    bypassBaseAskForScopedPaths: options.bypassBaseAskForScopedPaths ?? false,
    includeUserMemory: options.includeUserMemory ?? true,
    restrictReadsToMemoryPaths: options.restrictReadsToMemoryPaths ?? false,
  };
  const basePm = config.getPermissionManager?.();
  const scopedPm: MemoryScopedPermissionManager = {
    hasRelevantRules(ctx: PermissionCheckContext): boolean {
      return (
        isScopedTool(ctx.toolName, opts) || !!basePm?.hasRelevantRules(ctx)
      );
    },
    hasMatchingAskRule(ctx: PermissionCheckContext): boolean {
      return basePm?.hasMatchingAskRule(ctx) ?? false;
    },
    findMatchingDenyRule(ctx: PermissionCheckContext): string | undefined {
      const scoped = getScopedDenyRule(ctx, projectRoot, opts);
      if (scoped) {
        return scoped;
      }
      return basePm?.findMatchingDenyRule(ctx);
    },
    async evaluate(ctx: PermissionCheckContext): Promise<PermissionDecision> {
      const scopedDecision = await evaluateScopedDecision(
        ctx,
        projectRoot,
        opts,
      );
      if (!basePm) {
        return scopedDecision;
      }
      const baseDecision = basePm.hasRelevantRules(ctx)
        ? await basePm.evaluate(ctx)
        : 'default';
      return mergePermissionDecision(scopedDecision, baseDecision, opts);
    },
    async isToolEnabled(toolName: string): Promise<boolean> {
      if (toolName === ToolNames.SHELL) {
        return opts.allowShell;
      }
      if (isScopedTool(toolName, opts)) {
        return true;
      }
      if (basePm) {
        return basePm.isToolEnabled(toolName);
      }
      return true;
    },
  };

  const scopedConfig = Object.create(config) as Config;
  scopedConfig.getPermissionManager = () =>
    scopedPm as unknown as PermissionManager;
  return scopedConfig;
}
