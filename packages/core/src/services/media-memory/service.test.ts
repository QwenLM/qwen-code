/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MediaMemoryService, type MediaMemoryBinding } from './service.js';
import { MEDIA_MEMORY_FILE_NAME } from './store.js';
import type { MediaMemorySnapshot } from './types.js';

it('keeps sibling files and execution lineage separate when their bytes match', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'media-memory-lineage-'));
  try {
    const service = new MediaMemoryService(root);
    const outputSha = 'c'.repeat(64);
    const outputPath = join(root, 'objects', `${outputSha}.png`);
    const recognize = (fileRef: string) =>
      service.recordFileRecognized({
        fileRef,
        sha256: 'a'.repeat(64),
        mediaType: 'image',
        metadata: {},
        sizeBytes: 1,
        mimeType: 'image/png',
        origin: 'user',
        source: { protocol: 'local', locator: basename(fileRef) },
        recognition: {
          ingestionConfigHash: '',
          detectorVersion: 'test',
          probeStatus: 'complete',
        },
      });
    const succeed = (source: MediaMemoryBinding) =>
      service.commitPolicySucceeded({
        invocationId: 'same-invocation',
        source,
        executionOrigin: { kind: 'model' },
        toolName: 'omni_resize_image',
        finalArguments: {},
        omniConfigHash: 'same-config',
        startedAt: '2026-08-11T00:00:00.000Z',
        completedAt: '2026-08-11T00:00:01.000Z',
        outputs: [
          {
            kind: 'media',
            objectPath: outputPath,
            sha256: outputSha,
            mediaType: 'image',
            metadata: {},
            sizeBytes: 1,
            mimeType: 'image/png',
          },
        ],
      });
    const a = (await recognize('/a.png'))!;
    const b = (await recognize('/b.png'))!;
    expect(a.fileId).not.toBe(b.fileId);
    expect(a.fileVersionId).not.toBe(b.fileVersionId);
    const roots = [a.fileId, b.fileId];
    const sourceVersions = [a.fileVersionId, b.fileVersionId];
    const commits = [(await succeed(a))!, (await succeed(b))!];
    expect(commits[1].executionId).not.toBe(commits[0].executionId);
    expect(commits[1].created).toBe(true);
    const snapshot = JSON.parse(
      await fs.readFile(join(root, MEDIA_MEMORY_FILE_NAME), 'utf8'),
    ) as MediaMemorySnapshot;
    const bindings = commits.map(
      (commit) => commit.mediaBindings.get(outputSha)!,
    );
    expect(bindings[0].fileId).not.toBe(bindings[1].fileId);
    for (const [index, commit] of commits.entries()) {
      expect(snapshot.executions[commit.executionId]).toMatchObject({
        sourceVersionId: sourceVersions[index],
        rootFileId: roots[index],
      });
      expect(bindings[index].rootFileId).toBe(roots[index]);
      expect(snapshot.files[bindings[index].fileId]).toMatchObject({
        rootFileId: roots[index],
        fileRef: outputPath,
      });
      expect(snapshot.versions[bindings[index].fileVersionId]).toMatchObject({
        parentVersionId: sourceVersions[index],
        producedByExecutionId: commit.executionId,
      });
    }
    expect(
      snapshot.executions[commits[0].executionId].reusedExecutionId,
    ).toBeUndefined();
    expect(snapshot.executions[commits[1].executionId].reusedExecutionId).toBe(
      commits[0].executionId,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
