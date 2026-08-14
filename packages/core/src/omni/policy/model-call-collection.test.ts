/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import type { PolicyArtifactBatch } from '../../core/turn.js';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  MediaResourceRegistry,
  type MediaMemorySnapshot,
} from '../../services/media-memory/index.js';
import { OmniObjectStore } from '../storage.js';
import { collectModelPolicyCall } from './model-call-collection.js';

// The content sniff stays REAL (magic bytes, in-process) — only the
// ffprobe SUBPROCESS is stubbed. Under CI load the real ffprobe hit its
// 15s kill timer and the collection silently skipped per D12, reading
// as "0 executions" (observed twice on the hk runners). Probing adds
// nothing this suite asserts; the subprocess only adds a load
// dependency.
vi.mock('../ffmpeg.js', () => ({
  probeMediaMetadata: vi
    .fn()
    .mockResolvedValue({ width: 1, height: 1 } as never),
}));

/** A 1x1 JPEG — recognizeMediaFile sniffs real bytes, so the artifact has
 * to be a genuine image. */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwcJC4nHywjLBwcKDcpLDA1NTU1HyU5PTgyNTL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAA' +
    'AAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQR' +
    'AQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAA/9k=',
  'base64',
);

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '3',
  inputMediaTypes: ['image'],
  outputs: [
    { kind: 'media', required: true, mimeTypes: ['image/jpeg'], lossy: true },
  ],
};

describe('collectModelPolicyCall', () => {
  let tmpDir: string;
  let outputDir: string;
  let inputPath: string;
  let registry: MediaResourceRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-model-commit-'));
    outputDir = path.join(tmpDir, 'out');
    await fs.mkdir(outputDir, { recursive: true });
    inputPath = path.join(tmpDir, 'source.jpg');
    await fs.writeFile(inputPath, JPEG_1X1);
    await fs.writeFile(path.join(outputDir, 'derived.jpg'), JPEG_1X1);
    registry = new MediaResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function bridgeConfig(overrides?: Record<string, unknown>): Config {
    return {
      storage: { getQwenDir: () => tmpDir },
      getOmniMemoryConfig: () => DEFAULT_OMNI_MEMORY_CONFIG,
      getOmniMediaResourceRegistry: () => registry,
      ...overrides,
    } as unknown as Config;
  }

  function batchOf(
    origin: PolicyArtifactBatch['executionOrigin'] = { kind: 'model' },
  ): PolicyArtifactBatch {
    return {
      toolName: 'omni_downsample_image',
      invocationId: 'call-abc',
      executionOrigin: origin,
      artifacts: [
        {
          kind: 'image',
          storage: 'workspace',
          title: 'derived',
          workspacePath: 'derived.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: JPEG_1X1.length,
          metadata: {
            omniDisclosure: 'downsampled to 1x1',
            omniRole: 'degraded',
          },
        },
      ],
    };
  }

  async function readSnapshot(): Promise<MediaMemorySnapshot> {
    const file = path.join(
      new OmniObjectStore(tmpDir).getOmniRootDir(),
      'memory.json',
    );
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as MediaMemorySnapshot;
    } catch {
      return {
        schemaVersion: 1,
        files: {},
        versions: {},
        executions: {},
        entries: {},
      };
    }
  }

  it('commits a model-origin success through the same boundary', async () => {
    await collectModelPolicyCall({
      config: bridgeConfig(),
      batch: batchOf(),
      descriptor: DESCRIPTOR,
      args: { inputPath, outputDir, quality: 70 },
    });

    const snapshot = await readSnapshot();
    const executions = Object.values(snapshot.executions);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      toolName: 'omni_downsample_image',
      invocationId: 'call-abc',
      // The REAL origin is preserved — not rewritten as fixed_policy.
      executionOrigin: { kind: 'model' },
      toolVersion: '3',
      // Per-invocation plumbing is excluded from reproducible config.
      finalArguments: { quality: 70 },
    });

    // One entry per declared output, and the derivative was promoted into
    // the object store BEFORE the record referencing it was written.
    const entries = Object.values(snapshot.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'derived_media',
      role: 'degraded',
      disclosure: 'downsampled to 1x1',
    });
    const derivedVersion = snapshot.versions[entries[0]!.derivedVersionId!]!;
    const objectRef = snapshot.files[derivedVersion.fileId]!.fileRef;
    expect(objectRef.startsWith(path.join(tmpDir, 'omni'))).toBe(true);
    await expect(fs.stat(objectRef)).resolves.toBeDefined();
  });

  it('reuses the session binding for a handle-driven call', async () => {
    // The gate turned the model's resourceId into inputPath; the registry
    // still holds the identity, so the source is not re-recognized.
    const bound = registry.bind({
      fileId: 'f-src',
      fileVersionId: 'v-src',
      rootFileId: 'f-root',
      fileRef: inputPath,
      mediaType: 'image',
    });

    await collectModelPolicyCall({
      config: bridgeConfig(),
      batch: batchOf(),
      descriptor: DESCRIPTOR,
      args: { inputPath, outputDir, resourceId: bound.resourceId },
    });

    const snapshot = await readSnapshot();
    const execution = Object.values(snapshot.executions)[0]!;
    expect(execution.sourceVersionId).toBe('v-src');
    expect(execution.rootFileId).toBe('f-root');
    // resourceId is per-invocation plumbing, never reproducible config.
    expect(execution.finalArguments).not.toHaveProperty('resourceId');
  });

  it('leaves fixed-policy successes to the orchestrator', async () => {
    await collectModelPolicyCall({
      config: bridgeConfig(),
      batch: batchOf({
        kind: 'fixed_policy',
        policyId: 'img',
        stage: 'preprocessing',
      }),
      descriptor: DESCRIPTOR,
      args: { inputPath, outputDir },
    });

    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.executions)).toHaveLength(0);
  });

  it('does nothing when memory is not configured', async () => {
    await collectModelPolicyCall({
      config: bridgeConfig({ getOmniMemoryConfig: () => undefined }),
      batch: batchOf(),
      descriptor: DESCRIPTOR,
      args: { inputPath, outputDir },
    });

    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.executions)).toHaveLength(0);
  });

  it('never throws when an artifact escapes the declared output directory', async () => {
    const escaping = batchOf();
    escaping.artifacts[0]!.workspacePath = '../source.jpg';

    await expect(
      collectModelPolicyCall({
        config: bridgeConfig(),
        batch: escaping,
        descriptor: DESCRIPTOR,
        args: { inputPath, outputDir },
      }),
    ).resolves.toBeUndefined();

    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.executions)).toHaveLength(0);
  });
});
