/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, Response } from 'express';
import {
  getAutoMemoryRoot,
  getProjectAutoMemoryRoots,
  getUserAutoMemoryRoot,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { detectBOM } from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { openNoFollow } from '@qwen-code/qwen-code-core/noFollowOpen';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { FsError } from './fs/errors.js';
import { resolveWithinWorkspace } from './fs/paths.js';
import { sendGenerationClosedError } from './workspace-route-runtime.js';
import { runWithWorkspaceRuntimeStorage } from './workspace-runtime-storage.js';
import type { WorkspaceRuntime } from './workspace-registry.js';

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
 * and forget scan. A symlinked PROJECT root is refused (a committed
 * symlink would relocate the read boundary to its target); only the
 * user root may itself be a symlink (dotfiles layout).
 *
 * Mounted with a workspace `runtime`, both routes resolve the roots
 * under that runtime's session storage scope
 * (`runWithWorkspaceRuntimeStorage`) instead of the daemon's ambient
 * Storage scope; without one the ambient scope applies (unit tests).
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

export interface ServeAutoMemoryStatus {
  v: 1;
  workspaceCwd: string;
  /** True when at least one managed root exists on disk. */
  initialized: boolean;
  userDir: string;
  projectDir: string;
  entries: ServeAutoMemoryFile[];
  totalBytes: number;
  fileCount: number;
  errors?: Array<{
    kind: 'auto_memory_file';
    status: 'error';
    error: string;
    hint?: string;
    errorKind?: string;
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

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

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
 */
function parseAutoMemoryFrontmatter(head: string): FrontmatterFields {
  const normalized = head.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!match) return {};
  const out: FrontmatterFields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(name|title|description|type|category):\s*(.+)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    // Multi-line and structured values are not rendered.
    if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('>')) {
      continue;
    }
    const value = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value && out[kv[1] as keyof FrontmatterFields] === undefined) {
      out[kv[1] as keyof FrontmatterFields] = value;
    }
  }
  return out;
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

/**
 * Filesystem-only discovery of managed auto-memory entries under the
 * bound workspace's project root set and the user-level root. Per-file
 * failures are surfaced in-band via `errors[]`; an absent root is not an
 * error (a fresh host has neither).
 *
 * `opts.trusted` gates the repo-local project root the same way core's
 * recall/forget scans do (`getProjectAutoMemoryRoots`): an untrusted
 * workspace exposes only the configured root, and in local-memory mode
 * no project root at all.
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

  const scanRoot = async (
    scope: ServeAutoMemoryScope,
    root: string,
    refuseRootSymlink: boolean,
  ): Promise<boolean> => {
    let rootStat;
    try {
      rootStat = refuseRootSymlink ? await fs.lstat(root) : await fs.stat(root);
    } catch (err) {
      if (isEnoent(err)) return false;
      // A root that exists but cannot be stat'ed must not read as
      // "never created": record it and keep the scope initialized, so
      // the panel does not assert a creation state we could not observe.
      const detail = err instanceof Error ? err.message : String(err);
      errors.push({
        kind: 'auto_memory_file',
        status: 'error',
        error: detail,
        hint: root,
        errorKind: 'stat_failed',
      });
      writeStderrLine(
        `qwen serve: auto-memory root stat failed: ${detail} (${root})`,
      );
      return true;
    }
    if (refuseRootSymlink && rootStat.isSymbolicLink()) {
      // A symlinked project root would relocate the read boundary to its
      // target; core refuses the same shape for its memory roots.
      errors.push({
        kind: 'auto_memory_file',
        status: 'error',
        error: 'refusing symlinked project memory root',
        hint: root,
        errorKind: 'symlinked_root',
      });
      return true;
    }
    if (!rootStat.isDirectory()) return false;
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
      const meta = await probeFrontmatter(file.absolutePath);
      const entry: ServeAutoMemoryFile = {
        kind: 'auto_memory_file',
        scope,
        path: file.absolutePath,
        title:
          meta['name'] ?? meta['title'] ?? titleFromFilename(file.absolutePath),
        bytes: file.bytes,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
      };
      if (meta['description']) entry.description = meta['description'];
      if (meta['type']) entry.type = meta['type'];
      if (meta['category']) entry.category = meta['category'];
      entries.push(entry);
    }
    return true;
  };

  let projectExists = false;
  for (const root of projectRoots) {
    if (await scanRoot('project', root, true)) projectExists = true;
  }
  const userExists = await scanRoot('user', userDir, false);

  const result: ServeAutoMemoryStatus = {
    v: AUTO_MEMORY_STATUS_SCHEMA_VERSION,
    workspaceCwd: boundWorkspace,
    initialized: projectExists || userExists,
    userDir,
    projectDir,
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

  // Admit only project roots that are real, non-symlinked directories:
  // a symlinked root would relocate the containment boundary to its
  // target, so it is refused instead of canonicalized.
  const projectRoots: string[] = [];
  for (const root of getProjectAutoMemoryRoots(
    boundWorkspace,
    opts.trusted === true,
  )) {
    try {
      const rootStat = await fs.lstat(root);
      if (rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
        projectRoots.push(root);
      }
    } catch {
      // Absent (or unstat'able) roots admit nothing.
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
    throw err;
  }

  let before;
  try {
    before = await fs.lstat(resolved);
  } catch (err) {
    if (isEnoent(err)) {
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
    if (code === 'EACCES' || code === 'EPERM') {
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
      ...(decoded.content !== undefined ? { content: decoded.content } : {}),
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

export interface WorkspaceAutoMemoryRouteDeps {
  boundWorkspace: string;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
  /**
   * Workspace runtime whose session storage base dir the managed roots
   * resolve under (Storage scope). Omitted — e.g. by unit tests — the
   * daemon's ambient Storage scope applies.
   */
  runtime?: Pick<WorkspaceRuntime, 'sessionRuntimeBaseDir'>;
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
  deps: WorkspaceAutoMemoryRouteDeps,
  res: Response,
): (() => void) | null {
  const assertGenerationOpen =
    deps.captureGenerationAssertion?.() ?? (() => {});
  try {
    assertGenerationOpen();
    return assertGenerationOpen;
  } catch (error) {
    sendGenerationClosedError(res, error);
    return null;
  }
}

/** Mount the two auto-memory browse routes on the supplied Express app. */
export function mountWorkspaceAutoMemoryRoutes(
  app: Application,
  deps: WorkspaceAutoMemoryRouteDeps,
): void {
  // Resolve the managed roots under the bound workspace's runtime
  // storage scope, not the daemon's ambient one (each workspace may pin
  // its own runtimeOutputDir).
  const withRuntimeStorage = <T>(fn: () => T): T =>
    deps.runtime ? runWithWorkspaceRuntimeStorage(deps.runtime, fn) : fn();
  const trusted = () => deps.isWorkspaceTrusted?.() === true;

  app.get('/workspace/auto-memory', async (_req: Request, res: Response) => {
    const assertGenerationOpen = captureOpenGeneration(deps, res);
    if (!assertGenerationOpen) return;
    if (!requireTrustedWorkspace(deps, res)) return;
    try {
      const status = await withRuntimeStorage(() =>
        collectWorkspaceAutoMemoryStatus(deps.boundWorkspace, {
          trusted: trusted(),
        }),
      );
      assertGenerationOpen();
      res.status(200).json(status);
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      writeStderrLine(
        `qwen serve: GET /workspace/auto-memory failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to discover auto-memory',
        code: 'auto_memory_discovery_failed',
      });
    }
  });

  app.get(
    '/workspace/auto-memory/file',
    async (req: Request, res: Response) => {
      const assertGenerationOpen = captureOpenGeneration(deps, res);
      if (!assertGenerationOpen) return;
      if (!requireTrustedWorkspace(deps, res)) return;
      const filePath = req.query['path'];
      if (typeof filePath !== 'string' || filePath.length === 0) {
        res.status(400).json({
          error: '`path` query parameter is required',
          code: 'missing_path',
        });
        return;
      }
      try {
        const result = await withRuntimeStorage(() =>
          readWorkspaceAutoMemoryFile(deps.boundWorkspace, filePath, {
            trusted: trusted(),
          }),
        );
        assertGenerationOpen();
        res.status(200).json(result);
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        if (err instanceof AutoMemoryPathError) {
          // read_failed means the admitted path could not be resolved or
          // opened by the daemon (a locked root directory, an unreadable
          // file) — a server fault, deliberately not the 400 bucket.
          res
            .status(
              err.code === 'not_found'
                ? 404
                : err.code === 'read_failed'
                  ? 500
                  : 400,
            )
            .json({
              error: err.message,
              code: err.code,
              path: filePath,
            });
          return;
        }
        writeStderrLine(
          `qwen serve: GET /workspace/auto-memory/file failed: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to read auto-memory file',
          code: 'auto_memory_read_failed',
        });
      }
    },
  );
}
