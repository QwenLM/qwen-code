/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Storage } from '../../config/storage.js';
import {
  getWebPreviewSnapshotId,
  PUBLISHED_CONTENT_SHA256_METADATA_KEY,
} from '../../services/session-artifact-persistence.js';
import type { ToolArtifact } from '../tools.js';
import { MAX_ARTIFACT_BYTES } from './html.js';

export async function saveArtifactSnapshot(
  html: string,
  title: string,
  publishedUrl: string,
): Promise<ToolArtifact> {
  const id = randomUUID();
  const root = path.join(Storage.getRuntimeBaseDir(), 'artifacts', 'snapshots');
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, id);
  await fs.mkdir(dir);
  const file = path.join(dir, 'index.html');
  await fs.writeFile(file, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
