/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, Response } from 'express';
import type { ServeErrorKind } from '@qwen-code/acp-bridge/status';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
  getProjectAutoMemoryRoots,
  getUserAutoMemoryRoot,
  runWithMemoryProjectScope,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { sanitizeIndexField } from '@qwen-code/qwen-code-core/memory/indexer.js';
import { resolveTrustedMemoryRoot } from '@qwen-code/qwen-code-core/memory/trusted-memory-filesystem.js';
import { detectBOM } from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { parse as parseYaml } from '@qwen-code/qwen-code-core/utils/yaml-parser.js';
import {
  isUnverifiableIdentityError,
  openNoFollow,
} from '@qwen-code/qwen-code-core/noFollowOpen';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { FsError } from './fs/errors.js';
import { resolveWithinWorkspace } from './fs/paths.js';
import {
  resolveTrustedRuntime,
  sendGenerationClosedError,
} from './workspace-route-runtime.js';
import { runWithWorkspaceRuntimeStorage } from './workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
  WorkspaceRuntimeEnvMetadata,
} from './workspace-registry.js';

/**
 * Issue #4175 PR 16.5 (web-shell gap #13396): managed auto-memory browse
 * routes.
 *
 * `GET /workspace/auto-memory` lists the daemon's managed auto-memory
 * entries — the markdown files under the bound workspace's project root
 * (`~/.qwen/projects/<hash>/memory/`) and the user-level root
 * (`~/.qwen/memories/`) — with frontmatter-derived title/description plus
 * on-disk size and mtime. Read-only; returns `initialized: false` and an
 * empty `entries` list when neither root exists (mirroring PR 16's idle
 * status for explicit memory files).
 *
 * `GET /workspace/auto-memory/file?path=…` reads one entry's text. The
 * path is validated against the managed roots — not the sandboxed
 * workspace file API — because the roots sit OUTSIDE the bound workspace,
 * where `GET /file` refuses. Resolution is symlink-canonicalized via
 * `resolveWithinWorkspace` against the admitted roots, capped at 1 MB,
 * and lossy (BOM / non-UTF-8 / torn) reads are flagged instead of served,
 * matching the explicit memory route's read contract.
 *
 * The project scope walks core's trusted project root SET
 * (`getProjectAutoMemoryRoots`): the configured root plus, for a trusted
 * workspace, the repo-local `.qwen/memory` — the same universe recall
 * and forget scan, with the same first-root-wins precedence for a
 * relative path present in several roots and the same exclusion of the
 * `MEMORY.md` index. A PROJECT root is admitted only through core's
 * whole-chain check (`resolveTrustedMemoryRoot`): a symlinked root or a
 * symlinked ancestor inside its trusted anchor (a repo-tracked
 * `.qwen -> /outside`) is refused, since it would relocate the read
 * boundary to its target; only the user root may itself be a symlink
 * (dotfiles layout).
 *
 * The roots are resolved on BOTH memory axes of the serving workspace
 * runtime, matching what that runtime's sessions write: the Storage
 * base dir (`runWithWorkspaceRuntimeStorage`, the runtime's pinned
 * session output dir) and the memory PROJECT scope
 * (`runWithMemoryProjectScope`, read from the runtime's effective env the
 * way memory import does). Without a runtime (unit tests) the daemon's
 * ambient scope applies. `GET /workspaces/:workspace/auto-memory[/file]`
 * serves the same payloads for any registered workspace.
 *
 * Both routes are filesystem-only — neither spawns the ACP child.
 */

export type ServeAutoMemoryScope = 'project' | 'user';

export interface ServeAutoMemoryFile {
  kind: 'auto_memory_file';
  scope: ServeAutoMemoryScope;
  /** Absolute on-disk path of the entry. */
  path: string;
  /** Frontmatter `name`/`title`; falls back to the file name. */
  title: string;
  description?: string;
  type?: string;
  category?: string;
  bytes: number;
  /** Last modification time, ISO-8601. */
  modifiedAt: string;
}

/**
 * Every `errorKind` the listing can put in its `errors` cells. Each is a
 * member of the closed serve taxonomy (`SERVE_ERROR_KINDS`, enforced by
 * the `satisfies` below) and of the SDK's `DAEMON_ERROR_KINDS` (pinned by
 * test).
 */
export const AUTO_MEMORY_ERROR_KINDS = [
  'readdir_failed',
  'stat_failed',
  'symlinked_root',
] as const satisfies readonly ServeErrorKind[];

export type ServeAutoMemoryErrorKind = (typeof AUTO_MEMORY_ERROR_KINDS)[number];

export interface ServeAutoMemoryStatus {
  v: 1;
  workspaceCwd: string;
  /** True when at least one managed root exists on disk. */
  initialized: boolean;
  userDir: string;
  /** True when the user root exists on disk. */
  userDirExists: boolean;
  /** The configured project root (may not exist yet). */
  projectDir: string;
  /**
   * The project roots that exist and were walked, in precedence order —
   * the configured root and, for a trusted workspace, the repo-local
   * `.qwen/memory`. Refused (symlinked) and absent roots are not listed.
   */
  projectDirs: string[];
  entries: ServeAutoMemoryFile[];
  totalBytes: number;
  fileCount: number;
  errors?: Array<{
    kind: 'auto_memory_file';
    status: 'error';
    error: string;
    hint?: string;
    errorKind?: ServeAutoMemoryErrorKind;
  }>;
}

export interface ServeAutoMemoryFileContent {
  scope: ServeAutoMemoryScope;
  path: string;
  bytes: number;
  modifiedAt?: string;
  /**
   * Absent for non-UTF-8/BOM'd files and for reads that raced a write —
   * the same "lossy reads are never served" contract as the explicit
   * memory route's `?content=true`.
   */
  content?: string;
  truncated?: boolean;
  /**
   * Set exactly when `content` is absent: `torn` — the file changed
   * while it was read (transient, retry the read); `undecodable` — BOM'd
   * or non-UTF-8 bytes (permanent until the file itself changes).
   */
  contentUnavailable?: 'torn' | 'undecodable';
}

/** Refusals for `readWorkspaceAutoMemoryFile`, mapped to HTTP status. */
export class AutoMemoryPathError extends Error {
  constructor(
    readonly code: 'outside' | 'not_found' | 'not_a_file' | 'read_failed',
    message: string,
  ) {
    super(message);
    this.name = 'AutoMemoryPathError';
  }
}

const AUTO_MEMORY_STATUS_SCHEMA_VERSION = 1 as const;
const MAX_AUTO_MEMORY_CONTENT_BYTES = 1024 * 1024;
const FRONTMATTER_PROBE_BYTES = 4096;

function errnoCode(err: unknown): string | undefined {
  const code =
    typeof err === 'object' && err !== null
      ? (err as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' ? code : undefined;
}

function isEnoent(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}

/**
 * Errnos a resolver raises for a path that cannot name an existing entry
 * (a regular-file ancestor, an over-long component, a malformed path) —
 * faults of the request, answered like a missing file instead of
 * falling through to the daemon-fault bucket.
 */
const NOT_FOUND_ERRNOS = new Set([
  'ENOENT',
  'ENOTDIR',
  'ENAMETOOLONG',
  'EINVAL',
]);

function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

type FrontmatterFields = Partial<
  Record<'name' | 'title' | 'description' | 'type' | 'category', string>
>;

/**
 * Lenient read of the scalar fields the panel renders. Managed entries
 * carry a `---` YAML frontmatter block; anything malformed (or a file
 * without one) simply falls back to filename-derived metadata — a parse
 * hiccup never drops an entry from the listing.
 *
 * The fenced block is parsed with core's YAML parser (the same one the
 * recall/forget scans use), so block scalars, quoted values and plain
 * scalars behave the way core recalls them — not a hand-rolled line
 * regex that garbles `description: |` into a literal pipe.
 */
function parseAutoMemoryFrontmatter(head: string): FrontmatterFields {
  const normalized = head.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!match) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: FrontmatterFields = {};
  for (const key of FRONTMATTER_KEYS) {
    const value = frontmatterScalarString(parsed[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const FRONTMATTER_KEYS = [
  'name',
  'title',
  'description',
  'type',
  'category',
] as const;

/**
 * Coerce a parsed YAML scalar to the string the panel renders. Core's
 * parser yields numbers/booleans for bare scalars (`name: 10183`); keep
 * their text instead of dropping the field (core's `stringValue`
 * behaviour in the memory scans).
 */
function frontmatterScalarString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

async function probeFrontmatter(filePath: string): Promise<FrontmatterFields> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return parseAutoMemoryFrontmatter(
        buffer.subarray(0, bytesRead).toString('utf8'),
      );
    } finally {
      await handle.close();
    }
  } catch {
    // A probe failure never drops the entry: metadata is optional.
    return {};
  }
}

interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

type AutoMemoryError = NonNullable<ServeAutoMemoryStatus['errors']>[number];

async function collectFilesIn(
  dir: string,
  root: string,
  files: ScannedFile[],
  errors: AutoMemoryError[],
): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (!isEnoent(err)) {
      errors.push({
        kind: 'auto_memory_file',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        hint: dir,
        errorKind: 'readdir_failed',
      });
    }
    return;
  }
  for (const entry of dirents) {
    if (entry.name.startsWith('.')) continue;
    // Symlinked entries are not managed memories; reading them is refused
    // by the canonicalized root check, so they are not listed either.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Core's recall/forget scans recurse without a depth cap; the
      // listing follows suit so deeper user organization is not hidden.
      await collectFilesIn(path.join(dir, entry.name), root, files, errors);
      continue;
    }
    if (!isMarkdownName(entry.name)) continue;
    // The index is a link catalog, not a memory: core's scanners skip it
    // at every depth, so recall/forget never see it either.
    if (entry.name === AUTO_MEMORY_INDEX_FILENAME) continue;
    const absolutePath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) continue;
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (err) {
      if (!isEnoent(err)) {
        errors.push({
          kind: 'auto_memory_file',
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          hint: absolutePath,
          errorKind: 'stat_failed',
        });
      }
    }
  }
}

type ProjectRootAdmission =
  | { state: 'admitted' }
  | { state: 'absent' }
  | { state: 'refused' }
  | { state: 'stat_failed'; detail: string };

/**
 * Admission check for one PROJECT root, shared by the listing, the read
 * route and the folder-open target so all three agree on the boundary.
 * A root is admitted only when it is a real directory whose whole chain
 * inside its trusted anchor stays inside that anchor — core's
 * `resolveTrustedMemoryRoot`, the check recall/forget apply — so neither
 * a symlinked root nor a symlinked ancestor (a repo-tracked
 * `.qwen -> /outside`) can relocate the boundary to its target.
 */
export async function admitAutoMemoryProjectRoot(
  root: string,
): Promise<ProjectRootAdmission> {
  const describe = (err: unknown) =>
    err instanceof Error ? err.message : String(err);
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    return isEnoent(err)
      ? { state: 'absent' }
      : { state: 'stat_failed', detail: describe(err) };
  }
  if (rootStat.isSymbolicLink()) return { state: 'refused' };
  if (!rootStat.isDirectory()) return { state: 'absent' };
  try {
    await resolveTrustedMemoryRoot(root, getMemoryRootTrustedAnchor(root));
  } catch (err) {
    // An errno is a fault of the lstat/realpath itself; core's refusals
    // are plain errors.
    if (errnoCode(err) === undefined) return { state: 'refused' };
    return isEnoent(err)
      ? { state: 'absent' }
      : { state: 'stat_failed', detail: describe(err) };
  }
  return { state: 'admitted' };
}

/**
 * Filesystem-only discovery of managed auto-memory entries under the
 * bound workspace's project root set and the user-level root. Per-file
 * failures are surfaced in-band via `errors[]`; an absent root is not an
 * error (a fresh host has neither).
 *
 * `opts.trusted` gates the repo-local project root the same way core's
 * recall/forget scans do (`getProjectAutoMemoryRoots`): untrusted, only
 * the configured root is walked, and in local-memory mode no project
 * root at all. Both transports refuse an untrusted workspace (403) before
 * calling this, so production callers always pass `trusted: true`; the
 * narrowing is the fail-safe for a caller that omits it.
 */
export async function collectWorkspaceAutoMemoryStatus(
  boundWorkspace: string,
  opts: { trusted?: boolean } = {},
): Promise<ServeAutoMemoryStatus> {
  const projectDir = getAutoMemoryRoot(boundWorkspace);
  const userDir = getUserAutoMemoryRoot();
  const projectRoots = getProjectAutoMemoryRoots(
    boundWorkspace,
    opts.trusted === true,
  );
  const entries: ServeAutoMemoryFile[] = [];
  const errors: AutoMemoryError[] = [];
  const pushError = (
    error: string,
    hint: string,
    errorKind: ServeAutoMemoryErrorKind,
  ) =>
    errors.push({
      kind: 'auto_memory_file',
      status: 'error',
      error,
      hint,
      errorKind,
    });
  const reportStatFailed = (detail: string, root: string) => {
    // A root that exists but cannot be stat'ed must not read as "never
    // created": record it and keep the scope initialized, so the panel
    // does not assert a creation state we could not observe.
    pushError(detail, root, 'stat_failed');
    writeStderrLine(
      `qwen serve: auto-memory root stat failed: ${detail} (${root})`,
    );
  };

  const listRoot = async (
    scope: ServeAutoMemoryScope,
    root: string,
    seen?: Set<string>,
  ): Promise<void> => {
    const files: ScannedFile[] = [];
    await collectFilesIn(root, root, files, errors);
    files.sort((a, b) =>
      a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : 0,
    );
    for (const file of files) {
      // Core's cross-root precedence: the first root holding a relative
      // path wins, so a copy in a later root is not a second memory.
      if (seen) {
        if (seen.has(file.relativePath)) continue;
        seen.add(file.relativePath);
      }
      const meta = await probeFrontmatter(file.absolutePath);
      // Collaborator-authored frontmatter is hostile input: core's index
      // sanitizer strips control/zero-width/bidi chars, collapses
      // whitespace and caps the length, so a repo-tracked file cannot
      // reorder rendered text or overflow the row (same contract core
      // applies before embedding the fields in the committed index).
      const title =
        meta['name'] ?? meta['title'] ?? titleFromFilename(file.absolutePath);
      const entry: ServeAutoMemoryFile = {
        kind: 'auto_memory_file',
        scope,
        path: file.absolutePath,
        title: sanitizeIndexField(title),
        bytes: file.bytes,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
      };
      if (meta['description']) {
        entry.description = sanitizeIndexField(meta['description']);
      }
      if (meta['type']) entry.type = meta['type'];
      if (meta['category']) entry.category = meta['category'];
      entries.push(entry);
    }
  };

  let projectExists = false;
  const projectDirs: string[] = [];
  const seenProjectPaths = new Set<string>();
  for (const root of projectRoots) {
    const admission = await admitAutoMemoryProjectRoot(root);
    if (admission.state === 'absent') continue;
    projectExists = true;
    if (admission.state === 'stat_failed') {
      reportStatFailed(admission.detail, root);
      continue;
    }
    if (admission.state === 'refused') {
      pushError(
        'refusing symlinked project memory root',
        root,
        'symlinked_root',
      );
      continue;
    }
    projectDirs.push(root);
    await listRoot('project', root, seenProjectPaths);
  }

  // The user root is deliberately symlink-tolerant (dotfiles layout).
  let userExists = false;
  let userDirExists = false;
  try {
    const userStat = await fs.stat(userDir);
    if (userStat.isDirectory()) {
      userExists = true;
      userDirExists = true;
      await listRoot('user', userDir);
    }
  } catch (err) {
    if (!isEnoent(err)) {
      userExists = true;
      reportStatFailed(
        err instanceof Error ? err.message : String(err),
        userDir,
      );
    }
  }

  const result: ServeAutoMemoryStatus = {
    v: AUTO_MEMORY_STATUS_SCHEMA_VERSION,
    workspaceCwd: boundWorkspace,
    initialized: projectExists || userExists,
    userDir,
    userDirExists,
    projectDir,
    projectDirs,
    entries,
    totalBytes: entries.reduce((acc, entry) => acc + entry.bytes, 0),
    fileCount: entries.length,
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/**
 * Read one managed auto-memory entry. The requested path must resolve —
 * after symlink canonicalization — into one of the admitted managed
 * roots (the trusted project root set or the user root); anything else
 * is refused with `AutoMemoryPathError('outside')`.
 *
 * `opts.trusted` gates the repo-local project root exactly as in
 * `collectWorkspaceAutoMemoryStatus`.
 */
export async function readWorkspaceAutoMemoryFile(
  boundWorkspace: string,
  filePath: string,
  opts: { trusted?: boolean } = {},
): Promise<ServeAutoMemoryFileContent> {
  const userDir = getUserAutoMemoryRoot();

  // Admit only the project roots the listing walks: a symlinked root or
  // ancestor would relocate the containment boundary to its target, so
  // it is refused instead of canonicalized. Absent, unstat'able and
  // refused roots admit nothing.
  const projectRoots: string[] = [];
  for (const root of getProjectAutoMemoryRoots(
    boundWorkspace,
    opts.trusted === true,
  )) {
    if ((await admitAutoMemoryProjectRoot(root)).state === 'admitted') {
      projectRoots.push(root);
    }
  }

  const inRoot = (p: string, root: string): boolean => {
    const rel = path.relative(path.normalize(root), path.normalize(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const inProject = projectRoots.some((root) => inRoot(filePath, root));
  const inUser = inRoot(filePath, userDir);
  if (!inProject && !inUser) {
    throw new AutoMemoryPathError(
      'outside',
      `path is outside the auto-memory roots: ${filePath}`,
    );
  }
  const scope: ServeAutoMemoryScope = inProject ? 'project' : 'user';

  // Canonicalize the roots at request time so the value the shared
  // canonicalization cache keys on is already canonical: a root created
  // after an earlier request re-resolves instead of staying pinned to a
  // stale literal. CANONICAL_BOUND_CACHE itself is untouched — only the
  // string this route passes as the key changes.
  const canonicalRoot = async (root: string): Promise<string> => {
    try {
      return await fs.realpath(root);
    } catch (err) {
      return isEnoent(err) ? path.resolve(root) : root;
    }
  };
  const roots = await Promise.all(
    [...projectRoots, userDir].map(canonicalRoot),
  );

  let resolved: string;
  try {
    resolved = await resolveWithinWorkspace(filePath, roots, 'read');
  } catch (err) {
    if (err instanceof FsError) {
      // The literal path was already admitted by the root pre-check above:
      // a symlink escape is still 'outside', a file that vanished
      // mid-flight is 'not_found', and everything else (a root directory
      // that became non-searchable, an unparseable pattern) is a read
      // fault of the daemon, not a fault of the request.
      const kind =
        err.kind === 'path_not_found'
          ? 'not_found'
          : err.kind === 'symlink_escape' ||
              err.kind === 'path_outside_workspace'
            ? 'outside'
            : 'read_failed';
      throw new AutoMemoryPathError(kind, err.message);
    }
    // The resolver rethrows raw errnos it does not map for 'read'
    // intent (a regular-file ancestor, an over-long name): the path
    // cannot name an existing entry, which is a fault of the request.
    if (NOT_FOUND_ERRNOS.has(errnoCode(err) ?? '')) {
      throw new AutoMemoryPathError(
        'not_found',
        `no such auto-memory file: ${filePath}`,
      );
    }
    throw err;
  }

  let before;
  try {
    before = await fs.lstat(resolved);
  } catch (err) {
    if (NOT_FOUND_ERRNOS.has(errnoCode(err) ?? '')) {
      throw new AutoMemoryPathError(
        'not_found',
        `no such auto-memory file: ${filePath}`,
      );
    }
    throw err;
  }
  if (!before.isFile()) {
    throw new AutoMemoryPathError(
      'not_a_file',
      `path is not a regular file: ${filePath}`,
    );
  }

  let handle;
  try {
    handle = await openNoFollow(resolved);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new AutoMemoryPathError(
        'outside',
        `path resolves to a symlink outside the auto-memory roots: ${filePath}`,
      );
    }
    // The path was admitted and lstat'ed above, so these are faults of the
    // read itself, not of the request: a rotated-away file is a 404, an
    // unreadable one a read fault (the route classifies both).
    if (code === 'ENOENT') {
      throw new AutoMemoryPathError(
        'not_found',
        `no such auto-memory file: ${filePath}`,
      );
    }
    // Core's deliberate fail-closed refusal on volumes that cannot prove
    // file identity (inode 0) is a read fault, not an unexpected crash.
    if (
      code === 'EACCES' ||
      code === 'EPERM' ||
      isUnverifiableIdentityError(err)
    ) {
      throw new AutoMemoryPathError(
        'read_failed',
        `auto-memory file cannot be opened: ${filePath}`,
      );
    }
    throw err;
  }
  try {
    const opened = await handle.stat();
    const tornPre =
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size;
    const buffer = Buffer.alloc(
      Math.min(opened.size, MAX_AUTO_MEMORY_CONTENT_BYTES + 1),
    );
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    const torn =
      tornPre ||
      bytesRead !== buffer.length ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs;
    const truncated = opened.size > MAX_AUTO_MEMORY_CONTENT_BYTES;
    const decoded = torn
      ? {}
      : decodeAutoMemoryContent(
          buffer.subarray(0, MAX_AUTO_MEMORY_CONTENT_BYTES),
          truncated,
        );
    return {
      scope,
      path: filePath,
      bytes: opened.size,
      modifiedAt: new Date(opened.mtimeMs).toISOString(),
      ...(decoded.truncated ? { truncated: true } : {}),
      ...(decoded.content !== undefined
        ? { content: decoded.content }
        : { contentUnavailable: torn ? 'torn' : 'undecodable' }),
    };
  } finally {
    await handle.close();
  }
}

/**
 * BOM / UTF-8 validation shared with the explicit memory route's read
 * contract: bytes that cannot round-trip losslessly are never served as
 * text.
 */
function decodeAutoMemoryContent(
  slice: Buffer,
  truncated: boolean,
): { content?: string; truncated?: boolean } {
  if (detectBOM(slice)) return { truncated };
  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(slice, {
        stream: truncated,
      }),
      truncated,
    };
  } catch {
    return { truncated };
  }
}

const MEMORY_PROJECT_SCOPE_ENV = 'QWEN_CODE_MEMORY_PROJECT_SCOPE';

/**
 * Memory-path overrides core reads from the daemon PROCESS env only
 * (`getMemoryBaseDir`, `getAutoMemoryRoot`): they cannot be applied per
 * runtime, so a runtime whose sessions run with a different value is
 * refused rather than served the daemon's layout.
 */
const PROCESS_GLOBAL_MEMORY_ENV = [
  'QWEN_CODE_MEMORY_BASE_DIR',
  'QWEN_CODE_MEMORY_LOCAL',
] as const;

/** The parts of a workspace runtime the managed roots resolve under. */
export type AutoMemoryRuntime = Pick<
  WorkspaceRuntime,
  'sessionRuntimeBaseDir'
> & {
  readonly env?: Pick<WorkspaceRuntimeEnvMetadata, 'mode' | 'effectiveEnv'>;
};

/** A runtime pins a process-global memory override the daemon cannot apply. */
export class AutoMemoryEnvOverrideError extends Error {
  readonly code = 'auto_memory_env_override_unsupported';
  constructor(readonly key: string) {
    super(
      `Auto-memory browse does not support a workspace-specific ${key} override.`,
    );
    this.name = 'AutoMemoryEnvOverrideError';
  }
}

function normalizedMemoryEnv(
  key: (typeof PROCESS_GLOBAL_MEMORY_ENV)[number],
  value: string | undefined,
): string {
  return key === 'QWEN_CODE_MEMORY_LOCAL'
    ? String(value === '1')
    : (value ?? '');
}

/**
 * Run `fn` with core's memory paths resolving on BOTH axes of `runtime`,
 * the way its sessions resolve them: the Storage base dir (the runtime's
 * pinned session output dir) and the memory PROJECT scope, read from the
 * runtime's effective env exactly as memory import does (process env
 * only for a parent-process runtime without a snapshot). The scope is
 * resolved inside the wrapper, per call — core's root memo keys on it.
 * Without a runtime the daemon's ambient scope applies (unit tests).
 */
export function runWithAutoMemoryRuntime<T>(
  runtime: AutoMemoryRuntime | undefined,
  fn: () => T,
): T {
  if (!runtime) return fn();
  const env = runtime.env;
  if (!env) return runWithWorkspaceRuntimeStorage(runtime, fn);
  if (env.effectiveEnv !== undefined) {
    for (const key of PROCESS_GLOBAL_MEMORY_ENV) {
      if (
        normalizedMemoryEnv(key, env.effectiveEnv[key]) !==
        normalizedMemoryEnv(key, process.env[key])
      ) {
        throw new AutoMemoryEnvOverrideError(key);
      }
    }
  }
  const configured =
    env.effectiveEnv !== undefined
      ? env.effectiveEnv[MEMORY_PROJECT_SCOPE_ENV]
      : env.mode === 'parent-process'
        ? process.env[MEMORY_PROJECT_SCOPE_ENV]
        : undefined;
  const scope =
    configured?.trim().toLowerCase() === 'workspace' ? 'workspace' : 'git-root';
  return runWithWorkspaceRuntimeStorage(runtime, () =>
    runWithMemoryProjectScope(scope, fn),
  );
}

export interface WorkspaceAutoMemoryRouteDeps {
  boundWorkspace: string;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
  /**
   * Workspace runtime whose memory axes (session storage base dir +
   * memory project scope) the managed roots resolve under. Omitted —
   * e.g. by unit tests — the daemon's ambient scope applies.
   */
  runtime?: AutoMemoryRuntime;
}

/** Everything one request needs, for either mount. */
interface AutoMemoryRequestContext {
  workspaceCwd: string;
  runtime?: AutoMemoryRuntime;
  assertGenerationOpen: () => void;
}

function requireTrustedWorkspace(
  deps: WorkspaceAutoMemoryRouteDeps,
  res: Response,
): boolean {
  if (deps.isWorkspaceTrusted?.() === true) return true;
  res.status(403).json({
    error: 'Workspace is not trusted.',
    code: 'untrusted_workspace',
  });
  return false;
}

function captureOpenGeneration(
  capture: (() => (() => void) | undefined) | undefined,
  res: Response,
): (() => void) | null {
  const assertGenerationOpen = capture?.() ?? (() => {});
  try {
    assertGenerationOpen();
    return assertGenerationOpen;
  } catch (error) {
    sendGenerationClosedError(res, error);
    return null;
  }
}

function sendEnvOverrideError(res: Response, err: unknown): boolean {
  if (!(err instanceof AutoMemoryEnvOverrideError)) return false;
  res.status(409).json({ error: err.message, code: err.code, key: err.key });
  return true;
}

// Both mounts serve a workspace only after the trust gate (403), so the
// collector/reader always run trusted here.
async function handleListing(
  label: string,
  ctx: AutoMemoryRequestContext,
  res: Response,
): Promise<void> {
  try {
    const status = await runWithAutoMemoryRuntime(ctx.runtime, () =>
      collectWorkspaceAutoMemoryStatus(ctx.workspaceCwd, { trusted: true }),
    );
    ctx.assertGenerationOpen();
    res.status(200).json(status);
  } catch (err) {
    if (sendGenerationClosedError(res, err)) return;
    if (sendEnvOverrideError(res, err)) return;
    writeStderrLine(
      `qwen serve: GET ${label} failed: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Failed to discover auto-memory',
      code: 'auto_memory_discovery_failed',
    });
  }
}

async function handleFileRead(
  label: string,
  ctx: AutoMemoryRequestContext,
  req: Request,
  res: Response,
): Promise<void> {
  const filePath = req.query['path'];
  if (typeof filePath !== 'string' || filePath.length === 0) {
    res.status(400).json({
      error: '`path` query parameter is required',
      code: 'missing_path',
    });
    return;
  }
  try {
    const result = await runWithAutoMemoryRuntime(ctx.runtime, () =>
      readWorkspaceAutoMemoryFile(ctx.workspaceCwd, filePath, {
        trusted: true,
      }),
    );
    ctx.assertGenerationOpen();
    res.status(200).json(result);
  } catch (err) {
    if (sendGenerationClosedError(res, err)) return;
    if (sendEnvOverrideError(res, err)) return;
    if (err instanceof AutoMemoryPathError) {
      res.status(autoMemoryPathErrorStatus(err)).json({
        error: err.message,
        code: err.code,
        path: filePath,
      });
      return;
    }
    writeStderrLine(
      `qwen serve: GET ${label} failed: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Failed to read auto-memory file',
      code: 'auto_memory_read_failed',
    });
  }
}

/**
 * HTTP status of a read refusal, shared by REST and ACP. `read_failed`
 * means the admitted path could not be resolved or opened by the daemon
 * (a locked root directory, an unreadable file) — a server fault,
 * deliberately not the 400 bucket.
 */
export function autoMemoryPathErrorStatus(err: AutoMemoryPathError): number {
  return err.code === 'not_found'
    ? 404
    : err.code === 'read_failed'
      ? 500
      : 400;
}

/**
 * Mount the two legacy auto-memory browse routes for the daemon's primary
 * workspace.
 */
export function mountWorkspaceAutoMemoryRoutes(
  app: Application,
  deps: WorkspaceAutoMemoryRouteDeps,
): void {
  const context = (
    assertGenerationOpen: () => void,
  ): AutoMemoryRequestContext => ({
    workspaceCwd: deps.boundWorkspace,
    ...(deps.runtime ? { runtime: deps.runtime } : {}),
    assertGenerationOpen,
  });

  app.get('/workspace/auto-memory', async (_req: Request, res: Response) => {
    const assertGenerationOpen = captureOpenGeneration(
      deps.captureGenerationAssertion,
      res,
    );
    if (!assertGenerationOpen) return;
    if (!requireTrustedWorkspace(deps, res)) return;
    await handleListing(
      '/workspace/auto-memory',
      context(assertGenerationOpen),
      res,
    );
  });

  app.get(
    '/workspace/auto-memory/file',
    async (req: Request, res: Response) => {
      const assertGenerationOpen = captureOpenGeneration(
        deps.captureGenerationAssertion,
        res,
      );
      if (!assertGenerationOpen) return;
      if (!requireTrustedWorkspace(deps, res)) return;
      await handleFileRead(
        '/workspace/auto-memory/file',
        context(assertGenerationOpen),
        req,
        res,
      );
    },
  );
}

/**
 * Mount the workspace-qualified twins, `GET /workspaces/:workspace/
 * auto-memory[/file]`: the runtime is resolved per request from the
 * registry (never falling back to the primary), trust-gated, and its
 * cwd and memory axes drive the same listing/read.
 */
export function mountWorkspaceQualifiedAutoMemoryRoutes(
  app: Application,
  deps: { workspaceRegistry: WorkspaceRegistry },
): void {
  const resolve = (
    req: Request,
    res: Response,
  ): AutoMemoryRequestContext | null => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return null;
    const guard = runtime.generationGuard;
    const assertGenerationOpen = captureOpenGeneration(
      () => (guard ? () => guard.assertOpen() : undefined),
      res,
    );
    if (!assertGenerationOpen) return null;
    return {
      workspaceCwd: runtime.workspaceCwd,
      runtime,
      assertGenerationOpen,
    };
  };

  app.get(
    '/workspaces/:workspace/auto-memory',
    async (req: Request, res: Response) => {
      const ctx = resolve(req, res);
      if (!ctx) return;
      await handleListing('/workspaces/:workspace/auto-memory', ctx, res);
    },
  );

  app.get(
    '/workspaces/:workspace/auto-memory/file',
    async (req: Request, res: Response) => {
      const ctx = resolve(req, res);
      if (!ctx) return;
      await handleFileRead(
        '/workspaces/:workspace/auto-memory/file',
        ctx,
        req,
        res,
      );
    },
  );
}
