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
  isMemoryDocumentFilename,
  isTeamAutoMemPath,
  TEAM_AUTO_MEMORY_DIRNAME,
} from './paths.js';
import { QWEN_DIR, realpathNearestExisting } from '../utils/paths.js';

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
  signal?: AbortSignal,
) => void | Promise<void>;

interface MemoryChangedRegistration {
  id: symbol;
  workspace: string;
  listener: MemoryChangedListener;
}

const listeners = new Set<MemoryChangedRegistration>();
/**
 * The store is the current window's outside-baseline bucket. A notify made
 * inside a window is not delivered; it is still recorded for every OTHER open
 * window so a sibling window's closing diff does not re-report the write
 * under its own attribution.
 */
const suppressDelivery = new AsyncLocalStorage<Map<string, string | null>>();

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
    root: string;
  }> = [
    {
      scope: 'user',
      root: getUserAutoMemoryRoot(),
    },
    {
      scope: 'project',
      root: getAutoMemoryRoot(projectRoot),
    },
    {
      scope: 'team',
      root: getTeamAutoMemoryRoot(projectRoot),
    },
  ];
  for (const candidate of candidates) {
    const resolvedRoot = realpathNearestExisting(candidate.root);
    if (candidate.scope === 'team') {
      const repoRoot = path.dirname(path.dirname(candidate.root));
      const expectedRoot = path.join(
        realpathNearestExisting(repoRoot),
        QWEN_DIR,
        TEAM_AUTO_MEMORY_DIRNAME,
      );
      if (
        resolvedRoot !== expectedRoot ||
        !isTeamAutoMemPath(absolutePath, projectRoot)
      ) {
        continue;
      }
    }
    const relativePath =
      relativeInside(candidate.root, absolutePath) ??
      relativeInside(resolvedRoot, realpathNearestExisting(absolutePath));
    if (!relativePath) continue;
    // All windows use the canonical root, keeping symlinks below it visible
    // to isTreeVisible instead of resolving away their lexical path segments.
    return {
      scope: candidate.scope,
      filePath: path.resolve(resolvedRoot, relativePath),
      relativePath,
    };
  }
  return undefined;
}

const SCOPE_ORDER: readonly MemoryChangedScope[] = ['user', 'project', 'team'];

/**
 * Content already reported while a coalesced window is open, per window.
 * `null` means the path was reported while absent.
 */
const outsideWindowEmits = new Set<Map<string, string | null>>();

/**
 * True when the tree walk can observe `filePath` under `root`: every ancestor
 * below the root is a real directory and the leaf, when it exists, is a
 * regular file. `readdir({ withFileTypes: true })` recursion is blind to a
 * symlinked ancestor (Dirent.isDirectory() is false for a link) and a
 * symlinked leaf is invisible to its isFile() check, so neither can ever
 * appear in a coalesced window's snapshot diff.
 */
async function isTreeVisible(root: string, filePath: string): Promise<boolean> {
  const leaf = await fs.lstat(filePath).catch(() => undefined);
  if (leaf !== undefined && (leaf.isSymbolicLink() || !leaf.isFile())) {
    return false;
  }
  const resolvedRoot = realpathNearestExisting(root);
  let current = path.dirname(path.resolve(filePath));
  while (current !== resolvedRoot) {
    const relative = path.relative(resolvedRoot, current);
    // '' is a case-divergent spelling of the root itself.
    if (relative === '') return true;
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      return false;
    }
    current = path.dirname(current);
  }
  return true;
}

async function rememberOutsideEmit(
  filePaths: readonly string[],
): Promise<void> {
  if (outsideWindowEmits.size === 0) return;
  const ownBucket = suppressDelivery.getStore();
  for (const filePath of filePaths) {
    const stat = await fs
      .lstat(filePath)
      .catch((err: unknown) =>
        (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined,
      );
    // A non-ENOENT lstat failure means 'unknown', not 'absent': recording
    // null would poison every other open window's baseline with a delete
    // marker for a file that may still exist.
    if (stat === undefined) continue;
    // A symlinked document reads fine here but is invisible to the tree walk
    // (Dirent.isFile() is false for links): recording it would let a closing
    // window report a `delete` for a file that is still on disk.
    if (stat !== null && stat.isSymbolicLink()) continue;
    // `null` encodes 'reported while absent' (a delete). A present but
    // unreadable file is unknown, not absent: keep the snapshot baseline.
    const content =
      stat === null
        ? null
        : await fs.readFile(filePath, 'utf-8').catch(() => undefined);
    if (content === undefined) continue;
    for (const bucket of outsideWindowEmits) {
      if (bucket !== ownBucket) {
        bucket.set(filePath, content);
      }
    }
  }
}

function recipientsFor(
  workspace: string,
  deliveryId: symbol | undefined,
): MemoryChangedRegistration[] {
  if (deliveryId !== undefined) {
    // A delivery id names one registration globally (the ids are unique
    // symbols): a Config relocated by /cd or a derived worktree Config
    // notifies with its live root, which no longer equals the key the
    // registration was made under. An id whose registration is gone matches
    // nothing — never another session's registration.
    const named = [...listeners].filter(
      (registration) => registration.id === deliveryId,
    );
    return named.length > 0 ? named : [];
  }
  const matched = [...listeners].filter(
    (registration) => registration.workspace === workspace,
  );
  const newest = matched.at(-1);
  return newest ? [newest] : [];
}

async function emit(
  sourceWorkspace: string,
  changes: readonly MemoryChangedNotice[],
  deliveryId?: symbol,
  signal?: AbortSignal,
): Promise<void> {
  if (changes.length === 0 || listeners.size === 0) return;
  const workspace = path.resolve(sourceWorkspace);
  const matched = recipientsFor(workspace, deliveryId);
  await Promise.all(
    matched.map(async (registration) => {
      for (const change of changes) {
        try {
          await registration.listener(change, signal);
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
  signal?: AbortSignal,
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
  const emittedPaths: string[] = [];
  for (const scope of SCOPE_ORDER) {
    const group = grouped.get(scope);
    if (!group || group.paths.length === 0) continue;
    emittedPaths.push(...group.paths);
    changes.push({
      scope,
      operation,
      paths: group.paths,
      relativePaths: group.relativePaths,
      ...(scope === 'user' ? {} : { workspace }),
    });
  }
  const inWindow = suppressDelivery.getStore() !== undefined;
  let baselinePaths = emittedPaths;
  // Inside a window the closing diff owns walk-visible paths; only paths the
  // walk can never observe are delivered immediately.
  const deliverable: MemoryDocumentChange[] = inWindow ? [] : [...changes];
  if (inWindow || outsideWindowEmits.size > 0) {
    // A window's closing diff can only report paths the tree walk observes.
    // A path behind a symlinked ancestor (or a symlinked leaf) is invisible
    // to it: recording one as another window's baseline would fabricate a
    // `delete` for a live file, and suppressing an in-window write to one
    // would swallow the change entirely. Keep such paths out of every
    // window's baseline and deliver them directly instead.
    const rootForScope = (scope: MemoryChangedScope): string =>
      scope === 'user'
        ? getUserAutoMemoryRoot()
        : scope === 'project'
          ? getAutoMemoryRoot(projectRoot)
          : getTeamAutoMemoryRoot(projectRoot);
    const invisible = new Set<string>();
    for (const change of changes) {
      for (const candidate of change.paths) {
        if (!(await isTreeVisible(rootForScope(change.scope), candidate))) {
          invisible.add(candidate);
        }
      }
    }
    if (invisible.size > 0) {
      baselinePaths = emittedPaths.filter((p) => !invisible.has(p));
      if (inWindow) {
        for (const change of changes) {
          const kept = change.paths
            .map((p, i) => (invisible.has(p) ? i : -1))
            .filter((i) => i >= 0);
          if (kept.length === 0) continue;
          deliverable.push({
            ...change,
            paths: kept.map((i) => change.paths[i]!),
            relativePaths: kept.map((i) => change.relativePaths[i]!),
          });
        }
      }
    }
  }
  // Record even when delivery is suppressed inside a coalesced window, so a
  // sibling window does not re-report the write under its own attribution.
  await rememberOutsideEmit(baselinePaths);
  if (inWindow) {
    if (deliverable.length > 0) {
      await emit(projectRoot, deliverable, deliveryId, signal);
    }
    return;
  }
  await emit(projectRoot, deliverable, deliveryId, signal);
}

/**
 * Notify listeners after managed auto-memory is enabled or disabled.
 * The setting write has already landed. `paths` is empty.
 */
const MEMORY_OPERATIONS: readonly MemoryChangedOperation[] = [
  'create',
  'update',
  'delete',
];

function isMemoryScope(value: unknown): value is MemoryChangedScope {
  return (
    typeof value === 'string' &&
    (SCOPE_ORDER as readonly string[]).includes(value)
  );
}

function isMemoryOperation(value: unknown): value is MemoryChangedOperation {
  return (
    typeof value === 'string' &&
    (MEMORY_OPERATIONS as readonly string[]).includes(value)
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonemptyString);
}

/**
 * Rebuild a notice from a hook bus payload. Returns undefined when the
 * payload is not a document change or an on/off toggle.
 */
export function memoryChangedNoticeFromHookInput(
  input: Record<string, unknown>,
): MemoryChangedNotice | undefined {
  const workspace = input['workspace'];
  if (typeof input['enabled'] === 'boolean') {
    if (!isNonemptyString(workspace)) return undefined;
    return {
      paths: [],
      relativePaths: [],
      workspace,
      enabled: input['enabled'],
    };
  }
  if (
    !isMemoryScope(input['memory_scope']) ||
    !isMemoryOperation(input['operation'])
  ) {
    return undefined;
  }
  const paths = input['paths'];
  const relativePaths = input['relative_paths'];
  if (
    !isStringList(paths) ||
    !isStringList(relativePaths) ||
    paths.length === 0 ||
    paths.length !== relativePaths.length ||
    (input['memory_scope'] !== 'user' && !isNonemptyString(workspace))
  ) {
    return undefined;
  }
  return {
    scope: input['memory_scope'],
    operation: input['operation'],
    paths: [...paths],
    relativePaths: [...relativePaths],
    ...(typeof workspace === 'string' ? { workspace } : {}),
  };
}

export async function notifyMemoryEnabledChange(
  workspace: string,
  enabled: boolean,
  deliveryId?: symbol,
  signal?: AbortSignal,
): Promise<void> {
  const change: MemoryEnabledChange = {
    paths: [],
    relativePaths: [],
    workspace: path.resolve(workspace),
    enabled,
  };
  await emit(workspace, [change], deliveryId, signal);
}

interface MemoryTreeSnapshot {
  documents: Map<string, string>;
  /**
   * Paths the walk saw but could not read: 'unknown'. Unknown is never a
   * content difference — a before-side unknown relabels a would-be 'create'
   * as 'update' (the document already existed) and joins the delete
   * candidates; an after-side unknown blocks a 'delete'.
   */
  unreadable: Set<string>;
  /**
   * False when a directory could not be enumerated. 'Could not enumerate' is
   * not 'empty' — a partial snapshot must never be one side of a difference.
   */
  complete: boolean;
}

async function readMemoryTree(
  root: string,
  snapshot: MemoryTreeSnapshot,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      snapshot.complete = false;
    }
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await readMemoryTree(full, snapshot);
    } else if (entry.isFile() && isMemoryDocumentFilename(entry.name)) {
      // Only memory documents enter the diff: an atomicWriteFile
      // `*.md.<hex>.tmp` sibling, an editor swap file, or a `.DS_Store` in a
      // walked root must never be announced as a create/update/delete.
      // One unreadable or vanished file must not reject the whole snapshot
      // (the same tolerance scan.ts applies): record it as unknown instead.
      const content = await fs.readFile(full, 'utf-8').catch(() => undefined);
      if (content === undefined) {
        snapshot.unreadable.add(path.resolve(full));
      } else {
        snapshot.documents.set(path.resolve(full), content);
      }
    }
  }
}

async function readMemoryDocuments(
  projectRoot: string,
): Promise<MemoryTreeSnapshot> {
  const snapshot: MemoryTreeSnapshot = {
    documents: new Map(),
    unreadable: new Set(),
    complete: true,
  };
  await Promise.all(
    [
      getUserAutoMemoryRoot(),
      getAutoMemoryRoot(projectRoot),
      getTeamAutoMemoryRoot(projectRoot),
    ].map((root) => readMemoryTree(realpathNearestExisting(root), snapshot)),
  );
  return snapshot;
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
  signal?: AbortSignal,
): Promise<T> {
  const outside = new Map<string, string | null>();
  outsideWindowEmits.add(outside);
  try {
    const before = await readMemoryDocuments(projectRoot).catch(
      () => undefined,
    );
    try {
      return await suppressDelivery.run(outside, fn);
    } finally {
      // The snapshot is best-effort: a failure here must never replace fn's
      // outcome (the extract cursor depends on it).
      const after = await readMemoryDocuments(projectRoot).catch(
        () => undefined,
      );
      if (before?.complete && after?.complete) {
        const created: string[] = [];
        const updated: string[] = [];
        const deleted: string[] = [];
        // An outside emit moves the baseline. It does not hide the path.
        const baseline = (filePath: string) =>
          outside.has(filePath)
            ? (outside.get(filePath) ?? undefined)
            : before.documents.get(filePath);
        for (const [filePath, content] of after.documents) {
          const reported = baseline(filePath);
          if (reported === undefined) {
            // Unknown-before is not absent-before: a document the opening
            // walk saw but could not read already existed, so a now-readable
            // one is an update, not a create.
            (before.unreadable.has(filePath) ? updated : created).push(
              filePath,
            );
          } else if (reported !== content) {
            updated.push(filePath);
          }
        }
        for (const filePath of new Set([
          ...before.documents.keys(),
          ...before.unreadable,
          ...outside.keys(),
        ])) {
          // Present-or-unknown is not a delete: a path that was only
          // unreadable in the after snapshot must not be reported gone.
          if (after.documents.has(filePath) || after.unreadable.has(filePath)) {
            continue;
          }
          // A before-side unreadable entry has no content baseline, but the
          // opening walk SAW it on disk — present then, gone now is a delete.
          if (
            baseline(filePath) !== undefined ||
            before.unreadable.has(filePath)
          ) {
            deleted.push(filePath);
          }
        }
        await notifyMemoryFileChange(
          deleted,
          projectRoot,
          'delete',
          deliveryId,
          signal,
        );
        await notifyMemoryFileChange(
          updated,
          projectRoot,
          'update',
          deliveryId,
          signal,
        );
        await notifyMemoryFileChange(
          created,
          projectRoot,
          'create',
          deliveryId,
          signal,
        );
      }
    }
  } finally {
    outsideWindowEmits.delete(outside);
  }
}
