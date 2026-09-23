/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
  isAutoMemPath,
  isTeamAutoMemPath,
  isUserAutoMemPath,
} from './paths.js';

export type MemoryChangedScope = 'user' | 'project' | 'team';
export type MemoryChangedOperation = 'create' | 'update' | 'delete';

export interface MemoryChangedDocument {
  scope: MemoryChangedScope;
  filePath: string;
  relativePath: string;
}

/**
 * One managed-memory document change. `paths` and `relativePaths` stay aligned.
 * `relativePaths` is the stable key inside the memory root. `workspace` is set
 * for project and team memory and omitted for user memory.
 */
export interface MemoryDocumentChange {
  scope: MemoryChangedScope;
  operation: MemoryChangedOperation;
  paths: string[];
  relativePaths: string[];
  workspace?: string;
}

/** Managed auto-memory was turned on or off for a workspace. No documents moved. */
export interface MemoryEnabledChange {
  paths: [];
  relativePaths: [];
  workspace: string;
  enabled: boolean;
}

export type MemoryChangedNotice = MemoryDocumentChange | MemoryEnabledChange;

type MemoryChangedListener = (
  change: MemoryChangedNotice,
) => void | Promise<void>;

interface MemoryChangedRegistration {
  workspace: string;
  listener: MemoryChangedListener;
}

const listeners = new Set<MemoryChangedRegistration>();

/**
 * Register a listener for one workspace. A write is delivered only to
 * listeners registered for that workspace, so another workspace in the same
 * process does not see it. Returns an unregister function.
 */
export function registerMemoryChangedListener(
  workspace: string,
  listener: MemoryChangedListener,
): () => void {
  const registration = { workspace: path.resolve(workspace), listener };
  listeners.add(registration);
  return () => {
    listeners.delete(registration);
  };
}

function relativeInside(root: string, filePath: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}

/**
 * Classify an absolute path as a managed-memory document.
 * User, then project, then team. Scheduling files outside `memory/` are not
 * included.
 */
export function describeMemoryFileChange(
  filePath: string,
  projectRoot: string,
): MemoryChangedDocument | undefined {
  const absolutePath = path.resolve(filePath);
  const candidates: Array<{
    scope: MemoryChangedScope;
    matches: boolean;
    root: string;
  }> = [
    {
      scope: 'user',
      matches: isUserAutoMemPath(absolutePath),
      root: getUserAutoMemoryRoot(),
    },
    {
      scope: 'project',
      matches: isAutoMemPath(absolutePath, projectRoot),
      root: getAutoMemoryRoot(projectRoot),
    },
    {
      scope: 'team',
      matches: isTeamAutoMemPath(absolutePath, projectRoot),
      root: getTeamAutoMemoryRoot(projectRoot),
    },
  ];
  for (const candidate of candidates) {
    if (!candidate.matches) continue;
    const relativePath = relativeInside(candidate.root, absolutePath);
    if (!relativePath) continue;
    return { scope: candidate.scope, filePath: absolutePath, relativePath };
  }
  return undefined;
}

const SCOPE_ORDER: readonly MemoryChangedScope[] = ['user', 'project', 'team'];

async function emit(
  sourceWorkspace: string,
  changes: readonly MemoryChangedNotice[],
): Promise<void> {
  if (changes.length === 0 || listeners.size === 0) return;
  const workspace = path.resolve(sourceWorkspace);
  const matched = [...listeners].filter(
    (registration) => registration.workspace === workspace,
  );
  await Promise.all(
    matched.map(async (registration) => {
      for (const change of changes) {
        try {
          await registration.listener(change);
        } catch {
          // The change is already on disk. A listener must not roll it back.
        }
      }
    }),
  );
}

/**
 * Notify listeners after managed-memory documents are created, updated, or
 * deleted. One path becomes `paths: [path]`. Paths passed together stay in one
 * array per scope. User memory omits `workspace`.
 */
export async function notifyMemoryFileChange(
  filePath: string | readonly string[],
  projectRoot: string,
  operation: MemoryChangedOperation,
): Promise<void> {
  if (listeners.size === 0) return;
  const filePaths = typeof filePath === 'string' ? [filePath] : filePath;
  const workspace = path.resolve(projectRoot);
  const grouped = new Map<
    MemoryChangedScope,
    { paths: string[]; relativePaths: string[] }
  >();
  for (const candidate of filePaths) {
    const described = describeMemoryFileChange(candidate, projectRoot);
    if (!described) continue;
    const group = grouped.get(described.scope) ?? {
      paths: [],
      relativePaths: [],
    };
    if (!group.paths.includes(described.filePath)) {
      group.paths.push(described.filePath);
      group.relativePaths.push(described.relativePath);
      grouped.set(described.scope, group);
    }
  }
  const changes: MemoryDocumentChange[] = [];
  for (const scope of SCOPE_ORDER) {
    const group = grouped.get(scope);
    if (!group || group.paths.length === 0) continue;
    changes.push({
      scope,
      operation,
      paths: group.paths,
      relativePaths: group.relativePaths,
      ...(scope === 'user' ? {} : { workspace }),
    });
  }
  await emit(projectRoot, changes);
}

/**
 * Notify listeners after managed auto-memory is enabled or disabled.
 * The setting write has already landed. `paths` is empty.
 */
export async function notifyMemoryEnabledChange(
  workspace: string,
  enabled: boolean,
): Promise<void> {
  const change: MemoryEnabledChange = {
    paths: [],
    relativePaths: [],
    workspace: path.resolve(workspace),
    enabled,
  };
  await emit(workspace, [change]);
}
