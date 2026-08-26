/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { deriveConfig, type Config } from '../config/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import { ToolNames } from '../tools/tool-names.js';
import { isShellCommandReadOnlyASTInDirectory } from '../utils/shellAstParser.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import {
  AUTO_MEMORY_PINNED_DIRNAME,
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
  | 'isPermissionsAllowListActive'
  | 'isToolEnabled'
>;

export interface MemoryScopedAgentConfigOptions {
  allowShell?: boolean;
  bypassBaseAskForScopedPaths?: boolean;
  includeUserMemory?: boolean;
  protectPinnedMemory?: boolean;
  restrictReadsToMemoryPaths?: boolean;
}

interface PinnedMemoryRoot {
  literalPath: string;
  resolvedPath: string | undefined;
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
  return isAllowedResolvedMemoryPath(
    realpathExistingOrNew(filePath),
    projectRoot,
    options,
  );
}

function isAllowedResolvedMemoryPath(
  resolvedPath: string | undefined,
  projectRoot: string,
  options: Pick<MemoryScopedAgentConfigOptions, 'includeUserMemory'> = {},
): boolean {
  if (!resolvedPath) return false;
  const includeUserMemory = options.includeUserMemory ?? true;
  const projectMemoryRoot = resolveTrustedMemoryRoot(
    getAutoMemoryRoot(projectRoot),
    getAutoMemoryTrustedAnchor(projectRoot),
  );
  const userMemoryRoot = realpathOrResolved(getUserAutoMemoryRoot());
  const isAllowed = (candidate: string): boolean =>
    isWithinRoot(candidate, projectMemoryRoot) ||
    (includeUserMemory && isWithinRoot(candidate, userMemoryRoot));
  return isAllowed(resolvedPath);
}

function createPinnedMemoryRoots(
  projectRoot: string,
  includeUserMemory: boolean,
): PinnedMemoryRoot[] {
  const memoryRoots = [getAutoMemoryRoot(projectRoot)];
  if (includeUserMemory) {
    memoryRoots.push(getUserAutoMemoryRoot());
  }
  return memoryRoots.map((memoryRoot) => {
    const literalPath = path.resolve(memoryRoot, AUTO_MEMORY_PINNED_DIRNAME);
    // Snapshot the resolved root for this agent run. Literal containment still
    // protects the reserved path if it is created later; retargeting symlinks
    // during a run is outside the automatic worker's capabilities.
    return {
      literalPath,
      resolvedPath: realpathExistingOrNew(literalPath),
    };
  });
}

function isProtectedPinnedMemoryPath(
  filePath: string | undefined,
  pinnedRoots: readonly PinnedMemoryRoot[],
  resolvedCandidate: string | undefined,
): boolean {
  if (!filePath) return false;
  const literalCandidate = path.resolve(filePath);
  return pinnedRoots.some((pinnedRoot) => {
    if (isWithinRootCaseInsensitive(literalCandidate, pinnedRoot.literalPath)) {
      return true;
    }
    return (
      !!resolvedCandidate &&
      !!pinnedRoot.resolvedPath &&
      isWithinRootCaseInsensitive(resolvedCandidate, pinnedRoot.resolvedPath)
    );
  });
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

function isWithinRootCaseInsensitive(filePath: string, root: string): boolean {
  // Lowercase the complete paths so case variants cannot fail open on a
  // case-insensitive filesystem. This is deliberately fail-closed, and
  // String.prototype.toLowerCase is locale-independent.
  return isWithinRoot(filePath.toLowerCase(), root.toLowerCase());
}

async function evaluateScopedDecision(
  ctx: PermissionCheckContext,
  projectRoot: string,
  opts: Required<MemoryScopedAgentConfigOptions>,
  pinnedRoots: readonly PinnedMemoryRoot[],
): Promise<PermissionDecision> {
  switch (ctx.toolName) {
    case ToolNames.SHELL: {
      if (!opts.allowShell || !ctx.command) {
        return 'deny';
      }
      const isReadOnly = await isShellCommandReadOnlyASTInDirectory(
        stripShellWrapper(ctx.command),
        ctx.cwd ?? projectRoot,
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
    case ToolNames.WRITE_FILE: {
      const resolvedCandidate = ctx.filePath
        ? realpathExistingOrNew(ctx.filePath)
        : undefined;
      const isPinned =
        opts.protectPinnedMemory &&
        isProtectedPinnedMemoryPath(
          ctx.filePath,
          pinnedRoots,
          resolvedCandidate,
        );
      if (isPinned) return 'deny';
      return isAllowedResolvedMemoryPath(resolvedCandidate, projectRoot, {
        includeUserMemory: opts.includeUserMemory,
      })
        ? 'allow'
        : 'deny';
    }
    default:
      return 'default';
  }
}

function getScopedDenyRule(
  ctx: PermissionCheckContext,
  projectRoot: string,
  opts: Required<MemoryScopedAgentConfigOptions>,
  pinnedRoots: readonly PinnedMemoryRoot[],
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
    case ToolNames.WRITE_FILE: {
      const resolvedCandidate = ctx.filePath
        ? realpathExistingOrNew(ctx.filePath)
        : undefined;
      const isAllowed = isAllowedResolvedMemoryPath(
        resolvedCandidate,
        projectRoot,
        { includeUserMemory: opts.includeUserMemory },
      );
      if (
        isAllowed &&
        opts.protectPinnedMemory &&
        isProtectedPinnedMemoryPath(
          ctx.filePath,
          pinnedRoots,
          resolvedCandidate,
        )
      ) {
        return `ManagedAutoMemory(${ctx.toolName}: pinned memory is read-only)`;
      }
      return `ManagedAutoMemory(${ctx.toolName}: only within ${allowedRoots})`;
    }
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
    protectPinnedMemory: options.protectPinnedMemory ?? false,
    restrictReadsToMemoryPaths: options.restrictReadsToMemoryPaths ?? false,
  };
  const pinnedRoots = opts.protectPinnedMemory
    ? createPinnedMemoryRoots(projectRoot, opts.includeUserMemory)
    : [];
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
      const scoped = getScopedDenyRule(ctx, projectRoot, opts, pinnedRoots);
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
        pinnedRoots,
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
    // The scheduler's permission-denied message branch calls this on
    // whatever `getPermissionManager()` returns (#9827). Without the
    // delegation a shim-rejected call under an active allowlist threw
    // `TypeError: ... is not a function` instead of reaching the
    // designed permission error.
    isPermissionsAllowListActive(): boolean {
      return basePm?.isPermissionsAllowListActive() ?? false;
    },
  };

  return deriveConfig(config, {
    getPermissionManager: () => scopedPm as unknown as PermissionManager,
  });
}
