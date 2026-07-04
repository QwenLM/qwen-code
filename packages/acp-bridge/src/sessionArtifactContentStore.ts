/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionArtifactContentRef } from '@qwen-code/qwen-code-core';
import type { DaemonSessionArtifact } from './sessionArtifacts.js';
import { SessionArtifactValidationError } from './sessionArtifacts.js';

const CONTENT_FORMAT_VERSION = 1;
const MAX_PINNED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CONTENT_STORE_BYTES = 256 * 1024 * 1024;

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
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) {
      throw new SessionArtifactValidationError(
        'Only regular workspace files can be pinned with content retention',
        'artifactId',
      );
    }
    if (sourceStat.size > MAX_PINNED_FILE_BYTES) {
      throw new SessionArtifactValidationError(
        `Pinned artifact content exceeds ${MAX_PINNED_FILE_BYTES} bytes`,
        'artifactId',
      );
    }

    return this.enqueueWrite(async () => {
      const tmpDir = path.join(this.rootDir, '.tmp');
      await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      let tmpPath: string | undefined = path.join(
        tmpDir,
        `${process.pid}-${Date.now()}-${artifact.id}.bin`,
      );
      try {
        await fs.copyFile(source, tmpPath);
        const { sha256, sizeBytes } = await hashFile(tmpPath);
        if (sizeBytes > MAX_PINNED_FILE_BYTES) {
          throw new SessionArtifactValidationError(
            `Pinned artifact content exceeds ${MAX_PINNED_FILE_BYTES} bytes`,
            'artifactId',
          );
        }

        const contentId = `${sha256}-${stableContentSuffix(
          sessionId,
          artifact.id,
        )}`;
        const contentDir = path.join(this.rootDir, contentId);
        const dataPath = path.join(contentDir, 'content');
        if (await exists(dataPath)) {
          await fs.rm(tmpPath, { force: true });
          tmpPath = undefined;
        } else {
          const usedBytes = await this.usedBytes();
          if (usedBytes + sizeBytes > MAX_CONTENT_STORE_BYTES) {
            throw new SessionArtifactValidationError(
              'Artifact content quota exceeded',
              'artifactId',
            );
          }
          await fs.mkdir(contentDir, { recursive: true, mode: 0o700 });
          await fs.rename(tmpPath, dataPath);
          tmpPath = undefined;
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
        await fs.writeFile(
          path.join(contentDir, 'manifest.json'),
          `${JSON.stringify(manifest)}\n`,
          { mode: 0o600 },
        );
        return {
          kind: 'managed_copy',
          contentId,
          sha256,
          sizeBytes,
          createdAt,
        };
      } catch (error) {
        if (tmpPath) {
          await fs.rm(tmpPath, { force: true }).catch(() => {});
        }
        throw error;
      }
    });
  }

  async fsck(
    contentRefs: readonly SessionArtifactContentRef[],
  ): Promise<SessionArtifactFsckResult> {
    const missing: string[] = [];
    const hashMismatches: string[] = [];
    for (const ref of contentRefs) {
      const dataPath = path.join(this.rootDir, ref.contentId, 'content');
      try {
        const { sha256 } = await hashFile(dataPath);
        if (sha256 !== ref.sha256) {
          hashMismatches.push(ref.contentId);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missing.push(ref.contentId);
          continue;
        }
        throw error;
      }
    }
    return { checked: contentRefs.length, missing, hashMismatches };
  }

  async gc(
    sessionId: string,
    referencedContentIds: ReadonlySet<string>,
  ): Promise<SessionArtifactGcResult> {
    const removed: string[] = [];
    const retained: string[] = [];
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
      if (entry === '.tmp') continue;
      const fullPath = path.join(this.rootDir, entry);
      if (referencedContentIds.has(entry)) {
        retained.push(entry);
        continue;
      }
      let manifest: ContentManifest;
      try {
        manifest = await readManifest(path.join(fullPath, 'manifest.json'));
      } catch {
        retained.push(entry);
        continue;
      }
      if (manifest.sessionId !== sessionId) {
        retained.push(entry);
        continue;
      }
      await fs.rm(fullPath, { recursive: true, force: true });
      removed.push(entry);
    }
    return { removed, retained };
  }

  private async usedBytes(): Promise<number> {
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
        // Malformed manifests are handled by fsck/GC; ignore them for quota.
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
): Promise<string> {
  const realWorkspace = await fs.realpath(workspaceCwd);
  const candidate = path.resolve(realWorkspace, workspacePath);
  const realCandidate = await fs.realpath(candidate);
  const relative = path.relative(realWorkspace, realCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SessionArtifactValidationError(
      'workspacePath must stay inside the workspace',
      'workspacePath',
    );
  }
  return realCandidate;
}

function hashFile(
  filePath: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += buffer.length;
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({ sha256: hash.digest('hex'), sizeBytes });
    });
  });
}

async function readManifest(filePath: string): Promise<ContentManifest> {
  const body = await fs.readFile(filePath, 'utf8');
  return JSON.parse(body) as ContentManifest;
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
