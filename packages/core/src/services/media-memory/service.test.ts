/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MediaMemoryService,
  type FileRecognizedEvent,
  type PolicySucceededInput,
} from './index.js';
import { truncateUtf8 } from './service.js';
import { MEDIA_MEMORY_FILE_NAME } from './store.js';
import type { MediaMemorySnapshot } from './types.js';

let root: string;
let clock: number;

/** Deterministic, strictly increasing timestamps per commit. */
class TestMediaMemoryService extends MediaMemoryService {
  protected override now(): string {
    return new Date(clock++).toISOString();
  }
}

let service: TestMediaMemoryService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-memory-svc-'));
  clock = 1_754_870_400_000; // 2025-08-11T00:00:00Z, arbitrary fixed base
  service = new TestMediaMemoryService(root);
});

afterEach(async () => {
  await fs
    .chmod(path.join(root, MEDIA_MEMORY_FILE_NAME), 0o600)
    .catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

const canDropPermissions =
  process.platform !== 'win32' &&
  (typeof process.getuid !== 'function' || process.getuid() !== 0);

async function readSnapshot(): Promise<MediaMemorySnapshot> {
  const raw = await fs.readFile(
    path.join(root, MEDIA_MEMORY_FILE_NAME),
    'utf8',
  );
  return JSON.parse(raw) as MediaMemorySnapshot;
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_OUT = 'c'.repeat(64);

function recognizedEvent(
  overrides?: Partial<FileRecognizedEvent>,
): FileRecognizedEvent {
  return {
    fileRef: '/movies/breaking-surface.mkv',
    sha256: SHA_A,
    mediaType: 'video',
    metadata: { durationMs: 4_860_000, width: 1920, height: 1080 },
    sizeBytes: 123_456_789,
    mimeType: 'video/x-matroska',
    origin: 'user',
    source: { protocol: 'local', locator: 'breaking-surface.mkv' },
    recognition: {
      ingestionConfigHash: '',
      detectorVersion: 'omni-sniff-ffprobe/1',
      probeStatus: 'complete',
    },
    ...overrides,
  };
}

function succeededInput(
  source: { fileId: string; fileVersionId: string; rootFileId: string },
  overrides?: Partial<PolicySucceededInput>,
): PolicySucceededInput {
  return {
    invocationId: 'deadbeef01234567',
    source,
    executionOrigin: {
      kind: 'fixed_policy',
      policyId: 'downscale-video',
      stage: 'preprocessing',
    },
    toolName: 'omni_downscale_video',
    toolVersion: '1',
    finalArguments: { maxHeight: 480, fps: 1 },
    omniConfigHash: 'fp-' + '0'.repeat(61),
    startedAt: '2026-08-11T00:00:00.000Z',
    completedAt: '2026-08-11T00:00:05.000Z',
    outputs: [
      {
        kind: 'media',
        objectPath: `/store/objects/${SHA_OUT}.mp4`,
        sha256: SHA_OUT,
        mediaType: 'video',
        metadata: { durationMs: 4_860_000, width: 854, height: 480 },
        sizeBytes: 10_000_000,
        mimeType: 'video/mp4',
        disclosure: 'downscaled to 480p/1fps',
      },
    ],
    ...overrides,
  };
}

describe('MediaMemoryService.recordFileRecognized', () => {
  it('creates file + version and is idempotent for identical content', async () => {
    const first = await service.recordFileRecognized(recognizedEvent());
    expect(first).toBeDefined();
    expect(first!.created).toBe(true);
    expect(first!.rootFileId).toBe(first!.fileId);

    const second = await service.recordFileRecognized(recognizedEvent());
    expect(second).toMatchObject({
      fileId: first!.fileId,
      fileVersionId: first!.fileVersionId,
      created: false,
    });

    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.files)).toHaveLength(1);
    expect(Object.keys(snapshot.versions)).toHaveLength(1);
  });

  it('creates a new version on content change and moves CURRENT_VERSION both ways', async () => {
    const v1 = await service.recordFileRecognized(recognizedEvent());
    const v2 = await service.recordFileRecognized(
      recognizedEvent({ sha256: SHA_B }),
    );
    expect(v2!.fileId).toBe(v1!.fileId);
    expect(v2!.fileVersionId).not.toBe(v1!.fileVersionId);
    expect(v2!.created).toBe(true);

    let snapshot = await readSnapshot();
    expect(snapshot.files[v1!.fileId].currentVersionId).toBe(v2!.fileVersionId);

    // Revert on disk: the pointer moves back, no third version appears.
    const reverted = await service.recordFileRecognized(recognizedEvent());
    expect(reverted).toMatchObject({
      fileVersionId: v1!.fileVersionId,
      created: false,
    });
    snapshot = await readSnapshot();
    expect(snapshot.files[v1!.fileId].currentVersionId).toBe(v1!.fileVersionId);
    expect(Object.keys(snapshot.versions)).toHaveLength(2);
  });

  it('keeps two files with identical bytes as two distinct records (M §11)', async () => {
    const a = await service.recordFileRecognized(recognizedEvent());
    const b = await service.recordFileRecognized(
      recognizedEvent({ fileRef: '/movies/copy.mkv' }),
    );
    expect(b!.fileId).not.toBe(a!.fileId);
    expect(b!.fileVersionId).not.toBe(a!.fileVersionId);
    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.files)).toHaveLength(2);
  });

  it.runIf(canDropPermissions)(
    'returns undefined instead of throwing when persistence fails',
    async () => {
      await service.recordFileRecognized(recognizedEvent());
      await fs.chmod(path.join(root, MEDIA_MEMORY_FILE_NAME), 0o000);
      const result = await service.recordFileRecognized(
        recognizedEvent({ sha256: SHA_B }),
      );
      expect(result).toBeUndefined();
    },
  );
});

describe('MediaMemoryService.commitPolicySucceeded', () => {
  it("gives a byte-identical sibling file its own execution, not the first file's", async () => {
    // Two Files with identical bytes and the same policy configuration.
    // The execution key used to be content-only, so B adopted A's
    // execution node: B got ZERO records of its own while A's derivative
    // versions were handed back stamped with B's root (mixed lineage).
    // M §11.2/§11.3: each File writes its own PolicyExecution and
    // provenance; only the underlying computation and bytes are reused.
    const a = (await service.recordFileRecognized(recognizedEvent()))!;
    const b = (await service.recordFileRecognized(
      recognizedEvent({ fileRef: '/movies/copy.mkv' }),
    ))!;

    const commitA = (await service.commitPolicySucceeded(succeededInput(a)))!;
    const commitB = (await service.commitPolicySucceeded(succeededInput(b)))!;

    // Separate execution nodes, and B's is recorded as a reuse of A's.
    expect(commitB.executionId).not.toBe(commitA.executionId);
    expect(commitB.created).toBe(true);
    const snapshot = await readSnapshot();
    expect(snapshot.executions[commitB.executionId]).toMatchObject({
      sourceVersionId: b.fileVersionId,
      rootFileId: b.rootFileId,
      reusedExecutionId: commitA.executionId,
    });
    // A's execution is the original — it points at nothing.
    expect(
      snapshot.executions[commitA.executionId]!.reusedExecutionId,
    ).toBeUndefined();

    // Each side's derivative is rooted in its OWN tree (no borrowed
    // lineage), while both name the same content-addressed object.
    const bindingA = commitA.mediaBindings.get(SHA_OUT)!;
    const bindingB = commitB.mediaBindings.get(SHA_OUT)!;
    expect(bindingA.rootFileId).toBe(a.rootFileId);
    expect(bindingB.rootFileId).toBe(b.rootFileId);
    expect(bindingB.fileId).not.toBe(bindingA.fileId);
    expect(snapshot.files[bindingA.fileId]!.fileRef).toBe(
      snapshot.files[bindingB.fileId]!.fileRef,
    );
  });

  it('stays idempotent when the SAME file replays the same execution', async () => {
    const a = (await service.recordFileRecognized(recognizedEvent()))!;
    const first = (await service.commitPolicySucceeded(succeededInput(a)))!;
    const replay = (await service.commitPolicySucceeded(succeededInput(a)))!;

    expect(replay.executionId).toBe(first.executionId);
    expect(replay.created).toBe(false);
    expect(replay.mediaBindings.get(SHA_OUT)).toEqual(
      first.mediaBindings.get(SHA_OUT),
    );
    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.executions)).toHaveLength(1);
    expect(
      snapshot.executions[first.executionId]!.reusedExecutionId,
    ).toBeUndefined();
  });

  it('commits execution + derived version + entry atomically with lineage edges', async () => {
    const source = (await service.recordFileRecognized(recognizedEvent()))!;
    const commit = await service.commitPolicySucceeded(succeededInput(source));
    expect(commit).toBeDefined();
    expect(commit!.created).toBe(true);

    const binding = commit!.mediaBindings.get(SHA_OUT);
    expect(binding).toBeDefined();
    expect(binding!.rootFileId).toBe(source.rootFileId);

    const snapshot = await readSnapshot();
    const execution = snapshot.executions[commit!.executionId];
    expect(execution).toMatchObject({
      invocationId: 'deadbeef01234567',
      sourceVersionId: source.fileVersionId,
      rootFileId: source.rootFileId,
      toolName: 'omni_downscale_video',
    });
    expect(execution.outputRefs).toHaveLength(1);

    const derivedVersion = snapshot.versions[binding!.fileVersionId];
    expect(derivedVersion).toMatchObject({
      sha256: SHA_OUT,
      parentVersionId: source.fileVersionId,
      producedByExecutionId: commit!.executionId,
    });
    expect(snapshot.files[binding!.fileId]).toMatchObject({
      origin: 'policy',
      rootFileId: source.rootFileId,
    });

    const entry = snapshot.entries[execution.outputRefs[0]];
    expect(entry).toMatchObject({
      kind: 'derived_media',
      derivedVersionId: binding!.fileVersionId,
      parentVersionId: source.fileVersionId,
      producedByExecutionId: commit!.executionId,
      channels: ['visual', 'acoustic'],
      coverage: { mode: 'complete', scope: {} },
    });
    expect(entry.artifactRef).toMatchObject({
      storage: 'managed',
      managedId: `sha256/${SHA_OUT}`,
    });
  });

  it('converges replays on the same execution node (content-identity key)', async () => {
    const source = (await service.recordFileRecognized(recognizedEvent()))!;
    const first = await service.commitPolicySucceeded(succeededInput(source));
    // Different invocation (degradation-cache hit), same content identity.
    const replay = await service.commitPolicySucceeded(
      succeededInput(source, { invocationId: 'cache-hit' }),
    );
    expect(replay!.executionId).toBe(first!.executionId);
    expect(replay!.created).toBe(false);
    expect(replay!.mediaBindings.get(SHA_OUT)).toEqual(
      first!.mediaBindings.get(SHA_OUT),
    );
    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.executions)).toHaveLength(1);
    expect(Object.keys(snapshot.entries)).toHaveLength(1);
    // The replay's invocationId is NOT rewritten onto the record.
    expect(snapshot.executions[first!.executionId].invocationId).toBe(
      'deadbeef01234567',
    );
  });

  it('creates distinct executions for distinct tool configurations', async () => {
    const source = (await service.recordFileRecognized(recognizedEvent()))!;
    const first = await service.commitPolicySucceeded(succeededInput(source));
    const other = await service.commitPolicySucceeded(
      succeededInput(source, { omniConfigHash: 'fp-other' }),
    );
    expect(other!.executionId).not.toBe(first!.executionId);
    expect(other!.created).toBe(true);
  });

  it('persists text outputs as policy_result entries with bounded inlineText', async () => {
    const bounded = new TestMediaMemoryService(root, {
      maxInlineTextBytes: 10,
    });
    const source = (await bounded.recordFileRecognized(recognizedEvent()))!;
    const commit = await bounded.commitPolicySucceeded(
      succeededInput(source, {
        outputs: [
          {
            kind: 'text',
            objectPath: `/store/objects/${SHA_OUT}.txt`,
            sha256: SHA_OUT,
            mimeType: 'text/plain',
            text: '你好世界这段文本很长', // 3 bytes per CJK code point
            sizeBytes: 30,
            role: 'transcript',
          },
        ],
      }),
    );
    expect(commit!.mediaBindings.size).toBe(0);
    const snapshot = await readSnapshot();
    const entry =
      snapshot.entries[snapshot.executions[commit!.executionId].outputRefs[0]];
    expect(entry.kind).toBe('policy_result');
    expect(entry.derivedVersionId).toBeUndefined();
    // 10-byte budget over 3-byte code points → 3 characters, never split.
    expect(entry.inlineText).toBe('你好世');
    expect(entry.channels).toEqual(['speech_text']);
    // Full content stays reachable through the managed artifact.
    expect(entry.artifactRef?.managedId).toBe(`sha256/${SHA_OUT}`);
  });

  it('derives sampled coverage for keyframe outputs', async () => {
    const source = (await service.recordFileRecognized(recognizedEvent()))!;
    const commit = await service.commitPolicySucceeded(
      succeededInput(source, {
        outputs: [
          {
            kind: 'media',
            objectPath: `/store/objects/${SHA_OUT}.jpg`,
            sha256: SHA_OUT,
            mediaType: 'image',
            metadata: { width: 854, height: 480 },
            sizeBytes: 50_000,
            mimeType: 'image/jpeg',
            role: 'keyframe',
          },
        ],
      }),
    );
    const snapshot = await readSnapshot();
    const entry =
      snapshot.entries[snapshot.executions[commit!.executionId].outputRefs[0]];
    expect(entry.coverage).toEqual({ mode: 'sampled', scope: {} });
    expect(entry.channels).toEqual(['visual']);
  });
});

describe('MediaMemoryService.findBindingBySha256', () => {
  it('returns the binding for known content and undefined for unknown', async () => {
    const source = (await service.recordFileRecognized(recognizedEvent()))!;
    await expect(service.findBindingBySha256(SHA_A)).resolves.toEqual({
      fileId: source.fileId,
      fileVersionId: source.fileVersionId,
      rootFileId: source.rootFileId,
    });
    await expect(service.findBindingBySha256(SHA_B)).resolves.toBeUndefined();
  });

  it('prefers the newest version when several match', async () => {
    await service.recordFileRecognized(recognizedEvent());
    const newer = (await service.recordFileRecognized(
      recognizedEvent({ fileRef: '/movies/copy.mkv' }),
    ))!;
    const found = await service.findBindingBySha256(SHA_A);
    expect(found).toEqual({
      fileId: newer.fileId,
      fileVersionId: newer.fileVersionId,
      rootFileId: newer.rootFileId,
    });
  });
});

describe('truncateUtf8', () => {
  it('returns short text unchanged', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello');
  });

  it('never splits a code point', () => {
    expect(truncateUtf8('a你b', 3)).toBe('a'); // '你' needs 3 bytes, only 2 left
    expect(truncateUtf8('a你b', 4)).toBe('a你');
    expect(truncateUtf8('🎬🎬', 5)).toBe('🎬'); // 4-byte emoji
  });
});
