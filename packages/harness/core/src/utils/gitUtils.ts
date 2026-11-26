/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitEnv, internalGitArgs } from './gitCommandPolicy.js';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { addAbortSignal } from 'node:stream';

export interface GitRepositoryLayout {
  /** Canonical path to the working tree containing the inspected directory. */
  worktreeRoot: string;
  /** Canonical path to this working tree's private Git directory. */
  gitDir: string;
  /** Canonical path shared by every linked worktree in the repository. */
  commonDir: string;
  /** True only for a linked worktree, not the repository's primary checkout. */
  isWorktree: boolean;
}

export interface GitHeadState {
  /** Full symbolic ref stored in HEAD, for example refs/heads/main. */
  ref?: string;
  /** Local branch name derived from refs/heads/* when HEAD is symbolic. */
  branch?: string;
  /** Commit object id when it can be read from loose refs or packed-refs. */
  commit?: string;
}

const GIT_DIRECTORY_POINTER_PREFIX = 'gitdir:';
const VALID_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_GIT_CONTROL_FILE_BYTES = 4 * 1024;
const MAX_GIT_REF_FILE_BYTES = 256;
const MAX_PACKED_REFS_LINE_BYTES = 8 * 1024;
export const DEFAULT_GIT_METADATA_PROBE_TIMEOUT_MS = 2_000;

const GIT_REPOSITORY_SELECTOR_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

export interface GitMetadataProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Preserve timeout as an error when the caller needs to evict a cache. */
  throwOnTimeout?: boolean;
  /** Preserve layout probe I/O errors (except ENOENT) and timeouts. Defaults to false. */
  throwOnError?: boolean;
}

export class GitMetadataProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Git metadata probe exceeded ${timeoutMs}ms`);
    this.name = 'GitMetadataProbeTimeoutError';
  }
}

/**
 * Build an environment for repository-local internal Git commands.
 *
 * Git repository selector variables override `git -C`. Removing them keeps
 * metadata collected through Git consistent with metadata read directly from
 * the directory passed by the caller. Authentication, proxy and user config
 * variables remain untouched.
 */
export function createGitCommandEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = internalGitEnv(source);
  for (const name of GIT_REPOSITORY_SELECTOR_ENV_VARS) {
    delete env[name];
  }
  return env;
}

async function withMetadataDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: GitMetadataProbeOptions,
): Promise<T> {
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_GIT_METADATA_PROBE_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    throw new GitMetadataProbeTimeoutError(timeoutMs);
  }
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternalSignal = () =>
    controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, {
      once: true,
    });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const rejectFromAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) {
      rejectFromAbort();
    } else {
      controller.signal.addEventListener('abort', rejectFromAbort, {
        once: true,
      });
      removeAbortListener = () =>
        controller.signal.removeEventListener('abort', rejectFromAbort);
    }
  });
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new GitMetadataProbeTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      operation(controller.signal),
      cancellation,
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  signal: AbortSignal,
  throwOnError = false,
): Promise<string | null> {
  signal.throwIfAborted();
  const initialStat = await lstatOrNull(filePath);
  if (!initialStat?.isFile() || initialStat.isSymbolicLink()) return null;
  if (initialStat.size > maxBytes) return null;

  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fs.constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxBytes) return null;

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > maxBytes) return null;
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    return content.includes('\0') ? null : content;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (
      isNodeError(error) &&
      (error.code === 'ENOENT' ||
        (!throwOnError && ['ELOOP', 'EINVAL'].includes(error.code ?? '')))
    ) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function canonicalizePath(
  value: string,
  throwOnError = false,
): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (throwOnError && !(isNodeError(error) && error.code === 'ENOENT')) {
      throw error;
    }
    return path.resolve(value);
  }
}

async function classifyGitMarker(
  markerPath: string,
  throwOnError = false,
): Promise<'directory' | 'file' | null> {
  try {
    const markerStat = await lstat(markerPath);
    if (markerStat.isDirectory()) return 'directory';
    if (markerStat.isFile()) return 'file';
    return null;
  } catch (error) {
    if (throwOnError && !(isNodeError(error) && error.code === 'ENOENT')) {
      throw error;
    }
    return null;
  }
}

async function isDirectory(
  directory: string,
  throwOnError = false,
): Promise<boolean> {
  try {
    const directoryStat = await lstat(directory);
    return directoryStat.isDirectory() && !directoryStat.isSymbolicLink();
  } catch (error) {
    if (throwOnError && !(isNodeError(error) && error.code === 'ENOENT')) {
      throw error;
    }
    return false;
  }
}

function parseGitDirectoryPointer(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine?.toLowerCase().startsWith(GIT_DIRECTORY_POINTER_PREFIX)) {
    return null;
  }
  const value = firstLine.slice(GIT_DIRECTORY_POINTER_PREFIX.length).trim();
  return value || null;
}

async function resolveCommonGitDirectory(
  gitDir: string,
  signal: AbortSignal,
  throwOnError = false,
): Promise<string | null> {
  const commondirPath = path.join(gitDir, 'commondir');
  const commondirStat = await lstatOrNull(commondirPath);
  if (!commondirStat) return gitDir;
  const content = await readBoundedRegularFile(
    commondirPath,
    MAX_GIT_CONTROL_FILE_BYTES,
    signal,
    throwOnError,
  );
  const value = content?.trim();
  if (!value) return null;
  return canonicalizePath(
    path.isAbsolute(value) ? value : path.resolve(gitDir, value),
    throwOnError,
  );
}

function parseGitHead(content: string): GitHeadState | null {
  const head = content.trim();
  if (VALID_OBJECT_ID.test(head)) return { commit: head };
  const refMatch = /^ref:\s*(.+)$/.exec(head);
  const ref = refMatch?.[1]?.trim();
  if (!ref || !isSafeGitRef(ref)) return null;
  return {
    ref,
    ...(ref.startsWith('refs/heads/')
      ? { branch: ref.slice('refs/heads/'.length) }
      : {}),
  };
}

async function validateGitDirectory(
  gitDir: string,
  commonDir: string,
  signal: AbortSignal,
  throwOnError = false,
): Promise<boolean> {
  const head = await readBoundedRegularFile(
    path.join(gitDir, 'HEAD'),
    MAX_GIT_CONTROL_FILE_BYTES,
    signal,
    throwOnError,
  );
  // Reftable stores the real HEAD in its tables; these files are Git's
  // compatibility markers, sufficient for layout discovery, not HEAD parsing.
  if (!head || !parseGitHead(head)) {
    if (
      head?.trim() !== 'ref: refs/heads/.invalid' ||
      (await readBoundedRegularFile(
        path.join(commonDir, 'refs', 'heads'),
        MAX_GIT_CONTROL_FILE_BYTES,
        signal,
        throwOnError,
      ))?.trim() !== 'this repository uses the reftable format'
    ) {
      return false;
    }
  }
  const [hasObjects, hasRefs] = await Promise.all([
    isDirectory(path.join(commonDir, 'objects'), throwOnError),
    isDirectory(path.join(commonDir, 'refs'), throwOnError),
  ]);
  return hasObjects && hasRefs;
}

interface GitMarker {
  root: string;
  markerPath: string;
  markerKind: 'directory' | 'file';
}

// Git discovers ancestors of the physical cwd, not of its symlink alias.
async function locateGitMarker(
  directory: string,
  signal: AbortSignal,
  throwOnError: boolean,
): Promise<GitMarker | null> {
  let currentDir = await canonicalizePath(path.resolve(directory), throwOnError);
  while (true) {
    signal.throwIfAborted();
    const markerPath = path.join(currentDir, '.git');
    const markerKind = await classifyGitMarker(markerPath, throwOnError);
    if (markerKind) return { root: currentDir, markerPath, markerKind };
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function settleProbeFailure(
  error: unknown,
  options: GitMetadataProbeOptions,
): null {
  if (options.signal?.aborted) throw options.signal.reason;
  if (options.throwOnError && !(isNodeError(error) && error.code === 'ENOENT')) {
    throw error;
  }
  if (options.throwOnTimeout && error instanceof GitMetadataProbeTimeoutError) {
    throw error;
  }
  return null;
}

/**
 * Locate the physical checkout by its .git marker, independently of whether
 * its HEAD, refs or linked-worktree metadata can currently be read.
 */
export async function findGitRootAsync(
  directory: string,
  options: GitMetadataProbeOptions = {},
): Promise<string | null> {
  try {
    return await withMetadataDeadline(async (signal) => {
      const marker = await locateGitMarker(
        directory,
        signal,
        options.throwOnError ?? false,
      );
      return marker?.root ?? null;
    }, options);
  } catch (error) {
    return settleProbeFailure(error, options);
  }
}

/**
 * Resolves repository layout without starting Git.
 *
 * Git's process startup may synchronously wait while applying a user-provided
 * cwd. Reading the documented .git pointer, commondir and HEAD files keeps
 * repository discovery outside that child-process failure mode. All filesystem
 * work is asynchronous so a slow mount does not freeze the JavaScript event
 * loop.
 */
export async function resolveGitRepositoryLayout(
  directory: string,
  options: GitMetadataProbeOptions = {},
): Promise<GitRepositoryLayout | null> {
  const throwOnError = options.throwOnError ?? false;
  try {
    return await withMetadataDeadline(async (signal) => {
      const marker = await locateGitMarker(directory, signal, throwOnError);
      if (!marker) return null;
      const { root: currentDir, markerPath, markerKind } = marker;
      let gitDir: string;
      if (markerKind === 'directory') {
        gitDir = await canonicalizePath(markerPath, throwOnError);
      } else {
        const markerContent = await readBoundedRegularFile(
          markerPath,
          MAX_GIT_CONTROL_FILE_BYTES,
          signal,
          throwOnError,
        );
        const pointer = markerContent
          ? parseGitDirectoryPointer(markerContent)
          : null;
        if (!pointer) return null;
        gitDir = await canonicalizePath(
          path.isAbsolute(pointer)
            ? pointer
            : path.resolve(currentDir, pointer),
          throwOnError,
        );
      }
      if (!(await isDirectory(gitDir, throwOnError))) return null;

      const commonDir = await resolveCommonGitDirectory(
        gitDir,
        signal,
        throwOnError,
      );
      if (!commonDir || !(await isDirectory(commonDir, throwOnError))) {
        return null;
      }
      const [worktreeRoot, canonicalGitDir, canonicalCommonDir] =
        await Promise.all([
          canonicalizePath(currentDir, throwOnError),
          canonicalizePath(gitDir, throwOnError),
          canonicalizePath(commonDir, throwOnError),
        ]);
      if (
        !(await validateGitDirectory(
          canonicalGitDir,
          canonicalCommonDir,
          signal,
          throwOnError,
        ))
      ) {
        return null;
      }
      if (markerKind === 'file' && canonicalGitDir !== canonicalCommonDir) {
        if (
          path.dirname(canonicalGitDir) !==
          path.join(canonicalCommonDir, 'worktrees')
        ) {
          return null;
        }
        const backlinkContent = await readBoundedRegularFile(
          path.join(canonicalGitDir, 'gitdir'),
          MAX_GIT_CONTROL_FILE_BYTES,
          signal,
          throwOnError,
        );
        const gitFileBacklink = backlinkContent?.trim();
        if (!gitFileBacklink) return null;
        const resolvedBacklink = await canonicalizePath(
          path.isAbsolute(gitFileBacklink)
            ? gitFileBacklink
            : path.resolve(canonicalGitDir, gitFileBacklink),
          throwOnError,
        );
        if (
          resolvedBacklink !== (await canonicalizePath(markerPath, throwOnError))
        ) {
          return null;
        }
      }
      return {
        worktreeRoot,
        gitDir: canonicalGitDir,
        commonDir: canonicalCommonDir,
        isWorktree: canonicalGitDir !== canonicalCommonDir,
      };
    }, options);
  } catch (error) {
    return settleProbeFailure(error, options);
  }
}

function isSafeGitRef(ref: string): boolean {
  const hasControlCharacter = [...ref].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
  const hasForbiddenCharacter = ['~', '^', ':', '?', '*', '[', ']'].some(
    (character) => ref.includes(character),
  );
  if (
    !ref.startsWith('refs/') ||
    ref.length > 1024 ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('\\') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    hasControlCharacter ||
    hasForbiddenCharacter
  ) {
    return false;
  }
  return ref.split('/').every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.startsWith('.') &&
      !segment.endsWith('.lock'),
  );
}

function containedGitPath(root: string, ref: string): string | null {
  const target = path.resolve(root, ...ref.split('/'));
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return target;
}

async function readObjectId(
  filePath: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const content = await readBoundedRegularFile(
      filePath,
      MAX_GIT_REF_FILE_BYTES,
      signal,
    );
    const value = content?.trim() ?? '';
    return VALID_OBJECT_ID.test(value) ? value : undefined;
  } catch {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}

function parsePackedRefLine(line: string, ref: string): string | undefined {
  if (!line || line.startsWith('#') || line.startsWith('^')) return undefined;
  const separator = line.indexOf(' ');
  if (separator <= 0 || line.slice(separator + 1).trim() !== ref) {
    return undefined;
  }
  const objectId = line.slice(0, separator).trim();
  return VALID_OBJECT_ID.test(objectId) ? objectId : undefined;
}

async function readPackedRef(
  packedRefsPath: string,
  ref: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const initialStat = await lstatOrNull(packedRefsPath);
  if (!initialStat?.isFile() || initialStat.isSymbolicLink()) {
    return undefined;
  }

  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let input: fs.ReadStream | undefined;
  try {
    handle = await open(packedRefsPath, fs.constants.O_RDONLY | noFollow);
    if (!(await handle.stat()).isFile()) return undefined;
    // Cancellation may occur during open/stat; check before creating a stream
    // that would be destroyed before iteration starts.
    signal.throwIfAborted();
    // Let FileHandle coordinate stream destruction and explicit closure to avoid
    // closing a descriptor twice after another thread has reused it.
    input = handle.createReadStream({
      autoClose: false,
      encoding: 'utf8',
      highWaterMark: 1024,
    });
    addAbortSignal(signal, input);

    let pending = '';
    let discardCurrentLine = false;
    for await (const chunk of input) {
      signal.throwIfAborted();
      const parts = String(chunk).split('\n');
      for (let index = 0; index < parts.length; index += 1) {
        const isCompleteLine = index < parts.length - 1;
        const part = parts[index];
        if (!discardCurrentLine) {
          pending += part;
          if (Buffer.byteLength(pending, 'utf8') > MAX_PACKED_REFS_LINE_BYTES) {
            pending = '';
            discardCurrentLine = true;
          }
        }
        if (!isCompleteLine) continue;

        if (!discardCurrentLine) {
          const objectId = parsePackedRefLine(pending.replace(/\r$/, ''), ref);
          if (objectId) return objectId;
        }
        pending = '';
        discardCurrentLine = false;
      }
    }
    return discardCurrentLine
      ? undefined
      : parsePackedRefLine(pending.replace(/\r$/, ''), ref);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (
      isNodeError(error) &&
      ['ENOENT', 'ELOOP', 'EINVAL'].includes(error.code ?? '')
    ) {
      return undefined;
    }
    return undefined;
  } finally {
    input?.destroy();
    await handle?.close();
  }
}

/** Reads HEAD, loose refs and packed-refs without starting Git. */
export async function readGitHead(
  layout: GitRepositoryLayout,
  options: GitMetadataProbeOptions = {},
): Promise<GitHeadState | null> {
  try {
    return await withMetadataDeadline(async (signal) => {
      const headContent = await readBoundedRegularFile(
        path.join(layout.gitDir, 'HEAD'),
        MAX_GIT_CONTROL_FILE_BYTES,
        signal,
      );
      const head = headContent ? parseGitHead(headContent) : null;
      if (!head) return null;
      if (head.commit) return head;
      const ref = head.ref;
      if (!ref) return head;

      const refRoots =
        layout.gitDir === layout.commonDir
          ? [layout.gitDir]
          : [layout.gitDir, layout.commonDir];
      let commit: string | undefined;
      for (const root of refRoots) {
        const refPath = containedGitPath(root, ref);
        if (!refPath) return null;
        commit = await readObjectId(refPath, signal);
        if (commit) break;
      }
      if (!commit) {
        for (const root of refRoots) {
          commit = await readPackedRef(
            path.join(root, 'packed-refs'),
            ref,
            signal,
          );
          if (commit) break;
        }
      }
      return { ...head, ...(commit ? { commit } : {}) };
    }, options);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof GitMetadataProbeTimeoutError) {
      if (options.throwOnTimeout) throw error;
      return null;
    }
    return null;
  }
}

/**
 * Checks if a directory is within a git repository
 * @param directory The directory to check
 * @returns true if the directory is in a git repository, false otherwise
 */
export function isGitRepository(directory: string): boolean {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      // Check if .git exists (either as directory or file for worktrees)
      if (fs.existsSync(gitDir)) {
        return true;
      }

      const parentDir = path.dirname(currentDir);

      // If we've reached the root directory, stop searching
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return false;
  } catch {
    // If any filesystem error occurs, assume not a git repo
    return false;
  }
}

/**
 * Finds the root directory of a git repository
 * @param directory Starting directory to search from
 * @returns The git repository root path, or null if not in a git repository
 */
export function findGitRoot(directory: string): string | null {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      if (fs.existsSync(gitDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return null;
  } catch {
    return null;
  }
}

/** Detects a linked worktree while preserving the published synchronous API. */
export function isGitWorktree(directory: string): boolean {
  try {
    const output = execFileSync(
      'git',
      [
        ...internalGitArgs(),
        '-C',
        directory,
        'rev-parse',
        '--git-dir',
        '--git-common-dir',
      ],
      {
        env: createGitCommandEnv(),
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .toString()
      .trim()
      .split('\n');
    if (output.length < 2) return false;
    const [gitDir, commonDir] = output;
    return (
      path.resolve(directory, gitDir) !== path.resolve(directory, commonDir)
    );
  } catch {
    return false;
  }
}

/** Async worktree detection for startup-sensitive internal callers. */
export async function isGitWorktreeAsync(
  directory: string,
  options: GitMetadataProbeOptions = {},
): Promise<boolean> {
  return (
    (await resolveGitRepositoryLayout(directory, options))?.isWorktree ?? false
  );
}
