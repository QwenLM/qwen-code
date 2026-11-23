/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { isNodeError } from '../utils/errors.js';
import {
  getProjectHash,
  QWEN_DIR,
  realpathNearestExisting,
  resolvePath,
  sanitizeCwd,
} from '../utils/paths.js';
import {
  getImportedProjectMemoryRoot,
  clearMemoryImportIdentityCache,
} from './import-paths.js';
import {
  clearGitMemoryIdentityCache,
  readMemoryMetadata,
  resolveGitMemoryLocation,
  type GitMemoryIdentity,
} from './git-memory-identity.js';
import type { AutoMemoryType } from './types.js';
import { MEMORY_PROJECT_SCOPES, type MemoryProjectScope } from './scopes.js';

export const AUTO_MEMORY_DIRNAME = 'memory';
export const AUTO_MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const AUTO_MEMORY_PINNED_DIRNAME = 'pinned';
export const AUTO_MEMORY_METADATA_FILENAME = 'meta.json';
export const AUTO_MEMORY_EXTRACT_CURSOR_FILENAME = 'extract-cursor.json';
export const AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME = 'consolidation.lock';
export const USER_AUTO_MEMORY_METADATA_FILENAME = 'user-memory-meta.json';
export const USER_AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME =
  'user-memory-consolidation.lock';

/**
 * Top-level directory name (under getMemoryBaseDir()) for the user-level
 * auto-memory layer — cross-project facts about the user (preferences,
 * working style, background). Mirror layout of the per-project memory dir.
 */
export const USER_AUTO_MEMORY_DIRNAME = 'memories';

/**
 * Directory name (under the repo's `.qwen/`) for the team auto-memory layer —
 * project memory shared with every collaborator. Unlike the private layers it
 * lives INSIDE the repository and is tracked by git, which is the sync transport.
 */
export const TEAM_AUTO_MEMORY_DIRNAME = 'team-memory';

// Canonical definitions live in scopes.ts (a zero-import leaf module that can
// be subpath-imported without pulling the core barrel). Re-exported here so
// the barrel surface is unchanged.
export { MEMORY_PROJECT_SCOPES, type MemoryProjectScope } from './scopes.js';

function findGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Returns the base directory for all auto-memory storage.
 * Defaults to the runtime output dir (`runtimeOutputDir`, `QWEN_RUNTIME_DIR`,
 * or the global qwen dir);
 * overridable via QWEN_CODE_MEMORY_BASE_DIR for tests.
 */
export function getMemoryBaseDir(): string {
  if (process.env['QWEN_CODE_MEMORY_BASE_DIR']) {
    return resolvePath(undefined, process.env['QWEN_CODE_MEMORY_BASE_DIR']);
  }
  return Storage.getRuntimeBaseDir();
}

const repositoryBindings = new Map<string, string>();

// Memoized on projectRoot alone: the team root resolves via findGitRoot, which
// does sync fs I/O — and isTeamAutoMemPath runs on every file write.
const _teamAutoMemoryRootCache = new Map<string, string>();

let warnedUnknownMemoryProjectScope = false;
let warnedImportedMemoryIdentityLost = false;

/**
 * Resolve QWEN_CODE_MEMORY_PROJECT_SCOPE. Only "workspace" (after trimming and
 * lowercasing) opts into per-workspace partitioning; anything else keeps the
 * git-root scope. An unrecognized non-empty value warns once so a typo surfaces
 * instead of silently falling back to the shared scope this flag exists to
 * prevent.
 */
const projectScopeContext = new AsyncLocalStorage<MemoryProjectScope>();
interface PinnedProjectMemoryOwner {
  cwd: string;
  memoryBaseDir?: string;
}
type ProjectMemoryOwner = string | PinnedProjectMemoryOwner;
type ProjectMemoryOwnerResolver =
  | ProjectMemoryOwner
  | ((projectRoot: string) => ProjectMemoryOwner | undefined)
  | undefined;
const projectOwnerContext = new AsyncLocalStorage<ProjectMemoryOwnerResolver>();
let standaloneProjectOwner: ProjectMemoryOwnerResolver;

export function setStandaloneProjectMemoryOwner(
  owner: (projectRoot: string) => ProjectMemoryOwner | undefined,
): void {
  standaloneProjectOwner = owner;
}

export function runWithMemoryProjectScope<T>(
  scope: MemoryProjectScope,
  run: () => T,
): T {
  return projectScopeContext.run(scope, run);
}

export function runWithMemoryProjectOwner<T>(
  owner: ProjectMemoryOwnerResolver,
  run: () => T,
): T {
  return projectOwnerContext.run(owner, run);
}

export function getMemoryProjectOwner(projectRoot: string): string {
  return resolvePinnedProjectMemoryOwner(projectRoot).cwd;
}

function resolvePinnedProjectMemoryOwner(
  projectRoot: string,
): PinnedProjectMemoryOwner {
  const owner = projectOwnerContext.getStore() ?? standaloneProjectOwner;
  const resolved = typeof owner === 'function' ? owner(projectRoot) : owner;
  return typeof resolved === 'object'
    ? resolved
    : { cwd: resolved ?? projectRoot };
}

function resolveMemoryProjectScope(): MemoryProjectScope {
  const scoped = projectScopeContext.getStore();
  if (scoped) return scoped;
  const raw = process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
  if (raw === undefined) return 'git-root';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'workspace') return 'workspace';
  if (
    normalized !== '' &&
    !(MEMORY_PROJECT_SCOPES as readonly string[]).includes(normalized) &&
    !warnedUnknownMemoryProjectScope
  ) {
    warnedUnknownMemoryProjectScope = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring unrecognized QWEN_CODE_MEMORY_PROJECT_SCOPE="${raw}"; ` +
        'falling back to "git-root". Expected "git-root" or "workspace".',
    );
  }
  return 'git-root';
}

export function getLegacyProjectMemoryRoot(checkout: string): string {
  return path.join(
    getMemoryBaseDir(),
    'projects',
    sanitizeCwd(path.resolve(checkout)),
    AUTO_MEMORY_DIRNAME,
  );
}

export interface ProjectMemoryTarget {
  owner: string;
  scope: MemoryProjectScope;
  memoryRoot: string;
}

function physicalDirectory(directory: string): string {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}

function hasDirectory(directory: string): boolean {
  return (
    fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() ?? false
  );
}

function readRepositoryBinding(
  filename: string,
  canonicalRoot: string,
): string | undefined {
  let binding: string;
  try {
    binding = readMemoryMetadata(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (binding === 'canonical\n') return canonicalRoot;
  if (binding.startsWith('legacy:')) {
    const checkout = binding.slice('legacy:'.length, -1);
    if (
      path.isAbsolute(checkout) &&
      !checkout.includes('\0') &&
      binding.endsWith('\n')
    )
      return getLegacyProjectMemoryRoot(checkout);
  }
  throw new Error(`Invalid project memory binding at ${filename}.`);
}

function getRepositoryMemoryRoot(
  git: GitMemoryIdentity,
  readOnly: boolean,
): string {
  const base = getMemoryBaseDir();
  const id = getProjectHash(git.commonDir);
  const canonicalRoot = path.join(
    base,
    'project-memory',
    id,
    AUTO_MEMORY_DIRNAME,
  );
  const directory = path.join(base, 'project-memory-bindings');
  const filename = path.join(directory, id);
  const cached = repositoryBindings.get(filename);
  if (cached !== undefined) return cached;
  const existing = () => {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isDirectory())
      throw new Error(
        `Invalid project memory binding directory at ${directory}.`,
      );
    return readRepositoryBinding(filename, canonicalRoot);
  };
  let memoryRoot = existing();
  if (!memoryRoot) {
    const legacy = getLegacyProjectMemoryRoot(git.checkout);
    const useLegacy =
      git.kind === 'main' &&
      !hasDirectory(canonicalRoot) &&
      hasDirectory(legacy);
    memoryRoot = useLegacy ? legacy : canonicalRoot;
    if (readOnly) return memoryRoot;

    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const winner = existing();
    if (winner) {
      memoryRoot = winner;
    } else {
      // Publish a complete record without replacing another process's choice.
      const staging = path.join(directory, randomUUID());
      try {
        fs.writeFileSync(
          staging,
          useLegacy ? `legacy:${git.checkout}\n` : 'canonical\n',
          {
            flag: 'wx',
            mode: 0o600,
            flush: true,
          },
        );
        try {
          fs.linkSync(staging, filename);
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
          const bound = existing();
          if (!bound) throw error;
          memoryRoot = bound;
        }
      } finally {
        fs.rmSync(staging, { force: true });
      }
    }
  }
  if (!readOnly) {
    if (repositoryBindings.size >= 256) {
      const first = repositoryBindings.keys().next().value;
      if (first !== undefined) repositoryBindings.delete(first);
    }
    repositoryBindings.set(filename, memoryRoot);
  }
  return memoryRoot;
}

export function resolveProjectMemoryTarget(
  projectRoot: string,
  options: { scope?: MemoryProjectScope; readOnly?: boolean } = {},
): ProjectMemoryTarget {
  const scope = options.scope ?? resolveMemoryProjectScope();
  if (process.env['QWEN_CODE_MEMORY_LOCAL'] === '1') {
    const owner = path.resolve(projectRoot);
    return {
      owner,
      scope,
      memoryRoot: path.join(owner, QWEN_DIR, AUTO_MEMORY_DIRNAME),
    };
  }
  if (scope === 'workspace') {
    const owner = physicalDirectory(projectRoot);
    return { owner, scope, memoryRoot: getLegacyProjectMemoryRoot(owner) };
  }
  const { identity, separateCheckout } = resolveGitMemoryLocation(projectRoot);
  if (!identity) {
    const owner = separateCheckout ?? path.resolve(projectRoot);
    return { owner, scope, memoryRoot: getLegacyProjectMemoryRoot(owner) };
  }
  return {
    owner: identity.commonDir,
    scope,
    memoryRoot: getRepositoryMemoryRoot(identity, options.readOnly ?? false),
  };
}

const checkedMigrationHints = new Set<string>();

function getProjectMemoryMigrationHint(
  projectRoot: string,
  { scope, memoryRoot }: ProjectMemoryTarget,
): string | undefined {
  const git =
    scope === 'git-root'
      ? resolveGitMemoryLocation(projectRoot).identity
      : null;
  const checkout = git?.checkout ?? physicalDirectory(projectRoot);
  const checkoutLegacy = getLegacyProjectMemoryRoot(checkout);
  if (checkoutLegacy !== memoryRoot && hasDirectory(checkoutLegacy)) {
    return 'Historical project memory is available. Run `qwen memory import worktree` to preview it.';
  }
  for (
    let alias = path.resolve(projectRoot);
    alias !== checkout;
    alias = path.dirname(alias)
  ) {
    if (physicalDirectory(alias) === checkout) {
      const legacy = getLegacyProjectMemoryRoot(alias);
      if (legacy !== memoryRoot && hasDirectory(legacy))
        return 'Historical project memory is available. Run `qwen memory import worktree` to preview it.';
      break;
    }
    if (path.dirname(alias) === alias) break;
  }
  if (git?.kind === 'linked' && path.basename(git.commonDir) === '.git') {
    const unverified = getLegacyProjectMemoryRoot(path.dirname(git.commonDir));
    if (unverified !== memoryRoot && hasDirectory(unverified)) {
      return 'This worktree uses shared project memory. A possible historical main checkout memory store was found. Open the main checkout to verify it or run `qwen memory import worktree --source <checkout>` to preview it.';
    }
  }
  return undefined;
}

export function getAutoMemoryRoot(projectRoot: string): string {
  const { cwd, memoryBaseDir } = resolvePinnedProjectMemoryOwner(projectRoot);
  const resolveRoot = () => {
    const target = resolveProjectMemoryTarget(cwd);
    if (process.env['QWEN_CODE_MEMORY_LOCAL'] !== '1') {
      const key = `${target.memoryRoot}\0${projectRoot}`;
      if (!checkedMigrationHints.has(key)) {
        if (checkedMigrationHints.size >= 256) checkedMigrationHints.clear();
        checkedMigrationHints.add(key);
        const hint = getProjectMemoryMigrationHint(projectRoot, target);
        if (hint) {
          // eslint-disable-next-line no-console
          console.warn(`[qwen-code] ${hint}`);
        }
      }
    }
    return target.memoryRoot;
  };
  return memoryBaseDir === undefined
    ? resolveRoot()
    : Storage.runWithResolvedRuntimeBaseDir(memoryBaseDir, resolveRoot);
}

/** Clear the memoization caches (for tests that change environment or git layout). */
export function clearAutoMemoryRootCache(): void {
  repositoryBindings.clear();
  checkedMigrationHints.clear();
  clearGitMemoryIdentityCache();
  clearMemoryImportIdentityCache();
  _teamAutoMemoryRootCache.clear();
  warnedUnknownMemoryProjectScope = false;
  warnedImportedMemoryIdentityLost = false;
}

/**
 * The trusted filesystem anchor for a project's managed-memory root: the prefix
 * of getAutoMemoryRoot() that is derived from the user's environment rather than
 * repo-tracked contents, and is therefore safe to canonicalize through symlinks.
 *
 * In local-memory mode (`QWEN_CODE_MEMORY_LOCAL=1`) the root is
 * `<projectRoot>/.qwen/memory`, so the anchor is the project root; otherwise the
 * root lives under the shared memory base dir, which is the anchor. The write
 * boundary (isAllowedMemoryPath) canonicalizes this anchor but appends the
 * managed suffix literally, so a symlink planted INSIDE the suffix (e.g. a
 * repo-tracked `.qwen -> /outside`) can't silently relocate the allowed root
 * out of the trusted anchor.
 */
export function getAutoMemoryTrustedAnchor(projectRoot: string): string {
  const { cwd, memoryBaseDir } = resolvePinnedProjectMemoryOwner(projectRoot);
  if (process.env['QWEN_CODE_MEMORY_LOCAL'] === '1') return cwd;
  return memoryBaseDir === undefined
    ? getMemoryBaseDir()
    : Storage.runWithResolvedRuntimeBaseDir(memoryBaseDir, getMemoryBaseDir);
}

export function getProjectAutoMemoryRoots(
  projectRoot: string,
  trustedProject: boolean,
): string[] {
  const configuredRoot = getAutoMemoryRoot(projectRoot);
  const owner = getMemoryProjectOwner(projectRoot);
  const localRoot = path.join(owner, QWEN_DIR, AUTO_MEMORY_DIRNAME);
  const roots =
    path.resolve(configuredRoot) === path.resolve(localRoot)
      ? trustedProject
        ? [configuredRoot]
        : []
      : trustedProject
        ? [configuredRoot, localRoot]
        : [configuredRoot];
  if (
    trustedProject &&
    fs.existsSync(
      path.join(Storage.getRuntimeBaseDir(), 'imported-project-memory'),
    )
  ) {
    try {
      const imported = getImportedProjectMemoryRoot(owner);
      if (fs.existsSync(imported)) roots.push(imported);
    } catch (error) {
      // Invalid Git metadata must not redirect recall into another
      // repository, but silently dropping every imported document is not
      // acceptable either: surface the cause once so the user can repair it.
      if (!warnedImportedMemoryIdentityLost) {
        warnedImportedMemoryIdentityLost = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[qwen-code] Imported project memory is unavailable for this repository: ${
            error instanceof Error ? error.message : String(error)
          } If a linked worktree was moved, run \`git worktree repair\`.`,
        );
      }
    }
  }
  return roots;
}

export function getMemoryRootTrustedAnchor(root: string): string {
  const baseDir = path.resolve(getMemoryBaseDir());
  const resolvedRoot = path.resolve(root);
  const relativeToBase = path.relative(baseDir, resolvedRoot);
  if (
    relativeToBase === '' ||
    (!relativeToBase.startsWith(`..${path.sep}`) &&
      relativeToBase !== '..' &&
      !path.isAbsolute(relativeToBase))
  ) {
    return baseDir;
  }
  const parent = path.dirname(resolvedRoot);
  const grandparent = path.dirname(parent);
  if (
    path.basename(resolvedRoot) === AUTO_MEMORY_DIRNAME &&
    path.basename(parent) !== QWEN_DIR &&
    ['project-memory', 'projects'].includes(path.basename(grandparent))
  )
    return path.dirname(grandparent);
  return grandparent;
}

/**
 * Returns the project-level state directory that holds auxiliary files
 * (meta.json, extract-cursor.json, consolidation.lock) for the given project.
 * This is the parent of getAutoMemoryRoot(), so memory/ stays clean:
 * only MEMORY.md and topic files live inside it.
 */
export function getAutoMemoryProjectStateDir(projectRoot: string): string {
  return path.dirname(getAutoMemoryRoot(projectRoot));
}

/**
 * Returns true if the given absolute path is inside the auto-memory root for
 * the given project.
 *
 * Uses path.relative() instead of startsWith() to correctly handle
 * platform path-separator differences (e.g. Windows backslash vs forward
 * slash) and to be resilient against path-traversal edge cases.
 */
export function isAutoMemPath(
  absolutePath: string,
  projectRoot: string,
): boolean {
  const normalizedPath = path.normalize(absolutePath);
  const memRoot = path.normalize(getAutoMemoryRoot(projectRoot));
  const rel = path.relative(memRoot, normalizedPath);
  // rel === '' means absolutePath IS memRoot itself.
  // !rel.startsWith('..') && !path.isAbsolute(rel) means it's strictly inside.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function getAutoMemoryIndexPath(projectRoot: string): string {
  return path.join(getAutoMemoryRoot(projectRoot), AUTO_MEMORY_INDEX_FILENAME);
}

export function getAutoMemoryMetadataPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_METADATA_FILENAME,
  );
}

export function getAutoMemoryExtractCursorPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  );
}

export function getAutoMemoryConsolidationLockPath(
  projectRoot: string,
): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME,
  );
}

export function getAutoMemoryTopicFilename(type: AutoMemoryType): string {
  return `${type}.md`;
}

export function getAutoMemoryTopicPath(
  projectRoot: string,
  type: AutoMemoryType,
): string {
  return path.join(
    getAutoMemoryRoot(projectRoot),
    getAutoMemoryTopicFilename(type),
  );
}

export function getAutoMemoryFilePath(
  projectRoot: string,
  relativePath: string,
): string {
  return path.join(getAutoMemoryRoot(projectRoot), relativePath);
}

/**
 * Returns the user-level (cross-project) auto-memory root.
 * Lives at `${getMemoryBaseDir()}/memories/` — typically `~/.qwen/memories/`.
 * Unlike project memory, this is NOT scoped to a git root; it is shared
 * across every project the user works in.
 */
export function getUserAutoMemoryRoot(): string {
  return path.join(getMemoryBaseDir(), USER_AUTO_MEMORY_DIRNAME);
}

export function getUserAutoMemoryIndexPath(): string {
  return path.join(getUserAutoMemoryRoot(), AUTO_MEMORY_INDEX_FILENAME);
}

export function getUserAutoMemoryMetadataPath(): string {
  return path.join(getMemoryBaseDir(), USER_AUTO_MEMORY_METADATA_FILENAME);
}

export function getUserAutoMemoryConsolidationLockPath(): string {
  return path.join(
    getMemoryBaseDir(),
    USER_AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME,
  );
}

export function getUserAutoMemoryTopicPath(type: AutoMemoryType): string {
  return path.join(getUserAutoMemoryRoot(), getAutoMemoryTopicFilename(type));
}

/**
 * Returns true if the given absolute path is inside the user-level
 * auto-memory root. Uses path.relative() (not startsWith) so platform
 * path-separator differences and path-traversal edge cases are handled.
 */
export function isUserAutoMemPath(absolutePath: string): boolean {
  const normalizedPath = path.normalize(absolutePath);
  const memRoot = path.normalize(getUserAutoMemoryRoot());
  const rel = path.relative(memRoot, normalizedPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns the team auto-memory root: `<gitRoot>/.qwen/team-memory/`.
 * Anchored at the current worktree root so tracked writes appear in the active
 * branch diff. Falls back to projectRoot when there is no git root.
 */
export function getTeamAutoMemoryRoot(projectRoot: string): string {
  const cached = _teamAutoMemoryRootCache.get(projectRoot);
  if (cached !== undefined) return cached;
  const root = findGitRoot(projectRoot) ?? path.resolve(projectRoot);
  const result = path.join(root, QWEN_DIR, TEAM_AUTO_MEMORY_DIRNAME);
  _teamAutoMemoryRootCache.set(projectRoot, result);
  return result;
}

export function getTeamAutoMemoryIndexPath(projectRoot: string): string {
  return path.join(
    getTeamAutoMemoryRoot(projectRoot),
    AUTO_MEMORY_INDEX_FILENAME,
  );
}

/**
 * True if the given absolute path is inside the team memory root for the
 * given project. Uses path.relative() (not startsWith) so platform
 * path-separator differences and path-traversal edge cases are handled.
 */
export function isTeamAutoMemPath(
  absolutePath: string,
  projectRoot: string,
): boolean {
  const normalizedPath = path.normalize(realpathNearestExisting(absolutePath));
  const memRoot = path.normalize(
    realpathNearestExisting(getTeamAutoMemoryRoot(projectRoot)),
  );
  const rel = path.relative(memRoot, normalizedPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns true when the resolved file lives in any managed-memory layer.
 *
 * Unlike {@link isAnyAutoMemPath}, this helper includes team memory and is
 * intended only for read retention. It does not grant write permissions.
 * Resolving the nearest existing path prevents a symlink inside a memory root
 * from protecting content that actually lives outside that root.
 */
export function isManagedMemoryPath(
  filePath: string,
  projectRoot: string,
  baseDir: string = projectRoot,
): boolean {
  const absolutePath = path.resolve(baseDir, filePath);
  const resolvedPath = path.normalize(realpathNearestExisting(absolutePath));
  const roots = [
    getAutoMemoryRoot(projectRoot),
    getUserAutoMemoryRoot(),
    getTeamAutoMemoryRoot(projectRoot),
  ];
  return roots.some((root) => {
    const resolvedRoot = path.normalize(realpathNearestExisting(root));
    const rel = path.relative(resolvedRoot, resolvedPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * True if the path lives in EITHER the project-level memory root for the
 * given project OR the user-level memory root. Used by the extraction
 * agent's sandbox to allow writes to both scopes.
 *
 * Security-load-bearing: team memory is deliberately EXCLUDED. It is committed
 * to the repo and shared with collaborators, so its writes must stay 'ask' and
 * never be auto-approved through this predicate. Do not add team paths here.
 */
export function isAnyAutoMemPath(
  absolutePath: string,
  projectRoot: string,
): boolean {
  return (
    isAutoMemPath(absolutePath, projectRoot) || isUserAutoMemPath(absolutePath)
  );
}
