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
  getUserAutoMemoryRoot,
  isAutoMemPath,
  isUserAutoMemPath,
} from '@qwen-code/qwen-code-core';
import { detectBOM } from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { openNoFollow } from '@qwen-code/qwen-code-core/noFollowOpen';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { FsError } from './fs/errors.js';
import { resolveWithinWorkspace } from './fs/paths.js';
import { sendGenerationClosedError } from './workspace-route-runtime.js';

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
 * path is validated against the two managed roots — not the sandboxed
 * workspace file API — because both roots sit OUTSIDE the bound workspace,
 * where `GET /file` refuses. Resolution is symlink-canonicalized via
 * `resolveWithinWorkspace` against the two roots, capped at 1 MB, and
 * lossy (BOM / non-UTF-8 / torn) reads are flagged instead of served,
 * matching the explicit memory route's read contract.
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
/**
 * The managed layout is `<root>/MEMORY.md` + `<root>/<type>/<file>.md`;
 * depth 3 covers that plus one level of user organization without an
 * unbounded recursion.
 */
const MAX_SCAN_DEPTH = 3;

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
  depth: number,
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
      if (depth < MAX_SCAN_DEPTH) {
        await collectFilesIn(
          path.join(dir, entry.name),
          root,
          depth + 1,
          files,
          errors,
        );
      }
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
 * bound workspace's project root and the user-level root. Per-file
 * failures are surfaced in-band via `errors[]`; an absent root is not an
 * error (a fresh host has neither).
 */
export async function collectWorkspaceAutoMemoryStatus(
  boundWorkspace: string,
): Promise<ServeAutoMemoryStatus> {
  const projectDir = getAutoMemoryRoot(boundWorkspace);
  const userDir = getUserAutoMemoryRoot();
  const entries: ServeAutoMemoryFile[] = [];
  const errors: AutoMemoryError[] = [];

  const scanScope = async (
    scope: ServeAutoMemoryScope,
    root: string,
  ): Promise<boolean> => {
    try {
      const rootStat = await fs.stat(root);
      if (!rootStat.isDirectory()) return false;
    } catch {
      return false;
    }
    const files: ScannedFile[] = [];
    await collectFilesIn(root, root, 0, files, errors);
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

  const projectExists = await scanScope('project', projectDir);
  const userExists = await scanScope('user', userDir);

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
 * after symlink canonicalization — into one of the two managed roots;
 * anything else is refused with `AutoMemoryPathError('outside')`.
 */
export async function readWorkspaceAutoMemoryFile(
  boundWorkspace: string,
  filePath: string,
): Promise<ServeAutoMemoryFileContent> {
  const projectDir = getAutoMemoryRoot(boundWorkspace);
  const userDir = getUserAutoMemoryRoot();
  const inProject = isAutoMemPath(filePath, boundWorkspace);
  const inUser = isUserAutoMemPath(filePath);
  if (!inProject && !inUser) {
    throw new AutoMemoryPathError(
      'outside',
      `path is outside the auto-memory roots: ${filePath}`,
    );
  }
  const scope: ServeAutoMemoryScope = inProject ? 'project' : 'user';

  let resolved: string;
  try {
    resolved = await resolveWithinWorkspace(filePath, [projectDir, userDir], 'read');
  } catch (err) {
    if (err instanceof FsError) {
      // The literal path was already admitted by the root pre-check above,
      // so a canonicalization failure means a symlink escape (or the file
      // vanished mid-flight); either way the read is refused, not served.
      throw new AutoMemoryPathError('outside', err.message);
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
  /** Test/embed override for the discovery pass. */
  collectStatus?: typeof collectWorkspaceAutoMemoryStatus;
  /** Test/embed override for the single-file read. */
  readFile?: typeof readWorkspaceAutoMemoryFile;
}

function requireTrustedWorkspace(
  deps: WorkspaceAutoMemoryRouteDeps,
  res: Response,
): boolean {
  if (deps.isWorkspaceTrusted?.() !== false) return true;
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
  app.get('/workspace/auto-memory', async (_req: Request, res: Response) => {
    const assertGenerationOpen = captureOpenGeneration(deps, res);
    if (!assertGenerationOpen) return;
    if (!requireTrustedWorkspace(deps, res)) return;
    try {
      const collectStatus = deps.collectStatus ?? collectWorkspaceAutoMemoryStatus;
      const status = await collectStatus(deps.boundWorkspace);
      assertGenerationOpen();
      res.status(200).json(status);
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      writeStderrLine(
        `qwen serve: GET /workspace/auto-memory failed: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
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
        const readFile = deps.readFile ?? readWorkspaceAutoMemoryFile;
        const result = await readFile(deps.boundWorkspace, filePath);
        assertGenerationOpen();
        res.status(200).json(result);
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        if (err instanceof AutoMemoryPathError) {
          res.status(err.code === 'not_found' ? 404 : 400).json({
            error: err.message,
            code: err.code,
            path: filePath,
          });
          return;
        }
        writeStderrLine(
          `qwen serve: GET /workspace/auto-memory/file failed: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
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
