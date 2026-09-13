/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getWebPreviewSnapshotId,
  PUBLISHED_CONTENT_SHA256_METADATA_KEY,
} from '../../services/session-artifact-persistence.js';
import type { ToolArtifact } from '../tools.js';
import { MAX_ARTIFACT_BYTES } from './html.js';

const SNAPSHOT_REFERENCES_METADATA_KEY = 'qwen.snapshot.references';

export async function saveArtifactSnapshot(
  html: string,
  title: string,
  publishedUrl: string,
  sessionId: string,
  runtimeBaseDir: string,
): Promise<ToolArtifact> {
  const id = randomUUID();
  const root = path.join(runtimeBaseDir, 'artifacts', 'snapshots');
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, id);
  await fs.mkdir(dir);
  const file = path.join(dir, 'index.html');
  try {
    const references = path.join(dir, 'references');
    await fs.mkdir(references);
    await fs.writeFile(
      path.join(references, snapshotReference(sessionId)),
      '',
      {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      },
    );
    await fs.writeFile(file, html, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    await syncSnapshotDirectory(references);
    await syncSnapshotDirectory(dir);
    await syncSnapshotDirectory(root);
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    kind: 'html',
    storage: 'published',
    title,
    url: pathToFileURL(file).href,
    managedId: `preview-${id}`,
    mimeType: 'text/html',
    sizeBytes: Buffer.byteLength(html, 'utf8'),
    metadata: {
      artifactType: 'web_preview_snapshot',
      [SNAPSHOT_REFERENCES_METADATA_KEY]: 1,
      publishedUrl,
      [PUBLISHED_CONTENT_SHA256_METADATA_KEY]: createHash('sha256')
        .update(html)
        .digest('hex'),
    },
  };
}

export async function readArtifactSnapshot(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
): Promise<string> {
  const id = getWebPreviewSnapshotId(artifact);
  const sha256 = artifact.metadata?.[PUBLISHED_CONTENT_SHA256_METADATA_KEY];
  const unavailable = () => new Error('Saved webpage version is unavailable.');
  if (!id) throw unavailable();
  const root = path.join(runtimeBaseDir, 'artifacts', 'snapshots');
  const file = path.join(root, id, 'index.html');
  if (artifact.url !== pathToFileURL(file).href) throw unavailable();
  const realRoot = await fs.realpath(root);
  if ((await fs.realpath(file)) !== path.join(realRoot, id, 'index.html')) {
    throw unavailable();
  }
  const handle = await fs.open(
    file,
    // O_NOFOLLOW refuses a symlink swapped in after the realpath check, and
    // O_NONBLOCK keeps a FIFO swapped into the same window from blocking the
    // open: the path is only proven to be a regular file by the fstat below.
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw unavailable();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const content = bytes.subarray(0, length);
    if (
      length !== stat.size ||
      createHash('sha256').update(content).digest('hex') !== sha256
    ) {
      throw unavailable();
    }
    return content.toString('utf8');
  } finally {
    await handle.close();
  }
}

function snapshotReference(sessionId: string, operationId?: string): string {
  const owner = createHash('sha256').update(sessionId).digest('hex');
  return operationId
    ? `${owner}-${createHash('sha256').update(operationId).digest('hex')}`
    : owner;
}

async function syncSnapshotDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

async function snapshotDirectory(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
): Promise<string | undefined> {
  const id = getWebPreviewSnapshotId(artifact);
  if (!id) return undefined;
  const root = path.join(runtimeBaseDir, 'artifacts', 'snapshots');
  const dir = path.join(root, id);
  if (artifact.url !== pathToFileURL(path.join(dir, 'index.html')).href) {
    return undefined;
  }
  // Untracked snapshots predate reference-based reclamation and stay intact.
  if (artifact.metadata?.[SNAPSHOT_REFERENCES_METADATA_KEY] !== 1)
    return undefined;
  const realRoot = await fs.realpath(root);
  if ((await fs.realpath(dir)) !== path.join(realRoot, id)) return undefined;
  if (
    (await fs.realpath(path.join(dir, 'index.html'))) !==
    path.join(realRoot, id, 'index.html')
  )
    return undefined;
  if (
    (await fs.realpath(path.join(dir, 'references'))) !==
    path.join(realRoot, id, 'references')
  ) {
    return undefined;
  }
  return dir;
}

export async function retainArtifactSnapshot(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
  sessionId: string,
  operationId?: string,
): Promise<void> {
  try {
    const dir = await snapshotDirectory(artifact, runtimeBaseDir);
    if (!dir) return;
    const references = path.join(dir, 'references');
    const owner = snapshotReference(sessionId);
    if (
      !operationId &&
      (await fs.readdir(references)).some(
        (entry) => entry === owner || entry.startsWith(`${owner}-`),
      )
    )
      return;
    await fs.writeFile(
      path.join(references, snapshotReference(sessionId, operationId)),
      '',
      { flag: 'wx', mode: 0o600, flush: true },
    );
    await syncSnapshotDirectory(references);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A fork must acquire ownership before committing. An ordinary restore can
    // still show an unavailable historical descriptor when its file is missing.
    if (code !== 'EEXIST' && !(code === 'ENOENT' && !operationId)) throw error;
  }
}

export async function deleteArtifactSnapshot(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
  sessionId: string,
  operationId?: string,
  assertCleanupOwned?: () => void,
): Promise<void> {
  try {
    const dir = await snapshotDirectory(artifact, runtimeBaseDir);
    if (!dir) return;
    await releaseSnapshotDirectory(
      dir,
      sessionId,
      operationId,
      assertCleanupOwned,
    );
  } catch {
    assertCleanupOwned?.();
    // Reclamation must never break record removal.
  }
}

async function releaseSnapshotDirectory(
  dir: string,
  sessionId: string,
  operationId?: string,
  assertCleanupOwned?: () => void,
): Promise<void> {
  const references = path.join(dir, 'references');
  const owner = snapshotReference(sessionId, operationId);
  let released = false;
  for (const reference of await fs.readdir(references)) {
    if (
      reference === owner ||
      (!operationId && reference.startsWith(`${owner}-`))
    ) {
      assertCleanupOwned?.();
      await fs.unlink(path.join(references, reference));
      released = true;
    }
  }
  if (!released) return;
  // rmdir is the atomic last-owner claim. A concurrent retain either prevents
  // it or fails before the new fork can commit its transcript.
  try {
    assertCleanupOwned?.();
    await fs.rmdir(references);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return;
    throw error;
  }
  const file = path.join(dir, 'index.html');
  assertCleanupOwned?.();
  await fs.unlink(file);
  assertCleanupOwned?.();
  await fs.rmdir(dir);
}
