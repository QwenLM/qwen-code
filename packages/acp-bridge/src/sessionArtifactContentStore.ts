/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionArtifactContentRef } from '@qwen-code/qwen-code-core';
import type { SessionArtifactPersistenceWarning } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from './internal/stderrLine.js';
import type { DaemonSessionArtifact } from './sessionArtifacts.js';
import { SessionArtifactValidationError } from './sessionArtifacts.js';

const CONTENT_FORMAT_VERSION = 1;
const MAX_PINNED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CONTENT_STORE_BYTES = 256 * 1024 * 1024;
const MAX_CONTENT_MANIFEST_BYTES = 4 * 1024;
const CONTENT_ID_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{16}$/;

interface ContentManifest {
  v: typeof CONTENT_FORMAT_VERSION;
  contentId: string;
  sessionId: string;
  artifactId: string;
  workspacePath: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

interface ResolvedWorkspaceFile {
  realWorkspace: string;
  realPath: string;
  stat: fsSync.Stats;
}

export interface SessionArtifactFsckResult {
  checked: number;
  missing: string[];
  hashMismatches: string[];
}

export interface SessionArtifactGcResult {
  removed: string[];
  retained: string[];
}

export class SessionArtifactContentStore {
  private readonly rootDir: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly leasedContentIds = new Map<string, number>();
  private cachedTotalBytes: number | undefined;

  constructor(rootDir = defaultContentRoot()) {
    this.rootDir = rootDir;
  }

  async pinWorkspaceFile(
    sessionId: string,
    artifact: DaemonSessionArtifact,
    workspaceCwd: string,
  ): Promise<SessionArtifactContentRef | undefined> {
    if (artifact.storage !== 'workspace' || !artifact.workspacePath) {
      return undefined;
    }
    const workspacePath = artifact.workspacePath;
    const source = await resolveWorkspaceFile(
      workspaceCwd,
      workspacePath,
    ).catch((error: unknown) => {
      if (error instanceof SessionArtifactValidationError) {
        throw error;
      }
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'artifactId',
      );
    });
    return this.enqueueWrite(async () => {
      const tmpDir = path.join(this.rootDir, '.tmp');
      await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      let tmpPath: string | undefined = path.join(
        tmpDir,
        `${process.pid}-${Date.now()}-${artifact.id}.bin`,
      );
      let sourceHandle: FileHandle | undefined;
      let addedSizeBytes = 0;
      let contentDir: string | undefined;
      try {
        sourceHandle = await openRegularWorkspaceFile(source);
        const { sha256, sizeBytes } = await copyOpenFileToTemp(
          sourceHandle,
          tmpPath,
        );

        const contentId = `${sha256}-${stableContentSuffix(
          sessionId,
          artifact.id,
        )}`;
        contentDir = path.join(this.rootDir, contentId);
        const dataPath = path.join(contentDir, 'content');
        if (await exists(dataPath)) {
          if (!(await contentFileMatches(dataPath, sha256, sizeBytes))) {
            throw new SessionArtifactValidationError(
              'Existing retained artifact content failed verification',
              'artifactId',
            );
          }
          await fs.rm(tmpPath, { force: true });
          tmpPath = undefined;
        } else {
          const usedBytes = await this.getUsedBytes();
          if (usedBytes + sizeBytes > MAX_CONTENT_STORE_BYTES) {
            throw new SessionArtifactValidationError(
              `Artifact content quota exceeded (usedBytes=${usedBytes}, requestedBytes=${sizeBytes}, limitBytes=${MAX_CONTENT_STORE_BYTES})`,
              'artifactId',
            );
          }
          await fs.mkdir(contentDir, { recursive: true, mode: 0o700 });
          await fs.rename(tmpPath, dataPath);
          tmpPath = undefined;
          addedSizeBytes = sizeBytes;
        }

        const createdAt = new Date().toISOString();
        const manifest: ContentManifest = {
          v: CONTENT_FORMAT_VERSION,
          contentId,
          sessionId,
          artifactId: artifact.id,
          workspacePath,
          sha256,
          sizeBytes,
          createdAt,
        };
        await writeManifestAtomic(contentDir, manifest);
        if (addedSizeBytes > 0 && this.cachedTotalBytes !== undefined) {
          this.cachedTotalBytes += addedSizeBytes;
        }
        this.leaseContentId(contentId);
        return {
          kind: 'managed_copy',
          contentId,
          sha256,
          sizeBytes,
          createdAt,
        };
      } catch (error) {
        if (addedSizeBytes > 0) {
          if (contentDir) {
            await fs
              .rm(contentDir, { recursive: true, force: true })
              .catch(() => {});
          }
          this.cachedTotalBytes = undefined;
        }
        if (tmpPath) {
          await fs.rm(tmpPath, { force: true }).catch(() => {});
        }
        throw error;
      } finally {
        await sourceHandle?.close().catch(() => undefined);
      }
    });
  }

  releaseContentRef(ref: SessionArtifactContentRef): void {
    this.releaseContentId(ref.contentId);
  }

  leaseContentRefs(refs: readonly SessionArtifactContentRef[]): () => void {
    const leased: string[] = [];
    for (const ref of refs) {
      this.leaseContentId(ref.contentId);
      leased.push(ref.contentId);
    }
    return () => {
      for (const contentId of leased) {
        this.releaseContentId(contentId);
      }
    };
  }

  async fsck(
    contentRefs: readonly SessionArtifactContentRef[],
  ): Promise<SessionArtifactFsckResult> {
    const missing: string[] = [];
    const hashMismatches: string[] = [];
    for (const ref of contentRefs) {
      if (!isValidContentId(ref.contentId)) {
        missing.push(ref.contentId);
        continue;
      }
      const dataPath = path.join(this.rootDir, ref.contentId, 'content');
      try {
        const { sha256 } = await hashFile(dataPath);
        if (sha256 !== ref.sha256) {
          hashMismatches.push(ref.contentId);
        }
      } catch {
        missing.push(ref.contentId);
        continue;
      }
    }
    const result = { checked: contentRefs.length, missing, hashMismatches };
    writeStderrLine(
      `[artifacts] action=fsck checked=${result.checked} missing=${result.missing.length} hashMismatches=${result.hashMismatches.length}`,
    );
    return result;
  }

  async verifyContentRef(
    sessionId: string,
    artifactId: string,
    ref: SessionArtifactContentRef,
  ): Promise<SessionArtifactPersistenceWarning | undefined> {
    if (
      ref.kind !== 'managed_copy' ||
      !isValidContentId(ref.contentId) ||
      !/^[0-9a-f]{64}$/.test(ref.sha256) ||
      !Number.isSafeInteger(ref.sizeBytes) ||
      ref.sizeBytes < 0
    ) {
      return 'restore_validation_failed';
    }
    const contentDir = path.join(this.rootDir, ref.contentId);
    let manifest: ContentManifest;
    try {
      manifest = await readManifest(path.join(contentDir, 'manifest.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'content_missing';
      }
      return 'restore_validation_failed';
    }
    if (
      manifest.sessionId !== sessionId ||
      manifest.artifactId !== artifactId ||
      manifest.contentId !== ref.contentId ||
      manifest.sha256 !== ref.sha256 ||
      manifest.sizeBytes !== ref.sizeBytes
    ) {
      return 'restore_validation_failed';
    }
    try {
      const contentPath = path.join(contentDir, 'content');
      const stat = await fs.lstat(contentPath);
      if (!stat.isFile()) {
        return 'content_hash_mismatch';
      }
      const { sha256, sizeBytes } = await hashFile(contentPath);
      if (sha256 !== ref.sha256 || sizeBytes !== ref.sizeBytes) {
        return 'content_hash_mismatch';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'content_missing';
      }
      throw error;
    }
    return undefined;
  }

  async gc(
    sessionId: string,
    referencedContentIds: ReadonlySet<string>,
  ): Promise<SessionArtifactGcResult> {
    return this.enqueueWrite(async () => {
      const removed: string[] = [];
      const retained: string[] = [];
      const failedRemovals: string[] = [];
      let entries: string[];
      try {
        entries = await fs.readdir(this.rootDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { removed, retained };
        }
        throw error;
      }
      for (const entry of entries) {
        if (entry === '.tmp') {
          await cleanTmpDir(path.join(this.rootDir, entry));
          continue;
        }
        const fullPath = path.join(this.rootDir, entry);
        if (
          referencedContentIds.has(entry) ||
          this.leasedContentIds.has(entry)
        ) {
          retained.push(entry);
          continue;
        }
        let manifest: ContentManifest;
        try {
          manifest = await readManifest(path.join(fullPath, 'manifest.json'));
        } catch (error) {
          writeStderrLine(
            `[artifacts] action=content_gc_manifest_read_failed contentId=${entry} reason=${JSON.stringify(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
          retained.push(entry);
          continue;
        }
        if (manifest.sessionId !== sessionId) {
          retained.push(entry);
          continue;
        }
        try {
          await fs.rm(fullPath, { recursive: true, force: true });
        } catch (error) {
          writeStderrLine(
            `[artifacts] action=content_gc_remove_failed contentId=${entry} reason=${JSON.stringify(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
          retained.push(entry);
          failedRemovals.push(entry);
          continue;
        }
        if (this.cachedTotalBytes !== undefined) {
          this.cachedTotalBytes = Math.max(
            0,
            this.cachedTotalBytes - manifest.sizeBytes,
          );
        }
        removed.push(entry);
      }
      if (failedRemovals.length > 0) {
        throw new Error(
          `artifact content GC failed to remove ${failedRemovals.length} entr${
            failedRemovals.length === 1 ? 'y' : 'ies'
          }`,
        );
      }
      return { removed, retained };
    });
  }

  private async getUsedBytes(): Promise<number> {
    if (this.cachedTotalBytes === undefined) {
      this.cachedTotalBytes = await this.scanUsedBytes();
    }
    return this.cachedTotalBytes;
  }

  private async scanUsedBytes(): Promise<number> {
    let total = 0;
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry === '.tmp') continue;
      try {
        const manifest = await readManifest(
          path.join(this.rootDir, entry, 'manifest.json'),
        );
        total += manifest.sizeBytes;
      } catch {
        try {
          const stat = await fs.stat(path.join(this.rootDir, entry, 'content'));
          if (stat.isFile()) {
            total += stat.size;
          }
        } catch {
          // Malformed manifests are handled by fsck/GC.
        }
      }
    }
    return total;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.catch(() => {}).then(operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private leaseContentId(contentId: string): void {
    this.leasedContentIds.set(
      contentId,
      (this.leasedContentIds.get(contentId) ?? 0) + 1,
    );
  }

  private releaseContentId(contentId: string): void {
    const count = this.leasedContentIds.get(contentId);
    if (count === undefined) return;
    if (count <= 1) {
      this.leasedContentIds.delete(contentId);
      return;
    }
    this.leasedContentIds.set(contentId, count - 1);
  }
}

function defaultContentRoot(): string {
  return path.join(getGlobalQwenDir(), 'session-artifacts', 'content');
}

function getGlobalQwenDir(): string {
  const envDir = process.env['QWEN_HOME'];
  if (envDir) {
    return resolveUserPath(envDir);
  }
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), '.qwen');
  }
  return path.join(homeDir, '.qwen');
}

function resolveUserPath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  return path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
}

function stableContentSuffix(sessionId: string, artifactId: string): string {
  return createHash('sha256')
    .update(`${sessionId}:${artifactId}`)
    .digest('hex')
    .slice(0, 16);
}

async function resolveWorkspaceFile(
  workspaceCwd: string,
  workspacePath: string,
): Promise<ResolvedWorkspaceFile> {
  const realWorkspace = await fs.realpath(workspaceCwd);
  const candidate = path.resolve(realWorkspace, workspacePath);
  const realCandidate = await fs.realpath(candidate);
  validateWorkspaceContained(realWorkspace, realCandidate);
  return {
    realWorkspace,
    realPath: realCandidate,
    stat: await fs.stat(realCandidate),
  };
}

async function openRegularWorkspaceFile(
  source: ResolvedWorkspaceFile,
): Promise<FileHandle> {
  const sourceStat = source.stat;
  if (!sourceStat.isFile()) {
    throw new SessionArtifactValidationError(
      'Only regular workspace files can be pinned with content retention',
      'artifactId',
    );
  }
  if (sourceStat.nlink > 1) {
    throw new SessionArtifactValidationError(
      'Hardlinked workspace files cannot be pinned with content retention',
      'artifactId',
    );
  }
  if (sourceStat.size > MAX_PINNED_FILE_BYTES) {
    throw new SessionArtifactValidationError(
      `Pinned artifact content exceeds ${MAX_PINNED_FILE_BYTES} bytes`,
      'artifactId',
    );
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(
      source.realPath,
      fsSync.constants.O_RDONLY | noFollowFlag(),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SessionArtifactValidationError(
        'workspacePath must not resolve through a symlink while pinning content',
        'workspacePath',
      );
    }
    throw error;
  }
  try {
    const handleStat = await handle.stat();
    const realAfterOpen = await fs.realpath(source.realPath);
    validateWorkspaceContained(source.realWorkspace, realAfterOpen);
    if (realAfterOpen !== source.realPath) {
      throw new SessionArtifactValidationError(
        'workspacePath changed while pinning content',
        'workspacePath',
      );
    }
    const currentStat = await fs.stat(source.realPath);
    if (!handleStat.isFile()) {
      throw new SessionArtifactValidationError(
        'Only regular workspace files can be pinned with content retention',
        'artifactId',
      );
    }
    if (
      !sameFile(sourceStat, handleStat) ||
      !sameFile(currentStat, handleStat)
    ) {
      throw new SessionArtifactValidationError(
        'workspacePath changed while pinning content',
        'workspacePath',
      );
    }
    if (handleStat.nlink > 1) {
      throw new SessionArtifactValidationError(
        'Hardlinked workspace files cannot be pinned with content retention',
        'artifactId',
      );
    }
    if (handleStat.size > MAX_PINNED_FILE_BYTES) {
      throw new SessionArtifactValidationError(
        `Pinned artifact content exceeds ${MAX_PINNED_FILE_BYTES} bytes`,
        'artifactId',
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function validateWorkspaceContained(
  realWorkspace: string,
  realPath: string,
): void {
  const relative = path.relative(realWorkspace, realPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SessionArtifactValidationError(
      'workspacePath must stay inside the workspace',
      'workspacePath',
    );
  }
}

async function copyOpenFileToTemp(
  handle: FileHandle,
  tmpPath: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const writer = await fs.open(tmpPath, 'w', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let sizeBytes = 0;
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      sizeBytes += bytesRead;
      if (sizeBytes > MAX_PINNED_FILE_BYTES) {
        throw new SessionArtifactValidationError(
          `Pinned artifact content exceeds ${MAX_PINNED_FILE_BYTES} bytes`,
          'artifactId',
        );
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writer.write(chunk);
    }
    await writer.sync();
  } finally {
    await writer.close().catch(() => undefined);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

function noFollowFlag(): number {
  return typeof fsSync.constants.O_NOFOLLOW === 'number'
    ? fsSync.constants.O_NOFOLLOW
    : 0;
}

function sameFile(before: fsSync.Stats, after: fsSync.Stats): boolean {
  if (
    before.dev !== 0 &&
    before.ino !== 0 &&
    after.dev !== 0 &&
    after.ino !== 0
  ) {
    return before.dev === after.dev && before.ino === after.ino;
  }
  return before.size === after.size && before.mtimeMs === after.mtimeMs;
}

async function hashFile(
  filePath: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const fileStat = await fs.lstat(filePath);
  if (!fileStat.isFile()) {
    throw new Error('Retained artifact content must be a regular file');
  }
  const handle = await fs.open(
    filePath,
    fsSync.constants.O_RDONLY | noFollowFlag(),
  );
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let sizeBytes = 0;
  let position = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('Retained artifact content must be a regular file');
    }
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      sizeBytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: hash.digest('hex'), sizeBytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function contentFileMatches(
  filePath: string,
  sha256: string,
  sizeBytes: number,
): Promise<boolean> {
  const existing = await hashFile(filePath);
  return existing.sha256 === sha256 && existing.sizeBytes === sizeBytes;
}

async function readManifest(filePath: string): Promise<ContentManifest> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size > MAX_CONTENT_MANIFEST_BYTES) {
    throw new Error('Invalid artifact content manifest');
  }
  const body = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(body) as Partial<ContentManifest>;
  if (
    parsed.v !== CONTENT_FORMAT_VERSION ||
    !parsed.contentId ||
    !isValidContentId(parsed.contentId) ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.artifactId !== 'string' ||
    typeof parsed.workspacePath !== 'string' ||
    typeof parsed.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.sha256) ||
    typeof parsed.sizeBytes !== 'number' ||
    !Number.isSafeInteger(parsed.sizeBytes) ||
    parsed.sizeBytes < 0 ||
    typeof parsed.createdAt !== 'string'
  ) {
    throw new Error('Invalid artifact content manifest');
  }
  return parsed as ContentManifest;
}

async function writeManifestAtomic(
  contentDir: string,
  manifest: ContentManifest,
): Promise<void> {
  const tmpPath = path.join(
    contentDir,
    `.manifest-${process.pid}-${Date.now()}.json.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'w', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, path.join(contentDir, 'manifest.json'));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function cleanTmpDir(tmpDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(tmpDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    try {
      await fs.rm(path.join(tmpDir, entry), { recursive: true, force: true });
    } catch (error) {
      writeStderrLine(
        `[artifacts] action=content_tmp_cleanup_failed entry=${JSON.stringify(
          entry,
        )} reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }
}

function isValidContentId(contentId: string): boolean {
  return CONTENT_ID_PATTERN.test(contentId);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
