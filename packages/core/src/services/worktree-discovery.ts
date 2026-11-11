/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worktree-aware session discovery.
 *
 * Provides helpers to discover same-repo worktree paths from Git metadata and
 * to list or resolve transcript sessions across those worktrees.
 */

import { realpathSync, existsSync, createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { createInterface } from 'node:readline';
import { runLogger } from '../utils/runLogger.js';
import { isNodeError } from '../utils/errors.js';
import {
  CONFIG_DIR,
  sanitizePath,
  MAX_SANITIZED_LENGTH,
} from '../utils/paths.js';
import {
  getTranscriptProjectDir,
  getTranscriptProjectsDir,
} from './transcript-paths.js';
import {
  listTranscriptSessions,
  isSafeSessionFileStem,
  resolveTranscriptSessionById,
  type ListTranscriptSessionsOptions,
  type TranscriptSessionInfo,
  type ResolveTranscriptSessionResult,
  TranscriptSessionError,
} from './transcriptSessionService.js';
import { SessionStateStore } from './session-state-store.js';
import {
  getLegacyWorktreeState,
  projectLegacyWorktreeState,
  type PersistedWorktreeState,
} from './legacyWorktreeSessionState.js';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { decodeTranscriptLine } from './transcript/entry-codec.js';
import { beginResumeRead, isResumeReadError, type ResumeReadAttempt } from './transcript/resume-read-budget.js';

/**
 * Resolve symlinks, falling back to the original path on failure.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------------------
// Same-repo worktree path discovery
// ---------------------------------------------------------------------------

/**
 * Returns the absolute paths of all worktrees belonging to the same git
 * repository as `cwd`.
 *
 * - Reads the common Git directory and linked worktree gitdir files directly.
 * - The worktree containing `cwd` is placed first; others are sorted
 *   alphabetically.
 * - Returns an empty array when repository metadata is unavailable or `cwd`
 *   is not inside a repository.
 * - All paths are NFC-normalized for macOS compatibility.
 */
export async function getSameRepoWorktreePaths(cwd: string): Promise<string[]> {
  try {
    // Resolve symlinks on the input cwd for consistent comparison
    // (e.g., macOS /var/folders -> /private/var/folders).
    const resolvedCwd = safeRealpath(cwd);

    const layout = await resolveGitRepositoryLayout(cwd);
    if (!layout) return [];

    const worktreePaths = new Set<string>();
    worktreePaths.add(safeRealpath(layout.worktreeRoot).normalize('NFC'));
    if (nodePath.basename(layout.commonDir) === '.git') {
      worktreePaths.add(
        safeRealpath(nodePath.dirname(layout.commonDir)).normalize('NFC'),
      );
    }

    const linkedWorktreesDir = nodePath.join(layout.commonDir, 'worktrees');
    const entries = await readdir(linkedWorktreesDir, {
      withFileTypes: true,
    }).catch(() => []);
    const linkedPaths = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const privateGitDir = nodePath.join(linkedWorktreesDir, entry.name);
            const gitFile = (
              await readFile(nodePath.join(privateGitDir, 'gitdir'), 'utf8')
            ).trim();
            if (!gitFile) return null;
            const resolvedGitFile = nodePath.isAbsolute(gitFile)
              ? gitFile
              : nodePath.resolve(privateGitDir, gitFile);
            const candidateRoot = nodePath.dirname(resolvedGitFile);
            const candidateLayout = await resolveGitRepositoryLayout(
              candidateRoot,
            );
            if (
              !candidateLayout?.isWorktree ||
              normalizePathForCompare(candidateLayout.commonDir) !==
                normalizePathForCompare(layout.commonDir)
            ) {
              return null;
            }
            return safeRealpath(candidateLayout.worktreeRoot).normalize('NFC');
          } catch {
            return null;
          }
        }),
    );
    for (const linkedPath of linkedPaths) {
      if (linkedPath) worktreePaths.add(linkedPath);
    }

    // Sort: current worktree first (the one containing cwd), then alphabetically.
    // Use longest matching path to find the most specific worktree containing cwd.
    const normalizedCwd = resolvedCwd.normalize('NFC');
    let currentWorktree: string | undefined;
    for (const p of worktreePaths) {
      if (normalizedCwd === p || normalizedCwd.startsWith(p + nodePath.sep)) {
        if (!currentWorktree || p.length > currentWorktree.length) {
          currentWorktree = p;
        }
      }
    }

    const others = [...worktreePaths]
      .filter((p) => p !== currentWorktree)
      .sort();

    const result = currentWorktree ? [currentWorktree, ...others] : [...others];

    runLogger.debug(
      `[worktree-discovery] getSameRepoWorktreePaths(${cwd}): found ${result.length} worktree(s)`,
    );

    return result;
  } catch (error) {
    runLogger.debug(
      `[worktree-discovery] getSameRepoWorktreePaths failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Path normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a path for reliable comparison: resolves symlinks, normalizes
 * Unicode (NFC), and resolves to absolute.
 */
export function normalizePathForCompare(p: string): string {
  const resolved = safeRealpath(p);
  return nodePath.resolve(resolved).normalize('NFC');
}

/**
 * Returns true if `child` is the same path as `parent` or a subdirectory of it.
 * Uses `path.relative()` to avoid startsWith false positives like
 * `/tmp/repo-extra` matching `/tmp/repo`.
 */
export function isSameOrChildPath(child: string, parent: string): boolean {
  const childNorm = normalizePathForCompare(child);
  const parentNorm = normalizePathForCompare(parent);
  const rel = nodePath.relative(parentNorm, childNorm);
  return (
    rel === '' || (!!rel && !rel.startsWith('..') && !nodePath.isAbsolute(rel))
  );
}

// ---------------------------------------------------------------------------
// Worktree-aware session listing
// ---------------------------------------------------------------------------

/**
 * Represents a discovered transcript bucket with full identity.
 */
interface TranscriptBucket {
  /** The real project root for this bucket (used for SessionStateStore, resume write-back). */
  bucketProjectRoot: string;
  /** Absolute path to `~/.qwen/projects/<sanitized>`. Used for listing JSONL files. */
  bucketProjectDir: string;
  /** The git worktree root that owns this bucket. */
  ownerWorktreePath: string;
  /** Path to display in UI for source attribution. */
  displaySourcePath: string;
}

interface TranscriptBucketSet {
  currentWorktreeRoot: string;
  buckets: TranscriptBucket[];
}

/**
 * JSONL 中的项目路径与实际存储目录匹配后，得到的仓库归属。
 */
interface InferredBucketOwnership {
  /** 保留原始路径拼写，以便继续定位既有存储目录。 */
  projectRoot: string;
  /** The worktree path that actually owns this cwd. */
  ownerWorktreePath: string;
}

/**
 * Returns the managed worktree root encoded in a transcript cwd when that
 * worktree is no longer registered with Git.
 *
 * Managed worktrees live below `<repo>/<CONFIG_DIR>/worktrees/<slug>`. Once a
 * worktree is removed, its old cwd still sits below the main repository path,
 * so a plain parent-path match would incorrectly attribute its transcript to
 * the main worktree.
 */
function findRemovedManagedWorktreeRoot(
  projectRoot: string,
  worktreePaths: string[],
): string | undefined {
  const registered = new Set(worktreePaths.map(normalizePathForCompare));

  for (const worktreePath of worktreePaths) {
    const container = nodePath.join(
      normalizePathForCompare(worktreePath),
      CONFIG_DIR,
      'worktrees',
    );
    const relative = nodePath.relative(container, projectRoot);
    if (
      !relative ||
      relative.startsWith('..') ||
      nodePath.isAbsolute(relative)
    ) {
      continue;
    }

    const [slug] = relative.split(nodePath.sep);
    if (!slug) continue;

    const managedWorktreeRoot = nodePath.join(container, slug);
    if (!registered.has(managedWorktreeRoot)) {
      return managedWorktreeRoot;
    }
  }

  return undefined;
}

function isRecognizedWorktreeOwner(
  candidatePath: string,
  knownWorktreePaths: readonly string[],
): boolean {
  const normalizedCandidate = normalizePathForCompare(candidatePath);
  if (
    knownWorktreePaths.some(
      (worktreePath) =>
        normalizePathForCompare(worktreePath) === normalizedCandidate,
    )
  ) {
    return true;
  }

  return knownWorktreePaths.some((worktreePath) => {
    const managedWorktreeContainer = nodePath.join(
      normalizePathForCompare(worktreePath),
      CONFIG_DIR,
      'worktrees',
    );
    const relative = nodePath.relative(
      managedWorktreeContainer,
      normalizedCandidate,
    );
    return (
      !!relative &&
      !relative.startsWith('..') &&
      !nodePath.isAbsolute(relative) &&
      !relative.includes(nodePath.sep)
    );
  });
}

async function listRecentTranscriptFiles(
  bucketDir: string,
  maxFiles: number,
): Promise<string[]> {
  const files = await readdir(bucketDir);
  return (
    await Promise.all(
      files
        .filter((file) => file.endsWith('.jsonl'))
        .map(async (file) => {
          const filePath = nodePath.join(bucketDir, file);
          try {
            const stats = await stat(filePath);
            return { file, mtimeMs: stats.mtimeMs };
          } catch {
            return null;
          }
        }),
    )
  )
    .filter((entry): entry is { file: string; mtimeMs: number } => !!entry)
    .sort((left, right) =>
      right.mtimeMs !== left.mtimeMs
        ? right.mtimeMs - left.mtimeMs
        : right.file.localeCompare(left.file),
    )
    .slice(0, maxFiles)
    .map((entry) => nodePath.join(bucketDir, entry.file));
}

async function readRecentTranscriptProjectRoots(
  bucketDir: string,
  maxFiles = 3,
): Promise<string[]> {
  const filePaths = await listRecentTranscriptFiles(bucketDir, maxFiles);
  const roots: string[] = [];
  for (const filePath of filePaths) {
    const projectRoot = await readTranscriptBucketProjectRoot(filePath);
    if (projectRoot) {
      roots.push(projectRoot);
    }
  }
  return roots;
}

/**
 * 从最近的 JSONL 读取与 bucket 匹配的项目路径，再校验其仓库归属。
 * Hook 的执行目录可位于其他仓库；它不能替代原项目的存储身份。
 */
async function inferBucketOwnership(
  bucketDir: string,
  worktreePaths: string[],
  maxFiles = 3,
): Promise<InferredBucketOwnership | null> {
  try {
    const projectRoots = await readRecentTranscriptProjectRoots(
      bucketDir,
      maxFiles,
    );
    for (const projectRoot of projectRoots) {
      const removedManagedWorktreeRoot = findRemovedManagedWorktreeRoot(
        projectRoot,
        worktreePaths,
      );
      if (removedManagedWorktreeRoot) {
        return {
          projectRoot,
          ownerWorktreePath: removedManagedWorktreeRoot,
        };
      }

      // Find the longest (most specific) matching worktree path.
      let bestMatch: string | undefined;
      for (const wtPath of worktreePaths) {
        if (isSameOrChildPath(projectRoot, wtPath)) {
          if (!bestMatch || wtPath.length > bestMatch.length) {
            bestMatch = wtPath;
          }
        }
      }
      // A nested independent repository is still a filesystem child of the
      // current checkout. Only accept the path match when Git confirms that
      // both locations share the same common directory (linked worktrees do;
      // nested repositories do not).
      if (
        bestMatch &&
        (await pathsBelongToSameGitRepository(projectRoot, bestMatch))
      ) {
        return { projectRoot, ownerWorktreePath: bestMatch };
      }
    }
  } catch {
    // Bucket dir unreadable.
  }
  return null;
}

async function pathsBelongToSameGitRepository(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftCommonDir, rightCommonDir] = await Promise.all([
    readGitCommonDir(left),
    readGitCommonDir(right),
  ]);
  return (
    leftCommonDir !== undefined &&
    rightCommonDir !== undefined &&
    leftCommonDir === rightCommonDir
  );
}

async function readGitCommonDir(cwd: string): Promise<string | undefined> {
  const layout = await resolveGitRepositoryLayout(cwd);
  return layout ? normalizePathForCompare(layout.commonDir) : undefined;
}

/**
 * 流式读取存储归属，不依赖启动元数据的行数。项目路径必须与实际 bucket
 * 编码相符；旧 bucket 仍可使用消息 cwd，不能被 Worktree 的 originalCwd 误改。
 */
async function readTranscriptBucketProjectRoot(
  filePath: string,
  strict = false,
): Promise<string | null> {
  const bucketName = normalizeTranscriptBucketNameForCompare(
    nodePath.basename(nodePath.dirname(filePath)),
  );
  const sessionId = nodePath.basename(filePath, '.jsonl');
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      const decoded = decodeTranscriptLine(line);
      if (decoded.kind !== 'entry') continue;
      const entry = decoded.entry;
      if ('sessionId' in entry && entry.sessionId !== sessionId) continue;
      const candidates =
        entry.type === 'worktree-state'
          ? [entry.worktreeSession?.originalCwd]
          : entry.type === 'workspace-directories'
            ? entry.directories
            : 'cwd' in entry
              ? [entry.cwd]
              : [];
      for (const candidate of candidates) {
        if (
          typeof candidate === 'string' &&
          nodePath.isAbsolute(candidate) &&
          normalizeTranscriptBucketNameForCompare(sanitizePath(candidate)) ===
            bucketName
        ) {
          return candidate;
        }
      }
    }
  } catch (error) {
    if (strict) throw error;
    // Browsing may skip unreadable files; deletion must surface read errors.
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

function normalizeTranscriptBucketNameForCompare(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/**
 * Discovers all project buckets under `~/.qwen/projects/` that belong to
 * any of the given worktree paths. This includes:
 * - Exact matches (the worktree root itself, e.g., `/repo` → `-repo`)
 * - Subdirectory matches (e.g., `/repo/packages/foo` → `-repo-packages-foo`)
 *
 * For subdirectory buckets, ownership is validated using the project path
 * recorded in the bucket's JSONL files. This prevents sibling repos with
 * similar sanitized names (e.g., `/tmp/repo-subdir` vs `/tmp/repo/subdir`)
 * from being incorrectly included.
 */
async function discoverSameRepoBuckets(
  worktreePaths: string[],
): Promise<TranscriptBucket[]> {
  const indexed = worktreePaths.map((wtPath) => {
    // 根路径已带分隔符，生成子目录前缀前先去掉它，避免 C:\ 编码后重复追加 -。
    // 这里只调整匹配前缀，实际存储目录和后续 Git 归属校验仍使用原路径。
    const prefixRoot = wtPath.endsWith(nodePath.sep)
      ? wtPath.slice(0, -1)
      : wtPath;
    return {
      path: wtPath,
      prefix: normalizeTranscriptBucketNameForCompare(sanitizePath(prefixRoot)),
      // 长路径使用未截断的编码前缀筛选候选，再通过 transcript cwd 验证归属。
      rawPrefix: normalizeTranscriptBucketNameForCompare(
        prefixRoot.replace(/[^a-zA-Z0-9]/g, '-'),
      ),
    };
  });

  // Always include the worktree roots themselves as exact buckets.
  const seen = new Set<string>();
  const results: TranscriptBucket[] = [];
  for (const wt of worktreePaths) {
    const key = normalizeTranscriptBucketNameForCompare(sanitizePath(wt));
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        bucketProjectRoot: wt,
        bucketProjectDir: getTranscriptProjectDir(wt),
        ownerWorktreePath: wt,
        displaySourcePath: wt,
      });
    }
  }

  // Scan ~/.qwen/projects/ for subdirectory buckets.
  try {
    const projectsDir = getTranscriptProjectsDir();
    if (!existsSync(projectsDir)) {
      return results;
    }

    const dirents = await readdir(projectsDir, { withFileTypes: true });

    // Collect candidate subdirectory buckets for parallel validation.
    const candidates: Array<{
      dirName: string;
      bucketDir: string;
    }> = [];

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const dirName = dirent.name;
      const dirNameForCompare =
        normalizeTranscriptBucketNameForCompare(dirName);
      if (seen.has(dirNameForCompare)) continue;

      for (const { prefix, rawPrefix } of indexed) {
        // For short paths: rawPrefix === prefix, use prefix + '-' for exact prefix match.
        // For long paths (rawPrefix > MAX_SANITIZED_LENGTH): the dirName is truncated+hashed
        // so it will be shorter than rawPrefix. Use the truncated raw prefix for candidate
        // detection; transcript cwd validation will filter out false positives.
        const candidatePrefix =
          rawPrefix.length > MAX_SANITIZED_LENGTH
            ? rawPrefix.slice(0, MAX_SANITIZED_LENGTH)
            : rawPrefix;
        const isCandidate =
          (dirNameForCompare.startsWith(candidatePrefix + '-') ||
            dirNameForCompare.startsWith(prefix + '-')) &&
          dirNameForCompare !== prefix;
        if (isCandidate) {
          candidates.push({
            dirName,
            bucketDir: nodePath.join(projectsDir, dirName),
          });
          break;
        }
      }
    }

    // 校验 JSONL 的项目路径及 Git 归属，路径前缀只用于筛选候选。
    const validations = await Promise.all(
      candidates.map(async (candidate) => {
        const ownership = await inferBucketOwnership(
          candidate.bucketDir,
          worktreePaths,
        );
        return { ...candidate, ownership };
      }),
    );

    for (const { dirName, bucketDir, ownership } of validations) {
      if (ownership) {
        seen.add(normalizeTranscriptBucketNameForCompare(dirName));
        results.push({
          bucketProjectRoot: ownership.projectRoot,
          bucketProjectDir: bucketDir,
          ownerWorktreePath: ownership.ownerWorktreePath,
          displaySourcePath: ownership.projectRoot,
        });
      } else {
        runLogger.debug(
          `[worktree-discovery] skipping bucket "${dirName}": prefix matched but transcript project ownership could not be verified`,
        );
      }
    }
  } catch (error) {
    runLogger.debug(
      `[worktree-discovery] failed to scan projects dir: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return results;
}

async function getSameRepoTranscriptBucketSet(
  currentProjectRoot: string,
): Promise<TranscriptBucketSet> {
  const worktreePaths = await getSameRepoWorktreePaths(currentProjectRoot);
  const currentWorktreeRoot = worktreePaths[0] ?? currentProjectRoot;
  const buckets =
    worktreePaths.length === 0
      ? []
      : await discoverSameRepoBuckets(worktreePaths);

  // getSameRepoWorktreePaths resolves cwd through realpath, so a symlinked
  // launch cwd (logical !== real) yields buckets keyed only by the real path.
  // Sessions are written under the logical cwd bucket, so always include it or
  // resume/list would never find them.
  const logicalBucket: TranscriptBucket = {
    bucketProjectRoot: currentProjectRoot,
    bucketProjectDir: getTranscriptProjectDir(currentProjectRoot),
    ownerWorktreePath: currentWorktreeRoot,
    displaySourcePath: currentProjectRoot,
  };
  const logicalDirKey = normalizeTranscriptBucketNameForCompare(
    logicalBucket.bucketProjectDir,
  );
  const alreadyPresent = buckets.some(
    (bucket) =>
      normalizeTranscriptBucketNameForCompare(bucket.bucketProjectDir) ===
      logicalDirKey,
  );

  return {
    currentWorktreeRoot,
    buckets: alreadyPresent ? buckets : [logicalBucket, ...buckets],
  };
}

export interface ListSameRepoTranscriptSessionsOptions {
  currentProjectRoot: string;
  currentSessionId?: string;
  includeFullContent?: boolean;
  lightweight?: boolean;
  forResume?: boolean;
  resumeAttempt?: ResumeReadAttempt;
}

export interface TranscriptSessionScopes {
  current: TranscriptSessionInfo[];
  all: TranscriptSessionInfo[];
}

interface LoadedTranscriptBucket {
  bucket: TranscriptBucket;
  sessions: TranscriptSessionInfo[];
}

async function readSessionWorktreeState(
  projectRoot: string,
  sessionId: string,
): Promise<PersistedWorktreeState | null> {
  try {
    return await getLegacyWorktreeState(
      new SessionStateStore({ projectRoot, sessionId }),
    );
  } catch (error) {
    runLogger.debug(
      `[worktree-discovery] failed to read worktree state for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Adds transcript storage, logical-project, and worktree-source identity to a
 * session.
 *
 * A worktree session may keep writing its transcript to the original bucket
 * (for example when an explicit cwd is also supplied). In that case the
 * JSONL worktree state is authoritative when present. The legacy sidecar is
 * consulted only for transcripts written before `worktree-state` existed.
 * transcriptProjectRoot remains unchanged for resume write-back.
 */
async function annotateSessionSource(
  session: TranscriptSessionInfo,
  bucket: TranscriptBucket,
  currentWorktreeRoot: string,
  knownWorktreePaths: readonly string[],
  logicalWorktreePathsByProjectRoot: Map<string, Promise<string[]>>,
): Promise<void> {
  session.transcriptProjectRoot = bucket.bucketProjectRoot;
  session.transcriptProjectDir = bucket.bucketProjectDir;

  let ownerWorktreePath = bucket.ownerWorktreePath;
  let displaySourcePath = bucket.displaySourcePath;
  let worktreeState = session.worktreeSession;
  if (worktreeState === undefined) {
    const legacyState = await readSessionWorktreeState(
      bucket.bucketProjectRoot,
      session.id,
    );
    if (legacyState) {
      worktreeState = projectLegacyWorktreeState(legacyState);
      // 将旧 sidecar 投影到与 JSONL 相同的公开 Session 结构，使
      // Headless、ACP 与 TUI 共用兼容行为，且不覆盖显式 null。
      session.worktreeSession = worktreeState;
      session.cwd = worktreeState.worktreePath;
    }
  }
  const logicalProjectPath =
    worktreeState?.originalCwd ??
    session.originalCwd ??
    session.directories?.[0] ??
    bucket.bucketProjectRoot;
  session.displayProjectPath = logicalProjectPath;

  if (
    worktreeState?.worktreePath &&
    isRecognizedWorktreeOwner(worktreeState.worktreePath, knownWorktreePaths)
  ) {
    ownerWorktreePath = worktreeState.worktreePath;
    displaySourcePath = worktreeState.worktreePath;
  } else if (
    !worktreeState &&
    session.directories?.[0] &&
    normalizePathForCompare(logicalProjectPath) !==
      normalizePathForCompare(bucket.bucketProjectRoot)
  ) {
    const logicalProjectRootKey = normalizePathForCompare(logicalProjectPath);
    let logicalWorktreePathsPromise =
      logicalWorktreePathsByProjectRoot.get(logicalProjectRootKey);
    if (!logicalWorktreePathsPromise) {
      logicalWorktreePathsPromise = getSameRepoWorktreePaths(logicalProjectPath);
      logicalWorktreePathsByProjectRoot.set(
        logicalProjectRootKey,
        logicalWorktreePathsPromise,
      );
    }
    const logicalWorktreePaths = await logicalWorktreePathsPromise;
    const belongsToCurrentRepo = logicalWorktreePaths.some(
      (worktreePath) =>
        normalizePathForCompare(worktreePath) ===
        normalizePathForCompare(currentWorktreeRoot),
    );
    const logicalOwnerWorktreePath = logicalWorktreePaths[0];
    if (belongsToCurrentRepo && logicalOwnerWorktreePath) {
      ownerWorktreePath = logicalOwnerWorktreePath;
      displaySourcePath = logicalProjectPath;
    }
  }

  if (
    normalizePathForCompare(ownerWorktreePath) !==
    normalizePathForCompare(currentWorktreeRoot)
  ) {
    session.sourceWorktreePath = displaySourcePath;
  }
}

function dedupeSortAndIndexSessions(
  loadedBuckets: LoadedTranscriptBucket[],
  scope: 'current' | 'all',
): TranscriptSessionInfo[] {
  const dedupedById = new Map<string, TranscriptSessionInfo>();
  for (const { sessions } of loadedBuckets) {
    for (const session of sessions) {
      const existing = dedupedById.get(session.id);
      if (
        !existing ||
        new Date(session.lastUpdated).getTime() >
          new Date(existing.lastUpdated).getTime()
      ) {
        if (existing) {
          runLogger.debug(
            `[worktree-discovery] duplicate session id ${session.id} in ${scope} scope: keeping ${session.transcriptProjectRoot} over ${existing.transcriptProjectRoot}`,
          );
        }
        dedupedById.set(session.id, session);
      }
    }
  }

  return Array.from(dedupedById.values())
    .sort(
      (left, right) =>
        new Date(right.lastUpdated).getTime() -
        new Date(left.lastUpdated).getTime(),
    )
    .map((session, index) => ({
      ...session,
      index: index + 1,
    }));
}

/**
 * Lists transcript sessions for the current worktree and all same-repo
 * worktrees in a single bucket scan.
 *
 * Each scope is deduplicated independently. This preserves a current-worktree
 * copy when another worktree contains a newer transcript with the same session
 * id, while retaining the existing newest-copy behavior for the all-worktrees
 * scope.
 */
export async function listSameRepoTranscriptSessionScopes(
  options: ListSameRepoTranscriptSessionsOptions,
): Promise<TranscriptSessionScopes> {
  const {
    currentProjectRoot,
    currentSessionId,
    includeFullContent,
    lightweight,
  } = options;
  const listOpts: ListTranscriptSessionsOptions = {
    includeFullContent,
    lightweight: options.forResume ? true : lightweight,
    forResume: options.forResume,
    resumeAttempt: options.resumeAttempt,
  };
  const { currentWorktreeRoot, buckets } =
    await getSameRepoTranscriptBucketSet(currentProjectRoot);
  const worktreeCount = new Set(
    buckets.map((bucket) => bucket.ownerWorktreePath),
  ).size;
  const logicalWorktreePathsByProjectRoot = new Map<
    string,
    Promise<string[]>
  >();
  const knownWorktreePaths = buckets.map(
    (bucket) => bucket.ownerWorktreePath,
  );

  runLogger.debug(
    `[worktree-discovery] listing session scopes across ${buckets.length} bucket(s) from ${worktreeCount} worktree(s)`,
  );

  const loadedBuckets = await Promise.all(
    buckets.map(async (bucket) => {
      try {
        const sessions = await listTranscriptSessions(
          bucket.bucketProjectRoot,
          currentSessionId,
          { ...listOpts, projectDir: bucket.bucketProjectDir },
        );
        await Promise.all(
          sessions.map((session) =>
            annotateSessionSource(
              session,
              bucket,
              currentWorktreeRoot,
              knownWorktreePaths,
              logicalWorktreePathsByProjectRoot,
            ),
          ),
        );
        return { bucket, sessions } satisfies LoadedTranscriptBucket;
      } catch (error) {
        if (options.forResume && isResumeReadError(error)) throw error;
        runLogger.debug(
          `[worktree-discovery] failed to list sessions for bucket ${bucket.bucketProjectRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { bucket, sessions: [] } satisfies LoadedTranscriptBucket;
      }
    }),
  );

  const currentBuckets = loadedBuckets.map(({ bucket, sessions }) => ({
      bucket,
      sessions: sessions.filter((session) => !session.sourceWorktreePath),
    }));

  return {
    current: dedupeSortAndIndexSessions(currentBuckets, 'current'),
    all: dedupeSortAndIndexSessions(loadedBuckets, 'all'),
  };
}

/**
 * Lists transcript sessions across the current project root and all
 * same-repo worktrees. Each returned session carries source tracking
 * fields (`transcriptProjectRoot`, `transcriptProjectDir`,
 * `sourceWorktreePath`) so resume can rebind the writer to the correct
 * transcript bucket, plus `displayProjectPath` for presentation.
 */
export async function listSameRepoTranscriptSessions(
  options: ListSameRepoTranscriptSessionsOptions,
): Promise<TranscriptSessionInfo[]> {
  const scopes = await listSameRepoTranscriptSessionScopes(options);
  return scopes.all;
}

export interface ListAllProjectTranscriptSessionsOptions {
  currentSessionId?: string;
  includeFullContent?: boolean;
  lightweight?: boolean;
}

/**
 * Lists sessions from every directly stored transcript project bucket.
 *
 * The project root is recovered from recent transcript project metadata rather
 * than from the lossy sanitized bucket name. Unreadable or unidentifiable
 * buckets are skipped so one damaged project does not block the browser.
 */
export async function listAllProjectTranscriptSessions(
  options: ListAllProjectTranscriptSessionsOptions = {},
): Promise<TranscriptSessionInfo[]> {
  const projectsDir = getTranscriptProjectsDir();
  let dirents;
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    runLogger.debug(
      `[worktree-discovery] failed to scan all project buckets: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const loadedBuckets = await Promise.all(
    dirents
      .filter((dirent) => dirent.isDirectory())
      .map(async (dirent) => {
        const bucketProjectDir = nodePath.join(projectsDir, dirent.name);
        try {
          const [bucketProjectRoot] =
            await readRecentTranscriptProjectRoots(bucketProjectDir);
          if (!bucketProjectRoot) {
            runLogger.debug(
              `[worktree-discovery] skipping all-project bucket "${dirent.name}": transcript project identity unavailable`,
            );
            return null;
          }

          const sessions = await listTranscriptSessions(
            bucketProjectRoot,
            options.currentSessionId,
            {
              includeFullContent: options.includeFullContent,
              lightweight: options.lightweight,
              projectDir: bucketProjectDir,
            },
          );
          await Promise.all(
            sessions.map(async (session) => {
              session.transcriptProjectRoot = bucketProjectRoot;
              session.transcriptProjectDir = bucketProjectDir;
              let worktreeState = session.worktreeSession;
              if (worktreeState === undefined) {
                const legacyState = await readSessionWorktreeState(
                  bucketProjectRoot,
                  session.id,
                );
                if (legacyState) {
                  worktreeState = projectLegacyWorktreeState(legacyState);
                  session.worktreeSession = worktreeState;
                }
              }
              session.displayProjectPath =
                worktreeState?.originalCwd ??
                session.originalCwd ??
                session.directories?.[0] ??
                bucketProjectRoot;
            }),
          );
          return {
            bucket: {
              bucketProjectRoot,
              bucketProjectDir,
              ownerWorktreePath: bucketProjectRoot,
              displaySourcePath: bucketProjectRoot,
            },
            sessions,
          } satisfies LoadedTranscriptBucket;
        } catch (error) {
          runLogger.debug(
            `[worktree-discovery] failed to list all-project bucket "${dirent.name}": ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
  );

  return dedupeSortAndIndexSessions(
    loadedBuckets.filter(
      (bucket): bucket is LoadedTranscriptBucket => bucket !== null,
    ),
    'all',
  );
}

export interface TranscriptDeletionTarget {
  sessionPath: string;
  transcriptProjectRoot?: string;
}

/**
 * Locate the exact persisted file for deletion, including empty transcripts.
 * Unlike the session browser, this never samples other files or requires
 * resumable messages. Only ENOENT means absence; I/O errors must reach callers.
 */
export async function findTranscriptSessionForDeletion(
  currentProjectRoot: string,
  sessionId: string,
): Promise<TranscriptDeletionTarget | undefined> {
  if (!isSafeSessionFileStem(sessionId)) {
    throw TranscriptSessionError.invalidSessionIdentifier(sessionId);
  }
  const projectsDir = getTranscriptProjectsDir();
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const currentDir = getTranscriptProjectDir(currentProjectRoot);
  const candidates: Array<{ sessionPath: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = nodePath.join(
      projectsDir,
      entry.name,
      `${sessionId}.jsonl`,
    );
    try {
      const info = await stat(sessionPath);
      if (!info.isFile()) {
        throw new Error(`Session transcript is not a file: ${sessionPath}`);
      }
      candidates.push({ sessionPath, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      // Do not report an orphaned worktree owner as successfully deleted.
      const statePath = nodePath.join(
        projectsDir,
        entry.name,
        sessionId,
        'state.json',
      );
      try {
        await stat(statePath);
      } catch (stateError) {
        if (isNodeError(stateError) && stateError.code === 'ENOENT') continue;
        throw stateError;
      }
      throw new Error(
        `Session state exists without its transcript: ${statePath}`,
      );
    }
  }
  candidates.sort((a, b) => {
    const aCurrent = nodePath.dirname(a.sessionPath) === currentDir;
    const bCurrent = nodePath.dirname(b.sessionPath) === currentDir;
    return (
      Number(bCurrent) - Number(aCurrent) ||
      b.mtimeMs - a.mtimeMs ||
      a.sessionPath.localeCompare(b.sessionPath)
    );
  });
  const selected = candidates[0];
  if (!selected) return undefined;
  const transcriptProjectRoot =
    nodePath.dirname(selected.sessionPath) === currentDir
      ? currentProjectRoot
      : ((await readTranscriptBucketProjectRoot(selected.sessionPath, true)) ??
        undefined);
  if (!transcriptProjectRoot) {
    // An empty JSONL can be deleted by path, but must not bypass legacy state
    // whose project root is required for decoding and ownership settlement.
    const statePath = nodePath.join(
      nodePath.dirname(selected.sessionPath),
      sessionId,
      'state.json',
    );
    try {
      await stat(statePath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT')
        return { sessionPath: selected.sessionPath };
      throw error;
    }
    throw new Error(
      `Cannot determine the project root for session state: ${statePath}`,
    );
  }
  return { sessionPath: selected.sessionPath, transcriptProjectRoot };
}

// ---------------------------------------------------------------------------
// Worktree-aware session resolution
// ---------------------------------------------------------------------------

/** 列表允许跳过坏 sidecar，但选定会话后必须严格解析，不能把读取失败写成普通状态。 */
async function resolveResumeWorktreeSession(
  result: ResolveTranscriptSessionResult,
  projectRoot: string,
): Promise<ResolveTranscriptSessionResult> {
  if (result.sessionInfo.worktreeSession === undefined) {
    // 完整恢复读取已经确认 JSONL 无状态；直接兼容 sidecar，避免再读一次 JSONL。
    const legacy = await getLegacyWorktreeState(
      new SessionStateStore({
        projectRoot,
        sessionId: result.sessionInfo.id,
      }),
    );
    result.sessionInfo.worktreeSession = legacy
      ? projectLegacyWorktreeState(legacy)
      : null;
  }
  return result;
}

/**
 * Builds a full resolve result by reading the transcript for a selected session.
 */
async function buildSessionResolveResult(
  session: TranscriptSessionInfo,
  attempt?: ResumeReadAttempt,
  signal?: AbortSignal,
): Promise<ResolveTranscriptSessionResult> {
  const projectRoot =
    session.transcriptProjectRoot ??
    session.cwd ??
    session.directories?.[0] ??
    nodePath.dirname(session.sessionPath);
  const resolved = await resolveTranscriptSessionById(
    projectRoot,
    session.id,
    session.isCurrentSession ? session.id : undefined,
    {
      projectDir:
        session.transcriptProjectDir ?? nodePath.dirname(session.sessionPath),
      resumeAttempt: attempt,
      signal,
    },
  );
  if (!resolved) {
    throw new TranscriptSessionError(
      'INVALID_SESSION_IDENTIFIER',
      `Session "${session.id}" has no resumable content.`,
    );
  }
  const sessionInfo = {
    ...session,
    ...resolved.sessionInfo,
    index: session.index,
    isMetadataOnly: false,
  };
  try {
    const result = await resolveResumeWorktreeSession(
      {
        ...resolved,
        displayInfo: `Session ${session.index}: ${sessionInfo.firstUserMessage} (${sessionInfo.messageCount} messages, updated ${sessionInfo.lastUpdated})`,
        sessionInfo,
      },
      projectRoot,
    );
    result.resumeAttempt?.check();
    return result;
  } catch (error) {
    if (!attempt) resolved.resumeAttempt?.finish();
    throw error;
  }
}

/**
 * Resolves the exact session selected by the browser using its persisted path.
 */
export async function resolveSelectedTranscriptSession(
  session: TranscriptSessionInfo,
  signal?: AbortSignal,
): Promise<ResolveTranscriptSessionResult> {
  return buildSessionResolveResult(session, undefined, signal);
}

async function resolveAuthoritativeCurrentBucketSession(
  currentProjectRoot: string,
  sessionId: string,
  currentSessionId: string | undefined,
  attempt: ResumeReadAttempt,
): Promise<ResolveTranscriptSessionResult | null> {
  const result = await resolveTranscriptSessionById(
    currentProjectRoot,
    sessionId,
    currentSessionId,
    { resumeAttempt: attempt },
  );
  if (!result || result.sessionInfo.worktreeSession === undefined) {
    return null;
  }

  result.sessionInfo.transcriptProjectRoot = currentProjectRoot;
  result.sessionInfo.transcriptProjectDir =
    getTranscriptProjectDir(currentProjectRoot);
  result.sessionInfo.displayProjectPath =
    result.sessionInfo.worktreeSession?.originalCwd ??
    result.sessionInfo.originalCwd ??
    result.sessionInfo.directories?.[0] ??
    currentProjectRoot;
  return result;
}

function isNumericSessionIndex(value: string): boolean {
  const index = Number.parseInt(value, 10);
  return !Number.isNaN(index) && String(index) === value && index > 0;
}

async function resolveSameRepoTranscriptSessionByIdFromBuckets(
  bucketSet: TranscriptBucketSet,
  sessionId: string,
  currentSessionId: string | undefined,
  attempt: ResumeReadAttempt,
): Promise<ResolveTranscriptSessionResult | null> {
  if (!isSafeSessionFileStem(sessionId)) return null;
  const logicalWorktreePathsByProjectRoot = new Map<string, Promise<string[]>>();
  const candidates: Array<{ bucket: TranscriptBucket; modified: number }> = [];
  for (const bucket of bucketSet.buckets) {
    attempt.check();
    try {
      const snapshot = await stat(nodePath.join(bucket.bucketProjectDir, `${sessionId}.jsonl`));
      if (snapshot.isFile()) candidates.push({ bucket, modified: snapshot.mtimeMs });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  }
  candidates.sort((left, right) => right.modified - left.modified);
  for (const { bucket } of candidates) {
    try {
      const result = await resolveTranscriptSessionById(
        bucket.bucketProjectRoot,
        sessionId,
        currentSessionId,
        { projectDir: bucket.bucketProjectDir, resumeAttempt: attempt },
      );
      if (!result) continue;
      await annotateSessionSource(
        result.sessionInfo,
        bucket,
        bucketSet.currentWorktreeRoot,
        bucketSet.buckets.map((candidateBucket) => candidateBucket.ownerWorktreePath),
        logicalWorktreePathsByProjectRoot,
      );
      attempt.check();
      return result;
    } catch (error) {
      if (isResumeReadError(error)) throw error;
      runLogger.debug(
        `[worktree-discovery] failed direct session lookup for bucket ${bucket.bucketProjectRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

/**
 * Resolves a session identifier (UUID or numeric index) across the
 * current project root and all same-repo worktrees.
 *
 * The returned `ResolveTranscriptSessionResult` includes source tracking
 * fields on `sessionInfo` so the resume chain can rebind the transcript
 * writer to the correct bucket.
 */
export async function resolveSameRepoTranscriptSession(
  currentProjectRoot: string,
  resumeArg: string,
  currentSessionId?: string,
): Promise<ResolveTranscriptSessionResult> {
  const attempt = await beginResumeRead();
  try {
    return await resolveSameRepoTranscriptSessionWithAttempt(currentProjectRoot, resumeArg, currentSessionId, attempt);
  } catch (error) {
    attempt.finish();
    throw error;
  }
}

async function resolveSameRepoTranscriptSessionWithAttempt(
  currentProjectRoot: string,
  resumeArg: string,
  currentSessionId: string | undefined,
  attempt: ResumeReadAttempt,
): Promise<ResolveTranscriptSessionResult> {
  const trimmed = resumeArg.trim();
  if (!isNumericSessionIndex(trimmed)) {
    // 新 JSONL 已用对象或 null 明确标记会话类型。UUID 在当前 bucket
    // 直接命中时不再承担 Git Worktree 枚举和旧 sidecar 读取成本。
    const currentBucket = await resolveAuthoritativeCurrentBucketSession(
      currentProjectRoot,
      trimmed,
      currentSessionId,
      attempt,
    );
    if (currentBucket) {
      return currentBucket;
    }

    const bucketSet = await getSameRepoTranscriptBucketSet(currentProjectRoot);
    const direct = await resolveSameRepoTranscriptSessionByIdFromBuckets(
      bucketSet,
      trimmed,
      currentSessionId,
      attempt,
    );
    if (direct) {
      return resolveResumeWorktreeSession(
        direct,
        direct.sessionInfo.transcriptProjectRoot ?? currentProjectRoot,
      );
    }
    const searchedDirs = [
      ...new Set(bucketSet.buckets.map((bucket) => bucket.bucketProjectDir)),
    ];
    const dirInfo =
      searchedDirs.length > 0
        ? `\n  Searched current project and same-repo worktrees:\n${searchedDirs.map((d) => `    - ${d}`).join('\n')}`
        : '';
    throw new TranscriptSessionError(
      'INVALID_SESSION_IDENTIFIER',
      `Invalid session identifier "${trimmed}".${dirInfo}\n  Use --list-sessions to see available sessions.`,
    );
  }

  const sessions = await listSameRepoTranscriptSessions({
    currentProjectRoot,
    currentSessionId,
    forResume: true,
    resumeAttempt: attempt,
  });

  if (sessions.length === 0) {
    const worktreePaths = await getSameRepoWorktreePaths(currentProjectRoot);
    const searchInfo =
      worktreePaths.length > 1
        ? ` Searched ${worktreePaths.length} same-repo worktrees.`
        : '';
    throw new TranscriptSessionError(
      'NO_SESSIONS_FOUND',
      `No previous sessions found for ${currentProjectRoot}.${searchInfo}\n  Use --list-sessions to see available sessions.`,
    );
  }

  let selected: TranscriptSessionInfo | undefined;

  // Try exact UUID match.
  selected = sessions.find((session) => session.id === trimmed);

  // Try numeric index match.
  if (!selected) {
    const index = Number.parseInt(trimmed, 10);
    if (
      !Number.isNaN(index) &&
      String(index) === trimmed &&
      index > 0 &&
      index <= sessions.length
    ) {
      selected = sessions[index - 1];
    }
  }

  if (!selected) {
    const searchedDirs = [
      ...new Set(sessions.map((s) => s.transcriptProjectDir ?? '')),
    ].filter(Boolean);
    const dirInfo =
      searchedDirs.length > 0
        ? `\n  Searched current project and same-repo worktrees:\n${searchedDirs.map((d) => `    - ${d}`).join('\n')}`
        : '';
    throw new TranscriptSessionError(
      'INVALID_SESSION_IDENTIFIER',
      `Invalid session identifier "${trimmed}".${dirInfo}\n  Use --list-sessions to see available sessions.`,
    );
  }

  sessions.length = 0;
  return buildSessionResolveResult(selected, attempt);
}

/**
 * Resolves the most recently updated session across same-repo worktrees.
 */
export async function resolveLatestSameRepoTranscriptSession(
  currentProjectRoot: string,
  currentSessionId?: string,
): Promise<ResolveTranscriptSessionResult> {
  const attempt = await beginResumeRead();
  try {
    const selected = await selectLatestSameRepoTranscriptSession(
      currentProjectRoot,
      currentSessionId,
      attempt,
    );
    return await buildSessionResolveResult(selected, attempt);
  } catch (error) {
    attempt.finish();
    throw error;
  }
}

/** Select the source without loading messages. A daemon session reads them after the close/flush barrier. */
export async function selectLatestSameRepoTranscriptSession(
  currentProjectRoot: string,
  currentSessionId: string | undefined,
  attempt: ResumeReadAttempt,
): Promise<TranscriptSessionInfo> {
  const sessions = await listSameRepoTranscriptSessions({
    currentProjectRoot,
    currentSessionId,
    forResume: true,
    resumeAttempt: attempt,
  });

  if (sessions.length === 0) {
    const worktreePaths = await getSameRepoWorktreePaths(currentProjectRoot);
    const searchInfo =
      worktreePaths.length > 1
        ? ` Searched ${worktreePaths.length} same-repo worktrees.`
        : '';
    throw new TranscriptSessionError(
      'NO_SESSIONS_FOUND',
      `No previous sessions found for ${currentProjectRoot}.${searchInfo}`,
    );
  }

  return sessions[0];
}
