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
import { truncateUtf8, type PolicyTextOutputInput } from './service.js';
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
const SHA_TEXT = 'd'.repeat(64);

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

type Binding = { fileId: string; fileVersionId: string; rootFileId: string };

function succeededInput(
  source: Binding,
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

const recognize = (overrides?: Partial<FileRecognizedEvent>) =>
  service.recordFileRecognized(recognizedEvent(overrides));
const succeed = (source: Binding, overrides?: Partial<PolicySucceededInput>) =>
  service.commitPolicySucceeded(succeededInput(source, overrides));
const bindingOf = ({ fileId, fileVersionId, rootFileId }: Binding) => ({
  fileId,
  fileVersionId,
  rootFileId,
});

/** A text/plain output stored as `sha`. */
const textOutput = (
  text: string,
  sizeBytes: number,
  role: string,
  sha = SHA_TEXT,
): PolicyTextOutputInput => ({
  kind: 'text',
  objectPath: `/store/objects/${sha}.txt`,
  sha256: sha,
  mimeType: 'text/plain',
  text,
  sizeBytes,
  role,
});

/** The first entry an execution recorded. */
async function firstEntry(executionId: string) {
  const snapshot = await readSnapshot();
  return snapshot.entries[snapshot.executions[executionId].outputRefs[0]];
}

describe('MediaMemoryService.recordFileRecognized', () => {
  it('creates file + version and is idempotent for identical content', async () => {
    const first = await recognize();
    expect(first).toBeDefined();
    expect(first!.created).toBe(true);
    expect(first!.rootFileId).toBe(first!.fileId);

    const second = await recognize();
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
    const v1 = await recognize();
    const v2 = await recognize({ sha256: SHA_B });
    expect(v2!.fileId).toBe(v1!.fileId);
    expect(v2!.fileVersionId).not.toBe(v1!.fileVersionId);
    expect(v2!.created).toBe(true);

    let snapshot = await readSnapshot();
    expect(snapshot.files[v1!.fileId].currentVersionId).toBe(v2!.fileVersionId);

    // Revert on disk: the pointer moves back, no third version appears.
    const reverted = await recognize();
    expect(reverted).toMatchObject({
      fileVersionId: v1!.fileVersionId,
      created: false,
    });
    snapshot = await readSnapshot();
    expect(snapshot.files[v1!.fileId].currentVersionId).toBe(v1!.fileVersionId);
    expect(Object.keys(snapshot.versions)).toHaveLength(2);
  });

  it('keeps two files with identical bytes as two distinct records (M §11)', async () => {
    const a = await recognize();
    const b = await recognize({ fileRef: '/movies/copy.mkv' });
    expect(b!.fileId).not.toBe(a!.fileId);
    expect(b!.fileVersionId).not.toBe(a!.fileVersionId);
    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot.files)).toHaveLength(2);
  });

  it.runIf(canDropPermissions)(
    'returns undefined instead of throwing when persistence fails',
    async () => {
      await recognize();
      await fs.chmod(path.join(root, MEDIA_MEMORY_FILE_NAME), 0o000);
      expect(await recognize({ sha256: SHA_B })).toBeUndefined();
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
    const a = (await recognize())!;
    const b = (await recognize({ fileRef: '/movies/copy.mkv' }))!;

    const commitA = (await succeed(a))!;
    const commitB = (await succeed(b))!;

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
    const a = (await recognize())!;
    const first = (await succeed(a))!;
    const replay = (await succeed(a))!;

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

  it('leaves the derived version pointing at the execution that made it', async () => {
    // A second execution over the same source under a different omni
    // configuration can land on byte-identical output — same derived File,
    // same version. Rewriting the version's producer would make it name an
    // execution whose outputs it is not.
    const source = (await recognize())!;
    const first = (await succeed(source))!;
    const second = (await succeed(source, {
      omniConfigHash: 'fp-' + '1'.repeat(61),
    }))!;

    expect(second.executionId).not.toBe(first.executionId);
    const derivedVersionId = first.mediaBindings.get(SHA_OUT)!.fileVersionId;
    expect(second.mediaBindings.get(SHA_OUT)!.fileVersionId).toBe(
      derivedVersionId,
    );
    const snapshot = await readSnapshot();
    expect(snapshot.versions[derivedVersionId]!.producedByExecutionId).toBe(
      first.executionId,
    );
  });

  it('commits execution + derived version + entry atomically with lineage edges', async () => {
    const source = (await recognize())!;
    const commit = await succeed(source);
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
    const source = (await recognize())!;
    const first = await succeed(source);
    // Different invocation (degradation-cache hit), same content identity.
    const replay = await succeed(source, { invocationId: 'cache-hit' });
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
    const source = (await recognize())!;
    const first = await succeed(source);
    const other = await succeed(source, { omniConfigHash: 'fp-other' });
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
          // 3 bytes per CJK code point
          textOutput('你好世界这段文本很长', 30, 'transcript', SHA_OUT),
        ],
      }),
    );
    expect(commit!.mediaBindings.size).toBe(0);
    const entry = await firstEntry(commit!.executionId);
    expect(entry.kind).toBe('policy_result');
    expect(entry.derivedVersionId).toBeUndefined();
    // 10-byte budget over 3-byte code points → 3 characters, never split.
    expect(entry.inlineText).toBe('你好世');
    expect(entry.channels).toEqual(['speech_text']);
    // Full content stays reachable through the managed artifact.
    expect(entry.artifactRef?.managedId).toBe(`sha256/${SHA_OUT}`);
  });

  it.each([
    ['image', 'caption', ['visual']],
    ['audio', 'caption', ['acoustic']],
    ['video', 'summary', ['visual', 'acoustic']],
  ] as const)(
    'derives %s %s text channels from the source modality',
    async (mediaType, role, expectedChannels) => {
      const source = (await recognize({ mediaType }))!;
      const commit = await succeed(source, {
        outputs: [textOutput(`${mediaType} ${role}`, 20, role)],
      });
      const entry = await firstEntry(commit!.executionId);
      expect(entry.channels).toEqual(expectedChannels);
    },
  );

  it('records every output of a multi-output execution under one execution', async () => {
    // Real policy runs deliver more than one artifact (extract the audio
    // track AND its transcript; downscale AND a poster frame). Recording
    // only the first would have memory report the run as done while half
    // its products are invisible to recall and to reuse — the next
    // identical run then re-derives what memory silently dropped.
    const source = (await recognize())!;
    const input = succeededInput(source, {
      toolName: 'omni_extract_audio',
      outputs: [
        {
          kind: 'media',
          objectPath: `/store/objects/${SHA_OUT}.m4a`,
          sha256: SHA_OUT,
          mediaType: 'audio',
          metadata: { durationMs: 4_860_000 },
          sizeBytes: 5_000_000,
          mimeType: 'audio/mp4',
          role: 'extracted_audio',
        },
        textOutput('Two divers surface at dawn.', 27, 'transcript'),
      ],
    });
    const commit = (await service.commitPolicySucceeded(input))!;

    // Only the media output becomes a version the orchestrator can thread.
    expect([...commit.mediaBindings.keys()]).toEqual([SHA_OUT]);

    const snapshot = await readSnapshot();
    const execution = snapshot.executions[commit.executionId];
    expect(execution.outputRefs).toHaveLength(2);
    expect(Object.keys(snapshot.executions)).toHaveLength(1);
    const [audio, transcript] = execution.outputRefs.map(
      (id) => snapshot.entries[id],
    );
    expect(audio).toMatchObject({
      kind: 'derived_media',
      role: 'extracted_audio',
      derivedVersionId: commit.mediaBindings.get(SHA_OUT)!.fileVersionId,
      parentVersionId: source.fileVersionId,
      producedByExecutionId: commit.executionId,
      channels: ['acoustic'],
    });
    expect(transcript).toMatchObject({
      kind: 'policy_result',
      role: 'transcript',
      inlineText: 'Two divers surface at dawn.',
      parentVersionId: source.fileVersionId,
      producedByExecutionId: commit.executionId,
      channels: ['speech_text'],
    });
    expect(transcript.derivedVersionId).toBeUndefined();
    expect(transcript.outputId).not.toBe(audio.outputId);

    // Reuse must offer the whole set: a caller that re-runs this exact
    // computation skips it entirely, so a partially recorded set would hand
    // back an audio track with no transcript and call it a complete reuse.
    const reusable = await service.findReusableOutputs(
      SHA_A,
      input.omniConfigHash,
    );
    expect(reusable!.executionId).toBe(commit.executionId);
    expect(reusable!.outputs.map((o) => `${o.kind}:${o.sha256}`)).toEqual([
      `media:${SHA_OUT}`,
      `text:${SHA_TEXT}`,
    ]);
  });

  it('derives sampled coverage for keyframe outputs', async () => {
    const source = (await recognize())!;
    const commit = await succeed(source, {
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
    });
    const entry = await firstEntry(commit!.executionId);
    expect(entry.coverage).toEqual({ mode: 'sampled', scope: {} });
    expect(entry.channels).toEqual(['visual']);
  });

  it('derives partial coverage for clip outputs', async () => {
    const source = (await recognize())!;
    const commit = await succeed(source, {
      toolName: 'omni_extract_clip',
      outputs: [
        {
          kind: 'media',
          objectPath: `/store/objects/${SHA_OUT}.mp4`,
          sha256: SHA_OUT,
          mediaType: 'video',
          metadata: { durationMs: 30_000, width: 1920, height: 1080 },
          sizeBytes: 2_000_000,
          mimeType: 'video/mp4',
          role: 'clip',
        },
      ],
    });
    const entry = await firstEntry(commit!.executionId);
    // A clip is one slice of a 81-minute film. Recording it as `complete`
    // would let the gap derivation count the version's visual and acoustic
    // channels as fully covered, so recall reports nothing missing and the
    // model answers about the whole film from a 30-second excerpt — the
    // overclaim coverage exists to prevent.
    expect(entry.coverage).toEqual({ mode: 'partial', scope: {} });
    expect(entry.channels).toEqual(['visual', 'acoustic']);
  });
});

describe('MediaMemoryService.findBindingBySha256', () => {
  it('returns the binding for known content and undefined for unknown', async () => {
    const source = (await recognize())!;
    await expect(service.findBindingBySha256(SHA_A)).resolves.toEqual(
      bindingOf(source),
    );
    await expect(service.findBindingBySha256(SHA_B)).resolves.toBeUndefined();
  });

  it('prefers the newest version when several match', async () => {
    await recognize();
    const newer = (await recognize({ fileRef: '/movies/copy.mkv' }))!;
    const found = await service.findBindingBySha256(SHA_A);
    expect(found).toEqual(bindingOf(newer));
  });
});

describe('MediaMemoryService.collectVersionOutputRoles', () => {
  it('returns an empty set for a version with no recorded outputs', async () => {
    const source = (await recognize())!;
    await expect(
      service.collectVersionOutputRoles(bindingOf(source)),
    ).resolves.toEqual(new Set());
  });

  it('collects roles of outputs committed against the version itself', async () => {
    const source = (await recognize())!;
    await succeed(source, {
      outputs: [textOutput('full transcript', 15, 'transcript')],
    });
    const roles = await service.collectVersionOutputRoles(bindingOf(source));
    expect(roles).toEqual(new Set(['transcript']));
  });

  it('sees roles recorded on DERIVED versions (the §4.1 extract→transcribe chain)', async () => {
    const source = (await recognize())!;
    // Step 1: extract_audio on the video → derived audio version.
    const extract = (await succeed(source, {
      outputs: [
        {
          kind: 'media',
          objectPath: `/store/objects/${SHA_OUT}.wav`,
          sha256: SHA_OUT,
          mediaType: 'audio',
          metadata: { durationMs: 4_860_000 },
          sizeBytes: 46_656_000,
          mimeType: 'audio/wav',
          role: 'extracted_audio',
        },
      ],
    }))!;
    const audioBinding = extract.mediaBindings.get(SHA_OUT)!;
    expect(audioBinding).toBeDefined();

    // Step 2: transcribe the DERIVED audio — the transcript entry is
    // parented to the audio version, not the video version.
    await succeed(audioBinding, {
      toolName: 'omni_transcribe_audio',
      outputs: [textOutput('full transcript', 15, 'transcript')],
    });

    // Querying the VIDEO version must still surface the transcript role:
    // the audio version is in its derived subgraph.
    const roles = await service.collectVersionOutputRoles(bindingOf(source));
    expect(roles).toEqual(new Set(['transcript', 'extracted_audio']));
  });

  it('returns an empty set for an unknown version id', async () => {
    await expect(
      service.collectVersionOutputRoles({
        fileId: 'x'.repeat(16),
        fileVersionId: 'y'.repeat(16),
        rootFileId: 'z'.repeat(16),
      }),
    ).resolves.toEqual(new Set());
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
