/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  id: symbol;
  workspace: string;
  listener: MemoryChangedListener;
}

const listeners = new Set<MemoryChangedRegistration>();
const suppressDelivery = new AsyncLocalStorage<true>();

/**
 * Register a listener for one workspace. A write is delivered to the
 * registration named by `deliveryId` when the caller has one, and otherwise
 * to the newest registration for that workspace. Returns an unregister
 * function tagged with that id.
 */
export function registerMemoryChangedListener(
  workspace: string,
  listener: MemoryChangedListener,
): (() => void) & { id: symbol } {
  const registration: MemoryChangedRegistration = {
    id: Symbol('memory-hook-delivery'),
    workspace: path.resolve(workspace),
    listener,
  };
  listeners.add(registration);
  const unregister = () => {
    listeners.delete(registration);
  };
  return Object.assign(unregister, { id: registration.id });
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

function recipientsFor(
  workspace: string,
  deliveryId: symbol | undefined,
): MemoryChangedRegistration[] {
  const matched = [...listeners].filter(
    (registration) => registration.workspace === workspace,
  );
  if (deliveryId) {
    const named = matched.filter(
      (registration) => registration.id === deliveryId,
    );
    if (named.length > 0) return named;
  }
  const newest = matched.at(-1);
  return newest ? [newest] : [];
}

async function emit(
  sourceWorkspace: string,
  changes: readonly MemoryChangedNotice[],
  deliveryId?: symbol,
): Promise<void> {
  if (changes.length === 0 || listeners.size === 0) return;
  const workspace = path.resolve(sourceWorkspace);
  const matched = recipientsFor(workspace, deliveryId);
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
  deliveryId?: symbol,
): Promise<void> {
  if (suppressDelivery.getStore()) return;
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
  await emit(projectRoot, changes, deliveryId);
}

/**
 * Notify listeners after managed auto-memory is enabled or disabled.
 * The setting write has already landed. `paths` is empty.
 */
const MEMORY_SCOPES: readonly MemoryChangedScope[] = [
  'user',
  'project',
  'team',
];
const MEMORY_OPERATIONS: readonly MemoryChangedOperation[] = [
  'create',
  'update',
  'delete',
];

function isMemoryScope(value: unknown): value is MemoryChangedScope {
  return (
    typeof value === 'string' &&
    (MEMORY_SCOPES as readonly string[]).includes(value)
  );
}

function isMemoryOperation(value: unknown): value is MemoryChangedOperation {
  return (
    typeof value === 'string' &&
    (MEMORY_OPERATIONS as readonly string[]).includes(value)
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Rebuild a notice from a hook bus payload. Returns undefined when the
 * payload is not a document change or an on/off toggle.
 */
export function memoryChangedNoticeFromHookInput(
  input: Record<string, unknown>,
): MemoryChangedNotice | undefined {
  if (typeof input['enabled'] === 'boolean') {
    return {
      paths: [],
      relativePaths: [],
      workspace:
        typeof input['workspace'] === 'string' ? input['workspace'] : '',
      enabled: input['enabled'],
    };
  }
  if (
    !isMemoryScope(input['memory_scope']) ||
    !isMemoryOperation(input['operation'])
  ) {
    return undefined;
  }
  const workspace = input['workspace'];
  return {
    scope: input['memory_scope'],
    operation: input['operation'],
    paths: stringList(input['paths']),
    relativePaths: stringList(input['relative_paths']),
    ...(typeof workspace === 'string' ? { workspace } : {}),
  };
}

export async function notifyMemoryEnabledChange(
  workspace: string,
  enabled: boolean,
  deliveryId?: symbol,
): Promise<void> {
  const change: MemoryEnabledChange = {
    paths: [],
    relativePaths: [],
    workspace: path.resolve(workspace),
    enabled,
  };
  await emit(workspace, [change], deliveryId);
}

async function readMemoryTree(
  root: string,
  into: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await readMemoryTree(full, into);
    } else if (entry.isFile()) {
      into.set(path.resolve(full), await fs.readFile(full, 'utf-8'));
    }
  }
}

async function readMemoryDocuments(
  projectRoot: string,
): Promise<Map<string, string>> {
  const documents = new Map<string, string>();
  await Promise.all(
    [
      getUserAutoMemoryRoot(),
      getAutoMemoryRoot(projectRoot),
      getTeamAutoMemoryRoot(projectRoot),
    ].map((root) => readMemoryTree(root, documents)),
  );
  return documents;
}

/**
 * Run a memory agent, then emit one create, update, or delete per scope for
 * documents that actually differ. Tool writes inside `fn` are not emitted on
 * their own, so a shell `rm` is still reported and a rewritten index is one
 * event.
 */
export async function withCoalescedMemoryChanges<T>(
  projectRoot: string,
  deliveryId: symbol | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const before = await readMemoryDocuments(projectRoot);
  try {
    return await suppressDelivery.run(true, fn);
  } finally {
    const after = await readMemoryDocuments(projectRoot);
    const created: string[] = [];
    const updated: string[] = [];
    const deleted: string[] = [];
    for (const [filePath, content] of after) {
      if (!before.has(filePath)) {
        created.push(filePath);
      } else if (before.get(filePath) !== content) {
        updated.push(filePath);
      }
    }
    for (const filePath of before.keys()) {
      if (!after.has(filePath)) {
        deleted.push(filePath);
      }
    }
    await notifyMemoryFileChange(deleted, projectRoot, 'delete', deliveryId);
    await notifyMemoryFileChange(updated, projectRoot, 'update', deliveryId);
    await notifyMemoryFileChange(created, projectRoot, 'create', deliveryId);
  }
}
